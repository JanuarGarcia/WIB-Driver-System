import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { isAuthenticated } from '../auth';
import { useTeamFilter } from '../context/TeamFilterContext';
import { useNotifications, RIDER_NOTIFICATIONS_POLL_EVENT } from '../hooks/useNotifications';
import {
  fetchOrderHistoryNotifySince,
  fetchErrandNotifySince,
  fetchTaskPhotoNotifySince,
} from '../services/notificationApi';
import NotificationBell from './NotificationBell';
import NotificationPanel from './NotificationPanel';
import NotificationMuteToggle from './NotificationMuteToggle';

const STORAGE_MT_NOTIFY_CURSOR = 'wib_notify_mt_history_cursor';
const STORAGE_ERRAND_NOTIFY_CURSOR = 'wib_notify_errand_history_cursor';
const STORAGE_TASK_PHOTO_NOTIFY_CURSOR = 'wib_notify_task_photo_cursor';

const PATH_TITLES = {
  '/': 'Dashboard',
  '/tasks': 'Tasks',
  '/drivers': 'Drivers',
  '/new-task': 'New Task',
  '/settings': 'Settings',
  '/teams': 'Teams',
  '/merchants': 'Merchants',
  '/push-logs': 'Push Logs',
  '/broadcast-logs': 'Push Broadcast Logs',
  '/driver-trackback': 'Driver Track Back',
  '/notifications': 'Notifications',
  '/assignment': 'Assignment',
  '/reports': 'Reports',
  '/sms-logs': 'SMS Logs',
  '/email-logs': 'Email Logs',
  '/map-api-logs': 'Maps API Logs',
};

function getPageTitle(pathname) {
  if (PATH_TITLES[pathname]) return PATH_TITLES[pathname];
  for (const [path, title] of Object.entries(PATH_TITLES)) {
    if (path !== '/' && pathname.startsWith(path)) return title;
  }
  return 'Dashboard';
}

