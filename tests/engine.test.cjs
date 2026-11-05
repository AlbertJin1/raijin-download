'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { DownloadManager } = require('../electron/engine/manager.cjs');
const util = require('../electron/engine/util.cjs');

function randomPayload(size) { return crypto.randomBytes(size); }

/**
 * Configurable fixture server.
 *  ranges       – honour Range requests
 *  chunked      – omit Content-Length on full responses (unknown size)
 *  dropAfter    – destroy the socket after N bytes on the first K requests (flaky network)
 *  failFirst    – respond 503 to the first N GET requests
 *  slowMs       – delay between 64 KiB writes
 */
function makeServer(payload, opts = {}) {
  const state = { gets: 0, rangeRequests: 0, drops: 0, maxParallel: 0, open: 0, etag: opts.etag || '"v1"' };
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/redirect')) { res.statusCode = 302; res.setHeader('Location', '/file.bin'); return res.end(); }
    if (req.url.startsWith('/auth')) {
      if (req.headers.authorization !== `Basic ${Buffer.from('user:pass').toString('base64')}`) { res.statusCode = 401; return res.end(); }
    }
    if (req.url.startsWith('/cookie') && req.headers.cookie !== 'session=abc') { res.statusCode = 403; return res.end(); }
    if (req.url.startsWith('/empty')) { res.setHeader('Content-Length', 0); return res.end(); }
    state.gets += 1;
    if (opts.failFirst && state.gets <= opts.failFirst) { res.statusCode = 503; res.setHeader('Retry-After', '0'); return res.end('busy'); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="fixture.bin"');
    res.setHeader('ETag', state.etag);
    let start = 0; let end = payload.length - 1;
    const range = req.headers.range;
    if (range && opts.ranges !== false) {
      const m = range.match(/^bytes=(\d+)-(\d*)$/);
      if (!m) { res.statusCode = 416; return res.end(); }
      start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), payload.length - 1) : payload.length - 1;
      if (start >= payload.length) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${payload.length}`); return res.end(); }
      if (req.headers['if-range'] && req.headers['if-range'] !== state.etag) { start = 0; end = payload.length - 1; res.statusCode = 200; }
      else {
        state.rangeRequests += 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
      }
      res.setHeader('Accept-Ranges', 'bytes');
    } else res.statusCode = 200;
    if (!(opts.chunked && res.statusCode === 200)) res.setHeader('Content-Length', end - start + 1);
    state.open += 1; state.maxParallel = Math.max(state.maxParallel, state.open);
    res.on('close', () => { state.open -= 1; });
    const body = payload.subarray(start, end + 1);
    const shouldDrop = opts.dropAfter && state.drops < (opts.dropTimes ?? 2) && body.length > opts.dropAfter;
    let offset = 0;
    const step = 64 * 1024;
    while (offset < body.length) {
      if (shouldDrop && offset >= opts.dropAfter) { state.drops += 1; req.socket.destroy(); return; }
      const slice = body.subarray(offset, offset + step);
      offset += slice.length;
      if (!res.write(slice)) await new Promise((r) => res.once('drain', r));
      if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
      if (res.destroyed) return;
    }
    res.end();
  });
  server.state = state;
  return server;
}

async function setup(t, payload, serverOpts = {}, prefs = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'raijin-test-'));
  const downloadDir = path.join(root, 'files');
  const server = makeServer(payload, serverOpts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const manager = new DownloadManager({ userDataDir: path.join(root, 'data'), defaultDownloadDir: downloadDir });
  await manager.init();
  await manager.setPreferences({ notifications: false, maxConcurrent: 3, categoryFolders: false, maxRetries: 6, timeoutSec: 5, ...prefs });
  t.after(async () => {
    await manager.shutdown();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { manager, server, base, root, downloadDir };
}

async function waitFor(manager, id, statuses = ['completed', 'failed'], timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const job = manager.getJob(id);
    if (job && statuses.includes(job.status) && !manager.transfers.has(id)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${statuses.join('/')}: ${manager.getJob(id)?.status} ${manager.getJob(id)?.error || ''}`);
}

/* ------------------------------------------------------------------ utils */

test('safe filename strips traversal and Windows-reserved names', () => {
  assert.equal(util.safeFilename('../folder/evil:name?.zip'), '.._folder_evil_name_.zip');
  assert.equal(util.safeFilename('   '), 'download');
  assert.equal(util.safeFilename('CON.txt'), '_CON.txt');
  assert.ok(util.safeFilename('a'.repeat(400) + '.zip').endsWith('.zip'));
});

