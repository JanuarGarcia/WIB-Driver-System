/**
 * Header bell: opens panel + optional unread badge (session-local unread count).
 */
export default function NotificationBell({ unreadCount, isOpen, onToggle }) {
  const raw = typeof unreadCount === 'number' && unreadCount > 0 ? unreadCount : 0;
  const badgeLabel = raw > 99 ? '99+' : String(raw);

  const label =
    raw > 0 ? `Notifications, ${raw} unread` : 'Notifications';

  return (
    <button
      type="button"
      className={`main-header-icon main-header-notif-bell${isOpen ? ' main-header-notif-bell--open' : ''}`}
      aria-label={label}
      title={raw > 0 ? `Open notifications (${raw} unread)` : 'Open notifications'}
      aria-expanded={isOpen}
      onClick={onToggle}
    >
      <span className="main-header-icon-inner">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
        </svg>
        {raw > 0 ? (
          <span className="main-header-notif-badge" aria-live="polite">
            {badgeLabel}
          </span>
        ) : null}
      </span>
    </button>
  );
}
