import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive, AppWindow, File, FileText, Film, Image as ImageIcon, Music, X, ChevronDown, Check,
} from 'lucide-react';
import { extOf } from '../lib/format.js';

export function Modal({ title, subtitle, icon: Icon, onClose, children, footer, width = 560, busy = false, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey, true);
    const first = ref.current?.querySelector('[data-autofocus], input, textarea, select, button.btn-primary');
    first?.focus?.();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, busy]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}>
      <div ref={ref} className={`modal ${className}`} style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          {Icon && <span className="modal-icon"><Icon size={18} /></span>}
          <div className="modal-titles"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button type="button" className="icon-btn ghost" onClick={onClose} disabled={busy} aria-label="Close"><X size={17} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={Boolean(checked)} aria-label={label} disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button>
  );
}

export function Field({ label, hint, children, inline = false, className = '' }) {
  return (
    <div className={`field ${inline ? 'field-inline' : ''} ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Segmented({ value, options, onChange, size = 'md' }) {
  return (
    <div className={`segmented seg-${size}`} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <o.icon size={14} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/** Popover menu anchored to a trigger button. */
export function Dropdown({ trigger, children, align = 'left', width = 220, className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const left = align === 'right' ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
    setPos({ left, top: r.bottom + 6 });
  }, [open, align, width]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', () => setOpen(false), { once: true });
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <>
      {trigger({ ref: btn, open, toggle: () => setOpen((v) => !v) })}
      {open && pos && createPortal(
        <div ref={menu} className={`menu ${className}`} style={{ left: pos.left, top: pos.top, width }} onClick={(e) => { if (e.target.closest('[data-close]')) setOpen(false); }}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>,
        document.body,
      )}
    </>
  );
}

export function MenuItem({ icon: Icon, label, hint, onClick, danger, checked, disabled }) {
  return (
    <button type="button" className={`menu-item ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled} data-close>
      <span className="menu-icon">{checked != null ? (checked ? <Check size={14} /> : null) : Icon ? <Icon size={15} /> : null}</span>
      <span className="menu-label">{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
}
export const MenuSep = () => <div className="menu-sep" />;
export const MenuTitle = ({ children }) => <div className="menu-title">{children}</div>;

/** Right-click menu rendered at the cursor and clamped to the viewport. */
export function ContextMenu({ x, y, onClose, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y]);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); window.removeEventListener('blur', onClose); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="menu context" style={pos} onClick={(e) => { if (e.target.closest('[data-close]')) onClose(); }} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

const GLYPHS = { video: Film, music: Music, documents: FileText, images: ImageIcon, compressed: Archive, programs: AppWindow, other: File };
export function FileGlyph({ category = 'other', name = '', size = 'md' }) {
  const Icon = GLYPHS[category] || File;
  const ext = extOf(name).slice(0, 4).toUpperCase();
  return (
    <span className={`glyph glyph-${category} glyph-${size}`} aria-hidden="true">
      <Icon size={size === 'lg' ? 22 : 15} strokeWidth={1.9} />
      {size !== 'sm' && ext && <b>{ext}</b>}
    </span>
  );
}

/** Lightweight SVG area sparkline. */
export function Sparkline({ data = [], height = 40, className = '', max: forcedMax }) {
  const width = 240;
  const points = data.length ? data : [0];
  const max = Math.max(forcedMax || 0, Math.max(...points) * 1.25, 1);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((v, i) => [i * step, height - (v / max) * (height - 4) - 2]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg className={`sparkline ${className}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} className="spark-area" />
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function SelectBox({ value, onChange, options, className = '' }) {
  return (
    <span className={`select ${className}`}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={14} />
    </span>
  );
}