test('content-disposition parsing handles RFC 5987 and quoted names', () => {
  assert.equal(util.filenameFromHeaders('https://x.test/a.bin', new Headers({ 'content-disposition': 'attachment; filename="from-server.zip"' })), 'from-server.zip');
  assert.equal(util.filenameFromHeaders('https://x.test/a.bin', new Headers({ 'content-disposition': "attachment; filename*=UTF-8''hello%20world.zip" })), 'hello world.zip');
  assert.equal(util.filenameFromHeaders('https://x.test/get?id=1', new Headers({ 'content-type': 'application/pdf' })), 'get.pdf');
  assert.equal(util.filenameFromHeaders('https://x.test/files/report%202026.pdf', new Headers()), 'report 2026.pdf');
});

test('batch patterns expand numeric, padded, stepped and alphabetic ranges', () => {
  assert.deepEqual(util.expandPattern('https://x/img[08-11].jpg'), ['https://x/img08.jpg', 'https://x/img09.jpg', 'https://x/img10.jpg', 'https://x/img11.jpg']);
  assert.deepEqual(util.expandPattern('https://x/p[1-5:2].bin'), ['https://x/p1.bin', 'https://x/p3.bin', 'https://x/p5.bin']);
  assert.equal(util.expandPattern('https://x/[a-c]/[1-2].txt').length, 6);
  assert.deepEqual(util.extractUrls('ftp://no\nhttps://a.test/x.zip, junk https://b.test/y.iso.'), ['https://a.test/x.zip', 'https://b.test/y.iso']);
});

test('header parser drops hop-by-hop, range and malformed headers', () => {
  assert.deepEqual(util.parseHeaderLines('X-Token: abc\nRange: bytes=1-\nbad header: x\nAuthorization: Bearer z'), { 'X-Token': 'abc', Authorization: 'Bearer z' });
});

test('category detection', () => {
  assert.equal(util.categoryFor('movie.mkv'), 'video');
  assert.equal(util.categoryFor('song.flac'), 'music');
  assert.equal(util.categoryFor('setup.msi'), 'programs');
  assert.equal(util.categoryFor('x.7z'), 'compressed');
  assert.equal(util.categoryFor('noext'), 'other');
});

/* ----------------------------------------------------------- downloads */

test('dynamic segmentation downloads a large file with many parallel connections', async (t) => {
  const payload = randomPayload(12 * 1024 * 1024 + 4321);
  const { manager, server, base } = await setup(t, payload, { slowMs: 1 });
  const job = await manager.add(`${base}/file.bin`, { connections: 8 });
  const result = await waitFor(manager, job.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.segmented, true);
  assert.equal(result.filename, 'fixture.bin');
  assert.ok(server.state.maxParallel >= 4, `expected parallel connections, saw ${server.state.maxParallel}`);
  const saved = await fs.readFile(result.destination);
  assert.ok(saved.equals(payload), 'file content must match byte-for-byte');
  await assert.rejects(fs.stat(`${result.destination}.raijin`));
});

