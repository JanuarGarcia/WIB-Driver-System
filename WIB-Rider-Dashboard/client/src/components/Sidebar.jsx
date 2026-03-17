import { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { clearToken } from '../auth';
import { useTheme } from '../context/ThemeContext';

/* Place your logo at client/public/when-in-baguio-logo.png to display it; otherwise "WHEN IN Baguio" text shows */
const LOGO_IMG = '/when-in-baguio-logo.png';

const TOP_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/teams', label: 'Teams' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/merchants', label: 'Merchants' },
  { to: '/notifications', label: 'Notifications' },
  { to: '/assignment', label: 'Assignment' },
  { to: '/reports', label: 'Reports' },
];

const DRIVERS_ITEMS = [
  { to: '/drivers', label: 'Drivers' },
  { to: '/driver-trackback', label: 'Driver trackback' },
];

const LOGS_ITEMS = [
  { to: '/broadcast-logs', label: 'Broadcast logs' },
  { to: '/push-logs', label: 'Push logs' },
  { to: '/sms-logs', label: 'SMS logs' },
  { to: '/email-logs', label: 'Email logs' },
  { to: '/map-api-logs', label: 'Map API logs' },
];

function NavLink({ to, label, active, onClick }) {
  return (
    <Link
      to={to}
      className={`sidebar-nav-item ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      <span className="sidebar-nav-item-text">{label}</span>
    </Link>
  );
}

export default function Sidebar({ isOpen, onClose }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const path = location.pathname;

  const handleLogout = () => {
    clearToken();
    onClose?.();
    navigate('/login', { replace: true });
  };

  const isDriversActive = path === '/drivers' || path.startsWith('/driver-trackback');
  const isLogsActive = path.startsWith('/broadcast-logs') || path.startsWith('/push-logs') ||
    path.startsWith('/sms-logs') || path.startsWith('/email-logs') || path.startsWith('/map-api-logs');

  const [driversOpen, setDriversOpen] = useState(isDriversActive);
  const [logsOpen, setLogsOpen] = useState(isLogsActive);

  useEffect(() => {
    if (isDriversActive) setDriversOpen(true);
  }, [isDriversActive]);
  useEffect(() => {
    if (isLogsActive) setLogsOpen(true);
  }, [isLogsActive]);

  const isActive = (to) => {
    if (to === '/') return path === '/';
    return path === to || path.startsWith(to + '/');
  };

  return (
    <aside className={`app-sidebar ${isOpen ? 'app-sidebar-open' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo-wrap">
          <img
            src={LOGO_IMG}
            className="sidebar-logo-img"
            alt=""
            onError={(e) => { e.target.style.display = 'none'; e.target.nextElementSibling?.classList.add('visible'); }}
          />
          <span className="sidebar-brand-text">
            <span className="sidebar-brand-when">WIB</span>
            <span className="sidebar-brand-name"> Rider</span>
          </span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {TOP_ITEMS.map(({ to, label }) => (
          <NavLink key={to} to={to} label={label} active={isActive(to)} onClick={onClose} />
        ))}

        <div className="sidebar-nav-group">
          <button
            type="button"
            className={`sidebar-nav-item sidebar-nav-toggle ${driversOpen ? 'open' : ''} ${isDriversActive ? 'active' : ''}`}
            onClick={() => setDriversOpen((o) => !o)}
            aria-expanded={driversOpen}
          >
            <span className="sidebar-nav-item-text">Drivers</span>
            <svg className="sidebar-chevron" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 10l5 5 5-5z" />
            </svg>
          </button>
          {driversOpen && (
            <div className="sidebar-nav-sub">
              {DRIVERS_ITEMS.map(({ to, label }) => (
                <NavLink key={to} to={to} label={label} active={isActive(to)} onClick={onClose} />
              ))}
            </div>
          )}
        </div>

        <div className="sidebar-nav-group">
          <button
            type="button"
            className={`sidebar-nav-item sidebar-nav-toggle ${logsOpen ? 'open' : ''} ${isLogsActive ? 'active' : ''}`}
            onClick={() => setLogsOpen((o) => !o)}
            aria-expanded={logsOpen}
          >
            <span className="sidebar-nav-item-text">Logs</span>
            <svg className="sidebar-chevron" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 10l5 5 5-5z" />
            </svg>
          </button>
          {logsOpen && (
            <div className="sidebar-nav-sub">
              {LOGS_ITEMS.map(({ to, label }) => (
                <NavLink key={to} to={to} label={label} active={isActive(to)} onClick={onClose} />
              ))}
            </div>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-theme"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="sidebar-theme-icon-wrap">
            {theme === 'dark' ? (
              <svg className="sidebar-theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 0 0 0-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 0 0 0-1.41.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 0 0 0-1.41.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z" />
              </svg>
            ) : (
              <svg className="sidebar-theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z" />
              </svg>
            )}
          </span>
          <span className="sidebar-theme-label">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <button type="button" className="sidebar-logout" onClick={handleLogout} aria-label="Log out">
          Log out
        </button>
      </div>
    </aside>
  );
}
