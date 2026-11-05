'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

/** Every call resolves to the data, or rejects with an Error carrying `code` / `existingId`. */
const call = (channel) => async (...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result && result.ok) return result.data;
  const error = new Error(result?.error || 'Something went wrong.');
  error.code = result?.code || null;
  error.existingId = result?.existingId || null;
  error.filename = result?.filename || null;
  throw error;
};

contextBridge.exposeInMainWorld('raijin', Object.freeze({
  info: call('app:info'),
  rendererReady: call('app:renderer-ready'),
  getState: call('jobs:get'),
  add: call('jobs:add'),
  addMany: call('jobs:add-many'),
  probe: call('jobs:probe'),
  pause: call('jobs:pause'),
  resume: call('jobs:resume'),
  restart: call('jobs:restart'),
  remove: call('jobs:remove'),
  clear: call('jobs:clear'),
  startQueue: call('jobs:start-queue'),
  pauseAll: call('jobs:pause-all'),
  move: call('jobs:move'),
  setPriority: call('jobs:priority'),
  update: call('jobs:update'),
  hash: call('jobs:hash'),
  exportList: call('jobs:export'),
  importList: call('jobs:import'),
  setPreferences: call('prefs:set'),
  openFile: call('file:open'),
  showInFolder: call('file:show'),
  openFolder: call('folder:open'),
  chooseFolder: call('dialog:folder'),
  diskFree: call('disk:free'),
  readClipboard: call('clipboard:read'),
  writeClipboard: call('clipboard:write'),
  installExtension: call('extension:install'),
  bridgeStatus: call('bridge:status'),
  restartBridge: call('bridge:restart'),
  cancelWhenDone: call('when-done:cancel'),
  openExternal: call('app:open-external'),
  quit: call('app:quit'),
  minimize: call('window:minimize'),
  toggleMaximize: call('window:toggle-maximize'),
  isMaximized: call('window:is-maximized'),
  close: call('window:close'),
  onState: subscribe('rdm:state'),
  onTick: subscribe('rdm:tick'),
  onCompleted: subscribe('rdm:completed'),
  onFailed: subscribe('rdm:failed'),
  onCapture: subscribe('rdm:capture'),
  onToast: subscribe('rdm:toast'),
  onBridge: subscribe('rdm:bridge'),
  onWhenDone: subscribe('rdm:when-done'),
  onFocusJob: subscribe('rdm:focus-job'),
  onMaximized: subscribe('window:maximized'),
}));