test('server without range support falls back to a single stream', async (t) => {
  const payload = randomPayload(3 * 1024 * 1024);
  const { manager, base } = await setup(t, payload, { ranges: false });
  const job = await manager.add(`${base}/file.bin`, { connections: 8 });
  const result = await waitFor(manager, job.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.segmented, false);
  assert.equal(result.resumable, false);
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('unknown-size (chunked) responses complete when the stream ends', async (t) => {
  const payload = randomPayload(900 * 1024);
  const { manager, base } = await setup(t, payload, { ranges: false, chunked: true });
  const job = await manager.add(`${base}/file.bin`);
  const result = await waitFor(manager, job.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.totalBytes, payload.length);
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('dropped connections are retried and resumed mid-segment without corruption', async (t) => {
  const payload = randomPayload(6 * 1024 * 1024);
  const { manager, server, base } = await setup(t, payload, { dropAfter: 700 * 1024, dropTimes: 4 });
  const job = await manager.add(`${base}/file.bin`, { connections: 4 });
  const result = await waitFor(manager, job.id);
  assert.equal(result.status, 'completed', result.error);
  assert.ok(server.state.drops >= 1);
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('HTTP 503 with Retry-After is retried automatically', async (t) => {
  const payload = randomPayload(200 * 1024);
  const { manager, base } = await setup(t, payload, { failFirst: 2 });
  const job = await manager.add(`${base}/file.bin`);
  const result = await waitFor(manager, job.id);
  assert.equal(result.status, 'completed', result.error);
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('redirects, zero-byte files, basic auth and cookies work', async (t) => {
  const payload = randomPayload(64 * 1024);
  const { manager, base } = await setup(t, payload);
  const redirected = await manager.add(`${base}/redirect`);
  const empty = await manager.add(`${base}/empty.txt`);
  const auth = await manager.add(`${base}/auth/file.bin`, { auth: { username: 'user', password: 'pass' } });
  const cookie = await manager.add(`${base}/cookie/file.bin`, { cookies: 'session=abc' });
  for (const j of [redirected, empty, auth, cookie]) {
    const r = await waitFor(manager, j.id);
    assert.equal(r.status, 'completed', `${j.url}: ${r.error}`);
  }
  assert.equal((await fs.stat(manager.getJob(empty.id).destination)).size, 0);
  assert.ok((await fs.readFile(manager.getJob(redirected.id).destination)).equals(payload));
  const noAuth = await manager.add(`${base}/auth/file.bin`, { allowDuplicate: true });
  const failed = await waitFor(manager, noAuth.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /401/);
});

test('pause and resume continue from the saved segments', async (t) => {
  const payload = randomPayload(5 * 1024 * 1024);
  const { manager, server, base } = await setup(t, payload, {}, { speedLimitKBps: 600 });
  const job = await manager.add(`${base}/file.bin`, { connections: 4 });
  const until = Date.now() + 8000;
  while (Date.now() < until && (manager.getJob(job.id)?.downloadedBytes || 0) < 600 * 1024) await new Promise((r) => setTimeout(r, 20));
  await manager.pause(job.id);
  while (manager.transfers.has(job.id)) await new Promise((r) => setTimeout(r, 20));
  const paused = manager.getJob(job.id);
  assert.equal(paused.status, 'paused');
  const savedBytes = paused.segments.reduce((s, x) => s + x.received, 0);
  assert.ok(savedBytes > 0 && savedBytes < payload.length, `saved ${savedBytes}`);
  const requestsBefore = server.state.rangeRequests;
  await manager.setPreferences({ speedLimitKBps: 0 });
  await manager.resume(job.id);
  const result = await waitFor(manager, job.id);
  assert.equal(result.status, 'completed', result.error);
  assert.ok(server.state.rangeRequests > requestsBefore);
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('resume restarts cleanly when the file changed on the server', async (t) => {
  const payload = randomPayload(3 * 1024 * 1024);
  const { manager, server, base } = await setup(t, payload, {}, { speedLimitKBps: 500 });
  const job = await manager.add(`${base}/file.bin`, { connections: 2 });
  while ((manager.getJob(job.id)?.downloadedBytes || 0) < 300 * 1024) await new Promise((r) => setTimeout(r, 20));
  await manager.pause(job.id);
  while (manager.transfers.has(job.id)) await new Promise((r) => setTimeout(r, 20));
  server.state.etag = '"v2"';
  await manager.setPreferences({ speedLimitKBps: 0 });
  await manager.resume(job.id);
  const result = await waitFor(manager, job.id);
  assert.equal(result.status, 'completed', result.error);
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('state survives a restart of the manager and resumes on launch', async (t) => {
  const payload = randomPayload(4 * 1024 * 1024);
  const { manager, base, root, downloadDir } = await setup(t, payload, {}, { speedLimitKBps: 400 });
  const job = await manager.add(`${base}/file.bin`, { connections: 3 });
  while ((manager.getJob(job.id)?.downloadedBytes || 0) < 400 * 1024) await new Promise((r) => setTimeout(r, 20));
  await manager.shutdown();
  const reloaded = new DownloadManager({ userDataDir: path.join(root, 'data'), defaultDownloadDir: downloadDir });
  t.after(() => reloaded.shutdown());
  await reloaded.init();
  assert.equal(reloaded.getJob(job.id).status, 'queued', 'interrupted downloads are re-queued on launch');
  await reloaded.setPreferences({ speedLimitKBps: 0 });
  const result = await waitFor(reloaded, job.id);
  assert.equal(result.status, 'completed', result.error);
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('checksum verification passes for good files and flags mismatches', async (t) => {
  const payload = randomPayload(300 * 1024);
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const { manager, base } = await setup(t, payload);
  const good = await manager.add(`${base}/file.bin`, { checksum: { algo: 'sha256', expected: sha.toUpperCase() } });
  const bad = await manager.add(`${base}/file.bin`, { allowDuplicate: true, checksum: { algo: 'md5', expected: 'deadbeef' } });
  const g = await waitFor(manager, good.id);
  const b = await waitFor(manager, bad.id);
  assert.equal(g.status, 'completed', g.error);
  assert.equal(g.checksum.verified, true);
  assert.equal(b.status, 'failed');
  assert.match(b.error, /Checksum mismatch/);
  assert.equal(await manager.computeHash(good.id, 'sha256'), sha);
});

test('duplicate URLs are detected and get unique file names when allowed', async (t) => {
  const payload = randomPayload(100 * 1024);
  const { manager, base } = await setup(t, payload);
  const first = await manager.add(`${base}/file.bin`);
  await assert.rejects(manager.add(`${base}/file.bin`), (e) => e.code === 'DUPLICATE');
  const second = await manager.add(`${base}/file.bin`, { allowDuplicate: true });
  const a = await waitFor(manager, first.id);
  const b = await waitFor(manager, second.id);
  assert.notEqual(a.destination, b.destination);
  assert.match(path.basename(b.destination), /fixture \(1\)\.bin/);
});

test('batch add, download-later queue, category folders and priority ordering', async (t) => {
  const payload = randomPayload(50 * 1024);
  const { manager, base, downloadDir } = await setup(t, payload, {}, { categoryFolders: true, maxConcurrent: 1 });
  const res = await manager.addMany(`${base}/a[1-3].bin\n${base}/doc.pdf`, { start: false });
  assert.equal(res.added, 4);
  assert.ok(manager.jobs.every((j) => j.status === 'scheduled'));
  await manager.startQueue();
  for (const id of res.ids) assert.equal((await waitFor(manager, id)).status, 'completed');
  // server always names the file fixture.bin -> "Other" category folder
  const other = await fs.readdir(path.join(downloadDir, 'Other'));
  assert.equal(other.length, 4);
});

test('connections can be changed live and the speed limit is enforced', async (t) => {
  const payload = randomPayload(2 * 1024 * 1024);
  const { manager, base } = await setup(t, payload, {}, { speedLimitKBps: 1024 });
  const started = Date.now();
  const job = await manager.add(`${base}/file.bin`, { connections: 2 });
  await new Promise((r) => setTimeout(r, 300));
  await manager.update(job.id, { connections: 6 });
  const result = await waitFor(manager, job.id);
  const seconds = (Date.now() - started) / 1000;
  assert.equal(result.status, 'completed', result.error);
  assert.ok(seconds >= 1.4, `2 MiB at 1 MiB/s should take ~2s, took ${seconds.toFixed(2)}s`);
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('remove cancels an active download and cleans its temp file; restart re-downloads', async (t) => {
  const payload = randomPayload(2 * 1024 * 1024);
  const { manager, base } = await setup(t, payload, {}, { speedLimitKBps: 200 });
  const job = await manager.add(`${base}/file.bin`);
  while (!manager.getJob(job.id)?.downloadedBytes) await new Promise((r) => setTimeout(r, 20));
  const dest = manager.getJob(job.id).destination;
  await manager.remove(job.id);
  assert.equal(manager.getJob(job.id), undefined);
  await assert.rejects(fs.stat(`${dest}.raijin`));
  await manager.setPreferences({ speedLimitKBps: 0 });
  const again = await manager.add(`${base}/file.bin`);
  await waitFor(manager, again.id);
  await manager.restart(again.id);
  const result = await waitFor(manager, again.id);
  assert.equal(result.status, 'completed');
  assert.ok((await fs.readFile(result.destination)).equals(payload));
});

test('probe reports name, size and resume support without downloading', async (t) => {
  const payload = randomPayload(777 * 1024);
  const { manager, base } = await setup(t, payload);
  const info = await manager.probe(`${base}/file.bin`);
  assert.equal(info.ok, true);
  assert.equal(info.filename, 'fixture.bin');
  assert.equal(info.totalBytes, payload.length);
  assert.equal(info.resumable, true);
});

test('scheduler starts the queue at the configured time', async (t) => {
  const payload = randomPayload(10 * 1024);
  const { manager, base } = await setup(t, payload);
  const job = await manager.add(`${base}/file.bin`, { start: false });
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  await manager.setPreferences({ scheduler: { enabled: true, startTime: hhmm, days: [now.getDay()] } });
  manager.checkScheduler(now);
  assert.equal((await waitFor(manager, job.id)).status, 'completed');
});
