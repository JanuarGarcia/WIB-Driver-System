import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

const MENU_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/drivers', label: 'Drivers' },
  { to: '/teams', label: 'Teams' },
  { to: '/push-logs', label: 'Push Logs' },
  { to: '/broadcast-logs', label: 'Broadcast' },
  { to: '/settings', label: 'Settings' },
];

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  const closeMenu = () => setMenuOpen(false);

  return (
    <>
      <header className="header">
        <div className="header-left">
          <select className="header-select" defaultValue="">
            <option value="">All Team</option>
          </select>
          <input type="text" className="header-search" placeholder="Search map" />
        </div>
        <div className="header-center">
          <Link to="/" className="header-title" style={{ color: 'inherit', textDecoration: 'none' }}>WIB Rider</Link>
        </div>
        <div className="header-right">
          <Link to="/new-task" className="btn-add-task">+ Add New Task</Link>
          <button
            type="button"
            className="header-icon header-burger"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>
          </button>
          <button type="button" className="header-icon" aria-label="Sound">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          </button>
          <button type="button" className="header-icon" aria-label="Notifications">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
          </button>
          <button type="button" className="header-icon" aria-label="Logout">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8h5z"/></svg>
          </button>
        </div>
      </header>

      {/* Burger menu overlay – new screen with list */}
      {menuOpen && (
        <div className="burger-overlay" role="dialog" aria-label="Menu">
          <div className="burger-backdrop" onClick={closeMenu} />
          <div className="burger-panel">
            <div className="burger-panel-header">
              <span className="burger-panel-title">Menu</span>
              <button type="button" className="burger-close" aria-label="Close menu" onClick={closeMenu}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
            <nav className="burger-nav">
              {MENU_ITEMS.map(({ to, label }) => {
                const active = location.pathname === to || (to !== '/' && location.pathname.startsWith(to));
                return (
                  <Link
                    key={to}
                    to={to}
                    className={`burger-nav-item ${active ? 'burger-nav-item-active' : ''}`}
                    onClick={closeMenu}
                  >
                    {label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
