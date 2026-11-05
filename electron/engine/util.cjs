'use strict';
/**
 * Raijin Download Manager — shared engine helpers.
 * Developer: Jessie Albert Regualos (Yotsuchi)
 */
const path = require('node:path');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const CATEGORY_EXTENSIONS = Object.freeze({
  video: ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp', '.ts', '.m2ts'],
  music: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus', '.aiff', '.alac'],
  documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.csv', '.epub', '.odt', '.ods', '.odp', '.md', '.mobi'],
  images: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff', '.heic', '.avif', '.ico', '.psd', '.raw'],
  compressed: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.zst', '.cab', '.lz', '.lzma'],
  programs: ['.exe', '.msi', '.msix', '.msixbundle', '.appx', '.appxbundle', '.apk', '.dmg', '.pkg', '.deb', '.rpm', '.iso', '.img', '.bat', '.jar'],
});

const CATEGORY_LABELS = Object.freeze({
  video: 'Video', music: 'Music', documents: 'Documents', images: 'Images',
  compressed: 'Compressed', programs: 'Programs', other: 'Other',
});

const MIME_EXTENSIONS = Object.freeze({
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
  'application/x-7z-compressed': '.7z', 'application/vnd.rar': '.rar', 'application/x-rar-compressed': '.rar',
  'application/gzip': '.gz', 'application/x-msdownload': '.exe', 'application/x-msi': '.msi',
  'application/vnd.android.package-archive': '.apk', 'application/x-iso9660-image': '.iso',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/flac': '.flac', 'audio/mp4': '.m4a',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json',
});

function safeFilename(value) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  let result = cleaned || 'download';
  if (result.length > 180) {
    const ext = path.extname(result).slice(0, 16);
    result = result.slice(0, 180 - ext.length) + ext;
  }
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
  return reserved.test(result) ? `_${result}` : result;
}

function decodeRfc5987(value) {
  const match = String(value).match(/^([\w-]+)'[^']*'(.*)$/);
  const charset = match ? match[1].toLowerCase() : 'utf-8';
  const encoded = match ? match[2] : value;
  try {
    if (charset === 'utf-8' || charset === 'utf8') return decodeURIComponent(encoded);
    return Buffer.from(unescape(encoded), 'latin1').toString('latin1');
  } catch { return encoded; }
}

function filenameFromDisposition(disposition) {
  if (!disposition) return null;
  const star = disposition.match(/filename\*\s*=\s*("?)([^";]+)\1/i);
  if (star) {
    const decoded = decodeRfc5987(star[2].trim());
    if (decoded) return decoded;
  }
  const plain = disposition.match(/filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]+))/i);
  if (plain) {
    const raw = (plain[1] != null ? plain[1].replace(/\\(.)/g, '$1') : plain[2] || '').trim();
    if (!raw) return null;
    // Many servers send UTF-8 bytes in a latin1 header; recover them when possible.
    try {
      const bytes = Buffer.from(raw, 'latin1');
      const utf = bytes.toString('utf8');
      if (!utf.includes('�') && utf !== raw) return utf;
    } catch {}
    return raw;
  }
  return null;
}

function filenameFromUrl(value) {
  try {
    const url = new URL(value);
    let name = decodeURIComponent(path.posix.basename(url.pathname));
    if (!name || name === '/') name = '';
    return name || null;
  } catch { return null; }
}

function headerGetter(headers) {
  if (!headers) return () => null;
  if (typeof headers.get === 'function') return (name) => headers.get(name);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower[name.toLowerCase()] ?? null;
}

function filenameFromHeaders(responseUrl, headers) {
  const get = headerGetter(headers);
  const fromDisposition = filenameFromDisposition(get('content-disposition'));
  let name = fromDisposition || filenameFromUrl(responseUrl) || 'download';
  if (!path.extname(name)) {
    const mime = String(get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (MIME_EXTENSIONS[mime]) name += MIME_EXTENSIONS[mime];
  }
  return safeFilename(name);
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) };
}

