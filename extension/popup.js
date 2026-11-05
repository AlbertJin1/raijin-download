const DEFAULTS = { enabled: true, port: 52817, minSizeKB: 0, skipHosts: '' };
const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $('enabled').checked = cfg.enabled;
  $('minSizeKB').value = cfg.minSizeKB;
  $('skipHosts').value = cfg.skipHosts;
  $('port').value = cfg.port;
  refresh();
}

async function save() {
  await chrome.storage.local.set({
    enabled: $('enabled').checked,
    minSizeKB: Math.max(0, Number($('minSizeKB').value) || 0),
    skipHosts: $('skipHosts').value.trim(),
    port: Math.min(65535, Math.max(1024, Number($('port').value) || DEFAULTS.port)),
  });
  chrome.runtime.sendMessage({ type: 'settings-changed' });
  refresh();
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'ping' }, (response) => {
    const info = response?.info;
    $('status-dot').className = `dot ${info ? 'ok' : 'bad'}`;
    $('status').textContent = info
      ? `Connected to Raijin ${info.version}. ${$('enabled').checked ? 'Downloads will be sent to Raijin.' : 'Capturing is paused.'}`
      : 'Raijin is not running or browser integration is turned off in its Settings. Downloads stay in the browser.';
  });
}

['enabled', 'minSizeKB', 'skipHosts', 'port'].forEach((id) => $(id).addEventListener('change', save));
load();
