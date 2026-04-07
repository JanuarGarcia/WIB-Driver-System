import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { api, statusClass, statusLabel, resolveUploadUrl } from '../api';
import DriverDetailsModal from './DriverDetailsModal';
import SendPushModal from './SendPushModal';
import { useTeamFilter } from '../context/TeamFilterContext';
import { sanitizeLocationDisplayName, sanitizeMerchantDisplayName, shortTaskOrderDigits } from '../utils/displayText';
import { getAdvanceOrderLines } from '../utils/advanceOrder';
import { todayDateStrLocal, taskDropoffLatLng, riderGpsFromLocations } from '../utils/mapTasks';
import { isLiveConnection, isOnDuty, isAgentPanelOnline } from '../utils/agentPanelRiders';

const TABS = ['active', 'offline', 'total'];
const AGENT_REFRESH_INTERVAL_MS = 8000;
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

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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

/** Rider photo from task list join (`driver_profile_photo`) or resolved URL. */
function taskDriverAvatarUrl(t) {
  const raw = t?.driver_profile_photo ?? t?.profile_photo;
  if (raw == null || String(raw).trim() === '') return null;
  return resolveUploadUrl(String(raw).trim());
}

/** Show rider photo or initials; on broken URL fall back to initials (no broken-image icon). */
function AllTasksRiderAvatar({ src, initials }) {
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [src]);
  if (!src || imgFailed) {
    return <span className="task-card-all-tasks-avatar-initials">{initials}</span>;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setImgFailed(true)}
    />
  );
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
  return todayDateStrLocal();
}

const MONTH_NAMES_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `YYYY-MM-DD` → e.g. `April 04, 2026` (local calendar day, zero-padded day). */
function formatHumanDateLabel(yyyyMmDd) {
  if (!yyyyMmDd || typeof yyyyMmDd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) {
    return yyyyMmDd;
  }
  const [ys, ms, ds] = yyyyMmDd.split('-');
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || m < 1 || m > 12) {
    return yyyyMmDd;
  }
  const monthName = MONTH_NAMES_LONG[m - 1];
  const dayPadded = String(d).padStart(2, '0');
  return `${monthName} ${dayPadded}, ${y}`;
}

const ASSIGNED_STATUSES = ['assigned', 'acknowledged', 'started', 'inprogress'];
function normStatus(status) {
  return (status || '').toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
}

const QUEUE_POLL_MS = 8000;

function queueAssignTaskLines(t) {
  const orderBits = shortTaskOrderDigits(t.order_id, t.task_id);
  const cust = sanitizeLocationDisplayName(t.customer_name || '') || '—';
  const merchRaw =
    t.restaurant_name ||
    (t.dropoff_merchant && !/^\d+$/.test(String(t.dropoff_merchant).trim()) ? t.dropoff_merchant : null);
  const merch = sanitizeMerchantDisplayName(merchRaw || '') || '';
  const title = `Task #${t.task_id}${orderBits && orderBits !== '—' ? ` · …${orderBits}` : ''}`;
  const sub = merch ? `${cust} · ${merch}` : cust;
  return { title, sub };
}

function taskMinsWaiting(t) {
  const created = t.date_created ? new Date(t.date_created) : null;
  if (!created || Number.isNaN(created.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - created.getTime()) / 60000));
}

