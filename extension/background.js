/* Raijin Download Manager — browser integration (Manifest V3 service worker)
 * Developer: Jessie Albert Regualos (Yotsuchi) */

const DEFAULTS = { enabled: true, port: 52817, minSizeKB: 0, skipHosts: '' };
const CLIENT = 'raijin-extension/2.0';
const BINARY_MIME = /^(application\/(octet-stream|zip|x-zip|x-7z|x-rar|vnd\.rar|x-msdownload|x-msi|x-iso9660|gzip|x-tar|pdf|vnd\.android|x-apple-diskimage|x-debian)|video\/|audio\/)/i;
let appInfo = null;
let appInfoAt = 0;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function api(path, body, timeout = 1500) {
  const { port } = await settings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Raijin-Client': CLIENT, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function ping(force = false) {
  if (!force && appInfo && Date.now() - appInfoAt < 15000) return appInfo;
  try {
    const info = await api('/v1/ping');
    appInfo = info?.ok ? info : null;
  } catch { appInfo = null; }
  appInfoAt = Date.now();
  await updateBadge();
  return appInfo;
}

async function updateBadge() {
  const { enabled } = await settings();
  const text = !enabled ? 'off' : appInfo ? '' : '!';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: !enabled ? '#6b7280' : '#ef4444' });
}

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

function extensionOf(value) {
  try {
    const clean = decodeURIComponent(String(value).split(/[?#]/)[0]);
    const base = clean.split(/[\\/]/).pop() || '';
    return base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  } catch { return ''; }
}

function hostMatches(url, list) {
  if (!list.trim()) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return list.split(/[\s,]+/).filter(Boolean).some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
  } catch { return false; }
}

async function sendDownload(payload) {
  const cookies = await cookieHeader(payload.url);
  return api('/v1/download', { ...payload, cookies, userAgent: navigator.userAgent, browser: navigator.userAgentData?.brands?.[0]?.brand || 'Chromium' }, 4000);
}

/* --------------------------------------------------- automatic capturing */

chrome.downloads.onCreated.addListener(async (item) => {
  try {
    const cfg = await settings();
    if (!cfg.enabled || item.byExtensionId === chrome.runtime.id) return;
    const url = item.finalUrl || item.url;
    if (!/^https?:\/\//i.test(url) || item.state !== 'in_progress') return;
    if (hostMatches(url, cfg.skipHosts) || hostMatches(item.referrer || '', cfg.skipHosts)) return;
    const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize > 0 ? item.fileSize : 0;
    if (cfg.minSizeKB > 0 && size > 0 && size < cfg.minSizeKB * 1024) return;

    const info = await ping(true);
    if (!info) return; // Raijin is not running: let the browser handle it.
    const types = new Set(String(info.captureExtensions || '').split(/\s+/).filter(Boolean));
    const ext = extensionOf(item.filename) || extensionOf(url);
    if (!(types.has(ext) || (!ext && BINARY_MIME.test(item.mime || '')))) return;

    try { await chrome.downloads.cancel(item.id); } catch { return; }
    try { await chrome.downloads.erase({ id: item.id }); } catch {}
    const filename = item.filename ? item.filename.split(/[\\/]/).pop() : '';
    await sendDownload({ url, filename, referrer: item.referrer || '', fileSize: size || null, mime: item.mime || '' });
  } catch (error) {
    console.warn('[Raijin] capture failed', error);
  }
});

/* --------------------------------------------------------- context menus */

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'raijin-link', title: 'Download link with Raijin', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'raijin-media', title: 'Download this media with Raijin', contexts: ['image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'raijin-selection', title: 'Download selected links with Raijin', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'raijin-all', title: 'Download all links with Raijin…', contexts: ['page'] });
  });
}

chrome.runtime.onInstalled.addListener(() => { createMenus(); ping(true); });
chrome.runtime.onStartup.addListener(() => { createMenus(); ping(true); });

function collectLinks(selectionOnly) {
  const out = [];
  const seen = new Set();
  const push = (url, text) => {
    try {
      const abs = new URL(url, location.href).toString();
      if (!/^https?:/i.test(abs) || seen.has(abs)) return;
      seen.add(abs); out.push({ url: abs, text: (text || '').trim().slice(0, 200) });
    } catch {}
  };
  if (selectionOnly) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return out;
    for (let i = 0; i < sel.rangeCount; i++) {
      const frag = sel.getRangeAt(i).cloneContents();
      frag.querySelectorAll('a[href]').forEach((a) => push(a.getAttribute('href'), a.textContent));
      const anchor = sel.getRangeAt(i).commonAncestorContainer;
      const parentLink = (anchor.nodeType === 1 ? anchor : anchor.parentElement)?.closest?.('a[href]');
      if (parentLink) push(parentLink.href, parentLink.textContent);
    }
    return out;
  }
  document.querySelectorAll('a[href]').forEach((a) => push(a.href, a.textContent || a.title));
  document.querySelectorAll('img[src], video[src], audio[src], source[src]').forEach((m) => push(m.src || m.getAttribute('src'), m.alt || m.title || ''));
  return out;
}

async function cookiesForItems(items) {
  const byOrigin = new Map();
  for (const item of items) {
    try {
      const origin = new URL(item.url).origin;
      if (!byOrigin.has(origin) && byOrigin.size < 40) byOrigin.set(origin, await cookieHeader(item.url));
    } catch {}
  }
  return items.map((item) => {
    try { return { ...item, cookies: byOrigin.get(new URL(item.url).origin) || '' }; } catch { return item; }
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const alive = await ping(true);
    if (!alive) {
      await chrome.action.setBadgeText({ text: '!' });
      return;
    }
    if (info.menuItemId === 'raijin-link' || info.menuItemId === 'raijin-media') {
      const url = info.menuItemId === 'raijin-link' ? info.linkUrl : info.srcUrl;
      if (!/^https?:\/\//i.test(url || '')) return;
      await sendDownload({ url, referrer: info.pageUrl || tab?.url || '', pageTitle: tab?.title || '' });
      return;
    }
    if (!tab?.id) return;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: info.frameId ? [info.frameId] : undefined },
      func: collectLinks,
      args: [info.menuItemId === 'raijin-selection'],
    });
    const items = (result?.result || []).slice(0, 5000);
    if (!items.length) return;
    const withCookies = await cookiesForItems(items);
    await api('/v1/batch', { items: withCookies, referrer: tab.url || '', pageTitle: tab.title || '', userAgent: navigator.userAgent }, 6000);
  } catch (error) {
    console.warn('[Raijin] menu action failed', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ping') { ping(true).then((info) => sendResponse({ info })); return true; }
  if (message?.type === 'settings-changed') { updateBadge(); ping(true); }
  return false;
});
