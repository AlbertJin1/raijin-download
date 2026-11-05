'use strict';
/**
 * Raijin Download Manager — Electron main process.
 * Developer: Jessie Albert Regualos (Yotsuchi)
 */
const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, Notification, nativeImage,
  clipboard, powerSaveBlocker, nativeTheme,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { DownloadManager } = require('./engine/manager.cjs');
const { BrowserBridge } = require('./bridge.cjs');
const { extractUrls } = require('./engine/util.cjs');

const APP_NAME = 'Raijin Download Manager';
const APP_ID = 'com.yotsuchi.raijin';
const DEVELOPER = { name: 'Jessie Albert Regualos', alias: 'Yotsuchi' };
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const startHidden = process.argv.includes('--hidden');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let manager = null;
let bridge = null;
let quitting = false;
let rendererReady = false;
const pendingCaptures = [];
let clipboardTimer = null;
let lastClipboard = '';
let powerBlockerId = null;
let whenDoneTimer = null;
let trayHintShown = false;

/* --------------------------------------------------------------- helpers */

function resource(...parts) {
  return app.isPackaged ? path.join(process.resourcesPath, ...parts) : path.join(__dirname, '..', ...parts);
}
const iconIco = () => resource(app.isPackaged ? 'icons' : 'public/icons', 'raijin.ico');
const iconPng = () => resource(app.isPackaged ? 'icons' : 'public/icons', 'raijin.png');

