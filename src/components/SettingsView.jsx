import { useEffect, useState } from 'react';
import {
  SlidersHorizontal, Download, Network, Globe, Palette, Info, FolderOpen, FolderSearch, Puzzle, RefreshCw, Upload,
  FileDown, Trash2, Sun, Moon, Monitor, CircleCheck, CircleAlert, Clipboard, Rows3, Rows4,
} from 'lucide-react';
import { Toggle, Segmented, SelectBox } from './ui.jsx';
import { BrandMark } from './Chrome.jsx';
import { api } from '../lib/store.js';

const SECTIONS = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'connection', label: 'Connection', icon: Network },
  { id: 'integration', label: 'Browser & clipboard', icon: Globe },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
];

function Row({ title, desc, children, first }) {
  return <div className={`setting-row ${first ? 'first' : ''}`}><div><b>{title}</b>{desc && <span>{desc}</span>}</div><div className="setting-control">{children}</div></div>;
}

function NumberSetting({ value, min, max, suffix, onCommit, width = 90 }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => setDraft(String(value ?? '')), [value]);
  const commit = () => {
    const n = Math.max(min, Math.min(max, Math.round(Number(draft) || 0)));
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <span className="num-setting">
      <input className="input" style={{ width }} type="number" min={min} max={max} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      {suffix && <em>{suffix}</em>}
    </span>
  );
}

