import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleCheck, CircleAlert, Info as InfoIcon, X, ExternalLink, FolderOpen, Play, Pause, RotateCcw, Copy, Settings2,
  Trash2, ArrowUpToLine, ArrowDownToLine, ChevronUp, ChevronDown, Flag, Link2, CloudDownload, Clock3,
} from 'lucide-react';
import { api, useAction, useRaijinState, playChime } from './lib/store.js';
import { isActive, isWaiting, hostOf } from './lib/format.js';
import { extractUrls, nameFromUrl } from './lib/urls.js';
import { TitleBar, Toolbar, Sidebar, StatusBar, FILTERS, CATEGORIES } from './components/Chrome.jsx';
import { DownloadTable } from './components/DownloadTable.jsx';
import { DetailsPanel } from './components/DetailsPanel.jsx';
import { AddDialog } from './components/AddDialog.jsx';
import { BatchDialog } from './components/BatchDialog.jsx';
import { PropertiesDialog, SchedulerDialog, DeleteDialog, WhenDoneDialog, SpeedLimitDialog, AboutDialog } from './components/Dialogs.jsx';
import { SettingsView } from './components/SettingsView.jsx';
import { ContextMenu, MenuItem, MenuSep } from './components/ui.jsx';

const SORTERS = {
  name: (a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }),
  size: (a, b) => (a.totalBytes ?? -1) - (b.totalBytes ?? -1),
  progress: (a, b) => progressKey(a) - progressKey(b),
  speed: (a, b) => (a.speed || 0) - (b.speed || 0),
  eta: (a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity),
  added: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
};
function progressKey(job) {
  const rank = { downloading: 5, connecting: 5, finishing: 5, queued: 4, scheduled: 3, paused: 2, failed: 1, completed: 0 }[job.status] ?? 0;
  return rank * 1000 + (job.totalBytes ? (job.downloadedBytes / job.totalBytes) * 100 : 0);
}

function matchesFilter(job, filter) {
  if (filter === 'all') return true;
  if (filter === 'active') return isActive(job.status);
  if (filter === 'queued') return isWaiting(job.status);
  if (filter === 'paused') return job.status === 'paused';
  if (filter === 'completed') return job.status === 'completed';
  if (filter === 'failed') return job.status === 'failed';
  if (filter.startsWith('cat:')) return job.category === filter.slice(4);
  return true;
}

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const readStored = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const writeStored = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

