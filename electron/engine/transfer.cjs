'use strict';
/**
 * Raijin transfer engine — one instance per running download.
 *
 * Strategy (IDM-style dynamic segmentation):
 *  1. The first connection asks for `Range: bytes=0-`. Its response tells us the size,
 *     range support and file name, and its body keeps streaming as segment #0.
 *  2. Every additional connection "steals" work by splitting the segment with the most
 *     bytes remaining in half. When any connection finishes, it immediately splits the
 *     next-largest segment, so all connections stay busy until the very last byte.
 *  3. All connections write straight into one pre-allocated file with positional writes,
 *     so there is no slow "assembling" step at the end and resume needs only the
 *     per-segment byte counters (persisted in the job).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DEFAULT_USER_AGENT, parseContentRange, filenameFromHeaders, sleep, parseRetryAfter } = require('./util.cjs');
const { TokenBucket } = require('./throttle.cjs');

const MIN_SPLIT = 384 * 1024; // never create a segment smaller than this
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

class TransferError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

function isDone(seg) { return seg.end != null && seg.start + seg.received > seg.end; }
function remaining(seg) { return seg.end == null ? Infinity : seg.end - (seg.start + seg.received) + 1; }

function linkedController(parent) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  controller.unlink = () => parent.removeEventListener('abort', onAbort);
  return controller;
}

function httpError(response) {
  const status = response.status;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  const text = {
    401: 'The server requires authentication (HTTP 401). Add credentials or cookies in Properties.',
    403: 'Access denied by the server (HTTP 403). The link may have expired — use “Refresh address”.',
    404: 'File not found on the server (HTTP 404).',
    410: 'This link has expired (HTTP 410). Use “Refresh address” with a new link.',
    429: 'The server is rate-limiting requests (HTTP 429).',
  }[status] || `Server returned HTTP ${status}.`;
  return new TransferError(text, RETRYABLE_STATUS.has(status) ? 'HTTP_RETRY' : 'HTTP_FATAL', { status, retryAfter });
}

class Transfer {
  /**
   * @param {object} o
   * @param {object} o.job              live job record (mutated in place)
   * @param {object} o.prefs            current preferences (read live via getter)
   * @param {TokenBucket} o.globalBucket shared bandwidth limiter
   * @param {Function} o.resolveTarget  async (job) => destination path (called once on fresh starts)
   * @param {Function} o.onChange       (kind) => void, called on structural changes
   * @param {Function} [o.fetchImpl]
   */
  constructor({ job, getPrefs, globalBucket, resolveTarget, onChange, fetchImpl }) {
    this.job = job;
    this.getPrefs = getPrefs;
    this.globalBucket = globalBucket;
    this.jobBucket = new TokenBucket((job.speedLimitKBps || 0) * 1024);
    this.resolveTarget = resolveTarget;
    this.onChange = onChange || (() => {});
    this.fetch = fetchImpl || globalThis.fetch;
    this.workers = new Set();
    this.liveWorkers = 0;
    this.fatal = null;
    this.fh = null;
    this.history = [];
    this.speedTimer = null;
    this.restarts = 0;
    this.useOriginalUrl = false;
    this.lastError = null;
  }

  get prefs() { return this.getPrefs(); }
  get tempPath() { return this.job.destination ? `${this.job.destination}.raijin` : null; }
  get targetConnections() { return Math.max(1, Math.min(32, Number(this.job.connections) || 1)); }

  setSpeedLimit(kbps) { this.jobBucket.setRate((Number(kbps) || 0) * 1024); }

  setConnections(count) {
    this.job.connections = Math.max(1, Math.min(32, Math.round(Number(count) || 1)));
    if (this.running && this.job.segmented) this.spawnWorkers();
  }

  headers(extra = {}) {
    const job = this.job;
    const h = {
      'User-Agent': job.userAgent || this.prefs.userAgent || DEFAULT_USER_AGENT,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      ...(job.headers || {}),
    };
    if (job.referrer && !Object.keys(h).some((k) => k.toLowerCase() === 'referer')) h.Referer = job.referrer;
    if (job.cookies && !Object.keys(h).some((k) => k.toLowerCase() === 'cookie')) h.Cookie = job.cookies;
    if (job.auth?.username) h.Authorization = `Basic ${Buffer.from(`${job.auth.username}:${job.auth.password || ''}`).toString('base64')}`;
    return { ...h, ...extra };
  }

  requestUrl() {
    return (!this.useOriginalUrl && this.job.finalUrl) || this.job.url;
  }

  /** fetch with a header timeout; returns { response, controller } */
  async request(extraHeaders, parentSignal) {
    const controller = linkedController(parentSignal);
    const timeoutMs = Math.max(5, Number(this.prefs.timeoutSec) || 30) * 1000;
    const timer = setTimeout(() => controller.abort(new TransferError('Connection timed out.', 'TIMEOUT')), timeoutMs);
    try {
      const response = await this.fetch(this.requestUrl(), { method: 'GET', headers: this.headers(extraHeaders), redirect: 'follow', signal: controller.signal });
      return { response, controller };
    } catch (error) {
      controller.unlink();
      if (parentSignal.aborted) throw parentSignal.reason || error;
      const reason = controller.signal.reason;
      if (reason instanceof TransferError) throw reason;
      throw new TransferError(friendlyNetworkError(error), 'NETWORK', { cause: error });
    } finally { clearTimeout(timer); }
  }

  /* ------------------------------------------------------------------ run */

  async run(signal) {
    this.outerSignal = signal;
    this.running = true;
    this.startSpeedTimer();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await this.attempt();
          return;
        } catch (error) {
          if (signal.aborted) throw signal.reason || error;
          if ((error.code === 'SEGMENT_UNSUPPORTED' || error.code === 'FILE_CHANGED') && this.restarts < 2) {
            this.restarts += 1;
            if (error.code === 'SEGMENT_UNSUPPORTED') this.job.forceSingle = true;
            await this.resetProgress();
            this.job.note = error.code === 'FILE_CHANGED' ? 'The file changed on the server, so the download restarted.' : 'Server rejected parallel ranges — continuing with one connection.';
            this.onChange('structure');
            continue;
          }
          throw error;
        }
      }
    } finally {
      this.running = false;
      this.stopSpeedTimer();
      if (this.fh) { try { await this.fh.close(); } catch {} this.fh = null; }
    }
  }

  async resetProgress() {
    const job = this.job;
    job.segments = [];
    job.downloadedBytes = 0;
    job.progress = 0;
    if (this.fh) { try { await this.fh.close(); } catch {} this.fh = null; }
    if (this.tempPath) await fsp.rm(this.tempPath, { force: true }).catch(() => {});
  }

  async attempt() {
    const job = this.job;
    this.fatal = null;
    this.inner = linkedController(this.outerSignal);
    const signal = this.inner.signal;
    const canResume = job.segments?.length && job.destination && fs.existsSync(this.tempPath);
    let firstResponse = null;
    let firstController = null;

    if (canResume) {
      firstResponse = await this.validateResume(signal);
    }

    if (!job.segments?.length || !job.destination || !fs.existsSync(this.tempPath || '')) {
      const probe = await this.withRetries(() => this.openFresh(signal), signal);
      firstResponse = probe.response; firstController = probe.controller;
    }
    if (signal.aborted) throw this.outerSignal.reason || new Error('Aborted');

    // Zero-byte file
    if (job.totalBytes === 0) {
      try { await firstResponse?.body?.cancel(); } catch {}
      firstController?.unlink?.();
      await fsp.writeFile(this.tempPath, Buffer.alloc(0));
      job.segments = [];
      return;
    }

    if (!this.fh) this.fh = await fsp.open(this.tempPath, 'r+');
    job.status = 'downloading';
    job.startedAt = job.startedAt || new Date().toISOString();
    this.onChange('structure');

    // Kick off workers. The first one may consume the probe's open body.
    if (firstResponse) {
      const seg = job.segments.find((s) => !isDone(s) && s.start + s.received === 0) || null;
      if (seg) {
        seg.busy = true;
        this.startWorker(seg, { response: firstResponse, controller: firstController });
      } else {
        try { await firstResponse.body?.cancel(); } catch {}
        firstController?.unlink?.();
      }
    }
    this.spawnWorkers();

    while (this.workers.size) await Promise.allSettled([...this.workers]);
    this.inner.unlink();

    if (this.outerSignal.aborted) throw this.outerSignal.reason || new Error('Aborted');
    if (this.fatal) throw this.fatal;

    // Unknown-size stream finishes when the server closes the body.
    const unfinished = job.segments.filter((s) => !isDone(s));
    if (unfinished.length) throw this.lastError || new TransferError('The download stopped before the file was complete. Resume to continue.', 'INCOMPLETE');
    const written = job.segments.reduce((sum, s) => sum + s.received, 0);
    if (job.totalBytes != null && written !== job.totalBytes) throw new TransferError('Downloaded size does not match the server size.', 'INCOMPLETE');
    await this.fh.sync().catch(() => {});
    await this.fh.close();
    this.fh = null;
  }

  async withRetries(fn, signal) {
    const max = Math.max(0, Number(this.prefs.maxRetries ?? 8));
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (error) {
        if (signal.aborted) throw this.outerSignal.reason || error;
        if (!isRetryable(error) || attempt >= max) {
          if (error.code === 'HTTP_FATAL' && [403, 404, 410].includes(error.status) && this.job.finalUrl && !this.useOriginalUrl && this.job.finalUrl !== this.job.url) {
            this.useOriginalUrl = true; continue;
          }
          throw error;
        }
        this.job.note = `${error.message} Retrying (${attempt + 1}/${max})…`;
        this.onChange('progress');
        await sleep(backoff(attempt, error.retryAfter), signal);
      }
    }
  }

  /** Probe a brand-new download. Leaves the response body open for segment #0. */
  async openFresh(signal) {
    const job = this.job;
    const wantRanges = !job.forceSingle;
    const { response, controller } = await this.request(wantRanges ? { Range: 'bytes=0-' } : {}, signal);
    try {
      let total = null;
      let resumable = false;
      if (response.status === 206) {
        const cr = parseContentRange(response.headers.get('content-range'));
        if (!cr || cr.start !== 0) throw new TransferError('The server returned an invalid byte range.', 'SEGMENT_UNSUPPORTED');
        total = cr.total;
        resumable = true;
      } else if (response.status === 416) {
        // Usually an empty file. Re-request without a range to confirm.
        try { await response.body?.cancel(); } catch {}
        controller.unlink();
        job.forceSingle = true;
        return this.openFresh(signal);
      } else if (response.ok) {
        const length = response.headers.get('content-length');
        total = length != null && /^\d+$/.test(length) ? Number(length) : null;
        resumable = false;
        if (/bytes/i.test(response.headers.get('accept-ranges') || '') && total != null && !wantRanges) resumable = true;
      } else {
        throw httpError(response);
      }

      job.finalUrl = response.url || job.url;
      job.totalBytes = total;
      job.resumable = resumable;
      job.mimeType = response.headers.get('content-type') || job.mimeType || '';
      job.etag = response.headers.get('etag') || null;
      job.lastModified = response.headers.get('last-modified') || null;
      job.serverName = response.headers.get('server') || '';
      job.serverFilename = filenameFromHeaders(job.finalUrl, response.headers);
      job.segmented = Boolean(resumable && total != null && total >= MIN_SPLIT * 2 && this.targetConnections > 1 && !job.forceSingle);

      if (!job.destination) job.destination = await this.resolveTarget(job);
      await fsp.mkdir(path.dirname(job.destination), { recursive: true });
      await this.ensureDiskSpace(total);

      this.fh = await fsp.open(this.tempPath, 'w+');
      if (total) await this.fh.truncate(total).catch(() => {});
      job.segments = [{ start: 0, end: total != null ? total - 1 : null, received: 0 }];
      job.downloadedBytes = 0;
      job.progress = 0;
      job.note = null;
      this.onChange('structure');
      return { response, controller };
    } catch (error) {
      try { await response.body?.cancel(); } catch {}
      controller.unlink();
      throw error;
    }
  }

  /** Re-check the server before continuing a partially downloaded file. */
  async validateResume(signal) {
    const job = this.job;
    if (!job.resumable) {
      // Server never supported ranges: we have to start over.
      await this.resetProgress();
      return null;
    }
    const result = await this.withRetries(async () => {
      const { response, controller } = await this.request({ Range: 'bytes=0-0' }, signal);
      try { await response.body?.cancel(); } catch {}
      controller.unlink();
      if (response.status === 206) {
        const cr = parseContentRange(response.headers.get('content-range'));
        const etag = response.headers.get('etag');
        const sizeChanged = cr?.total != null && job.totalBytes != null && cr.total !== job.totalBytes;
        const etagChanged = job.etag && etag && etag.replace(/^W\//, '') !== job.etag.replace(/^W\//, '');
        if (sizeChanged || etagChanged) return 'changed';
        if (response.url) job.finalUrl = response.url;
        return 'ok';
      }
      if (response.ok) return 'no-ranges';
      throw httpError(response);
    }, signal);
    if (result === 'ok') {
      await this.ensureDiskSpace(job.segments.reduce((sum, s) => sum + Math.max(0, remaining(s) === Infinity ? 0 : remaining(s)), 0));
      job.downloadedBytes = job.segments.reduce((sum, s) => sum + s.received, 0);
      job.segmented = Boolean(job.totalBytes != null && job.totalBytes >= MIN_SPLIT * 2 && this.targetConnections > 1 && !job.forceSingle);
      return null;
    }
    if (result === 'changed') job.note = 'The file changed on the server, so the download restarted.';
    else job.note = 'The server no longer supports resuming; the download restarted.';
    await this.resetProgress();
    return null;
  }

  async ensureDiskSpace(bytesNeeded) {
    if (!bytesNeeded || typeof fsp.statfs !== 'function') return;
    try {
      const stats = await fsp.statfs(path.dirname(this.job.destination));
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(free) && free < bytesNeeded + 16 * 1024 * 1024) {
        throw new TransferError(`Not enough disk space. Needs ${formatSize(bytesNeeded)}, only ${formatSize(free)} free.`, 'DISK_FULL');
      }
    } catch (error) { if (error.code === 'DISK_FULL') throw error; }
  }

  /* -------------------------------------------------------------- workers */

  spawnWorkers() {
    const job = this.job;
    if (!this.inner || this.inner.signal.aborted) return;
    const target = job.segmented ? this.targetConnections : 1;
    while (this.liveWorkers < target) {
      const seg = this.claim();
      if (!seg) break;
      this.startWorker(seg, null);
    }
  }

  startWorker(seg, opened) {
    this.liveWorkers += 1;
    const promise = this.worker(seg, opened).finally(() => {
      this.liveWorkers -= 1;
      this.workers.delete(promise);
    });
    this.workers.add(promise);
  }

  /** Atomically (sync) claims an idle segment or splits the busiest one. */
  claim() {
    const job = this.job;
    const segs = job.segments;
    const free = segs.find((s) => !s.busy && !isDone(s));
    if (free) { free.busy = true; return free; }
    if (!job.segmented) return null;
    let best = null; let bestRemaining = 0;
    for (const s of segs) {
      if (!s.busy || s.end == null) continue;
      const rem = remaining(s);
      if (rem > bestRemaining) { best = s; bestRemaining = rem; }
    }
    if (!best || bestRemaining < MIN_SPLIT * 2) return null;
    const position = best.start + best.received;
    const mid = position + Math.floor(bestRemaining / 2);
    const fresh = { start: mid, end: best.end, received: 0, busy: true };
    best.end = mid - 1;
    segs.splice(segs.indexOf(best) + 1, 0, fresh);
    this.onChange('structure');
    return fresh;
  }

  compactSegments() {
    const segs = this.job.segments;
    for (let i = 0; i < segs.length - 1; i++) {
      const a = segs[i]; const b = segs[i + 1];
      if (!a.busy && !b.busy && isDone(a) && isDone(b) && a.end + 1 === b.start) {
        a.end = b.end; a.received = a.end - a.start + 1;
        segs.splice(i + 1, 1); i -= 1;
      }
    }
  }

  async worker(seg, opened) {
    let current = seg;
    let pending = opened;
    let failures = 0;
    const signal = this.inner.signal;
    while (current && !signal.aborted) {
      const before = current.received;
      try {
        await this.fetchSegment(current, pending, signal);
        pending = null;
        current.busy = false;
        failures = 0;
        this.compactSegments();
        this.onChange('progress');
      } catch (error) {
        pending = null;
        current.busy = false;
        if (signal.aborted) return;
        if (['SEGMENT_UNSUPPORTED', 'FILE_CHANGED', 'DISK_FULL', 'DISK'].includes(error.code)) {
          this.fatal = this.fatal || error;
          this.inner.abort(error);
          return;
        }
        if (current.received > before) failures = 0;
        this.lastError = error;
        if (error.code === 'HTTP_FATAL' && [403, 404, 410].includes(error.status) && this.job.finalUrl && !this.useOriginalUrl && this.job.finalUrl !== this.job.url) {
          this.useOriginalUrl = true;
        } else if (!isRetryable(error) || failures >= Math.max(0, Number(this.prefs.maxRetries ?? 8))) {
          // This connection gives up; others may still finish the file.
          if (this.liveWorkers <= 1) { this.fatal = this.fatal || error; }
          return;
        } else {
          failures += 1;
          this.job.note = `${error.message} Reconnecting…`;
          this.onChange('progress');
          try { await sleep(backoff(failures - 1, error.retryAfter), signal); } catch { return; }
        }
      }
      if (this.liveWorkers > (this.job.segmented ? this.targetConnections : 1)) return;
      current = this.claim();
    }
  }

  async fetchSegment(seg, opened, signal) {
    const job = this.job;
    if (isDone(seg)) return;
    if (!job.resumable && seg.received > 0) {
      // Cannot continue mid-file without range support: rewind this (single) segment.
      job.downloadedBytes -= seg.received;
      seg.received = 0;
    }
    let response; let controller;
    if (opened) ({ response, controller } = opened);
    else {
      const position = seg.start + seg.received;
      const extra = {};
      if (job.resumable) {
        extra.Range = seg.end != null ? `bytes=${position}-${seg.end}` : `bytes=${position}-`;
        if (job.etag && !/^W\//i.test(job.etag)) extra['If-Range'] = job.etag;
        else if (job.lastModified) extra['If-Range'] = job.lastModified;
      }
      ({ response, controller } = await this.request(extra, signal));
      try {
        if (extra.Range) {
          if (response.status === 206) {
            const cr = parseContentRange(response.headers.get('content-range'));
            if (!cr || cr.start !== position) throw new TransferError('The server returned a different byte range than requested.', 'SEGMENT_UNSUPPORTED');
            if (cr.total != null && job.totalBytes != null && cr.total !== job.totalBytes) throw new TransferError('The file size changed on the server.', 'FILE_CHANGED');
          } else if (response.ok) {
            // Server ignored Range / If-Range mismatch → full body.
            if (position === 0 && (seg.end == null || seg.end === (job.totalBytes ?? 0) - 1)) { /* whole file, fine */ }
            else if (extra['If-Range']) throw new TransferError('The file changed on the server.', 'FILE_CHANGED');
            else throw new TransferError('The server does not support parallel ranges.', 'SEGMENT_UNSUPPORTED');
          } else if (response.status === 416 && isDone(seg)) {
            return;
          } else throw httpError(response);
        } else if (!response.ok) throw httpError(response);
      } catch (error) {
        try { await response.body?.cancel(); } catch {}
        controller.unlink();
        throw error;
      }
    }
    await this.pump(seg, response, controller, signal);
  }

  async pump(seg, response, controller, signal) {
    const job = this.job;
    const stallMs = Math.max(10, Number(this.prefs.stallTimeoutSec) || 45) * 1000;
    let stallTimer = null;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(new TransferError('The connection stalled.', 'STALL')), stallMs);
    };
    armStall();
    let endedEarly = false;
    try {
      if (!response.body) throw new TransferError('The server returned an empty response.', 'NETWORK');
      for await (const chunk of response.body) {
        armStall();
        if (signal.aborted) break;
        await this.globalBucket.take(chunk.length, signal);
        await this.jobBucket.take(chunk.length, signal);
        const position = seg.start + seg.received;
        const room = seg.end == null ? chunk.length : Math.min(chunk.length, seg.end - position + 1);
        if (room <= 0) { endedEarly = true; break; }
        seg.received += room;
        seg.inflight = (seg.inflight || 0) + room;
        job.downloadedBytes += room;
        try {
          await this.fh.write(chunk, 0, room, position);
        } catch (error) {
          seg.received -= room;
          job.downloadedBytes -= room;
          throw new TransferError(error.code === 'ENOSPC' ? 'The disk is full.' : `Could not write to disk: ${error.message}`, error.code === 'ENOSPC' ? 'DISK_FULL' : 'DISK');
        } finally {
          seg.inflight -= room;
        }
        if (seg.end != null && seg.start + seg.received > seg.end) { endedEarly = true; break; }
      }
    } catch (error) {
      if (signal.aborted) throw this.outerSignal.reason || error;
      if (error instanceof TransferError) throw error;
      const reason = controller.signal.reason;
      if (reason instanceof TransferError) throw reason;
      throw new TransferError(friendlyNetworkError(error), 'NETWORK', { cause: error });
    } finally {
      clearTimeout(stallTimer);
      controller.unlink();
      if (endedEarly) { try { controller.abort(); } catch {} }
    }
    if (signal.aborted) throw this.outerSignal.reason || new Error('Aborted');
    if (seg.end == null) {
      // Unknown length: the stream end *is* the file end.
      seg.end = seg.start + seg.received - 1;
      job.totalBytes = seg.start + seg.received;
      if (seg.received === 0) { seg.end = -1; }
      return;
    }
    if (!isDone(seg)) throw new TransferError('The server closed the connection early.', 'NETWORK');
  }

  /* ---------------------------------------------------------------- speed */

  startSpeedTimer() {
    const job = this.job;
    let lastBytes = job.downloadedBytes || 0;
    let lastAt = Date.now();
    let ema = 0;
    this.speedTimer = setInterval(() => {
      const now = Date.now();
      const bytes = job.downloadedBytes || 0;
      const instant = Math.max(0, (bytes - lastBytes) / Math.max(0.05, (now - lastAt) / 1000));
      ema = ema ? ema * 0.55 + instant * 0.45 : instant;
      lastBytes = bytes; lastAt = now;
      job.speed = Math.round(ema);
      job.progress = job.totalBytes ? Math.min(100, (bytes / job.totalBytes) * 100) : null;
      job.eta = job.totalBytes && ema > 1 ? Math.round((job.totalBytes - bytes) / ema) : null;
      job.activeConnections = this.liveWorkers;
      this.history.push(Math.round(instant));
      if (this.history.length > 120) this.history.shift();
    }, 500);
    this.speedTimer.unref?.();
  }

  stopSpeedTimer() {
    clearInterval(this.speedTimer);
    this.speedTimer = null;
    this.job.speed = 0;
    this.job.eta = null;
    this.job.activeConnections = 0;
  }
}

