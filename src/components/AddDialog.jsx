import { useEffect, useRef, useState } from 'react';
import {
  CloudDownload, Clipboard, Folder, FolderSearch, RotateCcw, ChevronDown, ShieldCheck, ShieldAlert, LoaderCircle,
  CircleAlert, Clock3, ArrowDownToLine, Globe, Cookie, KeyRound, Fingerprint,
} from 'lucide-react';
import { Modal, Field, FileGlyph, SelectBox } from './ui.jsx';
import { formatBytes, hostOf } from '../lib/format.js';
import { extractUrls, categoryOfName, nameFromUrl } from '../lib/urls.js';
import { api } from '../lib/store.js';

export function shortPath(value, max = 46) {
  const text = String(value || '');
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const cut = tail.search(/[\\/]/);
  return `…${cut > 0 ? tail.slice(cut) : tail}`;
}

const CATEGORY_FOLDER = { video: 'Video', music: 'Music', documents: 'Documents', images: 'Images', compressed: 'Compressed', programs: 'Programs', other: 'Other' };

export function AddDialog({ initial = {}, prefs, notify, onClose, onAdded, onSwitchToBatch, onShowExisting }) {
  const [url, setUrl] = useState(initial.url || '');
  const [filename, setFilename] = useState(initial.filename || '');
  const [nameTouched, setNameTouched] = useState(Boolean(initial.filename));
  const [folder, setFolder] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [connections, setConnections] = useState(prefs.defaultConnections || 8);
  const [speedLimit, setSpeedLimit] = useState('');
  const [referrer, setReferrer] = useState(initial.referrer || '');
  const [cookies, setCookies] = useState(initial.cookies || '');
  const [userAgent, setUserAgent] = useState(initial.userAgent || '');
  const [headers, setHeaders] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hashAlgo, setHashAlgo] = useState('sha256');
  const [hash, setHash] = useState('');
  const [description, setDescription] = useState(initial.pageTitle || '');
  const [probe, setProbe] = useState(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState(null);
  const probeSeq = useRef(0);

  const validUrl = /^https?:\/\/\S+$/i.test(url.trim());

  useEffect(() => {
    setDuplicate(null);
    if (!validUrl) { setProbe(null); return undefined; }
    const seq = ++probeSeq.current;
    setProbing(true);
    const timer = setTimeout(async () => {
      try {
        const info = await api.probe(url.trim(), { referrer, cookies, userAgent, auth: username ? { username, password } : undefined });
        if (seq !== probeSeq.current) return;
        setProbe(info);
        if (info?.ok && !nameTouched) setFilename(info.filename);
      } catch (error) {
        if (seq === probeSeq.current) setProbe({ ok: false, error: error.message });
      } finally {
        if (seq === probeSeq.current) setProbing(false);
      }
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, validUrl, cookies, username, password]);

  const onUrlChange = (value) => {
    const urls = extractUrls(value);
    if (urls.length > 1) { onSwitchToBatch(value); return; }
    setUrl(value);
  };

  const pasteClipboard = async () => {
    const text = await api.readClipboard().catch(() => '');
    const urls = extractUrls(text);
    if (!urls.length) { notify('The clipboard does not contain a link.', 'info'); return; }
    if (urls.length > 1) onSwitchToBatch(text);
    else setUrl(urls[0]);
  };

  const effectiveName = filename.trim() || (probe?.ok ? probe.filename : nameFromUrl(url));
  const category = categoryOfName(effectiveName);
  const sep = String(prefs.downloadDir || '').includes('/') && !String(prefs.downloadDir || '').includes('\\') ? '/' : '\\';
  const autoFolder = `${prefs.downloadDir || 'Downloads'}${prefs.categoryFolders ? `${sep}${CATEGORY_FOLDER[category]}` : ''}`;
  const sizeText = probe?.ok ? formatBytes(probe.totalBytes, { empty: 'Unknown size' }) : initial.sizeHint ? formatBytes(initial.sizeHint) : null;

  const submit = async (start, allowDuplicate = false) => {
    if (!validUrl) { notify('Enter a valid http:// or https:// link.', 'error'); return; }
    setBusy(true);
    try {
      const job = await api.add(url.trim(), {
        filename: nameTouched ? filename.trim() : undefined,
        folder: folder || undefined,
        connections,
        speedLimitKBps: Number(speedLimit) || 0,
        referrer, cookies, userAgent, headers,
        auth: username ? { username, password } : undefined,
        checksum: hash.trim() ? { algo: hashAlgo, expected: hash.trim() } : undefined,
        description,
        sizeHint: probe?.totalBytes || initial.sizeHint || undefined,
        start,
        allowDuplicate,
        source: initial.source || 'manual',
      });
      onAdded(job, start);
    } catch (error) {
      if (error.code === 'DUPLICATE') setDuplicate({ id: error.existingId, filename: error.filename, start });
      else notify(error.message, 'error');
    } finally { setBusy(false); }
  };

  const sourceNote = initial.source === 'browser' ? 'Captured from your browser' : initial.source === 'clipboard' ? 'Found on your clipboard' : initial.source === 'cli' ? 'Opened from the command line' : null;

  return (
    <Modal
      title="Add a download" subtitle={sourceNote || 'Paste a link — Raijin checks it before you start.'} icon={CloudDownload} onClose={onClose} busy={busy} width={640}
      footer={(
        <>
          <span className="foot-hint">{validUrl && probe?.ok && probe.resumable === false ? <><ShieldAlert size={13} /> This server can’t resume — keep Raijin running until it finishes.</> : null}</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={() => submit(false)} disabled={busy || !validUrl}><Clock3 size={15} /> Download later</button>
          <button type="button" className="btn btn-primary" onClick={() => submit(true)} disabled={busy || !validUrl}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />} Start download
          </button>
        </>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(true); }}>
        <Field label="Address">
          <div className="input-group">
            <input data-autofocus className="input mono" value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder="https://example.com/files/setup.zip" spellCheck="false" autoComplete="off" />
            <button type="button" className="icon-btn" title="Paste from clipboard" onClick={pasteClipboard}><Clipboard size={16} /></button>
          </div>
        </Field>

        {validUrl && (
          <div className={`probe-card ${probe && !probe.ok ? 'probe-bad' : ''}`}>
            <FileGlyph category={category} name={effectiveName} size="lg" />
            <div className="probe-text">
              <strong>{effectiveName || 'download'}</strong>
              <span>
                {probing ? <><LoaderCircle size={12} className="spin" /> Checking the server…</> : probe?.ok ? (
                  <>
                    <b>{sizeText}</b>
                    <i>·</i>{hostOf(probe.finalUrl)}
                    <i>·</i>{probe.resumable ? <span className="ok-text"><ShieldCheck size={12} /> Resumable, multi-connection</span> : <span className="warn-text"><ShieldAlert size={12} /> Single connection, no resume</span>}
                  </>
                ) : probe ? <span className="bad-text"><CircleAlert size={12} /> {probe.error || 'Could not check this link'} — you can still try downloading.</span> : null}
              </span>
            </div>
          </div>
        )}

        {duplicate && (
          <div className="callout callout-warn">
            <CircleAlert size={16} />
            <div><b>Already in your list</b><span>{duplicate.filename || 'This link'} was added before.</span></div>
            <button type="button" className="btn btn-sm" onClick={() => { onShowExisting(duplicate.id); onClose(); }}>Show it</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => submit(duplicate.start, true)}>Download again</button>
          </div>
        )}

        <div className="grid-2">
          <Field label="Save as">
            <input className="input" value={filename} onChange={(e) => { setFilename(e.target.value); setNameTouched(true); }} placeholder={effectiveName || 'Name from the server'} spellCheck="false" />
          </Field>
          <Field label="Folder">
            <div className="input-group">
              <div className={`folder-chip ${folder ? '' : 'auto'}`} title={folder || autoFolder}>
                <Folder size={14} />
                <span>{shortPath(folder || autoFolder)}</span>
                {!folder && <em>auto</em>}
              </div>
              {folder && <button type="button" className="icon-btn" title="Back to automatic folder" onClick={() => setFolder('')}><RotateCcw size={15} /></button>}
              <button type="button" className="icon-btn" title="Choose folder" onClick={async () => { const f = await api.chooseFolder(folder || prefs.downloadDir).catch(() => null); if (f) setFolder(f); }}><FolderSearch size={16} /></button>
            </div>
          </Field>
        </div>

        <button type="button" className={`disclosure ${advanced ? 'open' : ''}`} onClick={() => setAdvanced((v) => !v)}>
          <ChevronDown size={15} /> Advanced options
          <span>{[cookies && 'cookies', referrer && 'referrer', username && 'login', hash && 'checksum', speedLimit && 'speed limit'].filter(Boolean).join(' · ')}</span>
        </button>

        {advanced && (
          <div className="advanced">
            <div className="grid-2">
              <Field label={`Connections · ${connections}`} hint="Raijin splits the file dynamically; more helps on fast servers.">
                <input type="range" min={1} max={32} value={connections} onChange={(e) => setConnections(Number(e.target.value))} />
              </Field>
              <Field label="Speed limit for this file" hint="KB/s · leave empty to use the global limit">
                <input className="input" type="number" min={0} value={speedLimit} onChange={(e) => setSpeedLimit(e.target.value)} placeholder="Unlimited" />
              </Field>
            </div>
            <Field label={<><Globe size={13} /> Referrer</>}>
              <input className="input mono" value={referrer} onChange={(e) => setReferrer(e.target.value)} placeholder="https://page-that-linked-the-file/" spellCheck="false" />
            </Field>
            <Field label={<><Cookie size={13} /> Cookies</>} hint={initial.cookies ? 'Taken from your browser so signed-in downloads work.' : 'Format: name=value; name2=value2'}>
              <input className="input mono" value={cookies} onChange={(e) => setCookies(e.target.value)} placeholder="session=…" spellCheck="false" />
            </Field>
            <div className="grid-2">
              <Field label={<><KeyRound size={13} /> Username</>}><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></Field>
              <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
            </div>
            <Field label="Custom headers" hint="One per line, e.g. Authorization: Bearer …">
              <textarea className="input mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} spellCheck="false" />
            </Field>
            <Field label="User agent" hint="Leave empty to use the one from Settings.">
              <input className="input mono" value={userAgent} onChange={(e) => setUserAgent(e.target.value)} spellCheck="false" />
            </Field>
            <Field label={<><Fingerprint size={13} /> Verify checksum</>} hint="Raijin hashes the file when it finishes and flags any mismatch.">
              <div className="input-group">
                <SelectBox value={hashAlgo} onChange={setHashAlgo} options={[{ value: 'sha256', label: 'SHA-256' }, { value: 'sha1', label: 'SHA-1' }, { value: 'sha512', label: 'SHA-512' }, { value: 'md5', label: 'MD5' }]} />
                <input className="input mono" value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Paste the expected hash" spellCheck="false" />
              </div>
            </Field>
            <Field label="Description">
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional note" />
            </Field>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
