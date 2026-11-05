import { useMemo, useState } from 'react';
import {
  FolderOpen, ExternalLink, Copy, Pause, Play, Settings2, ShieldCheck, ShieldAlert, Fingerprint, LoaderCircle, Layers, Zap,
} from 'lucide-react';
import { FileGlyph, Sparkline } from './ui.jsx';
import { formatBytes, formatDate, formatDuration, formatSpeed, hostOf, isActive, percentOf, STATUS_LABEL } from '../lib/format.js';

export function SegmentMap({ job }) {
  const total = job.totalBytes;
  if (!total) {
    const active = isActive(job.status);
    return <div className={`segmap ${active ? 'segmap-unknown' : ''}`}><div className="segmap-note">{job.status === 'completed' ? 'Complete' : active ? 'Size unknown — streaming' : 'Waiting for the server'}</div></div>;
  }
  const segs = job.status === 'completed' ? [{ start: 0, end: total - 1, received: total }] : job.segments || [];
  return (
    <div className="segmap" role="img" aria-label="Download segment map">
      {segs.map((s, i) => {
        const len = Math.max(1, s.end - s.start + 1);
        const left = (s.start / total) * 100;
        const width = (len / total) * 100;
        const filled = Math.min(100, (s.received / len) * 100);
        return (
          <div key={`${s.start}-${i}`} className={`seg ${s.busy ? 'busy' : ''} ${filled >= 100 ? 'done' : ''}`} style={{ left: `${left}%`, width: `${width}%` }}>
            <i style={{ width: `${filled}%` }} />
          </div>
        );
      })}
    </div>
  );
}

function Info({ label, children, mono }) {
  return <div className="info"><span>{label}</span><b className={mono ? 'mono' : ''}>{children}</b></div>;
}

