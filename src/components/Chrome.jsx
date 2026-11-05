import {
  Minus, Square, Copy as Restore, X, Plus, ListPlus, Play, Pause, RotateCcw, Trash2, CalendarClock, Gauge,
  Power, Search, Settings, PanelBottom, Layers, Download, Clock3, CircleCheck, CircleAlert, CirclePause,
  Film, Music, FileText, Image as ImageIcon, Archive, AppWindow, File, PlayCircle, PauseCircle, Zap, Globe,
  HardDrive, Moon, LogOut, Info, FolderOpen,
} from 'lucide-react';
import { Dropdown, MenuItem, MenuSep, MenuTitle, Sparkline } from './ui.jsx';
import { formatBytes, formatDuration, formatSpeed } from '../lib/format.js';
import { api } from '../lib/store.js';

export function BrandMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" className="brand-mark">
      <defs>
        <linearGradient id="rbolt" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#ffe08a" /><stop offset="0.55" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--accent-deep)" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="240" height="240" rx="60" className="brand-tile" />
      <path d="M150 30 L70 138 H124 L104 204 L190 92 H136 Z" fill="url(#rbolt)" />
      <rect x="70" y="214" width="116" height="14" rx="7" fill="var(--accent)" />
    </svg>
  );
}

export function TitleBar({ maximized, summary }) {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <BrandMark size={20} />
        <span className="brand-name">Raijin</span>
        <span className="brand-sub">Download Manager</span>
      </div>
      <div className="titlebar-center">
        {summary.active > 0 && (
          <span className="title-live"><i className="live-dot" />{summary.active} active · {formatSpeed(summary.speed)}{summary.eta != null && ` · ${formatDuration(summary.eta)} left`}</span>
        )}
      </div>
      <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => api?.minimize()}><Minus size={15} /></button>
        <button type="button" aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => api?.toggleMaximize()}>{maximized ? <Restore size={13} /> : <Square size={12} />}</button>
        <button type="button" aria-label="Close" className="close" onClick={() => api?.close()}><X size={16} /></button>
      </div>
    </header>
  );
}

function ToolButton({ icon: Icon, label, onClick, disabled, primary, active, title, kbd, refProp, ...rest }) {
  return (
    <button ref={refProp} type="button" className={`tool ${primary ? 'tool-primary' : ''} ${active ? 'tool-active' : ''}`} onClick={onClick} disabled={disabled} title={title || (kbd ? `${label} (${kbd})` : label)} {...rest}>
      <Icon size={18} strokeWidth={1.9} />
      <span>{label}</span>
    </button>
  );
}

const SPEED_PRESETS = [0, 128, 512, 1024, 2048, 5120, 10240, 25600];
const speedLabel = (kb) => (kb ? (kb >= 1024 ? `${(kb / 1024).toFixed(kb % 1024 ? 1 : 0)} MB/s` : `${kb} KB/s`) : 'Unlimited');