function categoryFor(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  for (const [category, list] of Object.entries(CATEGORY_EXTENSIONS)) if (list.includes(ext)) return category;
  return 'other';
}

/**
 * Expands batch patterns such as
 *   https://site/img[001-120].jpg   -> zero-padded numeric range
 *   https://site/part[1-9:2].bin    -> numeric range with a step
 *   https://site/disk-[a-f].iso     -> alphabetic range
 * Multiple bracket groups produce the cartesian product (capped).
 */
function expandPattern(input, limit = 5000) {
  const text = String(input || '');
  if (!/\[(\d+)-(\d+)(?::(\d+))?\]|\[([a-zA-Z])-([a-zA-Z])\]/.test(text)) return text.trim() ? [text.trim()] : [];
  const group = /\[(\d+)-(\d+)(?::(\d+))?\]|\[([a-zA-Z])-([a-zA-Z])\]/;
  const match = text.match(group);
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const tails = /\[(\d+)-(\d+)(?::(\d+))?\]|\[([a-zA-Z])-([a-zA-Z])\]/.test(after) ? expandPattern(after, limit) : [after];
  const values = [];
  if (match[1] != null) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    const step = Math.max(1, Number(match[3]) || 1);
    const width = match[1].length > 1 && match[1].startsWith('0') ? match[1].length : 0;
    const dir = from <= to ? 1 : -1;
    for (let n = from; dir > 0 ? n <= to : n >= to; n += step * dir) {
      values.push(width ? String(n).padStart(width, '0') : String(n));
      if (values.length >= limit) break;
    }
  } else {
    const from = match[4].charCodeAt(0);
    const to = match[5].charCodeAt(0);
    const dir = from <= to ? 1 : -1;
    for (let c = from; dir > 0 ? c <= to : c >= to; c += dir) values.push(String.fromCharCode(c));
  }
  const out = [];
  for (const value of values) {
    for (const tail of tails) {
      out.push((before + value + tail).trim());
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Extracts every http(s) URL from free-form text (one per line, or embedded in prose). */
function extractUrls(text) {
  const found = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const candidates = /\[(\d+)-(\d+)(?::\d+)?\]|\[[a-zA-Z]-[a-zA-Z]\]/.test(line) && /^https?:\/\//i.test(line)
      ? expandPattern(line)
      : (line.match(/https?:\/\/[^\s"'<>]+/gi) || []);
    for (const candidate of candidates) {
      const cleaned = candidate.replace(/[),.;]+$/, '');
      try {
        const url = new URL(cleaned);
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        const key = url.toString();
        if (!seen.has(key)) { seen.add(key); found.push(key); }
      } catch {}
    }
  }
  return found;
}

/** Parses "Name: value" lines into a header object, dropping unsafe/hop-by-hop headers. */
function parseHeaderLines(text) {
  const blocked = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'range', 'if-range', 'accept-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-connection']);
  const headers = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) continue;
    if (blocked.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

function sanitizeHeaders(input) {
  if (!input || typeof input !== 'object') return {};
  if (typeof input === 'string') return parseHeaderLines(input);
  const lines = Object.entries(input).map(([k, v]) => `${k}: ${v}`).join('\n');
  return parseHeaderLines(lines);
}

function validateUrl(input) {
  let parsed;
  try { parsed = new URL(String(input || '').trim()); } catch { throw Object.assign(new Error('Enter a valid download URL.'), { code: 'INVALID_URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('Only HTTP and HTTPS links are supported.'), { code: 'INVALID_URL' });
  return parsed;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal.reason || new Error('Aborted')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

module.exports = {
  DEFAULT_USER_AGENT, CATEGORY_EXTENSIONS, CATEGORY_LABELS,
  safeFilename, filenameFromHeaders, filenameFromDisposition, filenameFromUrl, parseContentRange, categoryFor,
  expandPattern, extractUrls, parseHeaderLines, sanitizeHeaders, validateUrl, sleep, parseRetryAfter,
};