function formatTaskWaitingLabel(mins) {
  if (mins == null) return null;
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} hr ${m} min${m === 1 ? '' : 's'}` : `${h} hr`;
  }
  return `${mins} min${mins === 1 ? '' : 's'}`;
}

function formatDistanceLabel(km) {
  if (km == null || !Number.isFinite(km)) return null;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

function isErrandTaskRow(t) {
  return t.task_source === 'errand' || Number(t.task_id) < 0;
}

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

const AgentPanel = forwardRef(function AgentPanel(
  {
    onOpenTaskDetails,
    onFocusRiderOnMap,
    /** Dashboard map: focus task drop-off pin (food + Mangan list rows). */
    onFocusTaskOnMap,
    listRevision = 0,
    onTaskListInvalidate,
    onQueueCountChange,
    /** Latest GPS from `drivers/locations` — used for “nearest to rider” sort and distance hints. */
    riderLocations = [],
  },
  ref
) {
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
  const [queueAssignDriver, setQueueAssignDriver] = useState(null);
  const [queueAssignTasks, setQueueAssignTasks] = useState([]);
  const [queueAssignLoading, setQueueAssignLoading] = useState(false);
  const [queueAssignError, setQueueAssignError] = useState(null);
  const [queueAssignSubmitting, setQueueAssignSubmitting] = useState(false);
  const [queueAssignSearch, setQueueAssignSearch] = useState('');
  const [queueAssignSort, setQueueAssignSort] = useState('oldest');
  const [queueAssignKind, setQueueAssignKind] = useState('all');
  const queueAssignSearchRef = useRef(null);
  /** Per-driver admin push (FCM); same flow as Drivers page / legacy dashboard. */
  const [pushModalDriver, setPushModalDriver] = useState(null);
  const searchInputRef = useRef(null);
  const filterRef = useRef(null);

  const openSendPushForDriver = useCallback((d) => {
    if (!d) return;
    const id = d.id ?? d.driver_id;
    const num = id != null ? parseInt(String(id), 10) : NaN;
    if (!Number.isFinite(num) || num <= 0) {
      alert('Cannot send push: driver ID is missing.');
      return;
    }
    setPushModalDriver({ ...d, id: num, driver_id: num });
  }, []);

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

  /* Keep queue list in sync for the open queue view and the header badge while on Agent. */
  useEffect(() => {
    loadQueue({ silent: true });
    const id = setInterval(() => {
      loadQueue({ silent: true });
    }, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [loadQueue]);

  useImperativeHandle(
    ref,
    () => ({
      openDriverQueue: () => {
        setPanelMode('queue');
        setSearchOpen(false);
        setFilterDropdownOpen(false);
        loadQueue();
      },
    }),
    [loadQueue]
  );

  useEffect(() => {
    if (typeof onQueueCountChange === 'function') onQueueCountChange(queueList.length);
  }, [queueList.length, onQueueCountChange]);

  useEffect(() => {
    if (panelMode !== 'queue') return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (queueAssignDriver) {
        e.preventDefault();
        if (!queueAssignSubmitting) {
          setQueueAssignDriver(null);
          setQueueAssignTasks([]);
          setQueueAssignError(null);
          setQueueAssignSearch('');
          setQueueAssignSort('oldest');
          setQueueAssignKind('all');
        }
        return;
      }
      setPanelMode('agents');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelMode, queueAssignDriver, queueAssignSubmitting]);

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

  useEffect(() => {
    if (listRevision < 1) return;
    loadAgents({ silent: true });
    if (allTasksView) fetchAssignedTasks();
  }, [listRevision, loadAgents, fetchAssignedTasks, allTasksView]);

  const handleRefresh = () => {
    loadAgents();
  };

  const handleHeaderRefresh = () => {
    if (panelMode === 'queue') loadQueue();
    else handleRefresh();
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

  const openQueueAssignModal = useCallback((row) => {
    setQueueAssignSearch('');
    setQueueAssignSort('oldest');
    setQueueAssignKind('all');
    setQueueAssignDriver(row);
    setQueueAssignTasks([]);
    setQueueAssignLoading(true);
    setQueueAssignError(null);
    const dateStr = todayStr();
    api(`tasks?date=${encodeURIComponent(dateStr)}`)
      .then((list) => {
        const raw = Array.isArray(list) ? list : [];
        const unassigned = raw.filter((t) => normStatus(t.status) === 'unassigned');
        setQueueAssignTasks(unassigned);
      })
      .catch((err) => {
        setQueueAssignError(err?.error || err?.message || 'Failed to load tasks');
      })
      .finally(() => setQueueAssignLoading(false));
  }, []);

  const closeQueueAssignModal = useCallback(() => {
    if (queueAssignSubmitting) return;
    setQueueAssignDriver(null);
    setQueueAssignTasks([]);
    setQueueAssignError(null);
    setQueueAssignSearch('');
    setQueueAssignSort('oldest');
    setQueueAssignKind('all');
  }, [queueAssignSubmitting]);

  const openAssignTaskDetailsFromQueue = useCallback(
    (taskId) => {
      if (queueAssignSubmitting || taskId == null || !onOpenTaskDetails) return;
      closeQueueAssignModal();
      onOpenTaskDetails(taskId);
    },
    [queueAssignSubmitting, onOpenTaskDetails, closeQueueAssignModal]
  );

  const hasRiderGpsForAssign = useMemo(
    () => Boolean(queueAssignDriver && riderGpsFromLocations(queueAssignDriver, riderLocations)),
    [queueAssignDriver, riderLocations]
  );

  useEffect(() => {
    if (queueAssignSort === 'nearest' && !hasRiderGpsForAssign && queueAssignDriver) {
      setQueueAssignSort('oldest');
    }
  }, [queueAssignSort, hasRiderGpsForAssign, queueAssignDriver]);

  const queueAssignKindCounts = useMemo(() => {
    let errand = 0;
    for (const t of queueAssignTasks) {
      if (isErrandTaskRow(t)) errand += 1;
    }
    return {
      all: queueAssignTasks.length,
      errand,
      delivery: queueAssignTasks.length - errand,
    };
  }, [queueAssignTasks]);

  const queueAssignDisplayTasks = useMemo(() => {
    const riderGps = queueAssignDriver ? riderGpsFromLocations(queueAssignDriver, riderLocations) : null;
    let rows = queueAssignTasks.map((t) => {
      const mins = taskMinsWaiting(t);
      const drop = taskDropoffLatLng(t);
      let distKm = null;
      if (riderGps && drop) distKm = haversineKm(riderGps.lat, riderGps.lng, drop.lat, drop.lng);
      const isErrand = isErrandTaskRow(t);
      const lines = queueAssignTaskLines(t);
      const merchRaw =
        t.restaurant_name ||
        (t.dropoff_merchant && !/^\d+$/.test(String(t.dropoff_merchant).trim()) ? t.dropoff_merchant : null);
      const merchantName = sanitizeMerchantDisplayName(merchRaw || '') || '';
      const customerName = sanitizeLocationDisplayName(t.customer_name || '') || '—';
      return {
        t,
        mins,
        distKm,
        isErrand,
        searchBlob: `${lines.title} ${lines.sub} ${t.task_id ?? ''} ${t.order_id ?? ''} ${merchantName} ${customerName}`.toLowerCase(),
        merchantName: merchantName || '—',
        customerName,
      };
    });

    if (queueAssignKind === 'errand') rows = rows.filter((r) => r.isErrand);
    else if (queueAssignKind === 'delivery') rows = rows.filter((r) => !r.isErrand);

    const q = queueAssignSearch.trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.searchBlob.includes(q));

    const sorted = [...rows];
    if (queueAssignSort === 'oldest') {
      sorted.sort((a, b) => {
        const da = a.t.date_created ? new Date(a.t.date_created).getTime() : Number.POSITIVE_INFINITY;
        const db = b.t.date_created ? new Date(b.t.date_created).getTime() : Number.POSITIVE_INFINITY;
        return da - db;
      });
    } else if (queueAssignSort === 'newest') {
      sorted.sort((a, b) => {
        const da = a.t.date_created ? new Date(a.t.date_created).getTime() : 0;
        const db = b.t.date_created ? new Date(b.t.date_created).getTime() : 0;
        return db - da;
      });
    } else if (queueAssignSort === 'nearest') {
      sorted.sort((a, b) => {
        if (a.distKm == null && b.distKm == null) return 0;
        if (a.distKm == null) return 1;
        if (b.distKm == null) return -1;
        return a.distKm - b.distKm;
      });
    }
    return sorted;
  }, [
    queueAssignTasks,
    queueAssignDriver,
    riderLocations,
    queueAssignSearch,
    queueAssignSort,
    queueAssignKind,
  ]);

  useEffect(() => {
    if (!queueAssignDriver || queueAssignLoading) return undefined;
    const timer = window.setTimeout(() => queueAssignSearchRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [queueAssignDriver, queueAssignLoading]);

  const submitQueueAssign = useCallback(
    async (task) => {
      if (!queueAssignDriver || queueAssignSubmitting) return;
      const driver_id = Number(queueAssignDriver.driver_id);
      if (!Number.isFinite(driver_id)) return;
      const rawTeam = queueAssignDriver.team_id;
      const parsedTeam = rawTeam != null && rawTeam !== '' ? parseInt(rawTeam, 10) : NaN;
      const team_id = Number.isFinite(parsedTeam) && parsedTeam > 0 ? parsedTeam : undefined;
      setQueueAssignSubmitting(true);
      setQueueAssignError(null);
      try {
        const taskId = typeof task === 'object' && task != null ? task.task_id : task;
        const errandOid =
          typeof task === 'object' && task != null && task.task_source === 'errand' && task.st_order_id != null
            ? Number(task.st_order_id)
            : Number(taskId) < 0
              ? Math.abs(Number(taskId))
              : null;
        const assignPath =
          errandOid != null ? `errand-orders/${errandOid}/assign` : `tasks/${taskId}/assign`;
        await api(assignPath, {
          method: 'PUT',
          body: JSON.stringify({ driver_id, team_id }),
        });
        setQueueAssignDriver(null);
        setQueueAssignTasks([]);
        setQueueAssignSearch('');
        setQueueAssignSort('oldest');
        setQueueAssignKind('all');
        await loadQueue({ silent: true });
        onTaskListInvalidate?.();
        if (allTasksView) fetchAssignedTasks();
      } catch (err) {
        setQueueAssignError(err?.error || err?.message || 'Assign failed');
      } finally {
        setQueueAssignSubmitting(false);
      }
    },
    [
      queueAssignDriver,
      queueAssignSubmitting,
      loadQueue,
      onTaskListInvalidate,
      allTasksView,
      fetchAssignedTasks,
    ]
  );

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
                <svg className="agent-header-leading-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12h13.5" />
                  <path d="M8.5 6.5L3 12l5.5 5.5" />
                </svg>
              </button>
              <span className="panel-header-title-wrap">Driver Queue</span>
            </>
          ) : (
            <span className="panel-header-title-wrap">Agent</span>
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
              title="Sort agents (name A–Z, Z–A, or by status)"
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
          <button
            type="button"
            className="panel-header-icon-btn"
            aria-label="Send / Broadcast"
            title="Open broadcast logs — send push messages to riders"
            onClick={handleSendClick}
          >
            <svg width="25" height="25" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
          <div className="agent-header-search-wrap">
            <button
              type="button"
              className={`panel-header-icon-btn ${searchOpen ? 'active' : ''}`}
              aria-label="Search agents"
              title="Search agents by name, location, or phone"
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
        <label className="btn-all-task btn-all-task-toggle" title="Show every rider’s assigned tasks in one list">
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
            title={
              key === 'active'
                ? 'Show riders who are connected and on duty'
                : key === 'offline'
                  ? 'Show riders who are offline or not on duty'
                  : 'Show full rider roster (all statuses)'
            }
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
                  const riderName = (t.driver_name || '').trim() || (t.driver_id != null ? `Driver #${t.driver_id}` : '—');
                  const initial = (() => {
                    if (riderName === '—') return '?';
                    const m = String(riderName).match(/\b\w/g);
                    if (m && m.length) return m.slice(0, 2).join('').toUpperCase();
                    const c = String(riderName).charAt(0);
                    return c ? c.toUpperCase() : '?';
                  })();
                  const avatarUrl = taskDriverAvatarUrl(t);
                  const rawLocation = t.delivery_address || t.restaurant_name || (t.dropoff_merchant && !/^\d+$/.test(String(t.dropoff_merchant).trim()) ? t.dropoff_merchant : null) || '';
                  const location = sanitizeLocationDisplayName(rawLocation) || '—';
                  const locationShort = location.length > 50 ? `${location.slice(0, 50)}…` : location;
                  const orderedTime = created ? created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }) : null;
                  const advanceLines = getAdvanceOrderLines(t, t.date_created);
                  const mapFocusCoords = taskDropoffLatLng(t);
                  const canFocusMap = Boolean(mapFocusCoords && onFocusTaskOnMap);
                  const listKey = t.task_source === 'errand' ? `errand-${t.order_id ?? t.task_id}` : String(t.task_id);
                  return (
                    <li
                      key={listKey}
                      className="task-card-all-tasks"
                      style={canFocusMap ? { cursor: 'pointer' } : undefined}
                      onClick={canFocusMap ? () => onFocusTaskOnMap(t) : undefined}
                    >
                      <div className="task-card-all-tasks-inner">
                        <div className="task-card-all-tasks-avatar" aria-hidden="true">
                          <AllTasksRiderAvatar src={avatarUrl} initials={initial} />
                        </div>
                        <div className="task-card-all-tasks-body">
                          <div className="task-card-all-tasks-badges">
                            {statusNorm === 'assigned' && (
                              <>
                                {t.timeline_ready_for_pickup ? (
                                  <span className="task-card-all-tasks-badge task-card-all-tasks-badge--rfp" title="From activity timeline: merchant ready for pickup">
                                    READY FOR PICKUP
                                  </span>
                                ) : null}
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
                              {advanceLines.noteLine ? (
                                <span className="task-card-v2-advance-line task-card-v2-advance-note">{advanceLines.noteLine}</span>
                              ) : null}
                            </div>
                          )}
                          {!advanceLines && orderedTime && (
                            <div className="task-card-all-tasks-order-time">Ordered Time {orderedTime}</div>
                          )}
                          {waitingMins && (
                            <div className="task-card-all-tasks-waiting">
                              <span
                                className="task-card-v2-direction-icon"
                                aria-hidden="true"
                                title="Delivery direction"
                              >
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                  style={{ transform: `rotate(${directionArrowRotation(getDirectionFromTask(t))}deg)` }}
                                >
                                  <path d="M12 4l-6 8h4v8h4v-8h4L12 4z" />
                                </svg>
                              </span>
                              <span className="task-card-all-tasks-waiting-text">
                                <span className="task-card-all-tasks-waiting-mins task-card-all-tasks-waiting-mins--blink">{waitingMins}</span>{' '}
                                waiting ni cx
                              </span>
                            </div>
                          )}
                          <div className="task-card-all-tasks-name">{riderName}</div>
                          <button
                            type="button"
                            className="task-card-all-tasks-details"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onOpenTaskDetails) onOpenTaskDetails(t.task_id);
                              else navigate(`/tasks?highlight=${t.task_id}`);
                            }}
                            aria-label={`View details for task ${t.task_id}${riderName !== '—' ? `, rider ${riderName}` : ''}`}
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
                <li
                  key={d.id}
                  className="agent-detail-card agent-active-detail-row"
                  style={onFocusRiderOnMap ? { cursor: 'pointer' } : undefined}
                  onClick={onFocusRiderOnMap ? () => onFocusRiderOnMap(d) : undefined}
                >
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
                        <button
                          type="button"
                          className="agent-detail-card-link"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openSendPushForDriver(d);
                          }}
                        >
                          Send Push
                        </button>
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
                <li
                  key={d.id}
                  className="agent-detail-card"
                  style={onFocusRiderOnMap ? { cursor: 'pointer' } : undefined}
                  onClick={onFocusRiderOnMap ? () => onFocusRiderOnMap(d) : undefined}
                >
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
                    <button
                      type="button"
                      className="agent-detail-card-link"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openSendPushForDriver(d);
                      }}
                    >
                      Send Push
                    </button>
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
            <div className="driver-queue-state driver-queue-state--empty">
              <p className="driver-queue-empty-title">No drivers in the queue</p>
              <p className="driver-queue-empty-sub">
                When a rider joins the queue from the app, they’ll appear here in line (first in, first out).
              </p>
            </div>
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
                    <div className="driver-queue-row-actions">
                      <button
                        type="button"
                        className="btn btn-sm driver-queue-assign"
                        disabled={queueAssignSubmitting}
                        onClick={(e) => {
                          e.stopPropagation();
                          openQueueAssignModal(row);
                        }}
                      >
                        Assign task
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm driver-queue-remove"
                        disabled={queueRemovingId === row.driver_id}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveFromQueue(row.driver_id);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      )}

      {queueAssignDriver &&
        createPortal(
          <div
            className="modal-backdrop driver-queue-assign-backdrop"
            role="presentation"
            onClick={closeQueueAssignModal}
          >
            <div
              className="modal-box modal-box-lg driver-queue-assign-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="driver-queue-assign-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="driver-queue-assign-modal-head">
                <div className="driver-queue-assign-modal-head-text">
                  <h2 id="driver-queue-assign-title" className="driver-queue-assign-modal-title">
                    Assign task
                  </h2>
                  <p className="driver-queue-assign-modal-sub">
                    Choose an unassigned order for{' '}
                    <strong>{queueAssignDriver.full_name || `Driver #${queueAssignDriver.driver_id}`}</strong>
                    {queueAssignDriver.team_name ? (
                      <>
                        {' '}
                        <span className="driver-queue-assign-modal-team">· {queueAssignDriver.team_name}</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  className="driver-queue-assign-modal-close"
                  onClick={closeQueueAssignModal}
                  disabled={queueAssignSubmitting}
                  aria-label="Close"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <p className="driver-queue-assign-modal-hint">
                <span>Showing tasks for {formatHumanDateLabel(todayStr())}</span>
                {!queueAssignLoading && !queueAssignError && queueAssignTasks.length > 0 ? (
                  <span className="driver-queue-assign-count-pill">{queueAssignTasks.length} unassigned</span>
                ) : null}
              </p>
              {queueAssignLoading && (
                <p className="driver-queue-assign-state">Loading tasks…</p>
              )}
              {queueAssignError && (
                <p className="driver-queue-assign-error" role="alert">
                  {queueAssignError}
                </p>
              )}
              {!queueAssignLoading && !queueAssignError && queueAssignTasks.length === 0 && (
                <p className="driver-queue-assign-state">No unassigned tasks for today.</p>
              )}
              {!queueAssignLoading && !queueAssignError && queueAssignTasks.length > 0 && (
                <>
                  <div className="driver-queue-assign-toolbar">
                    <div className="driver-queue-assign-search-wrap">
                      <span className="driver-queue-assign-search-icon" aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="11" cy="11" r="8" />
                          <path d="m21 21-4.3-4.3" />
                        </svg>
                      </span>
                      <input
                        ref={queueAssignSearchRef}
                        type="search"
                        className="driver-queue-assign-search"
                        placeholder="Search order, customer, merchant…"
                        value={queueAssignSearch}
                        onChange={(e) => setQueueAssignSearch(e.target.value)}
                        disabled={queueAssignSubmitting}
                        aria-label="Filter unassigned tasks"
                        autoComplete="off"
                      />
                    </div>
                    <div className="driver-queue-assign-filters">
                      <div className="driver-queue-assign-kind" role="group" aria-label="Task type">
                        {[
                          { key: 'all', label: 'All', count: queueAssignKindCounts.all },
                          { key: 'delivery', label: 'Delivery', count: queueAssignKindCounts.delivery },
                          { key: 'errand', label: 'MANGAN', count: queueAssignKindCounts.errand },
                        ].map(({ key, label, count }) => (
                          <button
                            key={key}
                            type="button"
                            className={`driver-queue-assign-kind-btn ${queueAssignKind === key ? 'driver-queue-assign-kind-btn--active' : ''}`}
                            disabled={queueAssignSubmitting}
                            onClick={() => setQueueAssignKind(key)}
                          >
                            {label}
                            <span className="driver-queue-assign-kind-count">{count}</span>
                          </button>
                        ))}
                      </div>
                      <label className="driver-queue-assign-sort-label">
                        <span className="driver-queue-assign-sort-text">Sort</span>
                        <select
                          className="driver-queue-assign-sort"
                          value={queueAssignSort}
                          disabled={queueAssignSubmitting}
                          onChange={(e) => setQueueAssignSort(e.target.value)}
                          aria-label="Sort tasks"
                        >
                          <option value="oldest">Longest waiting first</option>
                          <option value="newest">Newest first</option>
                          {hasRiderGpsForAssign ? <option value="nearest">Nearest to rider</option> : null}
                        </select>
                      </label>
                    </div>
                  </div>
                  {queueAssignDisplayTasks.length === 0 ? (
                    <p className="driver-queue-assign-state">No tasks match your search or filters.</p>
                  ) : (
                    <ul className="driver-queue-assign-list" aria-live="polite">
                      {queueAssignDisplayTasks.map((row) => {
                        const { t, mins, distKm, isErrand, merchantName, customerName } = row;
                        const orderDigits = shortTaskOrderDigits(t.order_id, t.task_id);
                        const dir = getDirectionFromTask(t);
                        const waitLabel = formatTaskWaitingLabel(mins);
                        const distLabel = formatDistanceLabel(distKm);
                        const urgent = mins != null && mins >= 45;
                        const listKey =
                          t.task_source === 'errand' ? `errand-${t.order_id ?? t.task_id}` : String(t.task_id);
                        const mapFocusCoords = taskDropoffLatLng(t);
                        const canFocusMap = Boolean(mapFocusCoords && onFocusTaskOnMap);
                        return (
                          <li
                            key={listKey}
                            className={`driver-queue-assign-row ${urgent ? 'driver-queue-assign-row--urgent' : ''}`}
                            style={canFocusMap ? { cursor: 'pointer' } : undefined}
                            onClick={canFocusMap ? () => onFocusTaskOnMap(t) : undefined}
                          >
                            <div className="driver-queue-assign-row-body">
                              <div className="driver-queue-assign-row-topline">
                                <div className="driver-queue-assign-dir" title={`Delivery direction: ${directionDisplayLabel(dir)}`}>
                                  <span className="driver-queue-assign-dir-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" fill="currentColor" style={{ transform: `rotate(${directionArrowRotation(dir)}deg)` }}>
                                      <path d="M12 4l-6 8h4v8h4v-8h4L12 4z" />
                                    </svg>
                                  </span>
                                  <span className="driver-queue-assign-dir-label">{directionDisplayLabel(dir)}</span>
                                </div>
                                <div className="driver-queue-assign-order-block">
                                  <span className="driver-queue-assign-order-label">Order</span>
                                  <span className="driver-queue-assign-order-num">{orderDigits}</span>
                                  {isErrand ? (
                                    <span className="driver-queue-assign-errand-badge" title="Mangan Order (ErrandWib)">
                                      MANGAN
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              <div className="driver-queue-assign-merchant">
                                <span className="driver-queue-assign-line-icon" aria-hidden="true">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
                                  </svg>
                                </span>
                                <span className="driver-queue-assign-merchant-text">{merchantName}</span>
                              </div>
                              <div className="driver-queue-assign-customer">
                                <span className="driver-queue-assign-line-icon" aria-hidden="true">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                                  </svg>
                                </span>
                                <span>{customerName}</span>
                              </div>
                              <div className="driver-queue-assign-meta">
                                {waitLabel ? (
                                  <span className={`driver-queue-assign-meta-pill ${urgent ? 'driver-queue-assign-meta-pill--urgent' : ''}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                      <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
                                    </svg>
                                    {waitLabel} waiting
                                  </span>
                                ) : null}
                                {distLabel ? (
                                  <span className="driver-queue-assign-meta-pill driver-queue-assign-meta-pill--distance" title="Straight-line distance from rider’s last GPS to drop-off">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
                                    </svg>
                                    ~{distLabel}
                                  </span>
                                ) : null}
                                <span className="driver-queue-assign-taskid" title="Internal task id">
                                  #{t.task_id}
                                </span>
                              </div>
                            </div>
                            <div className="driver-queue-assign-row-actions">
                              <button
                                type="button"
                                className="btn btn-sm btn-primary driver-queue-assign-pick"
                                disabled={queueAssignSubmitting}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  submitQueueAssign(t);
                                }}
                              >
                                Assign
                              </button>
                              {onOpenTaskDetails ? (
                                <button
                                  type="button"
                                  className="driver-queue-assign-details"
                                  disabled={queueAssignSubmitting}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openAssignTaskDetailsFromQueue(t.task_id);
                                  }}
                                >
                                  Details
                                </button>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body
        )}

      {selectedDriver && (
        <DriverDetailsModal
          size="wide"
          driverId={selectedDriver.id ?? selectedDriver.driver_id}
          summaryDriver={selectedDriver}
          onClose={() => setSelectedDriver(null)}
          onOpenTaskDetails={onOpenTaskDetails}
          footer={
            selectedDriver?.driver_source === 'errand' ? (
              <button type="button" className="agent-detail-modal-btn" onClick={() => setSelectedDriver(null)}>
                Close
              </button>
            ) : (
              <>
                <Link to="/drivers" className="agent-detail-modal-btn agent-detail-modal-btn--primary">
                  View in drivers table
                </Link>
                <button
                  type="button"
                  className="agent-detail-modal-btn"
                  onClick={() => {
                    const d = selectedDriver;
                    setSelectedDriver(null);
                    openSendPushForDriver(d);
                  }}
                >
                  Send Push
                </button>
              </>
            )
          }
        />
      )}

      <SendPushModal
        open={!!pushModalDriver}
        driverId={pushModalDriver?.id ?? pushModalDriver?.driver_id}
        driverLabel={
          pushModalDriver
            ? pushModalDriver.full_name || pushModalDriver.username || `Driver #${pushModalDriver.id ?? pushModalDriver.driver_id}`
            : ''
        }
        onClose={() => setPushModalDriver(null)}
      />
    </div>
  );
});

export default AgentPanel;