function appIcon() {
  const file = process.platform === 'win32' && fs.existsSync(iconIco()) ? iconIco() : iconPng();
  return nativeImage.createFromPath(file);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? (value >= 100 ? 0 : 1) : 0)} ${units[i]}`;
}

/* ---------------------------------------------------------------- window */

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: appIcon(),
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 580,
    show: false,
    frame: false,
    backgroundColor: '#0d0f14',
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!(startHidden || manager?.prefs.startMinimized) || !tray) mainWindow.show();
  });
  mainWindow.on('maximize', () => send('window:maximized', true));
  mainWindow.on('unmaximize', () => send('window:maximized', false));
  mainWindow.on('close', (event) => {
    if (quitting || !manager?.prefs.closeToTray || !tray) return;
    event.preventDefault();
    mainWindow.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'Raijin is still running', body: 'Downloads continue in the background. Right-click the tray icon to quit.', icon: appIcon(), silent: true }).show();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file:');
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on('did-start-loading', () => { rendererReady = false; });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

/* ------------------------------------------------------------------ tray */

function buildTrayMenu() {
  const limit = manager?.prefs.speedLimitKBps || 0;
  const speedItem = (label, value) => ({ label, type: 'radio', checked: limit === value, click: () => manager.setPreferences({ speedLimitKBps: value }) });
  return Menu.buildFromTemplate([
    { label: 'Open Raijin', click: showWindow },
    { label: 'Add link from clipboard', click: () => { showWindow(); captureFromClipboard(true); } },
    { type: 'separator' },
    { label: 'Start / resume all', click: () => manager.startQueue() },
    { label: 'Pause all', click: () => manager.pauseAll() },
    { type: 'separator' },
    {
      label: 'Speed limit',
      submenu: [speedItem('Unlimited', 0), speedItem('256 KB/s', 256), speedItem('1 MB/s', 1024), speedItem('5 MB/s', 5120), speedItem('20 MB/s', 20480)],
    },
    { type: 'separator' },
    { label: 'Quit Raijin', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  try {
    const image = appIcon().resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch (error) {
    console.error('[raijin] Tray unavailable:', error.message);
    tray = null;
  }
}

/* ------------------------------------------------------------- captures */

function deliverCapture(payload) {
  showWindow();
  mainWindow?.flashFrame?.(true);
  if (rendererReady) send('rdm:capture', payload);
  else pendingCaptures.push(payload);
}

async function handleCapturedDownload(info, source) {
  const options = {
    filename: info.filename || undefined,
    referrer: info.referrer || '',
    cookies: info.cookies || '',
    userAgent: info.userAgent || '',
    sizeHint: info.fileSize || null,
    source,
  };
  if (manager.prefs.autoStartCaptured) {
    try {
      const job = await manager.add(info.url, { ...options, source });
      notify('Download started', job.filename, { id: job.id });
      return { action: 'queued', id: job.id };
    } catch (error) {
      if (error.code !== 'DUPLICATE') throw error;
    }
  }
  deliverCapture({ mode: 'single', url: info.url, ...options, pageTitle: info.pageTitle || '' });
  return { action: 'prompted' };
}

function readClipboardText() {
  try { const value = clipboard.readText(); return typeof value === 'string' ? value : ''; } catch { return ''; }
}

function captureFromClipboard(force = false) {
  const text = readClipboardText().trim();
  const urls = extractUrls(text);
  if (!urls.length) {
    if (force) send('rdm:toast', { tone: 'info', message: 'The clipboard does not contain a download link.' });
    return;
  }
  if (urls.length > 1) deliverCapture({ mode: 'batch', items: urls.map((url) => ({ url })), source: 'clipboard' });
  else deliverCapture({ mode: 'single', url: urls[0], source: 'clipboard' });
}

function looksDownloadable(url) {
  const exts = new Set(String(manager.prefs.captureExtensions || '').split(/\s+/).filter(Boolean));
  try {
    const name = decodeURIComponent(new URL(url).pathname).toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return exts.has(ext);
  } catch { return false; }
}

function startClipboardMonitor() {
  stopClipboardMonitor();
  lastClipboard = readClipboardText();
  clipboardTimer = setInterval(() => {
    if (!manager?.prefs.clipboardMonitor) return;
    const text = readClipboardText();
    if (text === lastClipboard) return;
    lastClipboard = text;
    const trimmed = text.trim();
    if (!/^https?:\/\/\S+$/i.test(trimmed) || !looksDownloadable(trimmed) || manager.findByUrl(trimmed)) return;
    const visible = mainWindow?.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
    if (visible) send('rdm:capture', { mode: 'single', url: trimmed, source: 'clipboard', subtle: true });
    else if (Notification.isSupported()) {
      const n = new Notification({ title: 'Download link copied', body: `${trimmed.slice(0, 120)}\nClick to download with Raijin.`, icon: appIcon() });
      n.on('click', () => deliverCapture({ mode: 'single', url: trimmed, source: 'clipboard' }));
      n.show();
    }
  }, 1000);
  clipboardTimer.unref?.();
}

function stopClipboardMonitor() { clearInterval(clipboardTimer); clipboardTimer = null; }

/* ---------------------------------------------------------- integration */

async function syncBridge() {
  if (!bridge) return;
  if (manager.prefs.browserIntegration) await bridge.start(manager.prefs.bridgePort);
  else await bridge.stop();
  send('rdm:bridge', bridge.state());
}

function syncLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  if (!app.isPackaged) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try { app.setLoginItemSettings({ openAtLogin: Boolean(manager.prefs.launchAtStartup), path: exe, args: ['--hidden'] }); }
  catch (error) { console.error('[raijin] Could not update startup setting:', error.message); }
}

function syncPowerBlocker() {
  const active = manager.summary().active > 0 && manager.prefs.preventSleep;
  if (active && powerBlockerId == null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!active && powerBlockerId != null) { powerSaveBlocker.stop(powerBlockerId); powerBlockerId = null; }
}

function notify(title, body, { id, onClick } = {}) {
  if (!manager?.prefs.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: appIcon(), silent: true });
  n.on('click', () => {
    if (onClick) onClick();
    else { showWindow(); if (id) send('rdm:focus-job', id); }
  });
  n.show();
}

/* ------------------------------------------------------------ when done */

function runWhenDone(action) {
  if (action === 'quit') { quitting = true; app.quit(); return; }
  if (process.platform !== 'win32') { send('rdm:toast', { tone: 'info', message: 'Power actions are only available on Windows.' }); return; }
  if (action === 'shutdown') execFile('shutdown', ['/s', '/t', '0'], { windowsHide: true }, () => {});
  if (action === 'sleep') execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { windowsHide: true }, () => {});
}

function scheduleWhenDone(action) {
  clearTimeout(whenDoneTimer);
  const seconds = 30;
  showWindow();
  send('rdm:when-done', { action, seconds });
  whenDoneTimer = setTimeout(() => {
    whenDoneTimer = null;
    manager.setPreferences({ whenDone: 'nothing' }).finally(() => runWhenDone(action));
  }, seconds * 1000);
}

/* -------------------------------------------------------------- CLI args */

function urlsFromArgv(argv) {
  return argv.filter((a) => /^https?:\/\//i.test(a));
}

/* ------------------------------------------------------------------- IPC */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted request.');
    try { return { ok: true, data: await fn(...args) }; }
    catch (error) {
      return { ok: false, error: error?.message || 'Something went wrong.', code: error?.code || null, existingId: error?.existingId || null, filename: error?.filename || null };
    }
  });
}

function jobOr(id) {
  const job = manager.getJob(String(id));
  if (!job) throw new Error('Download not found.');
  return job;
}

function registerIpc() {
  handle('app:info', () => ({
    name: APP_NAME, version: app.getVersion(), developer: DEVELOPER, platform: process.platform,
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    userData: app.getPath('userData'), bridge: bridge?.state() || null, packaged: app.isPackaged,
    shouldUseDark: nativeTheme.shouldUseDarkColors,
  }));
  handle('app:renderer-ready', () => {
    rendererReady = true;
    const queued = pendingCaptures.splice(0);
    setTimeout(() => queued.forEach((c) => send('rdm:capture', c)), 150);
    return true;
  });
  handle('jobs:get', () => manager.snapshot());
  handle('jobs:add', (url, options) => manager.add(url, options || {}));
  handle('jobs:add-many', (input, options) => manager.addMany(input, options || {}));
  handle('jobs:probe', (url, options) => manager.probe(url, options || {}));
  handle('jobs:pause', (ids) => manager.pause(ids));
  handle('jobs:resume', (ids) => manager.resume(ids));
  handle('jobs:restart', (ids) => manager.restart(ids));
  handle('jobs:remove', (ids, options) => manager.remove(ids, options || {}));
  handle('jobs:clear', (kind) => manager.clear(kind));
  handle('jobs:start-queue', () => manager.startQueue());
  handle('jobs:pause-all', () => manager.pauseAll());
  handle('jobs:move', (ids, direction) => manager.move(ids, direction));
  handle('jobs:priority', (ids, priority) => manager.setPriority(ids, priority));
  handle('jobs:update', (id, patch) => manager.update(id, patch || {}));
  handle('jobs:hash', (id, algo) => manager.computeHash(id, algo));
  handle('jobs:export', async (format) => {
    const ext = format === 'txt' ? 'txt' : 'json';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export download list', defaultPath: path.join(app.getPath('documents'), `raijin-downloads.${ext}`),
      filters: [{ name: ext === 'txt' ? 'Text (URLs)' : 'Raijin list', extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, manager.exportList(ext), 'utf8');
    return result.filePath;
  });
  handle('jobs:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import download list', properties: ['openFile'],
      filters: [{ name: 'Lists', extensions: ['json', 'txt'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const stat = await fsp.stat(result.filePaths[0]);
    if (stat.size > 20 * 1024 * 1024) throw new Error('That file is too large to import.');
    return manager.importList(await fsp.readFile(result.filePaths[0], 'utf8'));
  });
  handle('prefs:set', async (patch) => {
    const before = { ...manager.prefs };
    const snapshot = await manager.setPreferences(patch || {});
    if (before.browserIntegration !== manager.prefs.browserIntegration || before.bridgePort !== manager.prefs.bridgePort) await syncBridge();
    if (before.launchAtStartup !== manager.prefs.launchAtStartup) syncLoginItem();
    if (before.speedLimitKBps !== manager.prefs.speedLimitKBps) tray?.setContextMenu(buildTrayMenu());
    if (before.theme !== manager.prefs.theme) nativeTheme.themeSource = manager.prefs.theme;
    syncPowerBlocker();
    return snapshot;
  });
  handle('file:open', async (id) => {
    const job = jobOr(id);
    if (job.status !== 'completed' || !job.destination || !fs.existsSync(job.destination)) throw new Error('The downloaded file could not be found. It may have been moved or deleted.');
    const error = await shell.openPath(job.destination);
    if (error) throw new Error(error);
    return true;
  });
  handle('file:show', (id) => {
    const job = jobOr(id);
    const target = job.destination && fs.existsSync(job.destination) ? job.destination : job.destination ? path.dirname(job.destination) : null;
    if (!target) throw new Error('This download does not have a file yet.');
    if (target === job.destination) shell.showItemInFolder(target); else shell.openPath(target);
    return true;
  });
  handle('folder:open', async (folder) => {
    const target = folder && typeof folder === 'string' ? path.resolve(folder) : manager.prefs.downloadDir;
    await fsp.mkdir(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
  handle('dialog:folder', async (current) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder', defaultPath: current || manager.prefs.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('disk:free', async () => {
    const dir = manager.prefs.downloadDir;
    if (typeof fsp.statfs !== 'function') return { free: null, path: dir };
    const stats = await fsp.statfs(dir);
    return { free: Number(stats.bavail) * Number(stats.bsize), path: dir };
  });
  handle('clipboard:read', () => readClipboardText());
  handle('clipboard:write', (text) => { clipboard.writeText(String(text || '')); return true; });
  handle('extension:install', async () => {
    const source = resource('extension');
    const target = path.join(app.getPath('userData'), 'browser-extension');
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.cp(source, target, { recursive: true });
    shell.openPath(target);
    return target;
  });
  handle('bridge:status', () => bridge.state());
  handle('bridge:restart', async () => { await bridge.stop(); await syncBridge(); return bridge.state(); });
  handle('when-done:cancel', async () => {
    clearTimeout(whenDoneTimer); whenDoneTimer = null;
    await manager.setPreferences({ whenDone: 'nothing' });
    return true;
  });
  handle('app:open-external', async (url) => {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') throw new Error('Only HTTPS links can be opened.');
    await shell.openExternal(parsed.toString());
    return true;
  });
  handle('app:quit', () => { quitting = true; app.quit(); return true; });
  handle('window:minimize', () => { mainWindow.minimize(); return true; });
  handle('window:toggle-maximize', () => { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); return mainWindow.isMaximized(); });
  handle('window:is-maximized', () => mainWindow.isMaximized());
  handle('window:close', () => { mainWindow.close(); return true; });
}

/* ----------------------------------------------------------------- start */

app.on('second-instance', (_event, argv) => {
  showWindow();
  for (const url of urlsFromArgv(argv)) deliverCapture({ mode: 'single', url, source: 'cli' });
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  manager = new DownloadManager({
    userDataDir: app.getPath('userData'),
    defaultDownloadDir: path.join(app.getPath('downloads'), 'Raijin'),
    trashItem: (file) => shell.trashItem(file),
  });
  await manager.init();
  nativeTheme.themeSource = manager.prefs.theme;

  manager.on('state', (snapshot) => { send('rdm:state', snapshot); syncPowerBlocker(); });
  manager.on('tick', (tick) => {
    send('rdm:tick', tick);
    const { summary } = tick;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (summary.active) mainWindow.setProgressBar(summary.progress != null ? summary.progress : 2, { mode: summary.progress != null ? 'normal' : 'indeterminate' });
      else mainWindow.setProgressBar(-1);
    }
    tray?.setToolTip(summary.active ? `${APP_NAME}\n${summary.active} active · ${formatBytes(summary.speed)}/s` : APP_NAME);
  });
  manager.on('completed', (job) => {
    send('rdm:completed', job);
    notify('Download complete', `${job.filename}\n${formatBytes(job.totalBytes ?? job.downloadedBytes)} · click to open`, {
      onClick: () => { if (job.destination && fs.existsSync(job.destination)) shell.showItemInFolder(job.destination); else showWindow(); },
    });
  });
  manager.on('failed', (job) => {
    send('rdm:failed', job);
    notify('Download failed', `${job.filename}\n${job.error || ''}`, { id: job.id });
  });
  manager.on('idle', ({ whenDone }) => {
    mainWindow?.setProgressBar(-1);
    syncPowerBlocker();
    if (whenDone && whenDone !== 'nothing') scheduleWhenDone(whenDone);
  });
  manager.on('scheduler', ({ action }) => notify(action === 'start' ? 'Scheduled queue started' : 'Scheduled queue stopped', action === 'start' ? 'Raijin started your download queue.' : 'Raijin paused active downloads.'));

  bridge = new BrowserBridge({
    version: app.getVersion(),
    getInfo: () => ({ autoStart: manager.prefs.autoStartCaptured, captureExtensions: manager.prefs.captureExtensions }),
    onDownload: (info) => handleCapturedDownload(info, 'browser'),
    onBatch: async (info) => {
      deliverCapture({ mode: 'batch', items: info.items, referrer: info.referrer, cookies: info.cookies, userAgent: info.userAgent, source: 'browser', pageTitle: info.pageTitle });
      return { action: 'prompted', count: info.items.length };
    },
  });
  bridge.on('status', (state) => send('rdm:bridge', state));

  registerIpc();
  createWindow();
  createTray();
  await syncBridge();
  syncLoginItem();
  startClipboardMonitor();

  for (const url of urlsFromArgv(process.argv)) deliverCapture({ mode: 'single', url, source: 'cli' });
  app.on('activate', showWindow);
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  stopClipboardMonitor();
  if (powerBlockerId != null) powerSaveBlocker.stop(powerBlockerId);
  Promise.allSettled([manager?.shutdown(), bridge?.stop()]).finally(() => {
    tray?.destroy();
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  if (!tray || quitting) app.quit();
});

process.on('uncaughtException', (error) => console.error('[raijin] Uncaught exception:', error));
process.on('unhandledRejection', (error) => console.error('[raijin] Unhandled rejection:', error));
