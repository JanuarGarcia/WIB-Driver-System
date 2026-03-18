import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, statusClass, statusLabel } from '../api';
import { useTeamFilter } from '../context/TeamFilterContext';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';

const TABS = ['active', 'offline', 'total'];

/** Baguio center [lat, lng] – used to compute delivery direction from coordinates */
const BAGUIO_CENTER_LAT = 16.4023;
const BAGUIO_CENTER_LNG = 120.596;

function getBearing(fromLat, fromLng, toLat, toLng) {
  const lat1 = (fromLat * Math.PI) / 180;
  const lat2 = (toLat * Math.PI) / 180;
  const dLng = ((toLng - fromLng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  let br = (Math.atan2(y, x) * 180) / Math.PI;
  return (br + 360) % 360;
}

function bearingToCompass(bearing) {
  if (bearing == null || Number.isNaN(bearing)) return null;
  const b = ((Number(bearing) % 360) + 360) % 360;
  const labels = [
    { max: 22.5, label: 'North' },
    { max: 67.5, label: 'North east' },
    { max: 112.5, label: 'East' },
    { max: 157.5, label: 'South east' },
    { max: 202.5, label: 'South' },
    { max: 247.5, label: 'South west' },
    { max: 292.5, label: 'West' },
    { max: 337.5, label: 'North west' },
    { max: 360, label: 'North' },
  ];
  for (const { max, label } of labels) {
    if (b <= max) return label;
  }
  return 'North';
}

function getDirectionFromTask(t) {
  const fromApi = (t.direction != null && String(t.direction).trim() !== '') ? String(t.direction).trim() : null;
  if (fromApi) return fromApi;
  const lat = t.task_lat != null ? parseFloat(t.task_lat) : null;
  const lng = t.task_lng != null ? parseFloat(t.task_lng) : null;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  const bearing = getBearing(BAGUIO_CENTER_LAT, BAGUIO_CENTER_LNG, lat, lng);
  return bearingToCompass(bearing);
}

function directionArrowRotation(dir) {
  if (!dir || typeof dir !== 'string') return 135;
  const v = dir.trim().toLowerCase().replace(/\s+/g, ' ');
  const map = {
    'north': 0, 'n': 0,
    'north-east': 45, 'north east': 45, 'ne': 45,
    'east': 90, 'e': 90,
    'south-east': 135, 'south east': 135, 'se': 135,
    'south': 180, 's': 180,
    'south-west': 225, 'south west': 225, 'sw': 225,
    'west': 270, 'w': 270,
    'north-west': 315, 'north west': 315, 'nw': 315,
  };
  return map[v] ?? 135;
}

function directionDisplayLabel(dir) {
  if (!dir || typeof dir !== 'string' || !dir.trim()) return '—';
  const v = dir.trim().toLowerCase().replace(/\s+/g, ' ');
  const map = {
    'north': 'North', 'n': 'North',
    'north-east': 'North-East', 'north east': 'North-East', 'ne': 'North-East',
    'east': 'East', 'e': 'East',
    'south-east': 'South-East', 'south east': 'South-East', 'se': 'South-East',
    'south': 'South', 's': 'South',
    'south-west': 'South-West', 'south west': 'South-West', 'sw': 'South-West',
    'west': 'West', 'w': 'West',
    'north-west': 'North-West', 'north west': 'North-West', 'nw': 'North-West',
  };
  return map[v] ?? dir.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-');
}
const SORT_OPTIONS = [
  { key: 'name-asc', label: 'Name A–Z' },
  { key: 'name-desc', label: 'Name Z–A' },
  { key: 'status', label: 'By status' },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const ASSIGNED_STATUSES = ['assigned', 'acknowledged', 'started', 'inprogress'];
function normStatus(status) {
  return (status || '').toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
}

export default function AgentPanel({ onOpenTaskDetails }) {
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
  const [allTasksView, setAllTasksView] = useState(false);
  const [assignedTasks, setAssignedTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const searchInputRef = useRef(null);
  const filterRef = useRef(null);
  const detailModalRef = useRef(null);

  const fetchAssignedTasks = useCallback(() => {
    setTasksLoading(true);
    const dateStr = todayStr();
    api(`tasks?date=${encodeURIComponent(dateStr)}`)
      .then((list) => {
        const tasks = Array.isArray(list) ? list : [];
        const assigned = tasks.filter((t) => ASSIGNED_STATUSES.includes(normStatus(t.status)));
        setAssignedTasks(assigned.sort((a, b) => {
          const dateA = a.date_created ? new Date(a.date_created).getTime() : 0;
          const dateB = b.date_created ? new Date(b.date_created).getTime() : 0;
          return dateB - dateA;
        }));
      })
      .catch(() => setAssignedTasks([]))
      .finally(() => setTasksLoading(false));
  }, []);

  useEffect(() => {
    if (allTasksView) fetchAssignedTasks();
  }, [allTasksView, fetchAssignedTasks]);

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

  const allAgents = Array.isArray(details.total) ? details.total : [];
  const filteredByTab =
    activeTab === 'active'
      ? allAgents.filter((a) => isActiveAgent(a))
      : activeTab === 'offline'
        ? allAgents.filter((a) => isActiveAgent(a) && isOfflineAgent(a))
        : allAgents.filter((a) => isActiveAgent(a));

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

  // Backend fields aren't consistent across statuses, so we enforce explicitly.
  // - Active: on_duty === true (fallback: status === 'active')
  // - Offline: Active AND online_status is offline/lost_connection
  // - Exclude: suspended/pending/expired/blocked
  function isOnDuty(a) {
    const onDutyVal = a?.on_duty;
    return onDutyVal === true || onDutyVal === 1 || onDutyVal === '1' || onDutyVal === 'true' || onDutyVal === 2 || onDutyVal === '2';
  }

  // Exclude: suspended/pending/expired/blocked
  // (These typically appear in `status`, but backend fields may be inconsistent—so we only exclude if status exists.)
  function isExcludedStatus(a) {
    const s = normStatus(a?.status);
    return ['suspended', 'pending', 'expired', 'blocked'].includes(s);
  }

  // Requirement:
  // Active = status === "active" AND online
  function isActiveAgent(a) {
    if (!a) return false;
    if (isExcludedStatus(a)) return false;
    const s = normStatus(a?.status);
    // If backend didn't provide `status`, fall back to on_duty semantics
    if (!s) {
      return isOnDuty(a) && normStatus(a?.online_status) === 'online';
    }
    return s === 'active' && normStatus(a?.online_status) === 'online';
  }

  // Offline = on_duty AND lost_connection/offline-ish
  function isOfflineAgent(a) {
    if (!a) return false;
    if (isExcludedStatus(a)) return false;
    const s = normStatus(a?.status);
    // If backend didn't provide `status`, fall back to on_duty semantics
    if (!s) {
      return isOnDuty(a) && normStatus(a?.online_status) === 'lost_connection';
    }
    return s === 'active' && normStatus(a?.online_status) === 'lost_connection';
  }

  // Use the same source list + rules as `filteredByTab` so counters match the cards.
  const allAgentsForStats = Array.isArray(details.total) ? details.total : [];
  const derivedStats = {
    total: allAgentsForStats.filter((a) => {
      if (!a) return false;
      if (isExcludedStatus(a)) return false;
      const s = normStatus(a?.status);
      // If status is missing, fall back to on_duty semantics
      return !s ? isOnDuty(a) : s === 'active';
    }).length,
    active: allAgentsForStats.filter((a) => isActiveAgent(a)).length,
    offline: allAgentsForStats.filter((a) => isOfflineAgent(a)).length,
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
    <div className={`panel agent-panel ${allTasksView ? 'agent-panel--all-tasks' : ''}`}>
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
      <div className={`panel-all-task-wrap ${allTasksView ? 'panel-all-task-wrap--active' : ''}`}>
        <label className="btn-all-task btn-all-task-toggle">
          <input
            type="checkbox"
            checked={allTasksView}
            onChange={(e) => setAllTasksView(e.target.checked)}
            aria-label="Show all tasks view"
          />
          <span className="btn-all-task-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          </span>
          <span className="btn-all-task-text">All tasks</span>
        </label>
      </div>
      <div className="panel-stats panel-stats--agents">
        {agentStatItems.map(({ key, label, count, highlight, icon }) => (
          <button
            key={key}
            type="button"
            className={`panel-stats-item ${highlight ? 'highlight' : ''} ${activeTab === key ? 'active' : ''}`}
            data-stat-key={key}
            onClick={() => {
              setActiveTab(key);
              setAllTasksView(false);
            }}
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
      <div className={`panel-body ${allTasksView ? (!tasksLoading && assignedTasks.length === 0 ? 'empty' : '') : (filtered.length === 0 ? 'empty' : '')}`}>
        {!allTasksView && loading && 'Loading…'}
        {!allTasksView && !loading && filtered.length === 0 && 'No agents'}
        {!loading && allTasksView && (
          <>
            {tasksLoading && 'Loading…'}
            {!tasksLoading && assignedTasks.length === 0 && 'No assigned tasks'}
            {!tasksLoading && assignedTasks.length > 0 && (
              <ul className="task-card-list task-card-list--all-tasks">
                {assignedTasks.slice(0, 25).map((t) => {
                  const statusNorm = normStatus(t.status);
                  const created = t.date_created ? new Date(t.date_created) : null;
                  const minsWaiting = created ? Math.max(0, Math.floor((Date.now() - created.getTime()) / 60000)) : null;
                  const waitingMins = minsWaiting !== null ? (minsWaiting >= 60 ? `${Math.floor(minsWaiting / 60)} hr ${minsWaiting % 60} mins` : `${minsWaiting}mins`) : null;
                  const customerName = t.customer_name || '—';
                  const initial = (String(customerName).match(/\b\w/g) || [customerName[0] || '?']).slice(0, 2).join('').toUpperCase();
                  const avatarUrl = t.customer_photo || t.customer_image || t.driver_photo || null;
                  const location = t.delivery_address || t.restaurant_name || (t.dropoff_merchant && !/^\d+$/.test(String(t.dropoff_merchant).trim()) ? t.dropoff_merchant : null) || '—';
                  const locationShort = location.length > 50 ? `${location.slice(0, 50)}…` : location;
                  const orderedTime = created ? created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }) : null;
                  return (
                    <li key={t.task_id} className="task-card-all-tasks">
                      <div className="task-card-all-tasks-inner">
                        <div className="task-card-all-tasks-avatar" aria-hidden="true">
                          {avatarUrl ? (
                            <img src={avatarUrl} alt="" />
                          ) : (
                            <span className="task-card-all-tasks-avatar-initials">{initial}</span>
                          )}
                        </div>
                        <div className="task-card-all-tasks-body">
                          <div className="task-card-all-tasks-badges">
                            {statusNorm === 'assigned' && (
                              <>
                                <span className="task-card-all-tasks-badge status-green">READY FOR PICKUP</span>
                                <span className={`task-card-all-tasks-badge ${statusClass(statusNorm)}`}>assigned</span>
                              </>
                            )}
                            {statusNorm !== 'assigned' && (
                              <span className={`task-card-all-tasks-badge ${statusClass(statusNorm)}`}>{statusLabel(statusNorm)}</span>
                            )}
                          </div>
                          {location !== '—' && (
                            <div className="task-card-all-tasks-location" title={location}>{locationShort}</div>
                          )}
                          {orderedTime && (
                            <div className="task-card-all-tasks-order-time">Ordered Time {orderedTime}</div>
                          )}
                          {waitingMins && (
                            <div className="task-card-all-tasks-waiting">
                              <span className="task-card-all-tasks-arrow" aria-hidden="true" style={{ color: 'var(--color-primary)' }}>
                                <svg viewBox="0 0 24 24" fill="currentColor" style={{ transform: `rotate(${directionArrowRotation(getDirectionFromTask(t))}deg)` }}>
                                  <path d="M12 4l-6 8h4v8h4v-8h4L12 4z"/>
                                </svg>
                              </span>
                              <span className="task-card-all-tasks-waiting-text">
                                <span className="task-card-all-tasks-waiting-mins">{waitingMins}</span> waiting ni cx
                              </span>
                            </div>
                          )}
                          <div className="task-card-all-tasks-name">{customerName}</div>
                          <button
                            type="button"
                            className="task-card-all-tasks-details"
                            onClick={() => onOpenTaskDetails ? onOpenTaskDetails(t.task_id) : navigate(`/tasks?highlight=${t.task_id}`)}
                            aria-label={`View details for order ${t.order_id ?? t.task_id}`}
                          >
                            Details
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        {!loading && filtered.length > 0 && !allTasksView && activeTab === 'active' && (
          <ul className="agent-detail-card-list agent-active-detail-list">
            {filtered.slice(0, 25).map((d) => {
              const name = d.full_name || d.username || `Driver #${d.id}`;
              const taskCount = d.total_task ?? d.task_count ?? d.assigned_tasks ?? 0;
              const lastSeen = d.last_seen ?? d.last_activity ?? 'Moments ago';
              const device = (d.device ?? d.platform ?? 'android').toString().toLowerCase();
              return (
                <li key={d.id} className="agent-detail-card agent-active-detail-row">
                  <div className="agent-active-detail-left">
                    <span className="agent-active-detail-dot" aria-hidden="true" />
                    <div className="agent-active-detail-info">
                      <div className="agent-active-detail-name">{name}</div>
                      <div className="agent-active-detail-meta">Online</div>
                      <div className="agent-active-detail-meta agent-active-detail-muted">{lastSeen}</div>
                      <div className="agent-active-detail-device">{device}</div>
                      <div className="agent-active-detail-duty">
                        <span className="agent-active-detail-duty-check" aria-hidden="true">✓</span>
                        On-Duty
                      </div>
                      <div className="agent-detail-card-actions agent-active-detail-actions">
                        <button
                          type="button"
                          className="agent-detail-card-link"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedDriver(d); }}
                        >
                          Details
                        </button>
                        <span className="agent-detail-card-link-sep"> </span>
                        <button type="button" className="agent-detail-card-link" onClick={() => navigate('/broadcast-logs')}>Send Push</button>
                      </div>
                    </div>
                  </div>
                  <div className="agent-active-detail-right">
                    <span className="agent-active-detail-task-num">{taskCount}</span>
                    <span className="agent-active-detail-task-label">Task{taskCount !== 1 ? 's' : ''}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && filtered.length > 0 && !allTasksView && (activeTab === 'offline' || activeTab === 'total') && (
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