export function Toolbar({
  selection, onAdd, onBatch, onResume, onPause, onRestart, onDelete, onStartAll, onPauseAll, onScheduler,
  prefs, setPrefs, search, setSearch, onSettings, showDetails, onToggleDetails, onCustomLimit, view,
}) {
  const hasSel = selection.length > 0;
  const canResume = selection.some((j) => ['paused', 'failed', 'scheduled'].includes(j.status));
  const canPause = selection.some((j) => ['queued', 'scheduled', 'connecting', 'downloading'].includes(j.status));
  const whenDone = prefs.whenDone || 'nothing';
  return (
    <div className="toolbar">
      <div className="tool-group">
        <ToolButton icon={Plus} label="Add URL" primary onClick={onAdd} kbd="Ctrl+N" />
        <ToolButton icon={ListPlus} label="Batch" onClick={onBatch} kbd="Ctrl+B" />
      </div>
      <span className="tool-sep" />
      <div className="tool-group">
        <ToolButton icon={Play} label="Resume" onClick={onResume} disabled={!canResume} kbd="Space" />
        <ToolButton icon={Pause} label="Pause" onClick={onPause} disabled={!canPause} kbd="Space" />
        <ToolButton icon={RotateCcw} label="Restart" onClick={onRestart} disabled={!hasSel} />
        <ToolButton icon={Trash2} label="Delete" onClick={onDelete} disabled={!hasSel} kbd="Del" />
      </div>
      <span className="tool-sep" />
      <div className="tool-group">
        <ToolButton icon={PlayCircle} label="Start all" onClick={onStartAll} title="Start the queue / resume everything" />
        <ToolButton icon={PauseCircle} label="Pause all" onClick={onPauseAll} />
        <ToolButton icon={CalendarClock} label="Scheduler" onClick={onScheduler} active={prefs.scheduler?.enabled} />
        <Dropdown align="left" width={210} trigger={({ ref, toggle, open }) => (
          <ToolButton refProp={ref} icon={Gauge} label={prefs.speedLimitKBps ? speedLabel(prefs.speedLimitKBps) : 'Speed'} onClick={toggle} active={open || prefs.speedLimitKBps > 0} title="Global speed limit" />
        )}>
          <MenuTitle>Global speed limit</MenuTitle>
          {SPEED_PRESETS.map((kb) => <MenuItem key={kb} label={speedLabel(kb)} checked={prefs.speedLimitKBps === kb} onClick={() => setPrefs({ speedLimitKBps: kb })} />)}
          <MenuSep />
          <MenuItem icon={Gauge} label="Custom limit…" onClick={onCustomLimit} />
        </Dropdown>
        <Dropdown align="left" width={230} trigger={({ ref, toggle, open }) => (
          <ToolButton refProp={ref} icon={whenDone === 'nothing' ? Power : whenDone === 'sleep' ? Moon : whenDone === 'quit' ? LogOut : Power} label={whenDone === 'nothing' ? 'When done' : whenDone === 'quit' ? 'Then quit' : whenDone === 'sleep' ? 'Then sleep' : 'Then shut down'} onClick={toggle} active={open || whenDone !== 'nothing'} />
        )}>
          <MenuTitle>When all downloads finish</MenuTitle>
          <MenuItem label="Do nothing" checked={whenDone === 'nothing'} onClick={() => setPrefs({ whenDone: 'nothing' })} />
          <MenuItem label="Quit Raijin" checked={whenDone === 'quit'} onClick={() => setPrefs({ whenDone: 'quit' })} />
          <MenuItem label="Put the computer to sleep" checked={whenDone === 'sleep'} onClick={() => setPrefs({ whenDone: 'sleep' })} />
          <MenuItem label="Shut down the computer" checked={whenDone === 'shutdown'} onClick={() => setPrefs({ whenDone: 'shutdown' })} />
        </Dropdown>
      </div>
      <div className="tool-spacer" />
      <div className="search">
        <Search size={15} />
        <input id="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search downloads" spellCheck="false" />
        {search ? <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label="Clear search"><X size={13} /></button> : <kbd>Ctrl F</kbd>}
      </div>
      <button type="button" className={`icon-btn ${showDetails ? 'on' : ''}`} title="Toggle details panel (Ctrl+D)" onClick={onToggleDetails} disabled={view !== 'downloads'}><PanelBottom size={17} /></button>
      <button type="button" className={`icon-btn ${view === 'settings' ? 'on' : ''}`} title="Settings (Ctrl+,)" onClick={onSettings}><Settings size={17} /></button>
    </div>
  );
}

export const FILTERS = [
  { id: 'all', label: 'All downloads', icon: Layers },
  { id: 'active', label: 'Downloading', icon: Download },
  { id: 'queued', label: 'Queue', icon: Clock3 },
  { id: 'paused', label: 'Paused', icon: CirclePause },
  { id: 'completed', label: 'Completed', icon: CircleCheck },
  { id: 'failed', label: 'Failed', icon: CircleAlert },
];
export const CATEGORIES = [
  { id: 'video', label: 'Video', icon: Film },
  { id: 'music', label: 'Music', icon: Music },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'images', label: 'Images', icon: ImageIcon },
  { id: 'compressed', label: 'Compressed', icon: Archive },
  { id: 'programs', label: 'Programs', icon: AppWindow },
  { id: 'other', label: 'Other', icon: File },
];

