import { useMemo, useState } from 'react';
import { ListPlus, Folder, FolderSearch, RotateCcw, Clock3, ArrowDownToLine, LoaderCircle, Search, Wand2 } from 'lucide-react';
import { Modal, Field, FileGlyph } from './ui.jsx';
import { extractUrls, categoryOfName, nameFromUrl } from '../lib/urls.js';
import { api } from '../lib/store.js';
import { shortPath } from './AddDialog.jsx';

const TYPE_FILTERS = [
  { id: 'all', label: 'All' }, { id: 'video', label: 'Video' }, { id: 'music', label: 'Music' }, { id: 'images', label: 'Images' },
  { id: 'documents', label: 'Docs' }, { id: 'compressed', label: 'Archives' }, { id: 'programs', label: 'Programs' }, { id: 'other', label: 'Other' },
];

export function BatchDialog({ initial = {}, prefs, notify, onClose, onAdded }) {
  const fromBrowser = Array.isArray(initial.items) && initial.items.length > 0;
  const [text, setText] = useState(initial.text || '');
  const [typeFilter, setTypeFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('');
  const [connections, setConnections] = useState(prefs.defaultConnections || 8);
  const [busy, setBusy] = useState(false);
  const [patternBase, setPatternBase] = useState('');
  const [patternFrom, setPatternFrom] = useState('1');
  const [patternTo, setPatternTo] = useState('10');
  const [patternPad, setPatternPad] = useState(true);

  const items = useMemo(() => {
    const raw = fromBrowser ? initial.items : extractUrls(text).map((url) => ({ url }));
    return raw.map((item) => {
      const name = item.filename || nameFromUrl(item.url);
      const category = categoryOfName(name);
      return { ...item, name, category, hasExt: /\.[a-z0-9]{1,6}$/i.test(name) };
    });
  }, [fromBrowser, initial.items, text]);

  const [deselected, setDeselected] = useState(() => new Set(
    fromBrowser ? initial.items.filter((i) => categoryOfName(i.filename || nameFromUrl(i.url)) === 'other' && !/\.(bin|dat|torrent)$/i.test(i.url.split(/[?#]/)[0])).map((i) => i.url) : [],
  ));

  const visible = items.filter((i) => (typeFilter === 'all' || i.category === typeFilter) && (!query || `${i.name} ${i.url} ${i.text || ''}`.toLowerCase().includes(query.toLowerCase())));
  const selected = items.filter((i) => !deselected.has(i.url));
  const counts = items.reduce((acc, i) => { acc[i.category] = (acc[i.category] || 0) + 1; return acc; }, { all: items.length });

  const toggle = (url) => setDeselected((prev) => { const next = new Set(prev); if (next.has(url)) next.delete(url); else next.add(url); return next; });
  const setVisible = (on) => setDeselected((prev) => { const next = new Set(prev); visible.forEach((i) => (on ? next.delete(i.url) : next.add(i.url))); return next; });

  const insertPattern = () => {
    if (!/^https?:\/\//i.test(patternBase) || !patternBase.includes('*')) { notify('Use a link with * where the number goes, e.g. https://site.com/img*.jpg', 'info'); return; }
    const from = Number(patternFrom); const to = Number(patternTo);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const width = patternPad ? String(Math.max(from, to)).length : 0;
    const token = `[${width ? String(from).padStart(width, '0') : from}-${width ? String(to).padStart(width, '0') : to}]`;
    setText((t) => `${t.trim() ? `${t.trim()}\n` : ''}${patternBase.replace('*', token)}`);
  };

  const submit = async (start) => {
    if (!selected.length) { notify('Select at least one link.', 'info'); return; }
    setBusy(true);
    try {
      const result = await api.addMany(selected.map((i) => ({ url: i.url, filename: i.filename || undefined, cookies: i.cookies || initial.cookies || undefined })), {
        folder: folder || undefined, connections, start,
        referrer: initial.referrer || '', userAgent: initial.userAgent || '', source: fromBrowser ? 'browser' : 'batch',
      });
      onAdded(result, start);
    } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Modal
      title={fromBrowser ? 'Download links from page' : 'Batch download'}
      subtitle={fromBrowser ? (initial.pageTitle || 'Pick the files you want from this page.') : 'Paste many links, or generate a numbered series.'}
      icon={ListPlus} onClose={onClose} busy={busy} width={760} className="batch-modal"
      footer={(
        <>
          <span className="foot-hint">{selected.length} of {items.length} selected</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={() => submit(false)} disabled={busy || !selected.length}><Clock3 size={15} /> Add to queue</button>
          <button type="button" className="btn btn-primary" onClick={() => submit(true)} disabled={busy || !selected.length}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />} Download {selected.length || ''}</button>
        </>
      )}
    >
      {!fromBrowser && (
        <>
          <Field label="Links" hint={<>One per line. Ranges expand automatically: <code>file[001-120].jpg</code>, <code>part[1-9:2].rar</code>, <code>disk-[a-f].iso</code></>}>
            <textarea data-autofocus className="input mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'https://example.com/file1.zip\nhttps://example.com/photos/img[001-050].jpg'} spellCheck="false" />
          </Field>
          <div className="pattern-row">
            <Wand2 size={15} />
            <input className="input mono" value={patternBase} onChange={(e) => setPatternBase(e.target.value)} placeholder="https://site.com/episode-*.mp4" spellCheck="false" />
            <input className="input num-in" type="number" value={patternFrom} onChange={(e) => setPatternFrom(e.target.value)} aria-label="From" />
            <span>to</span>
            <input className="input num-in" type="number" value={patternTo} onChange={(e) => setPatternTo(e.target.value)} aria-label="To" />
            <label className="check"><input type="checkbox" checked={patternPad} onChange={(e) => setPatternPad(e.target.checked)} /> 001</label>
            <button type="button" className="btn btn-sm" onClick={insertPattern}>Add series</button>
          </div>
        </>
      )}

      <div className="batch-tools">
        <div className="chips">
          {TYPE_FILTERS.filter((f) => f.id === 'all' || counts[f.id]).map((f) => (
            <button key={f.id} type="button" className={`chip ${typeFilter === f.id ? 'on' : ''}`} onClick={() => setTypeFilter(f.id)}>{f.label}<em>{counts[f.id] || 0}</em></button>
          ))}
        </div>
        <div className="mini-search"><Search size={13} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" /></div>
        <button type="button" className="link-btn" onClick={() => setVisible(true)}>Select shown</button>
        <button type="button" className="link-btn" onClick={() => setVisible(false)}>Clear shown</button>
      </div>

      <div className="batch-list">
        {visible.length === 0 ? <p className="muted pad">{items.length ? 'No links match this filter.' : 'Links you paste will be listed here.'}</p> : visible.slice(0, 1500).map((item) => (
          <label key={item.url} className={`batch-item ${deselected.has(item.url) ? '' : 'on'}`}>
            <input type="checkbox" checked={!deselected.has(item.url)} onChange={() => toggle(item.url)} />
            <FileGlyph category={item.category} name={item.name} size="sm" />
            <span className="bi-text"><b>{item.name}</b><small>{item.text && item.text !== item.name ? `${item.text} · ` : ''}{item.url}</small></span>
          </label>
        ))}
        {visible.length > 1500 && <p className="muted pad">…and {visible.length - 1500} more</p>}
      </div>

      <div className="grid-2 batch-opts">
        <Field label="Folder">
          <div className="input-group">
            <div className={`folder-chip ${folder ? '' : 'auto'}`}><Folder size={14} /><span title={folder || prefs.downloadDir}>{folder ? shortPath(folder) : (prefs.categoryFolders ? 'Automatic — sorted by category' : shortPath(prefs.downloadDir))}</span></div>
            {folder && <button type="button" className="icon-btn" onClick={() => setFolder('')} title="Automatic folder"><RotateCcw size={15} /></button>}
            <button type="button" className="icon-btn" title="Choose folder" onClick={async () => { const f = await api.chooseFolder(folder || prefs.downloadDir).catch(() => null); if (f) setFolder(f); }}><FolderSearch size={16} /></button>
          </div>
        </Field>
        <Field label={`Connections per file · ${connections}`}>
          <input type="range" min={1} max={32} value={connections} onChange={(e) => setConnections(Number(e.target.value))} />
        </Field>
      </div>
    </Modal>
  );
}