function isRetryable(error) {
  return ['NETWORK', 'TIMEOUT', 'STALL', 'HTTP_RETRY', 'INCOMPLETE'].includes(error?.code);
}

function backoff(attempt, retryAfter) {
  if (retryAfter != null) return Math.min(120000, Math.max(500, retryAfter));
  return Math.min(30000, 800 * 2 ** attempt) + Math.floor(Math.random() * 400);
}

function friendlyNetworkError(error) {
  const code = error?.cause?.code || error?.code || '';
  const map = {
    ENOTFOUND: 'Server not found. Check the address or your internet connection.',
    EAI_AGAIN: 'DNS lookup failed. Check your internet connection.',
    ECONNREFUSED: 'The server refused the connection.',
    ECONNRESET: 'The connection was reset by the server.',
    ETIMEDOUT: 'The connection timed out.',
    UND_ERR_CONNECT_TIMEOUT: 'The connection timed out.',
    UND_ERR_SOCKET: 'The connection was interrupted.',
    CERT_HAS_EXPIRED: 'The server’s security certificate has expired.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The server uses an untrusted (self-signed) certificate.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The server’s security certificate could not be verified.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'The server’s certificate does not match its address.',
  };
  return map[code] || (error?.message && error.message !== 'fetch failed' && error.message !== 'terminated' ? error.message : 'The network connection was interrupted.');
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}

module.exports = { Transfer, TransferError, MIN_SPLIT, isDone };
