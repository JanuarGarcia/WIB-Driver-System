import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTeamFilter } from '../context/TeamFilterContext';
import { api, formatDate } from '../api';

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

const SOUND_MUTED_KEY = 'wib_dashboard_sound_muted';
function getStoredSoundMuted() {
  try { return localStorage.getItem(SOUND_MUTED_KEY) === '1'; } catch (_) { return false; }
}

export default function MainHeader({ onMenuClick, onOpenNewTask }) {
  const location = useLocation();
  const title = getPageTitle(location.pathname);
  const { teams, selectedTeamId, setSelectedTeamId } = useTeamFilter();
  const [soundMuted, setSoundMuted] = useState(getStoredSoundMuted);
  const [language, setLanguage] = useState('en');
  const [languageSaving, setLanguageSaving] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const notifRef = useRef(null);

  useEffect(() => {
    api('settings').then((s) => {
      const lang = (s.language || s.app_default_language || 'en').toString().trim() || 'en';
      setLanguage(lang);
    }).catch(() => {});
  }, []);

  const handleLanguageChange = (e) => {
    const value = (e.target.value || 'en').trim();
    setLanguage(value);
    setLanguageSaving(true);
    api('settings/translation', { method: 'PUT', body: JSON.stringify({ app_default_language: value, app_language: value }) })
      .catch(() => {})
      .finally(() => setLanguageSaving(false));
  };

  const toggleSound = () => {
    setSoundMuted((prev) => {
      const next = !prev;
      try { localStorage.setItem(SOUND_MUTED_KEY, next ? '1' : '0'); } catch (_) {}
      return next;
    });
  };

  useEffect(() => {
    if (!notificationsOpen) return;
    setNotificationsLoading(true);
    api('notifications?limit=30')
      .then((list) => setNotifications(Array.isArray(list) ? list : []))
      .catch(() => setNotifications([]))
      .finally(() => setNotificationsLoading(false));
  }, [notificationsOpen]);

  useEffect(() => {
    if (!notificationsOpen) return;
    const handleClickOutside = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotificationsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [notificationsOpen]);

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
            <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
          </svg>
        </button>
        <select
          className="main-header-team-select"
          aria-label="Team filter"
          title="Filter dashboard data by delivery team"
          value={selectedTeamId}
          onChange={(e) => setSelectedTeamId(e.target.value)}
        >
          <option value="">All Team</option>
          {(teams || []).map((t) => (
            <option key={t.id} value={String(t.id)}>{t.name || `Team ${t.id}`}</option>
          ))}
        </select>
        <h1 className="main-header-title">{title}</h1>
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
        <button
          type="button"
          className="main-header-icon"
          aria-label={soundMuted ? 'Unmute sound' : 'Mute sound'}
          aria-pressed={soundMuted}
          onClick={toggleSound}
          title={soundMuted ? 'Turn dashboard notification sounds on' : 'Mute dashboard notification sounds'}
        >
          <span className="main-header-icon-inner">
            {soundMuted ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
            )}
          </span>
        </button>
        <div className="main-header-notif-wrap" ref={notifRef}>
          <button
            type="button"
            className="main-header-icon"
            aria-label="Notifications"
            title="View recent system notifications"
            aria-expanded={notificationsOpen}
            onClick={() => setNotificationsOpen((o) => !o)}
          >
            <span className="main-header-icon-inner">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
            </span>
          </button>
          {notificationsOpen && (
            <div className="main-header-notif-dropdown">
              <div className="main-header-notif-title">Notifications</div>
              {notificationsLoading ? (
                <div className="main-header-notif-loading">Loading…</div>
              ) : notifications.length === 0 ? (
                <div className="main-header-notif-empty">No notifications</div>
              ) : (
                <ul className="main-header-notif-list">
                  {notifications.slice(0, 20).map((n) => (
                    <li key={n.id ?? n.date} className="main-header-notif-item">
                      <span className="main-header-notif-item-title">{n.title ?? 'Notification'}</span>
                      {n.message && <span className="main-header-notif-item-msg">{n.message}</span>}
                      <span className="main-header-notif-item-date">{formatDate(n.date)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <Link to="/settings" className="main-header-icon" aria-label="Settings" title="App settings, map keys, and preferences">
          <span className="main-header-icon-inner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          </span>
        </Link>
      </div>
    </header>
  );
}
