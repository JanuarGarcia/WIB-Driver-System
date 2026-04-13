import { createElement } from 'react';
import { toast } from 'react-toastify';

const DEFAULT_AUTO_MS = 12500;

/** @typedef {'mangan' | 'task' | 'mixed'} RiderNotifOrderKind */

/**
 * Infer Mangan (ErrandWib) vs food task from copy (title / message / lines).
 * @param {{ title?: unknown, message?: unknown, tertiary?: unknown, byLine?: unknown, byLabel?: unknown }} parts
 * @returns {RiderNotifOrderKind}
 */
export function inferNotificationOrderKind(parts) {
  const blob = [parts?.title, parts?.message, parts?.tertiary, parts?.byLine, parts?.byLabel]
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => String(x).toLowerCase())
    .join(' ');
  if (/\bmangan\b/.test(blob) || /\b(errand|mangan)\s+order\b/.test(blob)) return 'mangan';
  return 'task';
}

function orderKindLabel(kind) {
  if (kind === 'mangan') return 'Mangan';
  if (kind === 'mixed') return 'Mixed';
  return 'Task';
}

function orderKindBadge(kind) {
  const k = kind === 'mangan' || kind === 'mixed' ? kind : 'task';
  const label = orderKindLabel(k);
  const aria =
    k === 'mangan' ? 'Mangan order notification' : k === 'mixed' ? 'Mixed task and Mangan notifications' : 'Task order notification';
  return createElement(
    'span',
    { className: 'rider-notif-toast-kind', 'aria-label': aria },
    label
  );
}

/**
 * Standard dashboard toast: one card layout (olive accent + progress). Order type is a small text chip (Mangan / Task / Mixed).
 * @param {object} opts
 * @param {string|number} [opts.toastId]
 * @param {string} opts.title
 * @param {string} [opts.byLabel] — actor only, or full "By …" (either is accepted)
 * @param {string} [opts.byLine] — full secondary line as shown (skips automatic "By …" wrapping)
 * @param {string} [opts.tertiary] — muted line (e.g. order ref)
 * @param {'mangan'|'task'|'mixed'} [opts.orderKind] — optional; otherwise inferred from title/lines
 * @param {() => void} [opts.onOpen] — when set, toast opens task/timeline and dismisses on click
 * @param {number} [opts.autoCloseMs]
 */
export function showRiderSystemToast(opts) {
  const o = opts || {};
  const title = (o.title || 'Notification').toString();
  const explicit = o.orderKind;
  const kind =
    explicit === 'mangan' || explicit === 'task' || explicit === 'mixed'
      ? explicit
      : inferNotificationOrderKind({
          title: o.title,
          message: o.message,
          tertiary: o.tertiary,
          byLine: o.byLine,
          byLabel: o.byLabel,
        });
  const fullByLine = (o.byLine || '').toString().trim();
  const rawBy = (o.byLabel || '').toString().trim();
  const byLine =
    fullByLine !== ''
      ? fullByLine
      : rawBy === ''
        ? null
        : /^by\s+/i.test(rawBy)
          ? rawBy
          : `By ${rawBy}`;
  const tertiary = (o.tertiary || '').toString().trim();
  const onOpen = typeof o.onOpen === 'function' ? o.onOpen : null;
  const tid = o.toastId != null ? String(o.toastId) : `wib-sys-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const autoClose =
    typeof o.autoCloseMs === 'number' && Number.isFinite(o.autoCloseMs) && o.autoCloseMs > 0
      ? o.autoCloseMs
      : DEFAULT_AUTO_MS;

  const body = createElement(
    'div',
    { className: 'rider-notif-toast-inner' },
    orderKindBadge(kind),
    createElement(
      'div',
      { className: 'rider-notif-toast-stacked' },
      createElement('div', { className: 'rider-notif-toast-line1' }, title),
      byLine ? createElement('div', { className: 'rider-notif-toast-line-by' }, byLine) : null,
      tertiary ? createElement('div', { className: 'rider-notif-toast-line2' }, tertiary) : null
    )
  );

  toast.info(body, {
    toastId: tid,
    icon: false,
    autoClose,
    className: 'rider-notif-toast',
    bodyClassName: 'rider-notif-toast-body',
    progressClassName: 'rider-notif-toast-progress',
    pauseOnHover: true,
    closeOnClick: !onOpen,
    onClick: onOpen
      ? () => {
          onOpen();
          toast.dismiss(tid);
        }
      : undefined,
  });
}
