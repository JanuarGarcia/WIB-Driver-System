import {
  parseActorFromNotificationMessage,
  formatNotificationMessageForDisplay,
  parseTaskIdFromNotificationMessage,
  dispatchOpenTaskFromNotification,
  buildNotificationDedupeKey,
  notificationOrderKind,
} from '../utils/riderNotificationNavigate';

function formatWhen(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatRelative(iso) {
  if (!iso) return { short: '-', full: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { short: '-', full: '' };
  const now = Date.now();
  const diffSec = Math.round((now - d.getTime()) / 1000);
  const full = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (diffSec < 45) return { short: 'Just now', full };
  if (diffSec < 3600) return { short: `${Math.max(1, Math.floor(diffSec / 60))}m ago`, full };
  if (diffSec < 86400) return { short: `${Math.floor(diffSec / 3600)}h ago`, full };
  if (diffSec < 172800) return { short: 'Yesterday', full };
  return { short: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), full };
}

function typeMeta(type, title, message) {
  const t = (type || '').toString().trim().toLowerCase();
  const titleText = String(title || '').toLowerCase();
  const messageText = String(message || '').toLowerCase();
  const isNewOrder =
    t === 'new_task' &&
    (titleText.includes('new task') ||
      titleText.includes('new mangan') ||
      titleText.includes('task broadcast') ||
      titleText.includes('auto-assign retry') ||
      messageText.includes('mangan order') ||
      messageText.includes('order #') ||
      messageText.includes('task #'));

  switch (t) {
    case 'new_task':
      return isNewOrder
        ? { label: 'New order', mod: 'rider-notif-card--new-order' }
        : { label: 'Task update', mod: 'rider-notif-card--new' };
    case 'task_accepted':
      return { label: 'Accepted', mod: 'rider-notif-card--accepted' };
    case 'task_done':
      return { label: 'Completed', mod: 'rider-notif-card--done' };
    case 'task_photo':
      return { label: 'Photo', mod: 'rider-notif-card--done' };
    case 'task_photo_receipt':
      return { label: 'Receipt', mod: 'rider-notif-card--rfp' };
    case 'task_photo_delivery':
      return { label: 'Delivery proof', mod: 'rider-notif-card--done' };
    case 'task_assigned':
    case 'assign':
      return { label: 'Assign', mod: 'rider-notif-card--assign' };
    case 'ready_pickup':
      return { label: 'Ready for pickup', mod: 'rider-notif-card--rfp' };
    default:
      return { label: 'Alert', mod: 'rider-notif-card--default' };
  }
}

export default function NotificationPanel({ items, pollError, onMarkAllRead, onClosePanel }) {
  const count = items?.length ?? 0;

  return (
    <div className="rider-notif-panel" role="region" aria-label="Notifications">
      {pollError ? (
        <div className="rider-notif-panel__error" role="alert">
          {pollError}
        </div>
      ) : null}
      <header className="rider-notif-panel__header">
        <div className="rider-notif-panel__header-main">
          <button
            type="button"
            className="rider-notif-panel__back"
            onClick={onClosePanel}
            aria-label="Close notifications"
            title="Back"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Back</span>
          </button>
          <div className="rider-notif-panel__header-text">
            <h2 className="rider-notif-panel__title">Notifications</h2>
            <p className="rider-notif-panel__subtitle">
              {count === 0 ? "You're all caught up" : `${count} in this session`}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="rider-notif-panel__markall"
          onClick={onMarkAllRead}
          disabled={count === 0}
        >
          Clear all
        </button>
      </header>

      <div className="rider-notif-panel__body">
        {!items || items.length === 0 ? (
          <div className="rider-notif-panel__empty">
            <div className="rider-notif-panel__empty-icon" aria-hidden="true">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
            <p className="rider-notif-panel__empty-title">No notifications yet</p>
            <p className="rider-notif-panel__empty-hint">New tasks and rider updates will show here.</p>
          </div>
        ) : (
          <ul className="rider-notif-panel__list">
            {items.map((n) => {
              const { label, mod } = typeMeta(n.type, n.title, n.message);
              const displayAt = n.activityAt || n.createdAt;
              const rel = formatRelative(displayAt);
              const unread = !n.localRead;
              const orderKind = notificationOrderKind(n);
              const orderKindLabel = orderKind === 'mangan' ? 'Mangan order' : orderKind === 'task' ? 'Task order' : null;
              const actor = n.message ? parseActorFromNotificationMessage(n.message) : '';
              const messageMain = n.message ? formatNotificationMessageForDisplay(n.message) : '';
              const taskNavId = n.message ? parseTaskIdFromNotificationMessage(n.message) : null;
              const canOpenTask = taskNavId != null;
              const rowKey = `${buildNotificationDedupeKey(n)}:${n.id ?? ''}`;

              return (
                <li key={rowKey}>
                  <article
                    className={`rider-notif-card ${mod}${unread ? ' rider-notif-card--unread' : ''}${
                      canOpenTask ? ' rider-notif-card--clickable' : ''
                    }`}
                    aria-label={`${label}: ${n.title || 'Notification'}`}
                  >
                    {canOpenTask ? (
                      <button
                        type="button"
                        className="rider-notif-card__hit"
                        onClick={() => {
                          dispatchOpenTaskFromNotification(taskNavId);
                          onClosePanel?.();
                        }}
                      >
                        <div className="rider-notif-card__top">
                          <span className="rider-notif-card__badge">{label}</span>
                          <div className="rider-notif-card__top-right">
                            {orderKind ? (
                              <span
                                className={`rider-notif-card__order-kind rider-notif-card__order-kind--${orderKind}`}
                                title={orderKindLabel}
                              >
                                {orderKindLabel}
                              </span>
                            ) : null}
                            {unread ? <span className="rider-notif-card__dot" title="Unread" /> : null}
                          </div>
                        </div>
                        <h3 className="rider-notif-card__title">{n.title || 'Notification'}</h3>
                        {actor ? (
                          <p className="rider-notif-card__actor">
                            <span className="rider-notif-card__actor-label">By</span> {actor}
                          </p>
                        ) : null}
                        {messageMain ? <p className="rider-notif-card__message">{messageMain}</p> : null}
                        <span className="rider-notif-card__open-hint">Open task</span>
                      </button>
                    ) : (
                      <div className="rider-notif-card__hit rider-notif-card__hit--static">
                        <div className="rider-notif-card__top">
                          <span className="rider-notif-card__badge">{label}</span>
                          <div className="rider-notif-card__top-right">
                            {orderKind ? (
                              <span
                                className={`rider-notif-card__order-kind rider-notif-card__order-kind--${orderKind}`}
                                title={orderKindLabel}
                              >
                                {orderKindLabel}
                              </span>
                            ) : null}
                            {unread ? <span className="rider-notif-card__dot" title="Unread" /> : null}
                          </div>
                        </div>
                        <h3 className="rider-notif-card__title">{n.title || 'Notification'}</h3>
                        {actor ? (
                          <p className="rider-notif-card__actor">
                            <span className="rider-notif-card__actor-label">By</span> {actor}
                          </p>
                        ) : null}
                        {messageMain ? <p className="rider-notif-card__message">{messageMain}</p> : null}
                      </div>
                    )}
                    <footer className="rider-notif-card__footer">
                      <time className="rider-notif-card__time" dateTime={displayAt} title={rel.full || formatWhen(displayAt)}>
                        {rel.short}
                      </time>
                      <span className="rider-notif-card__time-full" aria-hidden="true">
                        {formatWhen(displayAt)}
                      </span>
                    </footer>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