export default function App() {
  /* ----------------------------------------------------------- toasts */
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((message, tone = 'success', ms = 3800, action = null) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list.slice(-2), { id, message, tone, action }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), ms);
  }, []);
  const onError = useCallback((e) => notify(e.message || 'Could not load downloads.', 'error'), [notify]);

  const { state, apply, history, jobHistory } = useRaijinState(onError);
  const run = useAction(apply, notify);
  const prefs = state.preferences;
  const jobs = state.jobs;

  /* ------------------------------------------------------------ ui state */
  const [view, setView] = useState('downloads');
  const [settingsSection, setSettingsSection] = useState('general');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(() => readStored('raijin.sort', { key: 'added', dir: 'desc' }));
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [anchorId, setAnchorId] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const [maximized, setMaximized] = useState(false);
  const [info, setInfo] = useState(null);
  const [bridge, setBridge] = useState(null);
  const [disk, setDisk] = useState(null);
  const [addDialog, setAddDialog] = useState(null);
  const [batchDialog, setBatchDialog] = useState(null);
  const [propsId, setPropsId] = useState(null);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState(null);
  const [whenDone, setWhenDone] = useState(null);
  const [menu, setMenu] = useState(null);
  const [banner, setBanner] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [detailsHeight, setDetailsHeight] = useState(() => readStored('raijin.detailsHeight', 270));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const anyModal = Boolean(addDialog || batchDialog || propsId || schedulerOpen || aboutOpen || speedOpen || deleteIds || whenDone);

  useEffect(() => writeStored('raijin.sort', sort), [sort]);

  /* ------------------------------------------------------------- theme */
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && media.matches);
      root.dataset.theme = dark ? 'dark' : 'light';
    };
    applyTheme();
    root.dataset.accent = prefs.accent || 'amber';
    root.dataset.density = prefs.density || 'comfortable';
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [prefs.theme, prefs.accent, prefs.density]);

  /* ----------------------------------------------------- subscriptions */
  const savePrefs = useCallback((patch) => run('setPreferences', patch), [run]);

  const selectOnly = useCallback((id) => {
    setSelectedIds(new Set(id ? [id] : []));
    setAnchorId(id); setFocusId(id);
  }, []);

  const handleCapture = useCallback((capture) => {
    if (capture.mode === 'batch') { setBatchDialog({ ...capture }); return; }
    if (capture.subtle) { setBanner(capture); return; }
    setAddDialog({ ...capture });
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    const offs = [
      api.onCompleted((job) => {
        if (prefsRef.current.completionSound) playChime();
        notify(`Downloaded ${job.filename}`, 'success', 6000, { label: 'Open', run: () => run('openFile', job.id) });
      }),
      api.onFailed((job) => notify(`${job.filename}: ${job.error || 'Download failed.'}`, 'error', 7000)),
      api.onCapture(handleCapture),
      api.onToast((t) => notify(t.message, t.tone || 'info')),
      api.onBridge(setBridge),
      api.onWhenDone(setWhenDone),
      api.onFocusJob((id) => { setView('downloads'); setFilter('all'); setSearch(''); selectOnly(id); }),
      api.onMaximized(setMaximized),
    ];
    api.info().then((i) => { setInfo(i); setBridge(i.bridge); }).catch(() => {});
    api.isMaximized().then(setMaximized).catch(() => {});
    api.rendererReady().catch(() => {});
    return () => offs.forEach((off) => off());
  }, [notify, run, handleCapture, selectOnly]);

  useEffect(() => {
    if (!api?.diskFree) return undefined;
    const load = () => api.diskFree().then(setDisk).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [prefs.downloadDir]);

  /* ------------------------------------------------------ derived lists */
  const counts = useMemo(() => {
    const c = {};
    for (const f of FILTERS) c[f.id] = 0;
    for (const job of jobs) {
      c.all++;
      if (isActive(job.status)) c.active++;
      if (isWaiting(job.status)) c.queued++;
      if (job.status === 'paused') c.paused++;
      if (job.status === 'completed') c.completed++;
      if (job.status === 'failed') c.failed++;
      c[`cat:${job.category}`] = (c[`cat:${job.category}`] || 0) + 1;
    }
    return c;
  }, [jobs]);

  const visibleJobs = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = jobs.filter((job) => matchesFilter(job, filter) && (!term || `${job.filename} ${job.url} ${job.description || ''}`.toLowerCase().includes(term)));
    const sorter = SORTERS[sort.key] || SORTERS.added;
    list.sort((a, b) => {
      const r = sorter(a, b);
      return (sort.dir === 'asc' ? r : -r) || (a.order - b.order);
    });
    return list;
  }, [jobs, filter, search, sort]);

  const selection = useMemo(() => jobs.filter((j) => selectedIds.has(j.id)), [jobs, selectedIds]);
  const selectedIdList = useMemo(() => selection.map((j) => j.id), [selection]);
  const detailJob = selection.length === 1 ? selection[0] : null;

  // Drop selection entries that disappeared.
  useEffect(() => {
    if (!selectedIds.size) return;
    const ids = new Set(jobs.map((j) => j.id));
    if ([...selectedIds].some((id) => !ids.has(id))) setSelectedIds((prev) => new Set([...prev].filter((id) => ids.has(id))));
  }, [jobs, selectedIds]);

  /* ---------------------------------------------------------- selection */
  const onSelect = useCallback((id, { ctrl, shift }) => {
    if (!id) { setSelectedIds(new Set()); setAnchorId(null); setFocusId(null); return; }
    if (shift && anchorId) {
      const a = visibleJobs.findIndex((j) => j.id === anchorId);
      const b = visibleJobs.findIndex((j) => j.id === id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        const range = visibleJobs.slice(from, to + 1).map((j) => j.id);
        setSelectedIds((prev) => new Set(ctrl ? [...prev, ...range] : range));
        setFocusId(id);
        return;
      }
    }
    if (ctrl) {
      setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
      setAnchorId(id); setFocusId(id);
      return;
    }
    selectOnly(id);
  }, [anchorId, visibleJobs, selectOnly]);

  /* ------------------------------------------------------------ actions */
  const doResume = () => run('resume', selectedIdList);
  const doPause = () => run('pause', selectedIdList);
  const doRestart = () => run('restart', selectedIdList);
  const askDelete = () => { if (selectedIdList.length) setDeleteIds(selectedIdList); };
  const togglePause = () => {
    if (!selection.length) return;
    if (selection.some((j) => isActive(j.status) || j.status === 'queued')) doPause(); else doResume();
  };
  const openJob = useCallback((job) => {
    if (job.status === 'completed') run('openFile', job.id);
    else if (['paused', 'failed', 'scheduled'].includes(job.status)) run('resume', [job.id]);
    else setPropsId(job.id);
  }, [run]);

  const openAddFromText = useCallback((text, source = 'manual') => {
    const urls = extractUrls(text);
    if (urls.length > 1) setBatchDialog({ text: urls.join('\n'), source });
    else if (urls.length === 1) setAddDialog({ url: urls[0], source });
    return urls.length;
  }, []);

  const afterAdd = (job, started) => {
    setAddDialog(null);
    setView('downloads');
    if (filter !== 'all' && !matchesFilter(job, filter)) setFilter('all');
    selectOnly(job.id);
    notify(started ? `Downloading ${job.filename}` : `${job.filename} is waiting in the queue.`);
  };
  const afterBatch = (result, started) => {
    setBatchDialog(null);
    setView('downloads');
    notify(`${result.added} download${result.added === 1 ? '' : 's'} ${started ? 'started' : 'added to the queue'}${result.skipped ? ` · ${result.skipped} already listed` : ''}${result.invalid ? ` · ${result.invalid} invalid` : ''}.`);
  };

  /* ---------------------------------------------------------- keyboard */
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (anyModal) return;
      if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); setAddDialog({}); return; }
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); setBatchDialog({}); return; }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); setView('downloads'); setTimeout(() => document.getElementById('search')?.focus(), 0); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); savePrefs({ showDetails: !prefsRef.current.showDetails }); return; }
      if (mod && e.key === ',') { e.preventDefault(); setView('settings'); return; }
      if (isTyping(document.activeElement) || view !== 'downloads') return;
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelectedIds(new Set(visibleJobs.map((j) => j.id))); return; }
      if (e.key === 'Delete') { e.preventDefault(); askDelete(); return; }
      if (e.key === ' ') { e.preventDefault(); togglePause(); return; }
      if (e.key === 'Enter' && detailJob) { e.preventDefault(); openJob(detailJob); return; }
      if (e.key === 'Escape') { setSelectedIds(new Set()); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!visibleJobs.length) return;
        const index = visibleJobs.findIndex((j) => j.id === focusId);
        const next = visibleJobs[Math.max(0, Math.min(visibleJobs.length - 1, index < 0 ? 0 : index + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (e.shiftKey) onSelect(next.id, { shift: true }); else selectOnly(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    const onPaste = (e) => {
      if (anyModal || isTyping(document.activeElement)) return;
      const text = e.clipboardData?.getData('text') || '';
      if (openAddFromText(text)) e.preventDefault();
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [anyModal, openAddFromText]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    if (!openAddFromText(text)) notify('Drop a link (http or https) to download it.', 'info');
  };

  /* ------------------------------------------------------ details resize */
  const startResize = (e) => {
    e.preventDefault();
    const startY = e.clientY; const startH = detailsHeight;
    const move = (ev) => setDetailsHeight(Math.max(170, Math.min(window.innerHeight - 260, startH - (ev.clientY - startY))));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setDetailsHeight((h) => { writeStored('raijin.detailsHeight', h); return h; }); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  /* -------------------------------------------------------------- render */
  const filterLabel = FILTERS.find((f) => f.id === filter)?.label || CATEGORIES.find((c) => `cat:${c.id}` === filter)?.label || 'this view';
  const emptyKind = jobs.length === 0 ? 'none' : search.trim() ? 'search' : 'filter';
  const propsJob = propsId ? jobs.find((j) => j.id === propsId) : null;
  const single = selection.length === 1 ? selection[0] : null;

  return (
    <div
      className={`app ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={onDrop}
    >
      <TitleBar maximized={maximized} summary={state.summary} />
      <Toolbar
        view={view}
        selection={selection}
        prefs={prefs}
        setPrefs={savePrefs}
        search={search}
        setSearch={(v) => { setSearch(v); if (view !== 'downloads') setView('downloads'); }}
        onAdd={() => setAddDialog({})}
        onBatch={() => setBatchDialog({})}
        onResume={doResume}
        onPause={doPause}
        onRestart={doRestart}
        onDelete={askDelete}
        onStartAll={() => run('startQueue')}
        onPauseAll={() => run('pauseAll')}
        onScheduler={() => setSchedulerOpen(true)}
        onCustomLimit={() => setSpeedOpen(true)}
        showDetails={prefs.showDetails}
        onToggleDetails={() => savePrefs({ showDetails: !prefs.showDetails })}
        onSettings={() => setView((v) => (v === 'settings' ? 'downloads' : 'settings'))}
      />
      <div className="workspace">
        <Sidebar
          filter={view === 'downloads' ? filter : null}
          setFilter={(f) => { setFilter(f); setView('downloads'); }}
          counts={counts}
          history={history}
          summary={state.summary}
          stats={state.stats}
          onAbout={() => setAboutOpen(true)}
          onOpenFolder={() => run('openFolder')}
        />
        <main className="main">
          {view === 'settings' ? (
            <SettingsView prefs={prefs} savePrefs={savePrefs} runAction={run} notify={notify} info={info} bridge={bridge} section={settingsSection} setSection={setSettingsSection} />
          ) : (
            <>
              {banner && (
                <div className="banner">
                  <Link2 size={16} />
                  <div><b>Link copied</b><span title={banner.url}>{nameFromUrl(banner.url)} · {hostOf(banner.url)}</span></div>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => { setAddDialog({ url: banner.url, source: 'clipboard' }); setBanner(null); }}><CloudDownload size={14} /> Download</button>
                  <button type="button" className="btn btn-sm" onClick={async () => { const job = await run('add', banner.url, { start: false, source: 'clipboard' }); if (job) notify(`${job.filename} added to the queue.`); setBanner(null); }}><Clock3 size={14} /> Later</button>
                  <button type="button" className="icon-btn ghost" onClick={() => setBanner(null)} aria-label="Dismiss"><X size={15} /></button>
                </div>
              )}
              <DownloadTable
                jobs={visibleJobs}
                selectedIds={selectedIds}
                focusId={focusId}
                onSelect={onSelect}
                onOpen={openJob}
                onContextMenu={(x, y) => setMenu({ x, y })}
                sort={sort}
                setSort={setSort}
                density={prefs.density}
                emptyKind={emptyKind}
                filterLabel={filterLabel}
                onAdd={() => setAddDialog({})}
                onBatch={() => setBatchDialog({})}
              />
              {prefs.showDetails && (
                <div className="details-wrap" style={{ height: detailsHeight }}>
                  <div className="resizer" onMouseDown={startResize} role="separator" aria-orientation="horizontal" />
                  <DetailsPanel job={detailJob} count={selection.length} history={detailJob ? jobHistory.get(detailJob.id) : null} runAction={run} onProperties={setPropsId} notify={notify} />
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <StatusBar summary={state.summary} prefs={prefs} bridge={bridge} disk={disk} visibleCount={visibleJobs.length} totalCount={jobs.length} selectedCount={selection.length} />

      {menu && selection.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {single?.status === 'completed' && <MenuItem icon={ExternalLink} label="Open" hint="Enter" onClick={() => run('openFile', single.id)} />}
          {single?.destination && <MenuItem icon={FolderOpen} label="Show in folder" onClick={() => run('showInFolder', single.id)} />}
          {(single?.status === 'completed' || single?.destination) && <MenuSep />}
          {selection.some((j) => ['paused', 'failed', 'scheduled'].includes(j.status)) && <MenuItem icon={Play} label="Resume" hint="Space" onClick={doResume} />}
          {selection.some((j) => isActive(j.status) || j.status === 'queued' || j.status === 'scheduled') && <MenuItem icon={Pause} label="Pause" hint="Space" onClick={doPause} />}
          <MenuItem icon={RotateCcw} label="Restart from scratch" onClick={doRestart} />
          <MenuSep />
          <MenuItem icon={Copy} label={selection.length > 1 ? 'Copy addresses' : 'Copy address'} onClick={() => run('writeClipboard', selection.map((j) => j.url).join('\n')).then(() => notify('Copied.'))} />
          {single && <MenuItem icon={Link2} label="Refresh address…" onClick={() => setPropsId(single.id)} />}
          {single && <MenuItem icon={Settings2} label="Properties" onClick={() => setPropsId(single.id)} />}
          <MenuSep />
          <MenuItem icon={ArrowUpToLine} label="Move to top of queue" onClick={() => run('move', selectedIdList, 'top')} />
          <MenuItem icon={ChevronUp} label="Move up" onClick={() => run('move', selectedIdList, 'up')} />
          <MenuItem icon={ChevronDown} label="Move down" onClick={() => run('move', selectedIdList, 'down')} />
          <MenuItem icon={ArrowDownToLine} label="Move to bottom" onClick={() => run('move', selectedIdList, 'bottom')} />
          <MenuItem icon={Flag} label={selection.every((j) => j.priority > 0) ? 'Normal priority' : 'High priority'} onClick={() => run('setPriority', selectedIdList, selection.every((j) => j.priority > 0) ? 'normal' : 'high')} />
          <MenuSep />
          <MenuItem icon={Trash2} label={selection.length > 1 ? `Delete ${selection.length} downloads…` : 'Delete…'} hint="Del" danger onClick={askDelete} />
        </ContextMenu>
      )}

      {addDialog && (
        <AddDialog
          initial={addDialog} prefs={prefs} notify={notify}
          onClose={() => setAddDialog(null)}
          onAdded={afterAdd}
          onSwitchToBatch={(text) => { setAddDialog(null); setBatchDialog({ text, source: addDialog.source }); }}
          onShowExisting={(id) => { setView('downloads'); setFilter('all'); setSearch(''); selectOnly(id); }}
        />
      )}
      {batchDialog && <BatchDialog initial={batchDialog} prefs={prefs} notify={notify} onClose={() => setBatchDialog(null)} onAdded={afterBatch} />}
      {propsJob && <PropertiesDialog job={propsJob} onClose={() => setPropsId(null)} notify={notify} apply={apply} />}
      {schedulerOpen && <SchedulerDialog prefs={prefs} savePrefs={savePrefs} onClose={() => setSchedulerOpen(false)} onStartNow={() => { run('startQueue'); setSchedulerOpen(false); notify('Queue started.'); }} />}
      {deleteIds && (
        <DeleteDialog
          jobs={jobs.filter((j) => deleteIds.includes(j.id))}
          onClose={() => setDeleteIds(null)}
          onConfirm={async (withFiles) => { const ids = deleteIds; setDeleteIds(null); await run('remove', ids, { deleteFiles: withFiles }); notify(`${ids.length} download${ids.length === 1 ? '' : 's'} removed.`); }}
        />
      )}
      {whenDone && <WhenDoneDialog action={whenDone.action} seconds={whenDone.seconds} onCancel={() => { api.cancelWhenDone(); setWhenDone(null); notify('Cancelled.', 'info'); }} />}
      {speedOpen && <SpeedLimitDialog value={prefs.speedLimitKBps} onClose={() => setSpeedOpen(false)} onSave={(kb) => { savePrefs({ speedLimitKBps: kb }); setSpeedOpen(false); }} />}
      {aboutOpen && <AboutDialog info={info} onClose={() => setAboutOpen(false)} />}

      {dragging && <div className="drop-zone"><div><CloudDownload size={34} /><b>Drop to download</b><span>Links are checked before anything starts</span></div></div>}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.tone === 'error' ? <CircleAlert size={16} /> : t.tone === 'info' ? <InfoIcon size={16} /> : <CircleCheck size={16} />}
            <span>{t.message}</span>
            {t.action && <button type="button" className="toast-action" onClick={() => { t.action.run(); setToasts((l) => l.filter((x) => x.id !== t.id)); }}>{t.action.label}</button>}
            <button type="button" className="toast-close" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))} aria-label="Dismiss"><X size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
