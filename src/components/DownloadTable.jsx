import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CloudDownload, Plus, ListPlus, Link2 } from 'lucide-react';
import { FileGlyph } from './ui.jsx';
import { formatBytes, formatDate, formatDuration, formatSpeed, hostOf, isActive, percentOf, STATUS_LABEL } from '../lib/format.js';

const COLUMNS = [
  { id: 'name', label: 'Name', sortable: true },
  { id: 'size', label: 'Size', sortable: true, align: 'right' },
  { id: 'progress', label: 'Progress', sortable: true },
  { id: 'speed', label: 'Speed', sortable: true, align: 'right' },
  { id: 'eta', label: 'Time left', sortable: true, align: 'right' },
  { id: 'added', label: 'Added', sortable: true, align: 'right' },
];

function StatusText({ job }) {
  const pct = percentOf(job);
  switch (job.status) {
    case 'downloading': return <span className="st st-live">{pct != null ? `${pct.toFixed(1)}%` : formatBytes(job.downloadedBytes)}</span>;
    case 'connecting': return <span className="st st-live">Connecting…</span>;
    case 'finishing': return <span className="st st-live">{job.checksum?.expected ? 'Verifying…' : 'Finishing…'}</span>;
    case 'completed': return <span className="st st-ok">Completed</span>;
    case 'failed': return <span className="st st-bad">Failed{pct ? ` · ${Math.floor(pct)}%` : ''}</span>;
    case 'paused': return <span className="st st-mute">Paused{pct ? ` · ${Math.floor(pct)}%` : ''}</span>;
    case 'scheduled': return <span className="st st-mute">In queue</span>;
    default: return <span className="st st-mute">{STATUS_LABEL[job.status] || 'Queued'}</span>;
  }
}

const Row = memo(function Row({ job, selected, focused, onMouseDown, onDoubleClick, onContextMenu, style }) {
  const pct = percentOf(job);
  const active = isActive(job.status);
  const indeterminate = active && pct == null;
  const subtitle = job.status === 'failed' && job.error ? job.error : job.note || hostOf(job.url);
  return (
    <div
      role="row"
      aria-selected={selected}
      className={`row ${selected ? 'selected' : ''} ${focused ? 'focused' : ''} ${active ? 'is-active' : ''} row-${job.status}`}
      style={style}
      onMouseDown={(e) => onMouseDown(e, job.id)}
      onDoubleClick={() => onDoubleClick(job)}
      onContextMenu={(e) => onContextMenu(e, job.id)}
      data-id={job.id}
    >
      <div className="cell cell-name">
        <FileGlyph category={job.category} name={job.filename} />
        <div className="name-text">
          <strong title={job.filename}>{job.filename}</strong>
          <span className={job.status === 'failed' ? 'bad' : ''} title={job.status === 'failed' ? job.error : job.url}>
            {job.priority > 0 && <i className="prio">High</i>}
            {job.source === 'browser' && <i className="src">Browser</i>}
            {subtitle}
          </span>
        </div>
      </div>
      <div className="cell cell-size num">
        {job.totalBytes != null ? formatBytes(job.totalBytes) : active ? formatBytes(job.downloadedBytes) : '—'}
      </div>
      <div className="cell cell-progress">
        <div className={`bar ${indeterminate ? 'indeterminate' : ''} bar-${job.status}`}>
          <i style={{ width: `${pct ?? (job.status === 'completed' ? 100 : 0)}%` }} />
        </div>
        <StatusText job={job} />
      </div>
      <div className="cell cell-speed num">{job.status === 'downloading' ? formatSpeed(job.speed) : ''}</div>
      <div className="cell cell-eta num">{job.status === 'downloading' ? formatDuration(job.eta) : ''}</div>
      <div className="cell cell-added num">{formatDate(job.completedAt || job.createdAt)}</div>
    </div>
  );
});

export function DownloadTable({
  jobs, selectedIds, focusId, onSelect, onOpen, onContextMenu, sort, setSort, density, emptyKind, onAdd, onBatch, filterLabel,
}) {
  const scroller = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const rowHeight = density === 'compact' ? 38 : 54;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', update); };
  }, []);

  // Keep the keyboard-focused row in view (only when focus moves, never on progress ticks).
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    if (!focusId || !scroller.current) return;
    const index = jobsRef.current.findIndex((j) => j.id === focusId);
    if (index < 0) return;
    const el = scroller.current;
    const top = index * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  }, [focusId, rowHeight]);

  const handleMouseDown = useCallback((event, id) => {
    if (event.button === 2 && selectedIds.has(id)) return; // keep multi-selection for the context menu
    onSelect(id, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
  }, [onSelect, selectedIds]);

  const handleContext = useCallback((event, id) => {
    event.preventDefault();
    if (!selectedIds.has(id)) onSelect(id, {});
    onContextMenu(event.clientX, event.clientY);
  }, [onContextMenu, onSelect, selectedIds]);

  const overscan = 6;
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - overscan);
  const end = Math.min(jobs.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan);
  const visible = jobs.slice(start, end);

  return (
    <div className={`table density-${density}`} role="grid" aria-rowcount={jobs.length}>
      <div className="thead" role="row">
        {COLUMNS.map((c) => (
          <button
            key={c.id} type="button" role="columnheader"
            className={`th th-${c.id} ${c.align === 'right' ? 'right' : ''} ${sort.key === c.id ? 'sorted' : ''}`}
            onClick={() => setSort((s) => ({ key: c.id, dir: s.key === c.id && s.dir === 'asc' ? 'desc' : s.key === c.id ? 'asc' : c.id === 'name' ? 'asc' : 'desc' }))}
          >
            {c.label}
            {sort.key === c.id && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>
        ))}
      </div>
      <div className="tbody" ref={scroller} tabIndex={-1} onMouseDown={(e) => { if (e.target === e.currentTarget) onSelect(null, {}); }}>
        {jobs.length === 0 ? (
          <EmptyState kind={emptyKind} onAdd={onAdd} onBatch={onBatch} filterLabel={filterLabel} />
        ) : (
          <div style={{ height: jobs.length * rowHeight, position: 'relative' }}>
            {visible.map((job, i) => (
              <Row
                key={job.id}
                job={job}
                selected={selectedIds.has(job.id)}
                focused={focusId === job.id}
                onMouseDown={handleMouseDown}
                onDoubleClick={onOpen}
                onContextMenu={handleContext}
                style={{ position: 'absolute', top: (start + i) * rowHeight, left: 0, right: 0, height: rowHeight }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ kind, onAdd, onBatch, filterLabel }) {
  if (kind === 'search') {
    return <div className="empty"><div className="empty-art small"><Link2 size={22} /></div><h3>No matches</h3><p>Nothing in your list matches that search.</p></div>;
  }
  if (kind === 'filter') {
    return <div className="empty"><div className="empty-art small"><CloudDownload size={22} /></div><h3>Nothing in {filterLabel}</h3><p>Downloads will show up here when they match this view.</p></div>;
  }
  return (
    <div className="empty">
      <div className="empty-art"><CloudDownload size={30} /><span className="ring r1" /><span className="ring r2" /></div>
      <h3>Ready when you are</h3>
      <p>Paste a link with <kbd>Ctrl</kbd> <kbd>V</kbd>, drop one onto this window, or let the browser extension hand downloads over automatically.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-primary" onClick={onAdd}><Plus size={16} /> Add a download</button>
        <button type="button" className="btn" onClick={onBatch}><ListPlus size={16} /> Batch download</button>
      </div>
    </div>
  );
}
