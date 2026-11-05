// Renderer-side mirror of the engine's URL helpers (kept dependency-free for previews).
const GROUP = /\[(\d+)-(\d+)(?::(\d+))?\]|\[([a-zA-Z])-([a-zA-Z])\]/;

export function expandPattern(input, limit = 5000) {
  const text = String(input || '');
  const match = text.match(GROUP);
  if (!match) return text.trim() ? [text.trim()] : [];
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const tails = GROUP.test(after) ? expandPattern(after, limit) : [after];
  const values = [];
  if (match[1] != null) {
    const from = Number(match[1]); const to = Number(match[2]);
    const step = Math.max(1, Number(match[3]) || 1);
    const width = match[1].length > 1 && match[1].startsWith('0') ? match[1].length : 0;
    const dir = from <= to ? 1 : -1;
    for (let n = from; dir > 0 ? n <= to : n >= to; n += step * dir) {
      values.push(width ? String(n).padStart(width, '0') : String(n));
      if (values.length >= limit) break;
    }
  } else {
    const from = match[4].charCodeAt(0); const to = match[5].charCodeAt(0);
    const dir = from <= to ? 1 : -1;
    for (let c = from; dir > 0 ? c <= to : c >= to; c += dir) values.push(String.fromCharCode(c));
  }
  const out = [];
  for (const v of values) for (const t of tails) { out.push((before + v + t).trim()); if (out.length >= limit) return out; }
  return out;
}

export function extractUrls(text) {
  const found = []; const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const candidates = GROUP.test(line) && /^https?:\/\//i.test(line) ? expandPattern(line) : (line.match(/https?:\/\/[^\s"'<>]+/gi) || []);
    for (const c of candidates) {
      const cleaned = c.replace(/[),.;]+$/, '');
      try {
        const u = new URL(cleaned);
        if (!['http:', 'https:'].includes(u.protocol)) continue;
        const key = u.toString();
        if (!seen.has(key)) { seen.add(key); found.push(key); }
      } catch {}
    }
  }
  return found;
}

export function nameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || new URL(url).hostname;
  } catch { return url; }
}

export const CATEGORY_EXT = {
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts'],
  music: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff', 'alac'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'epub', 'odt', 'ods', 'odp', 'md', 'mobi'],
  images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'ico', 'psd', 'raw'],
  compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'zst', 'cab', 'lz', 'lzma'],
  programs: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'iso', 'img', 'bat', 'jar'],
};

export function categoryOfName(name) {
  const i = String(name).lastIndexOf('.');
  const ext = i > 0 ? String(name).slice(i + 1).toLowerCase().split(/[?#]/)[0] : '';
  for (const [cat, list] of Object.entries(CATEGORY_EXT)) if (list.includes(ext)) return cat;
  return 'other';
}