export default function MainHeader({ onMenuClick, onOpenNewTask }) {
  const location = useLocation();
  const title = getPageTitle(location.pathname);
  const { teams, selectedTeamId, setSelectedTeamId } = useTeamFilter();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notifRef = useRef(null);

  const {
    items: riderNotifications,
    unreadCount,
    pollError,
    markAllRead,
    acknowledgePanelOpen,
    primeNotificationSound,
  } = useNotifications();

  useEffect(() => {
    if (!notificationsOpen) return;
    const handleClickOutside = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotificationsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [notificationsOpen]);

  useEffect(() => {
    if (notificationsOpen) acknowledgePanelOpen();
  }, [notificationsOpen, acknowledgePanelOpen]);

  /** Poll global history cursors on every page so bell + fan-out run without opening the dashboard timeline. */
  useEffect(() => {
    if (!isAuthenticated()) return undefined;
    let cancelled = false;
    const intervalMs = 7000;

    const tick = async () => {
      if (cancelled) return;
      try {
        let mtAfter = 0;
        try {
          mtAfter = parseInt(sessionStorage.getItem(STORAGE_MT_NOTIFY_CURSOR) || '0', 10) || 0;
        } catch (_) {
          mtAfter = 0;
        }
        const mtData = await fetchOrderHistoryNotifySince(mtAfter);
        if (cancelled) return;
        const mtNext = Number(mtData.cursor);
        const mtProcessed = Number(mtData.processed) || 0;
        if (Number.isFinite(mtNext)) {
          if (mtAfter === 0) {
            sessionStorage.setItem(STORAGE_MT_NOTIFY_CURSOR, String(mtNext));
          } else if (mtNext > mtAfter) {
            sessionStorage.setItem(STORAGE_MT_NOTIFY_CURSOR, String(mtNext));
            if (mtProcessed > 0) {
              window.dispatchEvent(new CustomEvent(RIDER_NOTIFICATIONS_POLL_EVENT, { detail: { delayMs: 250 } }));
            }
          }
        }

        let soAfter = 0;
        try {
          soAfter = parseInt(sessionStorage.getItem(STORAGE_ERRAND_NOTIFY_CURSOR) || '0', 10) || 0;
        } catch (_) {
          soAfter = 0;
        }
        const soData = await fetchErrandNotifySince(soAfter);
        if (cancelled) return;
        const soNext = Number(soData.cursor);
        const soProcessed = Number(soData.processed) || 0;
        if (Number.isFinite(soNext)) {
          if (soAfter === 0) {
            sessionStorage.setItem(STORAGE_ERRAND_NOTIFY_CURSOR, String(soNext));
          } else if (soNext > soAfter) {
            sessionStorage.setItem(STORAGE_ERRAND_NOTIFY_CURSOR, String(soNext));
            if (soProcessed > 0) {
              window.dispatchEvent(new CustomEvent(RIDER_NOTIFICATIONS_POLL_EVENT, { detail: { delayMs: 250 } }));
            }
          }
        }

        let phAfter = 0;
        try {
          phAfter = parseInt(sessionStorage.getItem(STORAGE_TASK_PHOTO_NOTIFY_CURSOR) || '0', 10) || 0;
        } catch (_) {
          phAfter = 0;
        }
        const phData = await fetchTaskPhotoNotifySince(phAfter);
        if (cancelled) return;
        const phNext = Number(phData.cursor);
        const phProcessed = Number(phData.processed) || 0;
        if (Number.isFinite(phNext)) {
          if (phAfter === 0) {
            sessionStorage.setItem(STORAGE_TASK_PHOTO_NOTIFY_CURSOR, String(phNext));
          } else if (phNext > phAfter) {
            sessionStorage.setItem(STORAGE_TASK_PHOTO_NOTIFY_CURSOR, String(phNext));
            if (phProcessed > 0) {
              window.dispatchEvent(new CustomEvent(RIDER_NOTIFICATIONS_POLL_EVENT, { detail: { delayMs: 250 } }));
            }
          }
        }
      } catch (_) {
        /* ignore transient / network errors */
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const handleMarkAllRead = () => {
    markAllRead();
  };

  return (
    <header className="main-header">
      <div className="main-header-left">
        <button
          type="button"
          className="main-header-burger"
          onClick={onMenuClick}
          aria-label="Open menu"
          title="Open navigation menu"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
          </svg>
        </button>
        <div className="main-header-brand-group">
          <div className="main-header-team-select-wrap">
            <select
              className="main-header-team-select"
              aria-label="Team filter"
              title="Filter dashboard data by delivery team"
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
            >
              <option value="">All Team</option>
              {(teams || []).map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name || `Team ${t.id}`}
                </option>
              ))}
            </select>
            <span className="main-header-team-select-caret" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
          <h1 className="main-header-title">{title}</h1>
        </div>
      </div>
      <div className="main-header-actions">
        {onOpenNewTask ? (
          <button type="button" className="btn-add-task" onClick={onOpenNewTask} title="Create a new delivery task">
            Add New Task
          </button>
        ) : (
          <Link to="/new-task" className="btn-add-task" title="Create a new delivery task">
            Add New Task
          </Link>
        )}
        <NotificationMuteToggle />
        <div className="main-header-notif-wrap" ref={notifRef}>
          <NotificationBell
            unreadCount={unreadCount}
            isOpen={notificationsOpen}
            onToggle={() => {
              primeNotificationSound();
              setNotificationsOpen((o) => !o);
            }}
          />
          {notificationsOpen ? (
            <NotificationPanel
              items={riderNotifications}
              pollError={pollError}
              onMarkAllRead={handleMarkAllRead}
              onClosePanel={() => setNotificationsOpen(false)}
            />
          ) : null}
        </div>
        <Link to="/settings" className="main-header-icon" aria-label="Settings" title="App settings, map keys, and preferences">
          <span className="main-header-icon-inner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
          </span>
        </Link>
      </div>
    </header>
  );
}