export function DetailsPanel({ job, count, history, runAction, onProperties, notify }) {
  const [tab, setTab] = useState('overview');
  const [hashing, setHashing] = useState(false);
  const segments = useMemo(() => (job?.segments || []).filter((s) => s.end >= s.start), [job]);

  if (!job) {
    return (
      <section className="details details-empty">
        <Layers size={18} />
        <span>{count > 1 ? `${count} downloads selected` : 'Select a download to see its live connections, speed and details.'}</span>
      </section>
    );
  }
  const pct = percentOf(job);
  const active = isActive(job.status);
  const copy = (text, label) => runAction('writeClipboard', text).then(() => notify(`${label} copied.`));
  const computeHash = async () => {
    setHashing(true);
    const value = await runAction('hash', job.id, 'sha256');
    setHashing(false);
    if (value) notify('SHA-256 calculated.');
  };

  return (
    <section className="details">
      <div className="details-head">
        <FileGlyph category={job.category} name={job.filename} size="lg" />
        <div className="details-title">
          <h3 title={job.filename}>{job.filename}</h3>
          <p>
            <span className={`pill pill-${job.status}`}>{STATUS_LABEL[job.status]}</span>
            {pct != null && <span>{pct.toFixed(1)}%</span>}
            <span>{formatBytes(job.downloadedBytes)} of {formatBytes(job.totalBytes, { empty: 'unknown size' })}</span>
            {job.resumable === true && <span className="ok-text"><ShieldCheck size={12} /> Resumable</span>}
            {job.resumable === false && <span className="warn-text"><ShieldAlert size={12} /> No resume support</span>}
          </p>
        </div>
        <div className="details-actions">
          {active || job.status === 'queued' ? (
            <button type="button" className="btn btn-sm" onClick={() => runAction('pause', [job.id])}><Pause size={14} /> Pause</button>
          ) : job.status !== 'completed' ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => runAction('resume', [job.id])}><Play size={14} /> {job.status === 'failed' ? 'Retry' : 'Resume'}</button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => runAction('openFile', job.id)}><ExternalLink size={14} /> Open</button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => runAction('showInFolder', job.id)} disabled={!job.destination}><FolderOpen size={14} /> Folder</button>
          <button type="button" className="btn btn-sm" onClick={() => onProperties(job.id)}><Settings2 size={14} /> Properties</button>
        </div>
      </div>

      <div className="tabs">
        {[['overview', 'Overview'], ['connections', `Connections${job.segments?.length ? ` (${job.activeConnections || 0}/${job.connections})` : ''}`], ['request', 'Request & integrity']].map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="details-grid">
          <div className="details-map">
            <div className="map-head"><span><Layers size={13} /> Segment map</span><em>{job.status === 'completed' ? 'complete' : job.segmented ? `${segments.length} segment${segments.length === 1 ? '' : 's'} · dynamic` : 'single stream'}</em></div>
            <SegmentMap job={job} />
            <div className="map-head speed-head"><span><Zap size={13} /> Speed</span><em>{job.status === 'downloading' ? formatSpeed(job.speed) : '—'}</em></div>
            <Sparkline data={history?.length ? history : [0, 0]} height={46} className="details-spark" />
          </div>
          <div className="info-grid">
            <Info label="Speed">{job.status === 'downloading' ? formatSpeed(job.speed) : '—'}</Info>
            <Info label="Time left">{job.status === 'downloading' ? formatDuration(job.eta) : '—'}</Info>
            <Info label="Connections">{active ? `${job.activeConnections || 0} of ${job.connections}` : `${job.connections} max`}</Info>
            <Info label="Speed limit">{job.speedLimitKBps ? `${job.speedLimitKBps} KB/s` : 'Global'}</Info>
            <Info label="Server">{hostOf(job.finalUrl || job.url) || '—'}</Info>
            <Info label="Type">{job.mimeType ? job.mimeType.split(';')[0] : '—'}</Info>
            <Info label="Added">{formatDate(job.createdAt)}</Info>
            <Info label="Finished">{formatDate(job.completedAt)}</Info>
            <div className="info info-wide"><span>Saved to</span><b className="mono" title={job.destination || ''}>{job.destination || (job.folder ? `${job.folder} (pending)` : 'Decided when the download starts')}</b></div>
            {(job.error || job.note) && <div className={`info info-wide ${job.error ? 'info-bad' : ''}`}><span>{job.error ? 'Error' : 'Note'}</span><b>{job.error || job.note}</b></div>}
          </div>
        </div>
      )}

      {tab === 'connections' && (
        <div className="conn-list">
          {segments.length === 0 ? <p className="muted">Connections appear when the download starts.</p> : (
            <table>
              <thead><tr><th>#</th><th>Byte range</th><th>Downloaded</th><th>Progress</th><th>State</th></tr></thead>
              <tbody>
                {segments.map((s, i) => {
                  const len = s.end - s.start + 1;
                  const p = Math.min(100, (s.received / len) * 100);
                  return (
                    <tr key={`${s.start}-${i}`}>
                      <td>{i + 1}</td>
                      <td className="mono">{s.start.toLocaleString()} – {s.end.toLocaleString()}</td>
                      <td className="mono">{formatBytes(s.received)} / {formatBytes(len)}</td>
                      <td><div className={`bar mini ${s.busy ? 'bar-downloading' : p >= 100 ? 'bar-completed' : 'bar-paused'}`}><i style={{ width: `${p}%` }} /></div></td>
                      <td>{s.busy ? <span className="st st-live">Receiving</span> : p >= 100 ? <span className="st st-ok">Done</span> : <span className="st st-mute">Waiting</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'request' && (
        <div className="request-grid">
          <div className="info info-wide"><span>Address</span><b className="mono">{job.url}<button type="button" className="inline-btn" onClick={() => copy(job.url, 'Address')}><Copy size={12} /></button></b></div>
          {job.finalUrl && job.finalUrl !== job.url && <div className="info info-wide"><span>Redirected to</span><b className="mono">{job.finalUrl}</b></div>}
          <Info label="Referrer" mono>{job.referrer || '—'}</Info>
          <Info label="Cookies">{job.cookies ? `${job.cookies.split(';').length} sent` : 'None'}</Info>
          <Info label="Authentication">{job.auth?.username ? `Basic · ${job.auth.username}` : 'None'}</Info>
          <Info label="Custom headers">{Object.keys(job.headers || {}).length || 'None'}</Info>
          <Info label="ETag" mono>{job.etag || '—'}</Info>
          <Info label="Last modified">{job.lastModified || '—'}</Info>
          <div className="info info-wide">
            <span>Integrity</span>
            <b className="hash-row">
              {job.checksum?.expected && (
                <span className={job.checksum.verified ? 'ok-text' : job.checksum.verified === false ? 'bad-text' : ''}>
                  {job.checksum.verified ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />} {job.checksum.algo.toUpperCase()} {job.checksum.verified ? 'verified' : job.checksum.verified === false ? 'mismatch' : 'pending'}
                </span>
              )}
              {job.hashes?.sha256 ? (
                <span className="mono hash">SHA-256 {job.hashes.sha256}<button type="button" className="inline-btn" onClick={() => copy(job.hashes.sha256, 'Hash')}><Copy size={12} /></button></span>
              ) : (
                <button type="button" className="btn btn-sm" disabled={job.status !== 'completed' || hashing} onClick={computeHash}>
                  {hashing ? <LoaderCircle size={13} className="spin" /> : <Fingerprint size={13} />} Calculate SHA-256
                </button>
              )}
            </b>
          </div>
        </div>
      )}
    </section>
  );
}
