import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, statusClass, statusLabel } from '../api';
import DriverDetailsModal from './DriverDetailsModal';
import { useTeamFilter } from '../context/TeamFilterContext';
import { sanitizeLocationDisplayName } from '../utils/displayText';
import { getAdvanceOrderLines } from '../utils/advanceOrder';

const TABS = ['active', 'offline', 'total'];
const AGENT_REFRESH_INTERVAL_MS = 5000;
const DRIVER_STATUS_UPDATED_EVENT = 'wib:driver-status-updated';
const DRIVER_STATUS_UPDATED_AT_KEY = 'wib-driver-status-updated-at';

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

const QUEUE_POLL_MS = 8000;

/** Human-readable waiting duration since joined_at (dispatch scan). */
function formatQueueWaiting(joinedAt) {
  if (!joinedAt) return '—';
  const t = new Date(joinedAt).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return 'Just joined';
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  }
  const d = Math.floor(sec / 86400);
  return `${d} day${d === 1 ? '' : 's'}`;
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
  /** Right panel: agents (default) or driver queue (same panel shell). */
  const [panelMode, setPanelMode] = useState('agents');
  const [queueList, setQueueList] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState(null);
  const [queueRemovingId, setQueueRemovingId] = useState(null);
  const searchInputRef = useRef(null);
  const filterRef = useRef(null);

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

  const loadQueue = useCallback(async (opts = {}) => {
    const silent = opts.silent === true;
    if (!silent) {
      setQueueLoading(true);
      setQueueError(null);
    }
    try {
      const res = await api('driver-queue');
      setQueueList(Array.isArray(res?.queue) ? res.queue : []);
      setQueueError(null);
    } catch (err) {
      if (!silent) {
        setQueueError(err?.error || err?.message || 'Failed to load queue');
        setQueueList([]);
      }
    } finally {
      if (!silent) setQueueLoading(false);
    }
  }, []);

  useEffect(() => {
    if (panelMode !== 'queue') return undefined;
    const id = setInterval(() => {
      loadQueue({ silent: true });
    }, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [panelMode, loadQueue]);

  useEffect(() => {
    if (panelMode !== 'queue') return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setPanelMode('agents');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelMode]);

  const loadAgents = useCallback(async (opts = {}) => {
    const silent = opts.silent === true;
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    params.set('date', todayStr());
    if (selectedTeamId != null && selectedTeamId !== '') params.set('team_id', String(selectedTeamId));
    if ((searchQuery || '').trim()) params.set('agent_name', searchQuery.trim());
    try {
      const res = await api(`driver/agent-dashboard?${params}`);
      const d = res?.details || {};
      const active = Array.isArray(d.active) ? d.active : [];
      const offline = Array.isArray(d.offline) ? d.offline : [];
      const total = Array.isArray(d.total) ? d.total : [];

      // Fallback: when agent-dashboard returns empty, derive from `/drivers`
      // so Agent panel remains usable and consistent with Drivers table data.
      if (active.length === 0 && offline.length === 0 && total.length === 0) {
        const rows = await api('drivers');
        let drivers = Array.isArray(rows) ? rows : [];

        if (selectedTeamId != null && selectedTeamId !== '') {
          drivers = drivers.filter((r) => String(r.team_id ?? '') === String(selectedTeamId));
        }
        if ((searchQuery || '').trim()) {
          const q = searchQuery.trim().toLowerCase();
          drivers = drivers.filter((r) => {
            const id = String(r.id ?? r.driver_id ?? '').toLowerCase();
            const username = String(r.username ?? '').toLowerCase();
            const name = String(r.full_name ?? '').toLowerCase();
            const phone = String(r.phone ?? '').toLowerCase();
            return id.includes(q) || username.includes(q) || name.includes(q) || phone.includes(q);
          });
        }

        const normalized = drivers.map((r) => {
          return {
            ...r,
            id: r.id ?? r.driver_id,
            driver_id: r.driver_id ?? r.id,
            // `/drivers` has no live connection telemetry — do not infer "online" from on_duty alone.
            online_status: 'lost_connection',
            connection_status: 'Connection Lost',
            last_seen: r.status_updated_at ? new Date(r.status_updated_at).toLocaleString() : '—',
            total_task: r.total_task ?? 0,
          };
        });

        const isLiveFallback = (d) => {
          const c = String(d?.online_status || d?.connection_status || '').toLowerCase().trim();
          if (!c) return false;
          if (c === 'lost_connection' || c.includes('lost')) return false;
          return c === 'online' || c === 'connected';
        };
        const isOnlineAgentFallback = (d) => isLiveFallback(d) && Number(d.on_duty) === 1;

        setDetails({
          active: normalized.filter(isOnlineAgentFallback),
          offline: normalized.filter((d) => !isOnlineAgentFallback(d)),
          total: normalized,
        });
      } else {
        setDetails({ active, offline, total });
      }
    } catch (_) {
      setDetails({ active: [], offline: [], total: [] });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [selectedTeamId, searchQuery]);

  useEffect(() => {
    loadAgents();
    const intervalId = setInterval(() => {
      loadAgents({ silent: true });
    }, AGENT_REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [loadAgents]);

  useEffect(() => {
    const onDriverStatusUpdated = () => {
      loadAgents({ silent: true });
    };
    const onStorage = (e) => {
      if (e.key === DRIVER_STATUS_UPDATED_AT_KEY) loadAgents({ silent: true });
    };
    window.addEventListener(DRIVER_STATUS_UPDATED_EVENT, onDriverStatusUpdated);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(DRIVER_STATUS_UPDATED_EVENT, onDriverStatusUpdated);
      window.removeEventListener('storage', onStorage);
    };
  }, [loadAgents]);

  const handleRefresh = () => {
    loadAgents();
  };

  const handleHeaderRefresh = () => {
    if (panelMode === 'queue') loadQueue();
    else handleRefresh();
  };

  const openQueueView = () => {
    setPanelMode('queue');
    setSearchOpen(false);
    setFilterDropdownOpen(false);
    loadQueue();
  };

  const closeQueueView = () => {
    setPanelMode('agents');
    setQueueError(null);
  };

  const handleRemoveFromQueue = async (driverId) => {
    if (driverId == null) return;
    if (!window.confirm('Remove this driver from the queue?')) return;
    setQueueRemovingId(driverId);
    try {
      await api(`driver-queue/${driverId}/remove`, { method: 'PUT', body: '{}' });
      await loadQueue({ silent: true });
    } catch (err) {
      alert(err?.error || err?.message || 'Could not remove from queue');
    } finally {
      setQueueRemovingId(null);
    }
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

  // Statistics: only drivers with account status = active; normalize status/online fields safely.
  // Defensive team scope: always match dashboard team filter even if API returns extra rows.
  const allDriversRaw = Array.isArray(details.total) ? details.total : [];
  const allDrivers =
    selectedTeamId != null && selectedTeamId !== ''
      ? allDriversRaw.filter((d) => String(d.team_id ?? '') === String(selectedTeamId))
      : allDriversRaw;

  const activeDrivers = allDrivers.filter((d) => {
    const status = String(d?.status ?? '').toLowerCase().trim();
    // Treat NULL/blank status as active (matches backend behavior and `/drivers` endpoint).
    return status === '' || status === 'active';
  });

  const totalCount = activeDrivers.length;

  /** Live app connection — not the same as "on duty" (on duty + lost connection = still offline here). */
  function isLiveConnection(d) {
    const c = String(d?.online_status || d?.connection_status || '').toLowerCase().trim();
    if (!c) return false;
    if (c === 'lost_connection' || c.includes('lost')) return false;
    return c === 'online' || c === 'connected';
  }

  /** Only numeric `1` is on duty (avoids JS truthy bugs: e.g. string "0" is truthy). */
  function isOnDuty(d) {
    const v = d?.on_duty;
    if (v === true) return true;
    if (v === false || v == null) return false;
    const n = Number(v);
    return n === 1;
  }

  /**
   * "Active" (online) in Agent panel = active account + on duty + live connection.
   * Matches legacy behavior: on duty but connection lost counts as offline.
   */
  function isAgentPanelOnline(d) {
    return isLiveConnection(d) && isOnDuty(d);
  }

  const onlineCount = activeDrivers.filter(isAgentPanelOnline).length;

  const offlineCount = totalCount - onlineCount;

  const derivedStats = {
    total: totalCount,
    active: onlineCount,
    offline: offlineCount,
  };

  const filteredByTab =
    activeTab === 'active'
      ? activeDrivers.filter(isAgentPanelOnline)
      : activeTab === 'offline'
        ? activeDrivers.filter((d) => !isAgentPanelOnline(d))
        : activeDrivers;

  const searchLower = (searchQuery || '').trim().toLowerCase();
  const filteredBySearch =
    searchLower === ''
      ? filteredByTab
      : filteredByTab.filter((d) => {
          const name = (d.full_name || d.username || '').toLowerCase();
          const location = (d.current_location || '').toLowerCase();
          const phone = String(d.phone || '').toLowerCase();
          return name.includes(searchLower) || location.includes(searchLower) || phone.includes(searchLower);
        });

  const filtered = [...filteredBySearch].sort((a, b) => {
    const nameA = (a.full_name || a.username || `Driver #${a.id}`).toLowerCase();
    const nameB = (b.full_name || b.username || `Driver #${b.id}`).toLowerCase();
    if (sortBy === 'name-asc') return nameA.localeCompare(nameB);
    if (sortBy === 'name-desc') return nameB.localeCompare(nameA);
    if (sortBy === 'status') return ((isOnDuty(a) ? 0 : 1) - (isOnDuty(b) ? 0 : 1));
    return 0;
  });

  const agentStatItems = [
    { key: 'active', label: 'Active', count: derivedStats.active, highlight: activeTab === 'active', icon: 'active' },
    { key: 'offline', label: 'Offline', count: derivedStats.offline, highlight: activeTab === 'offline', icon: 'offline' },
    { key: 'total', label: 'Total', count: derivedStats.total, highlight: activeTab === 'total', icon: 'total' },
  ];


  const handleSendClick = () => {
    navigate('/broadcast-logs');
  };

  const totalQueued = queueList.length;
  const nextInLine = totalQueued > 0 ? queueList[0] : null;

  return (
    <div
      className={`panel agent-panel ${allTasksView ? 'agent-panel--all-tasks' : ''} ${panelMode === 'queue' ? 'agent-panel--queue-view' : ''}`}
    >
      <div className="panel-header agent-header">
        <div className="agent-header-leading">
          {panelMode === 'queue' ? (
            <>
              <button
                type="button"
                className="panel-header-icon-btn agent-panel-back-btn"
                aria-label="Back to agents"
                title="Back to agents"
                onClick={closeQueueView}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <span className="panel-header-title-wrap">Driver Queue</span>
            </>
          ) : (
            <>
              <span className="panel-header-title-wrap">Agent</span>
              <button
                type="button"
                className="panel-header-icon-btn agent-panel-queue-toggle"
                aria-label="Open driver queue"
                aria-pressed={false}
                onClick={openQueueView}
                title="Driver queue"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                </svg>
              </button>
            </>
          )}
        </div>
        <div className="panel-header-actions agent-header-icons">
          <button
            type="button"
            className="panel-header-icon-btn agent-header-refresh"
            aria-label={panelMode === 'queue' ? 'Refresh queue' : 'Refresh agents'}
            onClick={handleHeaderRefresh}
            title={panelMode === 'queue' ? 'Refresh queue' : 'Refresh agents'}
          >
            <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          {panelMode === 'agents' && (
          <>
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
          </>
          )}
        </div>
      </div>
      {panelMode === 'agents' && (
      <div className="agent-panel-mode-pane agent-panel-mode-pane--agents" key="agents-mode">
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
              // Ensure tab switching doesn't keep a stale search filter
              setSearchQuery('');
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
                  const rawLocation = t.delivery_address || t.restaurant_name || (t.dropoff_merchant && !/^\d+$/.test(String(t.dropoff_merchant).trim()) ? t.dropoff_merchant : null) || '';
                  const location = sanitizeLocationDisplayName(rawLocation) || '—';
                  const locationShort = location.length > 50 ? `${location.slice(0, 50)}…` : location;
                  const orderedTime = created ? created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }) : null;
                  const advanceLines = getAdvanceOrderLines(t, t.date_created);
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
                          {advanceLines && (
                            <div className="task-card-v2-advance task-card-all-tasks-advance" role="status" aria-label="Advance order schedule">
                              <span className="task-card-v2-advance-line">{advanceLines.deliveryLine}</span>
                              {advanceLines.orderedLine ? (
                                <span className="task-card-v2-advance-line">{advanceLines.orderedLine}</span>
                              ) : null}
                            </div>
                          )}
                          {!advanceLines && orderedTime && (
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
                      <div className={`agent-active-detail-duty ${isOnDuty(d) ? 'agent-active-detail-duty--on' : 'agent-active-detail-duty--off'}`}>
                        {isOnDuty(d) ? (
                          <>
                            <span className="agent-active-detail-duty-check" aria-hidden="true">✓</span>
                            On-Duty
                          </>
                        ) : (
                          <>
                            <span className="agent-active-detail-duty-off" aria-hidden="true">○</span>
                            Off-Duty
                          </>
                        )}
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
              const isLostConnection = !isLiveConnection(d);
              const connectionStatus =
                d.connection_status ?? (isLostConnection ? 'Connection Lost' : 'Online');
              const lastSeen = d.last_seen ?? d.last_activity ?? (isOnDuty(d) ? '1 day ago' : 'yesterday');
              const device = d.device ?? d.platform ?? 'Android';
              const phone = d.phone ? String(d.phone) : null;
              const dutyOn = isOnDuty(d);
              return (
                <li key={d.id} className="agent-detail-card">
                  <div className="agent-detail-card-header">
                    <span className="agent-detail-card-name">{name}</span>
                    <span className="agent-detail-card-duty">
                      <span className={`agent-detail-card-dot ${dutyOn ? 'on-duty' : 'off-duty'}`} aria-hidden="true" />
                      {dutyOn ? 'ON DUTY' : 'OFF DUTY'}
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
      </div>
      )}

      {panelMode === 'queue' && (
      <div className="agent-panel-mode-pane agent-panel-mode-pane--queue" key="queue-mode">
        <div className="driver-queue-summary" aria-live="polite">
          <div className="driver-queue-summary-item">
            <span className="driver-queue-summary-value">{totalQueued}</span>
            <span className="driver-queue-summary-label">Total queued</span>
          </div>
          <div className="driver-queue-summary-item driver-queue-summary-item--next">
            <span className="driver-queue-summary-value driver-queue-summary-value--name" title={nextInLine ? (nextInLine.full_name || '') : undefined}>
              {nextInLine ? (nextInLine.full_name || `Driver #${nextInLine.driver_id}`) : '—'}
            </span>
            <span className="driver-queue-summary-label">Next in line</span>
          </div>
        </div>
        <div
          className={`panel-body driver-queue-body ${!queueLoading && !queueError && totalQueued === 0 ? 'empty' : ''}`}
        >
          {queueLoading && queueList.length === 0 && !queueError && (
            <div className="driver-queue-state">Loading…</div>
          )}
          {queueError && (
            <div className="driver-queue-state driver-queue-state--error">
              <p className="driver-queue-error-text">{queueError}</p>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => loadQueue()}>
                Retry
              </button>
            </div>
          )}
          {!queueLoading && !queueError && queueList.length === 0 && (
            <div className="driver-queue-state driver-queue-state--empty">No drivers currently in queue</div>
          )}
          {!queueError && queueList.length > 0 && (
            <ul className="driver-queue-list">
              {queueList.map((row) => {
                const name = row.full_name || `Driver #${row.driver_id}`;
                const isNext = row.is_next === true || row.position === 1;
                const online = row.online_status === 'online';
                const onDuty = Number(row.on_duty) === 1 || row.on_duty === true;
                const joined = row.joined_at_iso || row.joined_at;
                return (
                  <li key={row.driver_id} className={`driver-queue-row ${isNext ? 'driver-queue-row--next' : ''}`}>
                    <div className="driver-queue-row-pos" aria-label={`Position ${row.position}`}>
                      {row.position}
                    </div>
                    <div className="driver-queue-row-main">
                      <div className="driver-queue-row-top">
                        <span className="driver-queue-row-name">{name}</span>
                        {isNext && <span className="driver-queue-pill">Next in line</span>}
                      </div>
                      <div className="driver-queue-row-sub">
                        <span className="driver-queue-row-team">{row.team_name || '—'}</span>
                        <span className="driver-queue-row-sep" aria-hidden="true">·</span>
                        <span className="driver-queue-row-wait">Waiting {formatQueueWaiting(joined)}</span>
                      </div>
                      <div className="driver-queue-row-badges">
                        <span className={`driver-queue-mini-badge ${online ? 'driver-queue-mini-badge--online' : 'driver-queue-mini-badge--offline'}`}>
                          {online ? 'Online' : 'Offline'}
                        </span>
                        <span className={`driver-queue-mini-badge ${onDuty ? 'driver-queue-mini-badge--duty-on' : 'driver-queue-mini-badge--duty-off'}`}>
                          {onDuty ? 'On duty' : 'Off duty'}
                        </span>
                        <span className="driver-queue-row-tasks">{row.total_task ?? 0} task{(row.total_task ?? 0) === 1 ? '' : 's'}</span>
                      </div>
                      {joined && (
                        <div className="driver-queue-row-joined">
                          Joined{' '}
                          {new Date(joined).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm driver-queue-remove"
                      disabled={queueRemovingId === row.driver_id}
                      onClick={() => handleRemoveFromQueue(row.driver_id)}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      )}

      {selectedDriver && (
        <DriverDetailsModal
          size="wide"
          driverId={selectedDriver.id ?? selectedDriver.driver_id}
          summaryDriver={selectedDriver}
          onClose={() => setSelectedDriver(null)}
          onOpenTaskDetails={onOpenTaskDetails}
          footer={
            <>
              <Link to="/drivers" className="agent-detail-modal-btn agent-detail-modal-btn--primary">
                View in drivers table
              </Link>
              <button type="button" className="agent-detail-modal-btn" onClick={() => navigate('/broadcast-logs')}>
                Send Push
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
