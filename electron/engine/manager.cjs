'use strict';
/**
 * Raijin Download Manager — queue, persistence and scheduling.
 * Developer: Jessie Albert Regualos (Yotsuchi)
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Transfer } = require('./transfer.cjs');
const { TokenBucket } = require('./throttle.cjs');
const {
  CATEGORY_LABELS, safeFilename, filenameFromUrl, categoryFor, validateUrl, sanitizeHeaders, extractUrls,
} = require('./util.cjs');

const STORE_VERSION = 2;
const ACTIVE = new Set(['connecting', 'downloading', 'finishing']);
const HASH_ALGOS = new Set(['md5', 'sha1', 'sha256', 'sha512']);

const DEFAULT_PREFS = Object.freeze({
  downloadDir: '',
  categoryFolders: true,
  theme: 'dark',
  accent: 'amber',
  density: 'comfortable',
  maxConcurrent: 3,
  defaultConnections: 8,
  speedLimitKBps: 0,
  maxRetries: 8,
  timeoutSec: 30,
  stallTimeoutSec: 45,
  userAgent: '',
  duplicateAction: 'ask',
  notifications: true,
  completionSound: true,
  resumeOnLaunch: true,
  launchAtStartup: false,
  startMinimized: false,
  closeToTray: true,
  preventSleep: true,
  clipboardMonitor: true,
  browserIntegration: true,
  bridgePort: 52817,
  autoStartCaptured: false,
  captureExtensions: '7z zip rar tar gz bz2 xz iso img exe msi msix apk dmg pkg deb rpm mp4 mkv avi mov wmv webm flv m4v mp3 flac wav aac ogg m4a pdf epub docx xlsx pptx torrent bin',
  showDetails: true,
  whenDone: 'nothing',
  scheduler: { enabled: false, startTime: '02:00', stopTime: '', days: [0, 1, 2, 3, 4, 5, 6] },
});

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function serializeJob(job) {
  const { history, ...rest } = job;
  return {
    ...rest,
    speed: 0, eta: null, activeConnections: 0,
    segments: (job.segments || []).map((s) => ({ start: s.start, end: s.end, received: Math.max(0, s.received - (s.inflight || 0)) })),
  };
}

function publicJob(job) {
  return {
    ...job,
    segments: (job.segments || []).map((s) => ({ start: s.start, end: s.end, received: s.received, busy: Boolean(s.busy) })),
  };
}

class DownloadManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.userDataDir   where downloads.json lives
   * @param {string} o.defaultDownloadDir
   * @param {Function} [o.fetchImpl]
   * @param {Function} [o.trashItem] async (path) => void; used when deleting files
   */
  constructor({ userDataDir, defaultDownloadDir, fetchImpl, trashItem } = {}) {
    super();
    this.storePath = path.join(userDataDir, 'raijin-downloads.json');
    this.defaultDownloadDir = defaultDownloadDir;
    this.fetchImpl = fetchImpl;
    this.trashItem = trashItem;
    this.jobs = [];
    this.prefs = structuredClone(DEFAULT_PREFS);
    this.stats = { totalBytes: 0, totalFiles: 0, since: new Date().toISOString() };
    this.transfers = new Map();   // id -> { transfer, controller, reason }
    this.reserved = new Set();
    this.globalBucket = new TokenBucket(0);
    this.saveTimer = null;
    this.saveChain = Promise.resolve();
    this.stateTimer = null;
    this.tickTimer = null;
    this.schedulerTimer = null;
    this.speedHistory = [];
    this.hadWork = false;
    this.schedulerKeys = { start: '', stop: '' };
    this.initialized = false;
  }

  /* ------------------------------------------------------------ lifecycle */

  async init() {
    if (this.initialized) return this.snapshot();
    await fsp.mkdir(path.dirname(this.storePath), { recursive: true });
    const saved = await this.readStore();
    if (saved) {
      this.prefs = this.mergePrefs(DEFAULT_PREFS, saved.preferences || {});
      if (saved.stats) this.stats = { ...this.stats, ...saved.stats };
      this.jobs = Array.isArray(saved.jobs) ? saved.jobs.filter((j) => j && typeof j.id === 'string' && typeof j.url === 'string') : [];
    }
    if (!this.prefs.downloadDir) this.prefs.downloadDir = this.defaultDownloadDir;
    try { await fsp.mkdir(this.prefs.downloadDir, { recursive: true }); }
    catch { this.prefs.downloadDir = this.defaultDownloadDir; await fsp.mkdir(this.prefs.downloadDir, { recursive: true }); }

    let order = 0;
    for (const job of this.jobs) {
      job.order = Number.isFinite(job.order) ? job.order : order;
      order = Math.max(order, job.order + 1);
      job.speed = 0; job.eta = null; job.activeConnections = 0;
      job.segments = Array.isArray(job.segments) ? job.segments.map((s) => ({ start: s.start, end: s.end, received: s.received })) : [];
      if (ACTIVE.has(job.status) || (job.status === 'paused' && job.interrupted)) {
        delete job.interrupted;
        job.status = this.prefs.resumeOnLaunch ? 'queued' : 'paused';
        job.note = this.prefs.resumeOnLaunch ? null : 'Paused because Raijin was closed.';
      }
      if (job.destination && job.status !== 'completed') this.reserved.add(job.destination.toLowerCase());
      if (job.destination && job.status === 'completed') this.reserved.add(job.destination.toLowerCase());
    }
    this.globalBucket.setRate(this.prefs.speedLimitKBps * 1024);
    this.initialized = true;
    this.startTimers();
    await this.persistNow();
    this.emitState(true);
    setTimeout(() => this.schedule(), 400).unref?.();
    return this.snapshot();
  }

  async readStore() {
    for (const file of [this.storePath, `${this.storePath}.bak`]) {
      try {
        const data = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (data && typeof data === 'object') return data;
      } catch {}
    }
    return null;
  }

  mergePrefs(base, patch) {
    const merged = { ...structuredClone(base), ...patch };
    merged.scheduler = { ...base.scheduler, ...(patch.scheduler || {}) };
    return merged;
  }

  async shutdown() {
    clearInterval(this.tickTimer); clearInterval(this.schedulerTimer); clearTimeout(this.stateTimer);
    for (const [id, entry] of this.transfers) {
      const job = this.getJob(id);
      entry.reason = 'shutdown';
      if (job) { job.status = 'paused'; job.interrupted = true; job.note = null; }
      entry.controller.abort(new Error('Application closing'));
    }
    await Promise.allSettled([...this.transfers.values()].map((e) => e.done));
    await this.persistNow();
  }

  startTimers() {
    this.tickTimer = setInterval(() => this.tick(), 500);
    this.tickTimer.unref?.();
    this.schedulerTimer = setInterval(() => this.checkScheduler(), 15000);
    this.schedulerTimer.unref?.();
  }

  /* ------------------------------------------------------------- snapshot */

  snapshot() {
    return {
      jobs: this.jobs.map(publicJob),
      preferences: structuredClone(this.prefs),
      stats: { ...this.stats },
      summary: this.summary(),
    };
  }

  summary() {
    let active = 0; let queued = 0; let speed = 0; let remainingBytes = 0; let downloaded = 0; let total = 0;
    for (const job of this.jobs) {
      if (ACTIVE.has(job.status)) {
        active++; speed += job.speed || 0;
        if (job.totalBytes) { remainingBytes += Math.max(0, job.totalBytes - (job.downloadedBytes || 0)); downloaded += job.downloadedBytes || 0; total += job.totalBytes; }
      }
      if (job.status === 'queued') queued++;
    }
    return { active, queued, speed, eta: speed > 0 ? Math.round(remainingBytes / speed) : null, progress: total ? downloaded / total : null };
  }

  emitState(immediate = false) {
    if (immediate) { clearTimeout(this.stateTimer); this.stateTimer = null; this.emit('state', this.snapshot()); return; }
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => { this.stateTimer = null; this.emit('state', this.snapshot()); }, 60);
    this.stateTimer.unref?.();
  }

  changed() { this.emitState(); this.scheduleSave(); }

  tick() {
    const active = this.jobs.filter((j) => ACTIVE.has(j.status));
    const summary = this.summary();
    this.speedHistory.push(summary.speed);
    if (this.speedHistory.length > 120) this.speedHistory.shift();
    if (!active.length && this.speedHistory.every((v) => v === 0) && !this._wasTicking) return;
    this._wasTicking = active.length > 0;
    this.emit('tick', {
      summary,
      history: this.speedHistory.slice(),
      jobs: active.map((job) => ({
        id: job.id, status: job.status, downloadedBytes: job.downloadedBytes, totalBytes: job.totalBytes,
        speed: job.speed, eta: job.eta, progress: job.progress, activeConnections: job.activeConnections, note: job.note,
        segments: publicJob(job).segments,
        history: this.transfers.get(job.id)?.transfer.history.slice(-120) || [],
      })),
    });
    if (active.length) this.scheduleSave(3000);
  }

  /* ----------------------------------------------------------- persistence */

  scheduleSave(delay = 400) {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persistNow(); }, delay);
    this.saveTimer.unref?.();
  }

  persistNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const payload = JSON.stringify({
      app: 'Raijin Download Manager', version: STORE_VERSION, savedAt: new Date().toISOString(),
      preferences: this.prefs, stats: this.stats, jobs: this.jobs.map(serializeJob),
    });
    this.saveChain = this.saveChain.then(async () => {
      const temp = `${this.storePath}.${process.pid}.tmp`;
      await fsp.writeFile(temp, payload, 'utf8');
      if (fs.existsSync(this.storePath)) await fsp.copyFile(this.storePath, `${this.storePath}.bak`).catch(() => {});
      await renameWithRetry(temp, this.storePath);
    }).catch((error) => console.error('[raijin] Could not save state:', error.message));
    return this.saveChain;
  }

  /* ----------------------------------------------------------- preferences */

  async setPreferences(patch = {}) {
    const p = { ...this.prefs };
    const bool = (k) => { if (typeof patch[k] === 'boolean') p[k] = patch[k]; };
    ['categoryFolders', 'notifications', 'completionSound', 'resumeOnLaunch', 'launchAtStartup', 'startMinimized', 'closeToTray',
      'preventSleep', 'clipboardMonitor', 'browserIntegration', 'autoStartCaptured', 'showDetails'].forEach(bool);
    if (['system', 'light', 'dark'].includes(patch.theme)) p.theme = patch.theme;
    if (['amber', 'violet', 'cyan', 'rose', 'lime'].includes(patch.accent)) p.accent = patch.accent;
    if (['comfortable', 'compact'].includes(patch.density)) p.density = patch.density;
    if (['ask', 'rename', 'skip'].includes(patch.duplicateAction)) p.duplicateAction = patch.duplicateAction;
    if (['nothing', 'quit', 'sleep', 'shutdown'].includes(patch.whenDone)) p.whenDone = patch.whenDone;
    if (patch.maxConcurrent != null) p.maxConcurrent = clampInt(patch.maxConcurrent, 1, 16, p.maxConcurrent);
    if (patch.defaultConnections != null) p.defaultConnections = clampInt(patch.defaultConnections, 1, 32, p.defaultConnections);
    if (patch.speedLimitKBps != null) p.speedLimitKBps = clampInt(patch.speedLimitKBps, 0, 10 * 1024 * 1024, p.speedLimitKBps);
    if (patch.maxRetries != null) p.maxRetries = clampInt(patch.maxRetries, 0, 100, p.maxRetries);
    if (patch.timeoutSec != null) p.timeoutSec = clampInt(patch.timeoutSec, 5, 300, p.timeoutSec);
    if (patch.stallTimeoutSec != null) p.stallTimeoutSec = clampInt(patch.stallTimeoutSec, 10, 600, p.stallTimeoutSec);
    if (patch.bridgePort != null) p.bridgePort = clampInt(patch.bridgePort, 1024, 65535, p.bridgePort);
    if (typeof patch.userAgent === 'string') p.userAgent = patch.userAgent.replace(/[\r\n]/g, ' ').trim().slice(0, 512);
    if (typeof patch.captureExtensions === 'string') p.captureExtensions = patch.captureExtensions.toLowerCase().replace(/[^a-z0-9\s,]/g, ' ').split(/[\s,]+/).filter(Boolean).join(' ');
    if (typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) {
      const dir = path.resolve(patch.downloadDir.trim());
      await fsp.mkdir(dir, { recursive: true });
      p.downloadDir = dir;
    }
    if (patch.scheduler && typeof patch.scheduler === 'object') {
      const s = { ...p.scheduler };
      if (typeof patch.scheduler.enabled === 'boolean') s.enabled = patch.scheduler.enabled;
      if (typeof patch.scheduler.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.scheduler.startTime)) s.startTime = patch.scheduler.startTime;
      if (typeof patch.scheduler.stopTime === 'string' && (/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.scheduler.stopTime) || patch.scheduler.stopTime === '')) s.stopTime = patch.scheduler.stopTime;
      if (Array.isArray(patch.scheduler.days)) s.days = [...new Set(patch.scheduler.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
      p.scheduler = s;
    }
    this.prefs = p;
    this.globalBucket.setRate(p.speedLimitKBps * 1024);
    this.changed();
    this.schedule();
    return this.snapshot();
  }

  /* -------------------------------------------------------------- jobs */

  getJob(id) { return this.jobs.find((job) => job.id === id); }
  nextOrder() { return this.jobs.reduce((max, j) => Math.max(max, j.order ?? 0), -1) + 1; }
  findByUrl(url) { return this.jobs.find((job) => job.url === url || job.finalUrl === url); }

  buildJob(url, options = {}) {
    const parsed = validateUrl(url);
    let auth = null;
    if (parsed.username || parsed.password) {
      auth = { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };
      parsed.username = ''; parsed.password = '';
    }
    if (options.auth?.username) auth = { username: String(options.auth.username), password: String(options.auth.password || '') };
    const custom = typeof options.filename === 'string' && options.filename.trim() ? safeFilename(options.filename.trim()) : null;
    const filename = custom || safeFilename(filenameFromUrl(parsed.toString()) || 'download');
    const checksum = options.checksum?.expected
      ? { algo: HASH_ALGOS.has(String(options.checksum.algo).toLowerCase()) ? String(options.checksum.algo).toLowerCase() : 'sha256', expected: String(options.checksum.expected).trim().toLowerCase(), actual: null, verified: null }
      : null;
    return {
      id: crypto.randomUUID(),
      url: parsed.toString(),
      finalUrl: null,
      referrer: typeof options.referrer === 'string' ? options.referrer.slice(0, 2048) : '',
      cookies: typeof options.cookies === 'string' ? options.cookies.replace(/[\r\n]/g, '').slice(0, 16384) : '',
      userAgent: typeof options.userAgent === 'string' ? options.userAgent.replace(/[\r\n]/g, '').slice(0, 512) : '',
      headers: sanitizeHeaders(options.headers),
      auth,
      filename,
      customFilename: Boolean(custom),
      folder: typeof options.folder === 'string' && options.folder.trim() ? path.resolve(options.folder.trim()) : null,
      destination: null,
      category: categoryFor(filename),
      status: options.start === false ? 'scheduled' : 'queued',
      source: ['manual', 'batch', 'browser', 'clipboard', 'cli', 'import'].includes(options.source) ? options.source : 'manual',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      totalBytes: Number.isFinite(Number(options.sizeHint)) && Number(options.sizeHint) > 0 ? Number(options.sizeHint) : null,
      downloadedBytes: 0,
      progress: 0,
      speed: 0,
      eta: null,
      connections: clampInt(options.connections, 1, 32, this.prefs.defaultConnections),
      activeConnections: 0,
      speedLimitKBps: clampInt(options.speedLimitKBps, 0, 10 * 1024 * 1024, 0),
      segments: [],
      segmented: false,
      resumable: null,
      mimeType: '',
      etag: null,
      lastModified: null,
      serverName: '',
      checksum,
      hashes: {},
      priority: options.priority === 'high' ? 1 : options.priority === 'low' ? -1 : 0,
      order: this.nextOrder(),
      note: null,
      error: null,
      description: typeof options.description === 'string' ? options.description.slice(0, 500) : '',
    };
  }

  /**
   * Adds a single download.
   * Throws { code: 'DUPLICATE', existingId } when the URL is already listed and the caller
   * did not pass allowDuplicate (UI asks the user in that case).
   */
  async add(url, options = {}) {
    const job = this.buildJob(url, options);
    const existing = this.findByUrl(job.url);
    if (existing && !options.allowDuplicate) {
      if (this.prefs.duplicateAction === 'skip' && options.source !== 'manual') return publicJob(existing);
      if (this.prefs.duplicateAction === 'ask' || options.source === 'manual') {
        throw Object.assign(new Error('This link is already in your download list.'), { code: 'DUPLICATE', existingId: existing.id, existingStatus: existing.status, filename: existing.filename });
      }
    }
    this.jobs.unshift(job);
    this.hadWork = this.hadWork || job.status === 'queued';
    this.changed();
    await this.persistNow();
    this.schedule();
    return publicJob(job);
  }

  /** Adds many URLs at once (batch / browser "download all links"). */
  async addMany(input, options = {}) {
    const urls = Array.isArray(input) ? input.flatMap((u) => extractUrls(typeof u === 'string' ? u : u?.url)) : extractUrls(input);
    const added = []; const skipped = []; const invalid = [];
    const perItem = new Map(Array.isArray(input) ? input.filter((u) => u && typeof u === 'object').map((u) => [u.url, u]) : []);
    for (const url of urls.slice(0, 5000)) {
      try {
        const extra = perItem.get(url) || {};
        const job = this.buildJob(url, { ...options, ...extra, filename: extra.filename || undefined, source: options.source || 'batch' });
        if (this.findByUrl(job.url) && !options.allowDuplicate) { skipped.push(url); continue; }
        this.jobs.unshift(job);
        added.push(job.id);
      } catch { invalid.push(url); }
    }
    if (added.length) {
      this.hadWork = this.hadWork || options.start !== false;
      this.changed();
      await this.persistNow();
      this.schedule();
    }
    return { added: added.length, skipped: skipped.length, invalid: invalid.length, ids: added };
  }

  /** Quick metadata look-up used by the Add dialog before a download starts. */
  async probe(url, options = {}) {
    const job = this.buildJob(url, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const transfer = new Transfer({ job, getPrefs: () => this.prefs, globalBucket: new TokenBucket(0), fetchImpl: this.fetchImpl, resolveTarget: async () => null });
    try {
      let response;
      for (const range of ['bytes=0-0', null]) {
        response = await (this.fetchImpl || fetch)(transfer.requestUrl(), {
          headers: transfer.headers(range ? { Range: range } : {}), redirect: 'follow', signal: controller.signal,
        });
        if (response.status !== 416) break;
        try { await response.body?.cancel(); } catch {}
      }
      try { await response.body?.cancel(); } catch {}
      if (!response.ok) return { ok: false, status: response.status, error: `Server returned HTTP ${response.status}.` };
      const { parseContentRange, filenameFromHeaders } = require('./util.cjs');
      const cr = parseContentRange(response.headers.get('content-range'));
      const length = response.headers.get('content-length');
      const totalBytes = response.status === 206 ? cr?.total ?? null : (length && /^\d+$/.test(length) ? Number(length) : null);
      const filename = filenameFromHeaders(response.url || job.url, response.headers);
      return {
        ok: true, finalUrl: response.url || job.url, filename, totalBytes,
        resumable: response.status === 206, mimeType: response.headers.get('content-type') || '',
        category: categoryFor(filename), server: response.headers.get('server') || '',
      };
    } catch (error) {
      return { ok: false, error: controller.signal.aborted ? 'The server took too long to respond.' : (error?.cause?.code === 'ENOTFOUND' ? 'Server not found.' : 'Could not reach the server.') };
    } finally { clearTimeout(timer); }
  }

  /* ------------------------------------------------------------- actions */

  ids(input) { return (Array.isArray(input) ? input : [input]).map(String); }

  async pause(input) {
    for (const id of this.ids(input)) {
      const job = this.getJob(id);
      if (!job) continue;
      if (this.transfers.has(id)) {
        const entry = this.transfers.get(id);
        entry.reason = 'pause';
        job.status = 'paused';
        entry.controller.abort(new Error('Paused'));
      } else if (['queued', 'scheduled'].includes(job.status)) job.status = 'paused';
      job.speed = 0; job.error = null;
    }
    this.changed();
    return this.snapshot();
  }

  async resume(input) {
    for (const id of this.ids(input)) {
      const job = this.getJob(id);
      if (!job || !['paused', 'failed', 'scheduled'].includes(job.status)) continue;
      job.status = 'queued'; job.error = null; job.note = null; delete job.interrupted;
      this.hadWork = true;
    }
    this.changed(); this.schedule();
    return this.snapshot();
  }

  async restart(input) {
    for (const id of this.ids(input)) {
      const job = this.getJob(id);
      if (!job) continue;
      if (this.transfers.has(id)) {
        const entry = this.transfers.get(id);
        entry.reason = 'restart';
        entry.controller.abort(new Error('Restart'));
        await entry.done.catch(() => {});
      }
      await this.removeTemp(job);
      if (job.status === 'completed') { this.reserved.delete(String(job.destination).toLowerCase()); job.destination = null; }
      Object.assign(job, { status: 'queued', segments: [], downloadedBytes: 0, progress: 0, error: null, note: null, completedAt: null, forceSingle: false, finalUrl: null });
      if (job.checksum) job.checksum = { ...job.checksum, actual: null, verified: null };
      this.hadWork = true;
    }
    this.changed(); this.schedule();
    return this.snapshot();
  }

  async remove(input, { deleteFiles = false } = {}) {
    const ids = new Set(this.ids(input));
    for (const id of ids) {
      const job = this.getJob(id);
      if (!job) continue;
      if (this.transfers.has(id)) {
        const entry = this.transfers.get(id);
        entry.reason = 'remove';
        entry.controller.abort(new Error('Removed'));
        await entry.done.catch(() => {});
      }
      await this.removeTemp(job);
      if (deleteFiles && job.status === 'completed' && job.destination && fs.existsSync(job.destination)) {
        try { if (this.trashItem) await this.trashItem(job.destination); else await fsp.rm(job.destination, { force: true }); }
        catch (error) { console.error('[raijin] Could not delete file:', error.message); }
      }
      if (job.destination) this.reserved.delete(job.destination.toLowerCase());
    }
    this.jobs = this.jobs.filter((job) => !ids.has(job.id));
    this.changed();
    return this.snapshot();
  }

  async removeTemp(job) {
    if (!job?.destination) return;
    await fsp.rm(`${job.destination}.raijin`, { force: true }).catch(() => {});
  }

  async clear(kind) {
    const statuses = kind === 'failed' ? ['failed'] : ['completed'];
    const doomed = this.jobs.filter((j) => statuses.includes(j.status)).map((j) => j.id);
    return this.remove(doomed);
  }

  async startQueue() {
    for (const job of this.jobs) {
      if (['scheduled', 'paused', 'failed'].includes(job.status)) { job.status = 'queued'; job.error = null; job.note = null; this.hadWork = true; }
    }
    this.changed(); this.schedule();
    return this.snapshot();
  }

  async pauseAll() {
    const ids = this.jobs.filter((j) => ACTIVE.has(j.status) || j.status === 'queued').map((j) => j.id);
    return this.pause(ids);
  }

  async move(input, direction) {
    const ids = new Set(this.ids(input));
    const sorted = [...this.jobs].sort((a, b) => a.order - b.order);
    if (direction === 'top' || direction === 'bottom') {
      const moving = sorted.filter((j) => ids.has(j.id));
      const rest = sorted.filter((j) => !ids.has(j.id));
      const next = direction === 'top' ? [...moving, ...rest] : [...rest, ...moving];
      next.forEach((job, index) => { job.order = index; });
    } else {
      const step = direction === 'up' ? -1 : 1;
      const list = direction === 'up' ? sorted : [...sorted].reverse();
      for (const job of list) {
        if (!ids.has(job.id)) continue;
        const index = sorted.indexOf(job);
        const neighbour = sorted[index + step];
        if (!neighbour || ids.has(neighbour.id)) continue;
        [job.order, neighbour.order] = [neighbour.order, job.order];
        sorted[index] = neighbour; sorted[index + step] = job;
      }
    }
    this.changed(); this.schedule();
    return this.snapshot();
  }

  async setPriority(input, priority) {
    const value = priority === 'high' ? 1 : priority === 'low' ? -1 : 0;
    for (const id of this.ids(input)) { const job = this.getJob(id); if (job) job.priority = value; }
    this.changed(); this.schedule();
    return this.snapshot();
  }

  /** Edit download properties (refresh address, rename, connections, limits, headers…). */
  async update(id, patch = {}) {
    const job = this.getJob(String(id));
    if (!job) throw new Error('Download not found.');
    const running = this.transfers.get(job.id);
    if (patch.connections != null) {
      job.connections = clampInt(patch.connections, 1, 32, job.connections);
      running?.transfer.setConnections(job.connections);
    }
    if (patch.speedLimitKBps != null) {
      job.speedLimitKBps = clampInt(patch.speedLimitKBps, 0, 10 * 1024 * 1024, 0);
      running?.transfer.setSpeedLimit(job.speedLimitKBps);
    }
    if (typeof patch.description === 'string') job.description = patch.description.slice(0, 500);
    const needsIdle = ['url', 'referrer', 'cookies', 'userAgent', 'headers', 'auth', 'filename', 'checksum'].some((k) => patch[k] !== undefined);
    if (needsIdle && running) throw new Error('Pause the download before changing its address, name or request settings.');
    if (typeof patch.url === 'string' && patch.url.trim() && patch.url.trim() !== job.url) {
      const parsed = validateUrl(patch.url);
      job.url = parsed.toString(); job.finalUrl = null; job.error = null;
      job.note = 'Address refreshed — the download will continue where it stopped.';
      if (job.status === 'failed') job.status = 'paused';
    }
    if (typeof patch.referrer === 'string') job.referrer = patch.referrer.slice(0, 2048);
    if (typeof patch.cookies === 'string') job.cookies = patch.cookies.replace(/[\r\n]/g, '').slice(0, 16384);
    if (typeof patch.userAgent === 'string') job.userAgent = patch.userAgent.replace(/[\r\n]/g, '').slice(0, 512);
    if (patch.headers !== undefined) job.headers = sanitizeHeaders(patch.headers);
    if (patch.auth !== undefined) job.auth = patch.auth?.username ? { username: String(patch.auth.username), password: String(patch.auth.password || '') } : null;
    if (patch.checksum !== undefined) {
      job.checksum = patch.checksum?.expected ? { algo: HASH_ALGOS.has(patch.checksum.algo) ? patch.checksum.algo : 'sha256', expected: String(patch.checksum.expected).trim().toLowerCase(), actual: null, verified: null } : null;
    }
    if (typeof patch.filename === 'string' && patch.filename.trim()) {
      const name = safeFilename(patch.filename.trim());
      if (name !== job.filename) await this.rename(job, name);
    }
    this.changed();
    return publicJob(job);
  }

  async rename(job, name) {
    if (job.status === 'completed' && job.destination && fs.existsSync(job.destination)) {
      const target = path.join(path.dirname(job.destination), name);
      if (fs.existsSync(target)) throw new Error('A file with that name already exists in the folder.');
      await fsp.rename(job.destination, target);
      this.reserved.delete(job.destination.toLowerCase());
      this.reserved.add(target.toLowerCase());
      job.destination = target;
    } else if (job.destination) {
      const target = await this.uniqueDestination(path.dirname(job.destination), name, job.destination);
      if (fs.existsSync(`${job.destination}.raijin`)) await fsp.rename(`${job.destination}.raijin`, `${target}.raijin`);
      this.reserved.delete(job.destination.toLowerCase());
      job.destination = target;
      name = path.basename(target);
    }
    job.filename = name;
    job.customFilename = true;
    job.category = categoryFor(name);
  }

  /* ------------------------------------------------------------ scheduling */

  schedule() {
    if (!this.initialized) return;
    const limit = this.prefs.maxConcurrent;
    const waiting = this.jobs
      .filter((job) => job.status === 'queued' && !this.transfers.has(job.id))
      .sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
    while (this.transfers.size < limit && waiting.length) this.start(waiting.shift());
    this.checkIdle();
  }

  start(job) {
    const controller = new AbortController();
    const transfer = new Transfer({
      job,
      getPrefs: () => this.prefs,
      globalBucket: this.globalBucket,
      fetchImpl: this.fetchImpl,
      resolveTarget: (j) => this.resolveTarget(j),
      onChange: (kind) => { if (kind === 'structure') this.changed(); },
    });
    const entry = { transfer, controller, reason: null, done: null };
    this.transfers.set(job.id, entry);
    job.status = 'connecting'; job.error = null; job.note = null; job.speed = 0;
    this.hadWork = true;
    this.changed();
    entry.done = this.execute(job, entry);
    this.emit('activity');
  }

  async resolveTarget(job) {
    if (!job.customFilename && job.serverFilename) job.filename = job.serverFilename;
    job.category = categoryFor(job.filename);
    const folder = job.folder || (this.prefs.categoryFolders ? path.join(this.prefs.downloadDir, CATEGORY_LABELS[job.category] || 'Other') : this.prefs.downloadDir);
    const destination = await this.uniqueDestination(folder, job.filename);
    job.filename = path.basename(destination);
    return destination;
  }

  async uniqueDestination(folder, requestedName, ignore = null) {
    await fsp.mkdir(folder, { recursive: true });
    const name = safeFilename(requestedName);
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let index = 0; index < 10000; index++) {
      const candidate = path.join(folder, index ? `${stem} (${index})${ext}` : name);
      const key = candidate.toLowerCase();
      if (ignore && key === ignore.toLowerCase()) return candidate;
      if (this.reserved.has(key) || fs.existsSync(candidate) || fs.existsSync(`${candidate}.raijin`)) continue;
      this.reserved.add(key);
      return candidate;
    }
    throw new Error('Could not find a free file name.');
  }

  async execute(job, entry) {
    try {
      await entry.transfer.run(entry.controller.signal);
      if (entry.controller.signal.aborted) throw new Error('Aborted');
      await this.finalize(job);
    } catch (error) {
      if (entry.controller.signal.aborted) {
        if (entry.reason === 'pause' || entry.reason === 'shutdown') job.status = 'paused';
      } else {
        job.status = 'failed';
        job.error = String(error?.message || 'Download failed.').slice(0, 400);
        job.note = null;
        this.emit('failed', publicJob(job));
      }
    } finally {
      this.transfers.delete(job.id);
      job.speed = 0; job.eta = null; job.activeConnections = 0;
      for (const s of job.segments || []) { delete s.busy; delete s.inflight; }
      if (job.status === 'completed' || job.status === 'failed') this.persistNow();
      this.changed();
      if (entry.reason !== 'shutdown') this.schedule();
    }
  }

  async finalize(job) {
    job.status = 'finishing';
    this.changed();
    const temp = `${job.destination}.raijin`;
    let target = job.destination;
    if (fs.existsSync(target)) {
      this.reserved.delete(target.toLowerCase());
      target = await this.uniqueDestination(path.dirname(target), path.basename(target));
    }
    await renameWithRetry(temp, target);
    if (target !== job.destination) { this.reserved.delete(job.destination.toLowerCase()); job.destination = target; job.filename = path.basename(target); }
    job.segments = job.totalBytes ? [{ start: 0, end: job.totalBytes - 1, received: job.totalBytes }] : [];
    job.downloadedBytes = job.totalBytes ?? job.downloadedBytes;
    job.progress = 100;
    if (job.checksum?.expected) {
      const actual = await hashFile(target, job.checksum.algo);
      job.checksum.actual = actual;
      job.checksum.verified = actual === job.checksum.expected;
      job.hashes = { ...(job.hashes || {}), [job.checksum.algo]: actual };
      if (!job.checksum.verified) {
        job.status = 'failed';
        job.completedAt = new Date().toISOString();
        job.error = `Checksum mismatch (${job.checksum.algo.toUpperCase()}). The file was saved but may be corrupted or tampered with.`;
        this.emit('failed', publicJob(job));
        return;
      }
    }
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.error = null; job.note = null;
    this.stats.totalBytes += job.downloadedBytes || 0;
    this.stats.totalFiles += 1;
    this.emit('completed', publicJob(job));
  }

  async computeHash(id, algo = 'sha256') {
    const job = this.getJob(String(id));
    if (!job || job.status !== 'completed' || !job.destination || !fs.existsSync(job.destination)) throw new Error('The downloaded file could not be found.');
    const name = HASH_ALGOS.has(algo) ? algo : 'sha256';
    const value = await hashFile(job.destination, name);
    job.hashes = { ...(job.hashes || {}), [name]: value };
    this.changed();
    return value;
  }

  checkIdle() {
    if (!this.hadWork) return;
    const busy = this.jobs.some((j) => ACTIVE.has(j.status) || j.status === 'queued') || this.transfers.size > 0;
    if (busy) return;
    this.hadWork = false;
    const completed = this.jobs.filter((j) => j.status === 'completed').length;
    this.emit('idle', { whenDone: this.prefs.whenDone, completed });
  }

  checkScheduler(now = new Date()) {
    const s = this.prefs.scheduler;
    if (!s?.enabled || !s.days?.includes(now.getDay())) return;
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const key = `${now.toDateString()} ${hhmm}`;
    if (s.startTime === hhmm && this.schedulerKeys.start !== key) {
      this.schedulerKeys.start = key;
      this.startQueue();
      this.emit('scheduler', { action: 'start' });
    }
    if (s.stopTime && s.stopTime === hhmm && this.schedulerKeys.stop !== key) {
      this.schedulerKeys.stop = key;
      this.pauseAll();
      this.emit('scheduler', { action: 'stop' });
    }
  }

  /* -------------------------------------------------------- import/export */

  exportList(format = 'json') {
    if (format === 'txt') return this.jobs.map((j) => j.url).join('\r\n');
    return JSON.stringify({ app: 'Raijin Download Manager', exportedAt: new Date().toISOString(), downloads: this.jobs.map((j) => ({ url: j.url, filename: j.filename, referrer: j.referrer, status: j.status, description: j.description })) }, null, 2);
  }

  async importList(text) {
    let items = null;
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data?.downloads;
      if (Array.isArray(list)) items = list.filter((d) => d && typeof d.url === 'string').map((d) => ({ url: d.url, filename: d.filename, referrer: d.referrer }));
    } catch {}
    return this.addMany(items || String(text || ''), { start: false, source: 'import' });
  }
}

async function renameWithRetry(from, to, attempts = 12) {
  for (let i = 0; ; i++) {
    try { await fsp.rename(from, to); return; }
    catch (error) {
      // Windows: antivirus or indexer can briefly lock a freshly written file.
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise((r) => setTimeout(r, 150 + i * 100));
    }
  }
}

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { DownloadManager, DEFAULT_PREFS, hashFile };
