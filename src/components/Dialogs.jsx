import { useEffect, useState } from 'react';
import {
  Settings2, CalendarClock, Trash2, Power, Moon, LogOut, Info, Gauge, LoaderCircle, Link2, Heart,
} from 'lucide-react';
import { Modal, Field, Toggle, SelectBox, FileGlyph } from './ui.jsx';
import { BrandMark } from './Chrome.jsx';
import { api } from '../lib/store.js';
import { formatBytes } from '../lib/format.js';

/* ------------------------------------------------------------- properties */

export function PropertiesDialog({ job, onClose, notify, apply }) {
  const running = ['connecting', 'downloading', 'finishing'].includes(job.status);
  const [form, setForm] = useState({
    filename: job.filename, url: job.url, referrer: job.referrer || '', cookies: job.cookies || '', userAgent: job.userAgent || '',
    headers: Object.entries(job.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    username: job.auth?.username || '', password: job.auth?.password || '',
    connections: job.connections, speedLimitKBps: job.speedLimitKBps || '',
    hashAlgo: job.checksum?.algo || 'sha256', hash: job.checksum?.expected || '', description: job.description || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const save = async () => {
    setBusy(true);
    try {
      const patch = { connections: Number(form.connections), speedLimitKBps: Number(form.speedLimitKBps) || 0, description: form.description };
      if (!running) {
        Object.assign(patch, {
          url: form.url.trim(), referrer: form.referrer, cookies: form.cookies, userAgent: form.userAgent, headers: form.headers,
          auth: form.username ? { username: form.username, password: form.password } : null,
          checksum: form.hash.trim() ? { algo: form.hashAlgo, expected: form.hash.trim() } : null,
        });
        if (form.filename.trim() && form.filename.trim() !== job.filename) patch.filename = form.filename.trim();
      }
      await api.update(job.id, patch);
      const snapshot = await api.getState();
      apply(snapshot);
      notify('Properties saved.');
      onClose();
    } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Download properties" subtitle={job.filename} icon={Settings2} onClose={onClose} busy={busy} width={640}
      footer={<><span className="foot-hint">{running ? 'Pause the download to change its address, name or request settings.' : ''}</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />} Save</button></>}>
      <div className="prop-head">
        <FileGlyph category={job.category} name={job.filename} size="lg" />
        <div><b>{formatBytes(job.totalBytes, { empty: 'Unknown size' })}</b><span className="mono">{job.destination || 'Not started yet'}</span></div>
      </div>
      <Field label="File name"><input className="input" value={form.filename} onChange={set('filename')} disabled={running} /></Field>
      <Field label={<><Link2 size={13} /> Address</>} hint="Link expired? Paste a fresh one here — Raijin continues from where it stopped.">
        <input className="input mono" value={form.url} onChange={set('url')} disabled={running} spellCheck="false" />
      </Field>
      <div className="grid-2">
        <Field label={`Connections · ${form.connections}`} hint="Changes apply instantly, even mid-download.">
          <input type="range" min={1} max={32} value={form.connections} onChange={set('connections')} />
        </Field>
        <Field label="Speed limit (KB/s)" hint="Empty = use the global limit">
          <input className="input" type="number" min={0} value={form.speedLimitKBps} onChange={set('speedLimitKBps')} placeholder="Unlimited" />
        </Field>
      </div>
      <Field label="Referrer"><input className="input mono" value={form.referrer} onChange={set('referrer')} disabled={running} spellCheck="false" /></Field>
      <Field label="Cookies"><input className="input mono" value={form.cookies} onChange={set('cookies')} disabled={running} spellCheck="false" /></Field>
      <div className="grid-2">
        <Field label="Username"><input className="input" value={form.username} onChange={set('username')} disabled={running} autoComplete="off" /></Field>
        <Field label="Password"><input className="input" type="password" value={form.password} onChange={set('password')} disabled={running} autoComplete="new-password" /></Field>
      </div>
      <Field label="Custom headers"><textarea className="input mono" rows={2} value={form.headers} onChange={set('headers')} disabled={running} spellCheck="false" /></Field>
      <Field label="User agent"><input className="input mono" value={form.userAgent} onChange={set('userAgent')} disabled={running} spellCheck="false" /></Field>
      <Field label="Expected checksum">
        <div className="input-group">
          <SelectBox value={form.hashAlgo} onChange={set('hashAlgo')} options={[{ value: 'sha256', label: 'SHA-256' }, { value: 'sha1', label: 'SHA-1' }, { value: 'sha512', label: 'SHA-512' }, { value: 'md5', label: 'MD5' }]} />
          <input className="input mono" value={form.hash} onChange={set('hash')} disabled={running} spellCheck="false" />
        </div>
      </Field>
      <Field label="Description"><input className="input" value={form.description} onChange={set('description')} /></Field>
    </Modal>
  );
}

/* -------------------------------------------------------------- scheduler */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function SchedulerDialog({ prefs, savePrefs, onClose, onStartNow }) {
  const [s, setS] = useState(prefs.scheduler || { enabled: false, startTime: '02:00', stopTime: '', days: [0, 1, 2, 3, 4, 5, 6] });
  const [whenDone, setWhenDone] = useState(prefs.whenDone || 'nothing');
  const [useStop, setUseStop] = useState(Boolean(prefs.scheduler?.stopTime));
  const toggleDay = (d) => setS((x) => ({ ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort() }));
  const save = async () => {
    await savePrefs({ scheduler: { ...s, stopTime: useStop ? (s.stopTime || '07:00') : '' }, whenDone });
    onClose();
  };
  return (
    <Modal title="Scheduler" subtitle="Run your queue overnight or off-peak, then let the PC rest." icon={CalendarClock} onClose={onClose} width={520}
      footer={<><button type="button" className="btn" onClick={onStartNow}>Start queue now</button><span className="foot-fill" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save schedule</button></>}>
      <div className="setting-row first">
        <div><b>Start the queue automatically</b><span>Downloads marked “Download later” and paused items start at this time.</span></div>
        <Toggle checked={s.enabled} onChange={(v) => setS((x) => ({ ...x, enabled: v }))} label="Enable scheduler" />
      </div>
      <div className={`sched-body ${s.enabled ? '' : 'dim'}`}>
        <div className="grid-2">
          <Field label="Start at"><input className="input" type="time" value={s.startTime} onChange={(e) => setS((x) => ({ ...x, startTime: e.target.value }))} /></Field>
          <Field label={<span className="label-with-toggle">Stop at <Toggle checked={useStop} onChange={setUseStop} label="Use stop time" /></span>}>
            <input className="input" type="time" value={s.stopTime || '07:00'} disabled={!useStop} onChange={(e) => setS((x) => ({ ...x, stopTime: e.target.value }))} />
          </Field>
        </div>
        <Field label="On these days">
          <div className="days">
            {DAYS.map((d, i) => <button key={d} type="button" className={`chip ${s.days.includes(i) ? 'on' : ''}`} onClick={() => toggleDay(i)}>{d}</button>)}
          </div>
        </Field>
      </div>
      <Field label="When all downloads finish">
        <SelectBox value={whenDone} onChange={setWhenDone} options={[{ value: 'nothing', label: 'Do nothing' }, { value: 'quit', label: 'Quit Raijin' }, { value: 'sleep', label: 'Sleep the computer' }, { value: 'shutdown', label: 'Shut down the computer' }]} />
      </Field>
      <p className="muted small">Raijin must be running (it can sit in the tray). Power actions wait 30 seconds so you can cancel.</p>
    </Modal>
  );
}

/* ----------------------------------------------------------------- delete */

export function DeleteDialog({ jobs, onClose, onConfirm }) {
  const [withFiles, setWithFiles] = useState(false);
  const completed = jobs.filter((j) => j.status === 'completed').length;
  return (
    <Modal title={jobs.length === 1 ? 'Delete this download?' : `Delete ${jobs.length} downloads?`} icon={Trash2} onClose={onClose} width={460}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-danger" data-autofocus onClick={() => onConfirm(withFiles)}>Delete</button></>}>
      <p className="muted">{jobs.length === 1 ? <b className="ink">{jobs[0].filename}</b> : `${jobs.length} items`} will be removed from the list. Unfinished parts are cleaned up.</p>
      {completed > 0 && (
        <label className="check-row">
          <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
          <span><b>Also delete {completed === 1 ? 'the downloaded file' : `${completed} downloaded files`}</b><small>Files are moved to the Recycle Bin.</small></span>
        </label>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- when-done timer */

export function WhenDoneDialog({ action, seconds, onCancel }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const Icon = action === 'sleep' ? Moon : action === 'quit' ? LogOut : Power;
  const label = action === 'sleep' ? 'Going to sleep' : action === 'quit' ? 'Quitting Raijin' : 'Shutting down';
  return (
    <Modal title="All downloads finished" icon={Icon} onClose={onCancel} width={420}
      footer={<button type="button" className="btn btn-primary" data-autofocus onClick={onCancel}>Cancel</button>}>
      <div className="countdown">
        <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" className="cd-track" /><circle cx="50" cy="50" r="44" className="cd-fill" style={{ strokeDashoffset: `${276.5 * (1 - left / seconds)}` }} /></svg>
        <b>{left}</b>
      </div>
      <p className="center">{label} in {left} second{left === 1 ? '' : 's'}.</p>
    </Modal>
  );
}

/* ------------------------------------------------------------ speed limit */

export function SpeedLimitDialog({ value, onClose, onSave }) {
  const [kb, setKb] = useState(value || '');
  return (
    <Modal title="Custom speed limit" icon={Gauge} onClose={onClose} width={400}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => onSave(Number(kb) || 0)}>Apply</button></>}>
      <Field label="Maximum total speed (KB/s)" hint="0 or empty means unlimited. 1024 KB/s = 1 MB/s.">
        <input data-autofocus className="input" type="number" min={0} value={kb} onChange={(e) => setKb(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSave(Number(kb) || 0); }} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ about */

export function AboutDialog({ info, onClose }) {
  return (
    <Modal title="About Raijin" icon={Info} onClose={onClose} width={480} className="about-modal">
      <div className="about">
        <BrandMark size={72} />
        <h1>Raijin <span>Download Manager</span></h1>
        <p className="about-ver">Version {info?.version || '2.0.0'}</p>
        <p className="about-tag">Named after the Japanese god of thunder and lightning — downloads that strike fast.</p>
        <div className="about-dev">
          <span>Designed &amp; developed by</span>
          <b>Jessie Albert Regualos</b>
          <em>aka Yotsuchi</em>
        </div>
        <div className="about-meta">
          <span>Electron {info?.electron}</span><span>Chromium {info?.chrome?.split('.')[0]}</span><span>Node {info?.node}</span>
        </div>
        <p className="about-copy"><Heart size={12} /> © {new Date().getFullYear()} Jessie Albert Regualos. All rights reserved.</p>
      </div>
    </Modal>
  );
}

