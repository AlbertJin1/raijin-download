'use strict';
/**
 * Local browser-integration bridge for the Raijin browser extension.
 *
 * Security model:
 *  - Listens on 127.0.0.1 only.
 *  - Host header must be 127.0.0.1/localhost on our port (blocks DNS rebinding).
 *  - Every request must carry `X-Raijin-Client`. Web pages cannot add custom headers to a
 *    cross-origin request without a CORS pre-flight, and pre-flights are always refused.
 *  - If an Origin header is present it must be a browser-extension origin.
 */
const http = require('node:http');
const { EventEmitter } = require('node:events');

const MAX_BODY = 2 * 1024 * 1024;
const EXTENSION_ORIGIN = /^(chrome|moz|edge|safari-web|ms-browser)-extension:\/\/[\w.-]+$/i;

class BrowserBridge extends EventEmitter {
  constructor({ version, getInfo, onDownload, onBatch }) {
    super();
    this.version = version;
    this.getInfo = getInfo;
    this.onDownload = onDownload;
    this.onBatch = onBatch;
    this.server = null;
    this.port = null;
    this.status = 'stopped';
    this.error = null;
    this.lastContact = null;
  }

  async start(port) {
    if (this.server && this.port === port) return this.state();
    await this.stop();
    this.port = port;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      this.reply(res, 500, { ok: false, error: error.message || 'Internal error' });
    }));
    this.server.keepAliveTimeout = 2000;
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 10000;
    await new Promise((resolve) => {
      this.server.once('error', (error) => {
        this.status = 'error';
        this.error = error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another port in Settings → Integration.` : error.message;
        this.server = null;
        resolve();
      });
      this.server.listen(port, '127.0.0.1', () => { this.status = 'running'; this.error = null; resolve(); });
    });
    this.emit('status', this.state());
    return this.state();
  }

  async stop() {
    if (!this.server) { this.status = 'stopped'; return this.state(); }
    const server = this.server;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    this.status = 'stopped';
    this.emit('status', this.state());
    return this.state();
  }

  state() {
    return { status: this.status, port: this.port, error: this.error, lastContact: this.lastContact };
  }

  reply(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }

  async readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }

  async handle(req, res) {
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.reply(res, 403, { ok: false, error: 'Forbidden host' });
    if (req.method === 'OPTIONS') return this.reply(res, 403, { ok: false, error: 'Pre-flight requests are not accepted' });
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !EXTENSION_ORIGIN.test(origin)) return this.reply(res, 403, { ok: false, error: 'Forbidden origin' });
    if (!req.headers['x-raijin-client']) return this.reply(res, 403, { ok: false, error: 'Missing client header' });

    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const firstContact = !this.lastContact || Date.now() - Date.parse(this.lastContact) > 60000;
    this.lastContact = new Date().toISOString();
    if (firstContact) this.emit('status', this.state());

    if (req.method === 'GET' && url.pathname === '/v1/ping') {
      return this.reply(res, 200, { ok: true, app: 'Raijin Download Manager', version: this.version, ...(this.getInfo?.() || {}) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/download') {
      if (!/application\/json/i.test(req.headers['content-type'] || '')) return this.reply(res, 415, { ok: false, error: 'JSON required' });
      const body = await this.readJson(req);
      if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) return this.reply(res, 400, { ok: false, error: 'A http(s) url is required' });
      const result = await this.onDownload(clean(body));
      return this.reply(res, 200, { ok: true, ...result });
    }
    if (req.method === 'POST' && url.pathname === '/v1/batch') {
      if (!/application\/json/i.test(req.headers['content-type'] || '')) return this.reply(res, 415, { ok: false, error: 'JSON required' });
      const body = await this.readJson(req);
      const items = Array.isArray(body.items) ? body.items.filter((i) => i && typeof i.url === 'string' && /^https?:\/\//i.test(i.url)).slice(0, 5000) : [];
      if (!items.length) return this.reply(res, 400, { ok: false, error: 'No links supplied' });
      const result = await this.onBatch({ ...clean(body), items: items.map((i) => ({ url: i.url, filename: str(i.filename, 255), text: str(i.text, 200), cookies: str(i.cookies, 16384) })) });
      return this.reply(res, 200, { ok: true, ...result });
    }
    return this.reply(res, 404, { ok: false, error: 'Not found' });
  }
}

function str(value, max) { return typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').slice(0, max) : ''; }

function clean(body) {
  return {
    url: str(body.url, 8192),
    filename: str(body.filename, 255),
    referrer: str(body.referrer, 4096),
    cookies: str(body.cookies, 16384),
    userAgent: str(body.userAgent, 512),
    mime: str(body.mime, 200),
    pageTitle: str(body.pageTitle, 300),
    fileSize: Number.isFinite(Number(body.fileSize)) && Number(body.fileSize) > 0 ? Number(body.fileSize) : null,
    browser: str(body.browser, 60),
  };
}

module.exports = { BrowserBridge };