function TextSetting({ value, onCommit, placeholder, mono }) {
  const [draft, setDraft] = useState(value || '');
  useEffect(() => setDraft(value || ''), [value]);
  return <input className={`input wide ${mono ? 'mono' : ''}`} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={() => { if (draft !== value) onCommit(draft); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} spellCheck="false" />;
}

export function SettingsView({ prefs, savePrefs, runAction, notify, info, bridge: bridgeProp, section, setSection }) {
  const [bridge, setBridge] = useState(bridgeProp);
  useEffect(() => setBridge(bridgeProp), [bridgeProp]);
  useEffect(() => {
    if (section !== 'integration' || !api) return undefined;
    const load = () => api.bridgeStatus().then(setBridge).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [section]);
  const chooseFolder = async () => {
    const folder = await api.chooseFolder(prefs.downloadDir).catch(() => null);
    if (folder) savePrefs({ downloadDir: folder });
  };
  const installExtension = async () => {
    const dir = await runAction('installExtension');
    if (dir) notify('Extension folder opened. In Chrome or Edge: Extensions → Developer mode → Load unpacked → pick that folder.', 'info', 9000);
  };

  return (
    <div className="settings">
      <nav className="settings-nav">
        <h2>Settings</h2>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={section === id ? 'on' : ''} onClick={() => setSection(id)}><Icon size={16} />{label}</button>
        ))}
      </nav>
      <div className="settings-body">
        {section === 'general' && (
          <section>
            <h3>General</h3>
            <Row first title="Launch Raijin when Windows starts" desc="Starts quietly in the tray so scheduled and browser downloads always work."><Toggle checked={prefs.launchAtStartup} onChange={(v) => savePrefs({ launchAtStartup: v })} /></Row>
            <Row title="Start minimized to the tray"><Toggle checked={prefs.startMinimized} onChange={(v) => savePrefs({ startMinimized: v })} /></Row>
            <Row title="Closing the window keeps Raijin in the tray" desc="Downloads keep running. Quit from the tray menu."><Toggle checked={prefs.closeToTray} onChange={(v) => savePrefs({ closeToTray: v })} /></Row>
            <Row title="Resume interrupted downloads on launch"><Toggle checked={prefs.resumeOnLaunch} onChange={(v) => savePrefs({ resumeOnLaunch: v })} /></Row>
            <Row title="Keep the PC awake while downloading" desc="Prevents sleep only while transfers are active."><Toggle checked={prefs.preventSleep} onChange={(v) => savePrefs({ preventSleep: v })} /></Row>
            <Row title="Desktop notifications" desc="When a download finishes or fails."><Toggle checked={prefs.notifications} onChange={(v) => savePrefs({ notifications: v })} /></Row>
            <Row title="Play a sound when a download completes"><Toggle checked={prefs.completionSound} onChange={(v) => savePrefs({ completionSound: v })} /></Row>
          </section>
        )}

        {section === 'downloads' && (
          <section>
            <h3>Downloads</h3>
            <Row first title="Download folder" desc={prefs.downloadDir}>
              <button type="button" className="btn btn-sm" onClick={() => runAction('openFolder')}><FolderOpen size={14} /> Open</button>
              <button type="button" className="btn btn-sm" onClick={chooseFolder}><FolderSearch size={14} /> Change</button>
            </Row>
            <Row title="Sort into category folders" desc="Video, Music, Documents, Images, Compressed, Programs and Other sub-folders."><Toggle checked={prefs.categoryFolders} onChange={(v) => savePrefs({ categoryFolders: v })} /></Row>
            <Row title="Simultaneous downloads" desc="Files downloading at the same time; the rest wait in the queue.">
              <input type="range" min={1} max={16} value={prefs.maxConcurrent} onChange={(e) => savePrefs({ maxConcurrent: Number(e.target.value) })} /><b className="range-val">{prefs.maxConcurrent}</b>
            </Row>
            <Row title="Connections per file" desc="Default for new downloads. Raijin splits work dynamically between them.">
              <input type="range" min={1} max={32} value={prefs.defaultConnections} onChange={(e) => savePrefs({ defaultConnections: Number(e.target.value) })} /><b className="range-val">{prefs.defaultConnections}</b>
            </Row>
            <Row title="Global speed limit" desc="Shared by all downloads. 0 = unlimited."><NumberSetting value={prefs.speedLimitKBps} min={0} max={10485760} suffix="KB/s" onCommit={(v) => savePrefs({ speedLimitKBps: v })} /></Row>
            <Row title="When a link is already in the list">
              <SelectBox value={prefs.duplicateAction} onChange={(v) => savePrefs({ duplicateAction: v })} options={[{ value: 'ask', label: 'Ask me' }, { value: 'rename', label: 'Download again with a new name' }, { value: 'skip', label: 'Skip it' }]} />
            </Row>
            <h4>Your list</h4>
            <Row first title="Export or import the download list" desc="Move your queue to another PC or back it up.">
              <button type="button" className="btn btn-sm" onClick={async () => { const f = await runAction('exportList', 'json'); if (f) notify('List exported.'); }}><FileDown size={14} /> Export</button>
              <button type="button" className="btn btn-sm" onClick={async () => { const r = await runAction('importList'); if (r) notify(`Imported ${r.added} link${r.added === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} already listed` : ''}.`); }}><Upload size={14} /> Import</button>
            </Row>
            <Row title="Clean up" desc="Removes entries from the list; your files stay on disk.">
              <button type="button" className="btn btn-sm" onClick={() => runAction('clear', 'completed')}><Trash2 size={14} /> Completed</button>
              <button type="button" className="btn btn-sm" onClick={() => runAction('clear', 'failed')}><Trash2 size={14} /> Failed</button>
            </Row>
          </section>
        )}

        {section === 'connection' && (
          <section>
            <h3>Connection</h3>
            <Row first title="Retry attempts" desc="Per connection, with exponential back-off and Retry-After support."><NumberSetting value={prefs.maxRetries} min={0} max={100} onCommit={(v) => savePrefs({ maxRetries: v })} /></Row>
            <Row title="Connect timeout"><NumberSetting value={prefs.timeoutSec} min={5} max={300} suffix="sec" onCommit={(v) => savePrefs({ timeoutSec: v })} /></Row>
            <Row title="Reconnect if a connection stalls for" desc="Silent connections are dropped and resumed automatically."><NumberSetting value={prefs.stallTimeoutSec} min={10} max={600} suffix="sec" onCommit={(v) => savePrefs({ stallTimeoutSec: v })} /></Row>
            <Row title="User agent" desc="Some servers only serve files to browsers. Leave empty for a current Chrome identity."><TextSetting value={prefs.userAgent} onCommit={(v) => savePrefs({ userAgent: v })} placeholder="Default (Chrome on Windows)" mono /></Row>
            <p className="muted small">Raijin uses your system’s network connection. Downloads that need a login can carry cookies, a referrer, credentials or custom headers — set them per download in the Add dialog or Properties.</p>
          </section>
        )}

        {section === 'integration' && (
          <section>
            <h3>Browser & clipboard</h3>
            <div className={`bridge-card ${bridge?.status === 'running' && prefs.browserIntegration ? 'ok' : bridge?.status === 'error' ? 'bad' : ''}`}>
              {bridge?.status === 'running' && prefs.browserIntegration ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
              <div>
                <b>{!prefs.browserIntegration ? 'Browser integration is off' : bridge?.status === 'running' ? `Listening for the extension on port ${bridge.port}` : bridge?.status === 'error' ? 'Integration could not start' : 'Starting…'}</b>
                <span>{bridge?.error || (bridge?.lastContact ? `Last contact from the browser: ${new Date(bridge.lastContact).toLocaleString()}` : 'No browser has connected yet.')}</span>
              </div>
              <button type="button" className="btn btn-sm" onClick={async () => { const s = await runAction('restartBridge'); if (s) setBridge(s); }}><RefreshCw size={14} /> Restart</button>
            </div>
            <Row first title="Accept downloads from the browser extension"><Toggle checked={prefs.browserIntegration} onChange={(v) => savePrefs({ browserIntegration: v })} /></Row>
            <Row title="Install the extension (Chrome, Edge, Brave, Opera)" desc="Captures downloads, adds “Download with Raijin” to right-click menus and passes your login cookies.">
              <button type="button" className="btn btn-sm btn-primary" onClick={installExtension}><Puzzle size={14} /> Get extension</button>
            </Row>
            <Row title="Start captured downloads immediately" desc="Off: Raijin shows the Add dialog first so you can rename or pick a folder."><Toggle checked={prefs.autoStartCaptured} onChange={(v) => savePrefs({ autoStartCaptured: v })} /></Row>
            <Row title="Integration port" desc="Must match the port in the extension’s popup."><NumberSetting value={prefs.bridgePort} min={1024} max={65535} onCommit={(v) => savePrefs({ bridgePort: v })} /></Row>
            <h4><Clipboard size={14} /> Clipboard</h4>
            <Row first title="Watch the clipboard for download links" desc="Copy a link to a file and Raijin offers to download it."><Toggle checked={prefs.clipboardMonitor} onChange={(v) => savePrefs({ clipboardMonitor: v })} /></Row>
            <Row title="File types to capture" desc="Used by the clipboard watcher and the browser extension.">
              <TextSetting value={prefs.captureExtensions} onCommit={(v) => savePrefs({ captureExtensions: v })} mono />
            </Row>
          </section>
        )}

        {section === 'appearance' && (
          <section>
            <h3>Appearance</h3>
            <Row first title="Theme">
              <Segmented value={prefs.theme} onChange={(v) => savePrefs({ theme: v })} options={[{ value: 'dark', label: 'Dark', icon: Moon }, { value: 'light', label: 'Light', icon: Sun }, { value: 'system', label: 'System', icon: Monitor }]} />
            </Row>
            <Row title="Accent colour">
              <div className="swatches">
                {['amber', 'violet', 'cyan', 'rose', 'lime'].map((a) => (
                  <button key={a} type="button" className={`swatch sw-${a} ${prefs.accent === a ? 'on' : ''}`} aria-label={a} title={a[0].toUpperCase() + a.slice(1)} onClick={() => savePrefs({ accent: a })} />
                ))}
              </div>
            </Row>
            <Row title="List density">
              <Segmented value={prefs.density} onChange={(v) => savePrefs({ density: v })} options={[{ value: 'comfortable', label: 'Comfortable', icon: Rows3 }, { value: 'compact', label: 'Compact', icon: Rows4 }]} />
            </Row>
            <Row title="Show the details panel"><Toggle checked={prefs.showDetails} onChange={(v) => savePrefs({ showDetails: v })} /></Row>
          </section>
        )}

        {section === 'about' && (
          <section className="about-section">
            <div className="about-hero">
              <BrandMark size={64} />
              <div>
                <h3>Raijin Download Manager</h3>
                <p>Version {info?.version || '2.0.0'} · Electron {info?.electron || ''}</p>
              </div>
            </div>
            <div className="credit-card">
              <span>Designed &amp; developed by</span>
              <b>Jessie Albert Regualos</b>
              <em>aka Yotsuchi</em>
            </div>
            <ul className="feature-list">
              <li>Dynamic segmentation — up to 32 connections that re-split work as they finish</li>
              <li>One pre-allocated file, no slow “assembling” step</li>
              <li>Pause, resume and crash-safe recovery, even after a restart</li>
              <li>Automatic retries, stall detection and expired-link refresh</li>
              <li>Browser capture with cookies, clipboard watching and batch patterns</li>
              <li>Scheduler, speed limits, checksum verification and power actions</li>
            </ul>
            <p className="muted small">Data folder: <span className="mono">{info?.userData}</span></p>
          </section>
        )}
      </div>
    </div>
  );
}
