export function formatBytes(bytes, { empty = '—' } = {}) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return empty;
  const value = Math.max(0, Number(bytes));
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[i]}`;
}

export const formatSpeed = (bytes) => (bytes > 0 ? `${formatBytes(bytes)}/s` : '—');

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '< 1s';
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function formatDate(value, { withTime = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400000).toDateString() === date.toDateString();
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (sameDay) return withTime ? `Today ${time}` : 'Today';
  if (yesterday) return withTime ? `Yesterday ${time}` : 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}), ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(date);
}

export function hostOf(value = '') {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function extOf(name = '') {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

export const STATUS_LABEL = {
  queued: 'Queued', scheduled: 'In queue', connecting: 'Connecting', downloading: 'Downloading', finishing: 'Finishing',
  paused: 'Paused', completed: 'Completed', failed: 'Failed',
};

export const isActive = (status) => status === 'connecting' || status === 'downloading' || status === 'finishing';
export const isWaiting = (status) => status === 'queued' || status === 'scheduled';

export function percentOf(job) {
  if (job.status === 'completed') return 100;
  if (!job.totalBytes) return null;
  return Math.max(0, Math.min(100, ((job.downloadedBytes || 0) / job.totalBytes) * 100));
}