export function Sidebar({ filter, setFilter, counts, history, summary, stats, onAbout, onOpenFolder }) {
  return (
    <aside className="sidebar">
      <div className="side-section">
        <div className="side-label">Status</div>
        {FILTERS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={`side-item ${filter === id ? 'on' : ''}`} onClick={() => setFilter(id)}>
            <Icon size={16} strokeWidth={1.9} /><span>{label}</span>
            {counts[id] > 0 && <em className={id === 'active' ? 'live' : id === 'failed' ? 'bad' : ''}>{counts[id]}</em>}
          </button>
        ))}
      </div>
      <div className="side-section">
        <div className="side-label">Categories</div>
        {CATEGORIES.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={`side-item ${filter === `cat:${id}` ? 'on' : ''}`} onClick={() => setFilter(`cat:${id}`)}>
            <Icon size={16} strokeWidth={1.9} /><span>{label}</span>
            {counts[`cat:${id}`] > 0 && <em>{counts[`cat:${id}`]}</em>}
          </button>
        ))}
      </div>
      <div className="side-fill" />
      <div className="side-meter">
        <div className="meter-head">
          <span><Zap size={13} /> Throughput</span>
          <b>{formatSpeed(summary.speed)}</b>
        </div>
        <Sparkline data={history.length ? history : [0, 0]} height={42} />
        <div className="meter-foot">
          <span>{formatBytes(stats.totalBytes || 0, { empty: '0 B' })} downloaded</span>
          <span>{stats.totalFiles || 0} files</span>
        </div>
      </div>
      <div className="side-foot">
        <button type="button" className="side-link" onClick={onOpenFolder}><FolderOpen size={14} /> Downloads folder</button>
        <button type="button" className="side-link" onClick={onAbout}><Info size={14} /> About Raijin</button>
      </div>
    </aside>
  );
}

export function StatusBar({ summary, prefs, bridge, disk, visibleCount, totalCount, selectedCount }) {
  const bridgeState = !prefs.browserIntegration ? 'off' : bridge?.status === 'running' ? 'on' : bridge?.status === 'error' ? 'error' : 'off';
  return (
    <footer className="statusbar">
      <span>{selectedCount ? `${selectedCount} selected · ` : ''}{visibleCount === totalCount ? `${totalCount} downloads` : `${visibleCount} of ${totalCount} shown`}</span>
      <span className="sb-sep" />
      <span className={summary.active ? 'sb-live' : ''}><Download size={12} /> {summary.active} active{summary.queued ? ` · ${summary.queued} queued` : ''}</span>
      <span className="sb-sep" />
      <span><Zap size={12} /> {formatSpeed(summary.speed)}</span>
      {prefs.speedLimitKBps > 0 && <><span className="sb-sep" /><span className="sb-warn"><Gauge size={12} /> Limited to {speedLabel(prefs.speedLimitKBps)}</span></>}
      {prefs.scheduler?.enabled && <><span className="sb-sep" /><span><CalendarClock size={12} /> Queue at {prefs.scheduler.startTime}</span></>}
      <span className="sb-fill" />
      {disk?.free != null && <span title={disk.path}><HardDrive size={12} /> {formatBytes(disk.free)} free</span>}
      <span className="sb-sep" />
      <span className={`sb-bridge ${bridgeState}`} title={bridge?.error || ''}><Globe size={12} /> Browser {bridgeState === 'on' ? (bridge?.lastContact ? 'linked' : 'ready') : bridgeState === 'error' ? 'port busy' : 'off'}</span>
    </footer>
  );
}
