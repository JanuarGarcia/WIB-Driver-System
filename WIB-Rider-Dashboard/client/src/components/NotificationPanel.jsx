function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Short relative label + full string for title tooltip */
function formatRelative(iso) {
  if (!iso) return { short: '—', full: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { short: '—', full: '' };
  const now = Date.now();
  const diffSec = Math.round((now - d.getTime()) / 1000);
  const full = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (diffSec < 45) return { short: 'Just now', full };
  if (diffSec < 3600) return { short: `${Math.max(1, Math.floor(diffSec / 60))}m ago`, full };
  if (diffSec < 86400) return { short: `${Math.floor(diffSec / 3600)}h ago`, full };
  if (diffSec < 172800) return { short: 'Yesterday', full };
  return { short: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), full };
}

/**
 * Map API `type` to display label + CSS modifier for accent color.
 */
function typeMeta(type) {
  const t = (type || '').toString().trim().toLowerCase();
  switch (t) {
    case 'new_task':
      return { label: 'New task', mod: 'rider-notif-card--new' };
    case 'task_accepted':
      return { label: 'Accepted', mod: 'rider-notif-card--accepted' };
    case 'task_done':
      return { label: 'Completed', mod: 'rider-notif-card--done' };
    case 'task_assigned':
    case 'assign':
      return { label: 'Assign', mod: 'rider-notif-card--assign' };
    case 'ready_pickup':
      return { label: 'Ready for pickup', mod: 'rider-notif-card--rfp' };
    default:
      return { label: 'Alert', mod: 'rider-notif-card--default' };
  }
}

import {
  parseActorFromNotificationMessage,
  stripActorSuffixForDisplay,
  parseTaskIdFromNotificationMessage,
  dispatchOpenTaskFromNotification,
} from '../utils/riderNotificationNavigate';

/**
 * Dropdown list of session notifications — WIB dashboard styling.
 */
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
        <div className="rider-notif-panel__header-text">
          <h2 className="rider-notif-panel__title">Notifications</h2>
          <p className="rider-notif-panel__subtitle">
            {count === 0 ? 'You’re all caught up' : `${count} in this session`}
          </p>
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
              const { label, mod } = typeMeta(n.type);
              const rel = formatRelative(n.createdAt);
              const unread = !n.localRead;
              const actor = n.message ? parseActorFromNotificationMessage(n.message) : '';
              const messageMain = n.message ? stripActorSuffixForDisplay(n.message) : '';
              const taskNavId = n.message ? parseTaskIdFromNotificationMessage(n.message) : null;
              const canOpenTask = taskNavId != null;

              return (
                <li key={n.id}>
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
                          {unread ? <span className="rider-notif-card__dot" title="Unread" /> : null}
                        </div>
                        <h3 className="rider-notif-card__title">{n.title || 'Notification'}</h3>
                        {actor ? (
                          <p className="rider-notif-card__actor">
                            <span className="rider-notif-card__actor-label">By</span> {actor}
                          </p>
                        ) : null}
                        {messageMain ? (
                          <p className="rider-notif-card__message">{messageMain}</p>
                        ) : null}
                        <span className="rider-notif-card__open-hint">Open task</span>
                      </button>
                    ) : (
                      <div className="rider-notif-card__hit rider-notif-card__hit--static">
                        <div className="rider-notif-card__top">
                          <span className="rider-notif-card__badge">{label}</span>
                          {unread ? <span className="rider-notif-card__dot" title="Unread" /> : null}
                        </div>
                        <h3 className="rider-notif-card__title">{n.title || 'Notification'}</h3>
                        {actor ? (
                          <p className="rider-notif-card__actor">
                            <span className="rider-notif-card__actor-label">By</span> {actor}
                          </p>
                        ) : null}
                        {messageMain ? (
                          <p className="rider-notif-card__message">{messageMain}</p>
                        ) : null}
                      </div>
                    )}
                    <footer className="rider-notif-card__footer">
                      <time className="rider-notif-card__time" dateTime={n.createdAt} title={rel.full || formatWhen(n.createdAt)}>
                        {rel.short}
                      </time>
                      <span className="rider-notif-card__time-full" aria-hidden="true">
                        {formatWhen(n.createdAt)}
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
