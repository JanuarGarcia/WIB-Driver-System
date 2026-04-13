import { createElement } from 'react';
import { toast } from 'react-toastify';

const DEFAULT_AUTO_MS = 12500;

function infoIcon() {
  return createElement(
    'span',
    { className: 'rider-notif-toast-info-icon', 'aria-hidden': 'true' },
    'i'
  );
}

/**
 * Standard dashboard toast: dark card, olive accent + progress, blue info mark, close control.
 * @param {object} opts
 * @param {string|number} [opts.toastId]
 * @param {string} opts.title
 * @param {string} [opts.byLabel] — actor only, or full "By …" (either is accepted)
 * @param {string} [opts.byLine] — full secondary line as shown (skips automatic "By …" wrapping)
 * @param {string} [opts.tertiary] — muted line (e.g. order ref)
 * @param {() => void} [opts.onOpen] — when set, toast opens task/timeline and dismisses on click
 * @param {number} [opts.autoCloseMs]
 */
export function showRiderSystemToast(opts) {
  const o = opts || {};
  const title = (o.title || 'Notification').toString();
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
    infoIcon(),
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
