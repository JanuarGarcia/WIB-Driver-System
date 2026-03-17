import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useTeamFilter } from '../context/TeamFilterContext';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';

const TABS = ['active', 'offline', 'total'];
const SORT_OPTIONS = [
  { key: 'name-asc', label: 'Name A–Z' },
  { key: 'name-desc', label: 'Name Z–A' },
  { key: 'status', label: 'By status' },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function AgentPanel() {
  const navigate = useNavigate();
  const { selectedTeamId } = useTeamFilter();
  const [details, setDetails] = useState({ active: [], offline: [], total: [] });
  const [activeTab, setActiveTab] = useState('active');
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const [sortBy, setSortBy] = useState('name-asc');
  const [selectedDriver, setSelectedDriver] = useState(null);
  const searchInputRef = useRef(null);
  const filterRef = useRef(null);
  const detailModalRef = useRef(null);

  function loadAgents() {
    setLoading(true);
    const params = new URLSearchParams();
    params.set('date', todayStr());
    if (selectedTeamId != null && selectedTeamId !== '') params.set('team_id', String(selectedTeamId));
    if ((searchQuery || '').trim()) params.set('agent_name', searchQuery.trim());
    api(`driver/agent-dashboard?${params}`)
      .then((res) => {
        const d = res?.details || {};
        setDetails({
          active: Array.isArray(d.active) ? d.active : [],
          offline: Array.isArray(d.offline) ? d.offline : [],
          total: Array.isArray(d.total) ? d.total : [],
        });
      })
      .catch(() => setDetails({ active: [], offline: [], total: [] }))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAgents();
  }, []);

  useEffect(() => {
    loadAgents();
  }, [selectedTeamId]);

  useTableAutoRefresh(loadAgents, 15000);

  const handleRefresh = () => {
    loadAgents();
  };

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (filterRef.current && !filterRef.current.contains(e.target)) {
        setFilterDropdownOpen(false);
      }
    }
    if (filterDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [filterDropdownOpen]);

  useEffect(() => {
    function handleEscape(e) {
      if (e.key === 'Escape') setSelectedDriver(null);
    }
    if (selectedDriver) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [selectedDriver]);

  const filteredByTab = details[activeTab] ?? [];

  const searchLower = (searchQuery || '').trim().toLowerCase();
  const filteredBySearch =
    searchLower === ''
      ? filteredByTab
      : filteredByTab.filter((d) => {
          const name = (d.full_name || d.username || '').toLowerCase();
          const location = (d.current_location || '').toLowerCase();
          return name.includes(searchLower) || location.includes(searchLower);
        });

  const filtered = [...filteredBySearch].sort((a, b) => {
    const nameA = (a.full_name || a.username || `Driver #${a.id}`).toLowerCase();
    const nameB = (b.full_name || b.username || `Driver #${b.id}`).toLowerCase();
    if (sortBy === 'name-asc') return nameA.localeCompare(nameB);
    if (sortBy === 'name-desc') return nameB.localeCompare(nameA);
    if (sortBy === 'status') return ((a.on_duty ? 0 : 1) - (b.on_duty ? 0 : 1));
    return 0;
  });

  const derivedStats = {
    active: (details.active || []).length,
    offline: (details.offline || []).length,
    total: (details.total || []).length,
  };

  const agentStatItems = [
    { key: 'active', label: 'Active', count: derivedStats.active, highlight: activeTab === 'active', icon: 'active' },
    { key: 'offline', label: 'Offline', count: derivedStats.offline, highlight: activeTab === 'offline', icon: 'offline' },
    { key: 'total', label: 'Total', count: derivedStats.total, highlight: activeTab === 'total', icon: 'total' },
  ];


  const handleSendClick = () => {
    navigate('/broadcast-logs');
  };

  return (
    <div className="panel agent-panel">
      <div className="panel-header agent-header">
        <span className="panel-header-title-wrap">Agent</span>
        <div className="panel-header-actions agent-header-icons">
          <button
            type="button"
            className="panel-header-icon-btn agent-header-refresh"
            aria-label="Refresh"
            onClick={handleRefresh}
            title="Refresh agents"
          >
            <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          <div className="agent-header-filter-wrap" ref={filterRef}>
            <button
              type="button"
              className="panel-header-icon-btn"
              aria-label="Filter / Sort"
              aria-expanded={filterDropdownOpen}
              onClick={() => setFilterDropdownOpen((o) => !o)}
            >
              <svg width="25" height="25" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/></svg>
            </button>
            {filterDropdownOpen && (
              <div className="agent-header-dropdown">
                <span className="agent-header-dropdown-title">Sort by</span>
                {SORT_OPTIONS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    className={`agent-header-dropdown-item ${sortBy === key ? 'active' : ''}`}
                    onClick={() => {
                      setSortBy(key);
                      setFilterDropdownOpen(false);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="panel-header-icon-btn" aria-label="Send / Broadcast" onClick={handleSendClick}>
            <svg width="25" height="25" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
          <div className="agent-header-search-wrap">
            <button
              type="button"
              className={`panel-header-icon-btn ${searchOpen ? 'active' : ''}`}
              aria-label="Search agents"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen((o) => !o)}
            >
              <svg width="25" height="25" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            </button>
            {searchOpen && (
              <div className="agent-header-search-inner">
                <input
                  ref={searchInputRef}
                  type="search"
                  className="agent-header-search-input"
                  placeholder="Search by name or location…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && (setSearchOpen(false), setSearchQuery(''), searchInputRef.current?.blur())}
                  aria-label="Search agents"
                />
                <button type="button" className="agent-header-search-close" onClick={() => { setSearchOpen(false); setSearchQuery(''); }} aria-label="Close search">×</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="panel-all-task-wrap">
        <Link to="/tasks" className="btn-all-task" aria-label="View all tasks">
          <span className="btn-all-task-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          </span>
          <span className="btn-all-task-text">All tasks</span>
        </Link>
      </div>
      <div className="panel-stats panel-stats--agents">
        {agentStatItems.map(({ key, label, count, highlight, icon }) => (
          <button
            key={key}
            type="button"
            className={`panel-stats-item ${highlight ? 'highlight' : ''} ${activeTab === key ? 'active' : ''}`}
            data-stat-key={key}
            onClick={() => setActiveTab(key)}
            aria-pressed={activeTab === key}
            aria-label={`${label}: ${count}`}
          >
            <span className="panel-stats-icon" aria-hidden="true">
              {icon === 'active' && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>
              )}
              {icon === 'offline' && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/></svg>
              )}
              {icon === 'total' && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              )}
            </span>
            <span className="panel-stats-number">{count}</span>
            <span className="panel-stats-label">{label}</span>
          </button>
        ))}
      </div>
      <div className={`panel-body ${filtered.length === 0 ? 'empty' : ''}`}>
        {loading && 'Loading…'}
        {!loading && filtered.length === 0 && 'No agents'}
        {!loading && filtered.length > 0 && activeTab === 'active' && (
          <ul className="agent-card-list">
            {filtered.slice(0, 25).map((d) => {
              const name = d.full_name || d.username || `Driver #${d.id}`;
              const initial = (name.match(/\b\w/g) || [name[0] || '?']).slice(0, 2).join('').toUpperCase();
              const avatarUrl = d.avatar_url || d.photo_url || d.image_url;
              const isActive = d.is_online === 1 || d.on_duty === 1;
              const statusLabel = isActive ? 'Active' : 'Offline';
              const lastSeen = d.last_seen ?? '—';
              const onlineStatus = d.online_status === 'online' ? 'Online' : d.online_status === 'lost_connection' ? 'Lost connection' : null;
              const statusLine = !isActive
                ? `Last seen: ${lastSeen}`
                : onlineStatus
                  ? `${onlineStatus} · ${lastSeen}`
                  : lastSeen;
              const taskCount = d.total_task ?? d.task_count ?? 0;
              return (
                <li key={d.id} className={`agent-card ${!isActive ? 'agent-card-offline' : ''}`}>
                  <div className="agent-card-inner">
                    <div className="agent-card-avatar" aria-hidden="true">
                      {avatarUrl ? (
                        <img src={avatarUrl} alt="" />
                      ) : (
                        <span className="agent-card-avatar-initials">{initial}</span>
                      )}
                    </div>
                    <div className="agent-card-body">
                      <div className="agent-card-name">{name}</div>
                      <div className="agent-card-meta">
                        <span className={`agent-card-status agent-card-status--${isActive ? 'active' : 'offline'}`}>
                          <span className="agent-card-status-dot" aria-hidden="true" />
                          {statusLabel}
                        </span>
                        <span className="agent-card-location">{d.current_location || d.location_address || '—'}</span>
                        <span className="agent-card-waiting" title="Last seen">{statusLine}</span>
                        {taskCount > 0 && (
                          <span className="agent-card-tasks">Tasks today: {taskCount}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="agent-card-details"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedDriver(d);
                      }}
                    >
                      Details
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && filtered.length > 0 && (activeTab === 'offline' || activeTab === 'total') && (
          <ul className="agent-detail-card-list">
            {filtered.slice(0, 25).map((d) => {
              const name = d.full_name || d.username || `Driver #${d.id}`;
              const taskCount = d.total_task ?? d.task_count ?? d.assigned_tasks ?? 0;
              const connectionStatus = d.connection_status ?? (d.online_status === 'online' ? 'Online' : 'Connection Lost');
              const isLostConnection = connectionStatus === 'Connection Lost' || d.online_status === 'lost_connection';
              const lastSeen = d.last_seen ?? d.last_activity ?? (d.on_duty ? '1 day ago' : 'yesterday');
              const device = d.device ?? d.platform ?? 'Android';
              const phone = d.phone ? String(d.phone) : null;
              return (
                <li key={d.id} className="agent-detail-card">
                  <div className="agent-detail-card-header">
                    <span className="agent-detail-card-name">{name}</span>
                    <span className="agent-detail-card-duty">
                      <span className={`agent-detail-card-dot ${d.on_duty ? 'on-duty' : 'off-duty'}`} aria-hidden="true" />
                      {d.on_duty ? 'ON DUTY' : 'OFF DUTY'}
                    </span>
                  </div>
                  <div className="agent-detail-card-row">Tasks today: {taskCount}</div>
                  <div className={`agent-detail-card-row ${isLostConnection ? 'agent-detail-card-row--lost' : ''}`}>
                    {connectionStatus}
                  </div>
                  <div className="agent-detail-card-row agent-detail-card-muted">
                    Last seen: {lastSeen}
                  </div>
                  {phone && (
                    <div className="agent-detail-card-row agent-detail-card-muted">{phone}</div>
                  )}
                  <div className="agent-detail-card-row agent-detail-card-device">{device}</div>
                  <div className="agent-detail-card-actions">
                    <button
                      type="button"
                      className="agent-detail-card-link"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedDriver(d);
                      }}
                    >
                      Details
                    </button>
                    <span className="agent-detail-card-link-sep"> </span>
                    <button type="button" className="agent-detail-card-link" onClick={() => navigate('/broadcast-logs')}>Send Push</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selectedDriver && (
        <div
          className="agent-detail-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="agent-detail-modal-title"
          onClick={(e) => e.target === e.currentTarget && setSelectedDriver(null)}
        >
          <div className="agent-detail-modal-card" ref={detailModalRef} onClick={(e) => e.stopPropagation()}>
            <div className="agent-detail-modal-header">
              <h2 id="agent-detail-modal-title" className="agent-detail-modal-title">
                {selectedDriver.full_name || selectedDriver.username || `Driver #${selectedDriver.id}`}
              </h2>
              <button
                type="button"
                className="agent-detail-modal-close"
                aria-label="Close"
                onClick={() => setSelectedDriver(null)}
              >
                ×
              </button>
            </div>
            <div className="agent-detail-modal-body">
              <div className="agent-detail-modal-row">
                <span className="agent-detail-modal-label">Status</span>
                <span className={`agent-detail-modal-value agent-detail-modal-status--${selectedDriver.is_online === 1 || selectedDriver.on_duty === 1 ? 'active' : 'offline'}`}>
                  {selectedDriver.is_online === 1 || selectedDriver.on_duty === 1 ? 'Active' : 'Offline'}
                </span>
              </div>
              <div className="agent-detail-modal-row">
                <span className="agent-detail-modal-label">Connection</span>
                <span className={`agent-detail-modal-value ${selectedDriver.online_status === 'lost_connection' ? 'agent-detail-modal-value--lost' : ''}`}>
                  {selectedDriver.online_status === 'online' ? 'Online' : 'Connection Lost'}
                </span>
              </div>
              <div className="agent-detail-modal-row">
                <span className="agent-detail-modal-label">Last seen</span>
                <span className="agent-detail-modal-value">{selectedDriver.last_seen ?? '—'}</span>
              </div>
              <div className="agent-detail-modal-row">
                <span className="agent-detail-modal-label">Tasks today</span>
                <span className="agent-detail-modal-value">{selectedDriver.total_task ?? selectedDriver.task_count ?? 0}</span>
              </div>
              {selectedDriver.phone && (
                <div className="agent-detail-modal-row">
                  <span className="agent-detail-modal-label">Phone</span>
                  <span className="agent-detail-modal-value">{selectedDriver.phone}</span>
                </div>
              )}
              <div className="agent-detail-modal-row">
                <span className="agent-detail-modal-label">Device</span>
                <span className="agent-detail-modal-value">{selectedDriver.device ?? selectedDriver.device_platform ?? '—'}</span>
              </div>
              {(selectedDriver.location_lat != null && selectedDriver.location_lng != null) && (
                <div className="agent-detail-modal-row">
                  <span className="agent-detail-modal-label">Location</span>
                  <span className="agent-detail-modal-value agent-detail-modal-muted">
                    {selectedDriver.location_lat}, {selectedDriver.location_lng}
                  </span>
                </div>
              )}
            </div>
            <div className="agent-detail-modal-actions">
              <Link to="/drivers" className="agent-detail-modal-btn agent-detail-modal-btn--primary">View in drivers table</Link>
              <button type="button" className="agent-detail-modal-btn" onClick={() => navigate('/broadcast-logs')}>Send Push</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
