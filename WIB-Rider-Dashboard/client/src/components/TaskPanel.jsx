import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api, statusClass, statusLabel } from '../api';
import { sanitizeLocationDisplayName, sanitizeMerchantDisplayName, shortTaskOrderDigits } from '../utils/displayText';
import { getAdvanceOrderLines, isAdvanceOrderDisplay } from '../utils/advanceOrder';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';
import { RIDER_NOTIFICATIONS_POLL_EVENT } from '../hooks/useNotifications';
import {
  DASHBOARD_TASKS_MAP_DATE_KEY,
  DASHBOARD_TASKS_MAP_DATE_EVENT,
  notifyDashboardTasksMapDateChanged,
  readDashboardTasksMapDateFromStorage,
  readEffectiveDashboardTaskDate,
  todayDateStrLocal,
  taskDropoffLatLng,
} from '../utils/mapTasks';
import { getLocationZone, getLocationZoneLabel } from '../utils/locationZones';

/** Match dashboard map `tasks?date=` on first paint so GET dedupe shares one request with Dashboard. */
function initialTaskPanelSelectedDate() {
  const ymd = readEffectiveDashboardTaskDate();
  const parts = ymd.split('-').map(Number);
  const [y, m, d] = parts;
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return new Date();
  return new Date(y, m - 1, d, 12, 0, 0);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** e.g. March 21, 2026 — matches Activity Timeline style */
function toDisplayDateLong(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
function toDisplayTime12h(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
function toDatePickerLabel(date) {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getDate();
  const month = MONTH_SHORT[d.getMonth()];
  const year = d.getFullYear();
  return `${String(day).padStart(2, '0')} ${month} ${year}`;
}

function getCalendarGrid(viewYear, viewMonth) {
  const first = new Date(viewYear, viewMonth - 1, 1);
  const last = new Date(viewYear, viewMonth, 0);
  const firstDay = first.getDay();
  const daysInMonth = last.getDate();
  const prevMonth = viewMonth === 1 ? 12 : viewMonth - 1;
  const prevYear = viewMonth === 1 ? viewYear - 1 : viewYear;
  const prevLast = new Date(prevYear, prevMonth, 0);
  const prevDays = prevLast.getDate();
  const leading = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    leading.push({ day: prevDays - i, month: prevMonth, year: prevYear, isOther: true });
  }
  const current = [];
  for (let d = 1; d <= daysInMonth; d++) {
    current.push({ day: d, month: viewMonth, year: viewYear, isOther: false });
  }
  const all = [...leading, ...current];
  const remainder = 42 - all.length;
  const trailing = [];
  const nextMonth = viewMonth === 12 ? 1 : viewMonth + 1;
  const nextYear = viewMonth === 12 ? viewYear + 1 : viewYear;
  for (let d = 1; d <= remainder; d++) {
    trailing.push({ day: d, month: nextMonth, year: nextYear, isOther: true });
  }
  return [...all, ...trailing];
}

const PROBLEM_FILTER_STORAGE_KEY = 'wib-tasks-problem-filter';
const PROBLEM_STATUS_IN = 'cancelled,canceled,declined,failed';
const TASK_PANEL_CACHE_PREFIX = 'wib-task-panel-cache-v1';
const ASSIGNED_TASK_STATUSES = new Set(['assigned', 'acknowledged', 'started', 'inprogress']);
const COMPLETED_TASK_STATUSES = new Set(['completed', 'delivered', 'successful']);
const PROBLEM_TASK_STATUSES = new Set(['cancelled', 'canceled', 'declined', 'failed']);

function readJsonSessionStorage(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function writeJsonSessionStorage(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // best-effort cache only
  }
}

function readStoredProblemFilter() {
  try {
    const v = sessionStorage.getItem(PROBLEM_FILTER_STORAGE_KEY);
    if (v === 'cancelled' || v === 'declined' || v === 'failed') return v;
  } catch (_) {}
  return 'cancelled';
}

const SORT_ORDER_OPTIONS = [
  { key: 'rfp', label: 'RFP' },
  { key: 'manual', label: 'Manual' },
  { key: 'direction', label: 'Direction' },
];
const SORT_DIRECTION_OPTIONS = [
  { key: 'oldest', label: 'Oldest first' },
  { key: 'latest', label: 'Latest first' },
];

/** Baguio center [lat, lng] – used as reference to compute delivery direction from coordinates */
const BAGUIO_CENTER_LAT = 16.4023;
const BAGUIO_CENTER_LNG = 120.596;

/** Bearing in degrees (0–360) from point A to B. North = 0, East = 90. */
function getBearing(fromLat, fromLng, toLat, toLng) {
  const lat1 = (fromLat * Math.PI) / 180;
  const lat2 = (toLat * Math.PI) / 180;
  const dLng = ((toLng - fromLng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  let br = (Math.atan2(y, x) * 180) / Math.PI;
  return (br + 360) % 360;
}

/** Compass label from bearing 0–360 (matches backend: "North east", "South west", etc.). */
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

/**
 * Compass for the card = sector of the drop-off vs Baguio center.
 * Prefer `taskDropoffLatLng` (client delivery coords / errand `client_address`) so we never use merchant fallback coords.
 */
function getDirectionFromTask(t) {
  const drop = taskDropoffLatLng(t, null);
  if (drop && Number.isFinite(drop.lat) && Number.isFinite(drop.lng)) {
    const bearing = getBearing(BAGUIO_CENTER_LAT, BAGUIO_CENTER_LNG, drop.lat, drop.lng);
    const derived = bearingToCompass(bearing);
    if (derived) return derived;
  }
  const fromApi = (t.direction != null && String(t.direction).trim() !== '') ? String(t.direction).trim() : null;
  return fromApi;
}

/** Arrow rotation (deg) from direction label - matches compass (up = North) */
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

/** Display direction label like live system: "North-West", "South-East", etc. */
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

/** Shown when API sets timeline_ready_for_pickup from Activity Timeline (mt_order_history / errand history). */
function TaskCardReadyForPickupBanner({ className = '' }) {
  return (
    <div
      className={['task-card-v2-rfp-banner', className].filter(Boolean).join(' ')}
      role="status"
      aria-label="Merchant marked this order ready for pickup"
    >
      <span className="task-card-v2-rfp-banner-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.6 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      </span>
      <div className="task-card-v2-rfp-banner-text">
        <span className="task-card-v2-rfp-banner-kicker">At restaurant</span>
        <span className="task-card-v2-rfp-banner-title">Ready for pickup</span>
      </div>
    </div>
  );
}

export default function TaskPanel({ onOpenTaskDetails, onFocusTaskOnMap, listRevision = 0 }) {
  const navigate = useNavigate();
  const openDetailsFromRow = (taskId, row) => {
    if (onOpenTaskDetails) onOpenTaskDetails(taskId, row);
    else navigate(`/tasks?highlight=${taskId}`);
  };
  const [tasks, setTasks] = useState([]);
  const [counts, setCounts] = useState({ unassigned: 0, assigned: 0, completed: 0 });
  const [problemCounts, setProblemCounts] = useState({ cancelled: 0, declined: 0, failed: 0 });
  /** 'active' = normal pipeline (unassigned / assigned / completed); 'problem' = cancelled / declined / failed */
  const [taskMode, setTaskMode] = useState('active');
  const [problemTaskFilter, setProblemTaskFilter] = useState(readStoredProblemFilter);
  const [activeTab, setActiveTab] = useState('unassigned');
  const [loading, setLoading] = useState(true);
  const [selectedDateTime, setSelectedDateTime] = useState(() => initialTaskPanelSelectedDate());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth() + 1);
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [popoverRect, setPopoverRect] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const [sortOrder, setSortOrder] = useState('rfp');
  const [sortDirection, setSortDirection] = useState('latest');
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  /** When true, list shows all advance/scheduled orders for the selected date (any task status). */
  const [scheduledOrdersOnly, setScheduledOrdersOnly] = useState(false);
  const [activityRefreshIntervalMs, setActivityRefreshIntervalMs] = useState(30000);
  const [taskCriticalEnabled, setTaskCriticalEnabled] = useState(false);
  const [taskCriticalMinutes, setTaskCriticalMinutes] = useState(5);
  /** Bumps on an interval so header time + “waiting” minutes refresh without 1s full-panel re-renders. */
  const [panelTimeTick, setPanelTimeTick] = useState(0);
  const calendarRef = useRef(null);
  const sortRef = useRef(null);
  /** Latest `taskCacheKey`; used so slow `tasks` responses never overwrite UI after date/mode changed. */
  const taskCacheKeyRef = useRef('');
  const selectedDateYmd = useMemo(() => {
    const y = selectedDateTime.getFullYear();
    const m = String(selectedDateTime.getMonth() + 1).padStart(2, '0');
    const d = String(selectedDateTime.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }, [selectedDateTime]);
  const taskCacheKey = useMemo(
    () => `${TASK_PANEL_CACHE_PREFIX}:${selectedDateYmd}:${taskMode}`,
    [selectedDateYmd, taskMode]
  );
  taskCacheKeyRef.current = taskCacheKey;

  useEffect(() => {
    api('settings')
      .then((s) => {
        const disabled = s.disable_activity_tracking === '1';
        const sec = parseInt(s.activity_refresh_interval, 10);
        const intervalSec = Number.isFinite(sec) && sec >= 5 ? sec : 60;
        setActivityRefreshIntervalMs(disabled ? 86400000 : Math.max(5000, intervalSec * 1000));
        setTaskCriticalEnabled(s.task_critical_options_enabled === '1');
        const mins = parseInt(s.task_critical_options_minutes, 10);
        setTaskCriticalMinutes(Number.isFinite(mins) && mins >= 1 ? mins : 5);
      })
      .catch(() => setActivityRefreshIntervalMs(30000));
  }, []);

  useEffect(() => {
    function handleClickOutside(e) {
      if (sortRef.current && !sortRef.current.contains(e.target)) {
        setSortDropdownOpen(false);
      }
    }
    if (sortDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [sortDropdownOpen]);

  useLayoutEffect(() => {
    if (calendarOpen && calendarRef.current) {
      const rect = calendarRef.current.getBoundingClientRect();
      setPopoverRect({ top: rect.bottom, left: rect.left, width: rect.width, height: rect.height });
    }
  }, [calendarOpen]);

  useEffect(() => {
    if (!calendarOpen) return;
    const onResize = () => {
      if (calendarRef.current) {
        const rect = calendarRef.current.getBoundingClientRect();
        setPopoverRect({ top: rect.bottom, left: rect.left, width: rect.width, height: rect.height });
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [calendarOpen]);

  const openCalendar = () => {
    const d = selectedDateTime;
    setViewMonth(d.getMonth() + 1);
    setViewYear(d.getFullYear());
    setCalendarOpen(true);
  };
  const goPrevMonth = () => {
    if (viewMonth === 1) {
      setViewMonth(12);
      setViewYear((y) => y - 1);
    } else setViewMonth((m) => m - 1);
  };
  const goNextMonth = () => {
    if (viewMonth === 12) {
      setViewMonth(1);
      setViewYear((y) => y + 1);
    } else setViewMonth((m) => m + 1);
  };
  const goToday = () => {
    const now = new Date();
    setViewMonth(now.getMonth() + 1);
    setViewYear(now.getFullYear());
    setSelectedDateTime(now);
  };
  const selectDay = (cell) => {
    const d = new Date(selectedDateTime);
    d.setFullYear(cell.year);
    d.setMonth(cell.month - 1);
    d.setDate(cell.day);
    setSelectedDateTime(d);
    setViewMonth(cell.month);
    setViewYear(cell.year);
  };
  const isSelected = (cell) => {
    const d = selectedDateTime;
    return d.getDate() === cell.day && d.getMonth() + 1 === cell.month && d.getFullYear() === cell.year;
  };
  const calendarGrid = getCalendarGrid(viewYear, viewMonth);

  useEffect(() => {
    try {
      sessionStorage.setItem(DASHBOARD_TASKS_MAP_DATE_KEY, toDateString(selectedDateTime));
    } catch (_) {}
    notifyDashboardTasksMapDateChanged();
  }, [selectedDateTime]);

  /** Keep picker in sync when Dashboard rolls stale session date to today (e.g. visibility). */
  useEffect(() => {
    const syncFromStorage = () => {
      const ymd = readDashboardTasksMapDateFromStorage() || todayDateStrLocal();
      setSelectedDateTime((prev) => {
        const py = prev.getFullYear();
        const pm = prev.getMonth() + 1;
        const pd = prev.getDate();
        const cur = `${py}-${String(pm).padStart(2, '0')}-${String(pd).padStart(2, '0')}`;
        if (cur === ymd) return prev;
        const parts = ymd.split('-').map(Number);
        const [y, m, d] = parts;
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return prev;
        return new Date(y, m - 1, d, 12, 0, 0);
      });
    };
    window.addEventListener(DASHBOARD_TASKS_MAP_DATE_EVENT, syncFromStorage);
    return () => window.removeEventListener(DASHBOARD_TASKS_MAP_DATE_EVENT, syncFromStorage);
  }, []);

  useEffect(() => {
    function handleClickOutside(e) {
      const inTrigger = calendarRef.current && calendarRef.current.contains(e.target);
      const inPopover = e.target.closest('[data-calendar-popover]');
      if (!inTrigger && !inPopover) setCalendarOpen(false);
    }
    if (calendarOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [calendarOpen]);

  const toDateString = (d) => {
    const x = d instanceof Date ? d : new Date(d);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const persistProblemFilter = useCallback((key) => {
    setProblemTaskFilter(key);
    try {
      sessionStorage.setItem(PROBLEM_FILTER_STORAGE_KEY, key);
    } catch (_) {}
  }, []);

  const fetchTasks = useCallback((opts = {}) => {
    const quiet = opts.quiet === true;
    if (!quiet) setLoading(true);
    const dateStr = toDateString(selectedDateTime);
    const cacheKeyAtRequest = taskCacheKey;
    let url = `tasks?date=${encodeURIComponent(dateStr)}`;
    if (taskMode === 'problem') {
      url += `&status_in=${encodeURIComponent(PROBLEM_STATUS_IN)}`;
    }
    api(url)
      .then((list) => {
        if (taskCacheKeyRef.current !== cacheKeyAtRequest) return;
        const raw = list || [];
        setTasks(raw);
        const norm = (status) => String(status ?? '').toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
        if (taskMode === 'active') {
          let u = 0;
          let a = 0;
          let c = 0;
          for (const task of raw) {
            const s = norm(task.status);
            if (s === 'unassigned') u += 1;
            else if (ASSIGNED_TASK_STATUSES.has(s)) a += 1;
            else if (COMPLETED_TASK_STATUSES.has(s)) c += 1;
          }
          setCounts({ unassigned: u, assigned: a, completed: c });
          writeJsonSessionStorage(cacheKeyAtRequest, {
            at: Date.now(),
            tasks: raw,
            counts: { unassigned: u, assigned: a, completed: c },
          });
        } else {
          let cancelled = 0;
          let declined = 0;
          let failed = 0;
          for (const task of raw) {
            const s = norm(task.status);
            if (s === 'cancelled' || s === 'canceled') cancelled += 1;
            else if (s === 'declined') declined += 1;
            else if (s === 'failed') failed += 1;
          }
          setProblemCounts({
            cancelled,
            declined,
            failed,
          });
          writeJsonSessionStorage(cacheKeyAtRequest, {
            at: Date.now(),
            tasks: raw,
            problemCounts: { cancelled, declined, failed },
          });
        }
      })
      .catch((err) => {
        if (taskCacheKeyRef.current !== cacheKeyAtRequest) return;
        const code = err && typeof err === 'object' ? String(err.code || '') : '';
        if (code === 'AUTH_REQUIRED' || code === 'HTML_RESPONSE') {
          setTasks([]);
          if (taskMode === 'active') {
            setCounts({ unassigned: 0, assigned: 0, completed: 0 });
          } else {
            setProblemCounts({ cancelled: 0, declined: 0, failed: 0 });
          }
        }
        /* Timeouts / network blips: keep last good list so the panel does not flash empty. */
      })
      .finally(() => {
        if (taskCacheKeyRef.current !== cacheKeyAtRequest) return;
        if (!quiet) setLoading(false);
      });
  }, [selectedDateTime, taskMode, taskCacheKey]);

  useEffect(() => {
    const cached = readJsonSessionStorage(taskCacheKey, null);
    if (cached && typeof cached === 'object' && Array.isArray(cached.tasks)) {
      setTasks(cached.tasks);
      setLoading(false);
      if (taskMode === 'active' && cached.counts && typeof cached.counts === 'object') {
        setCounts({
          unassigned: Number(cached.counts.unassigned) || 0,
          assigned: Number(cached.counts.assigned) || 0,
          completed: Number(cached.counts.completed) || 0,
        });
      }
      if (taskMode === 'problem' && cached.problemCounts && typeof cached.problemCounts === 'object') {
        setProblemCounts({
          cancelled: Number(cached.problemCounts.cancelled) || 0,
          declined: Number(cached.problemCounts.declined) || 0,
          failed: Number(cached.problemCounts.failed) || 0,
        });
      }
      return;
    }
    setTasks([]);
    if (taskMode === 'active') {
      setCounts({ unassigned: 0, assigned: 0, completed: 0 });
    } else {
      setProblemCounts({ cancelled: 0, declined: 0, failed: 0 });
    }
    setLoading(true);
  }, [taskCacheKey, taskMode]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    if (listRevision < 1) return;
    fetchTasks({ quiet: true });
  }, [listRevision, fetchTasks]);

  useEffect(() => {
    const id = setInterval(() => setPanelTimeTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const fetchTasksQuiet = useCallback(() => fetchTasks({ quiet: true }), [fetchTasks]);
  useTableAutoRefresh(fetchTasksQuiet, activityRefreshIntervalMs);

  useEffect(() => {
    let delayTimer;
    const onRealtime = (e) => {
      if (delayTimer) clearTimeout(delayTimer);
      const delayMs =
        e && e.detail && typeof e.detail.delayMs === 'number' && Number.isFinite(e.detail.delayMs)
          ? Math.max(0, e.detail.delayMs)
          : 250;
      delayTimer = window.setTimeout(() => {
        delayTimer = null;
        fetchTasksQuiet();
      }, delayMs);
    };
    window.addEventListener(RIDER_NOTIFICATIONS_POLL_EVENT, onRealtime);
    return () => {
      if (delayTimer) clearTimeout(delayTimer);
      window.removeEventListener(RIDER_NOTIFICATIONS_POLL_EVENT, onRealtime);
    };
  }, [fetchTasksQuiet]);

  const normStatus = (status) => String(status ?? '').toLowerCase().replace(/\s+/g, '').replace(/_/g, '');

  const filteredByTab = useMemo(() => {
    return tasks.filter((t) => {
      const s = normStatus(t.status);
      if (activeTab === 'unassigned') return s === 'unassigned';
      if (activeTab === 'assigned') return ASSIGNED_TASK_STATUSES.has(s);
      return COMPLETED_TASK_STATUSES.has(s);
    });
  }, [tasks, activeTab]);

  const filteredByProblem = useMemo(() => {
    return tasks.filter((t) => {
      const s = normStatus(t.status);
      if (problemTaskFilter === 'cancelled') return s === 'cancelled' || s === 'canceled';
      if (problemTaskFilter === 'declined') return s === 'declined';
      return s === 'failed';
    });
  }, [tasks, problemTaskFilter]);

  const scheduledTasksAll = useMemo(() => (tasks || []).filter(isAdvanceOrderDisplay), [tasks]);
  const scheduledCount = scheduledTasksAll.length;

  const filteredByMode = useMemo(() => {
    if (taskMode === 'problem') return filteredByProblem;
    if (scheduledOrdersOnly) return scheduledTasksAll;
    return filteredByTab;
  }, [taskMode, scheduledOrdersOnly, filteredByProblem, filteredByTab, scheduledTasksAll]);

  const filtered = useMemo(() => {
    return [...filteredByMode].sort((a, b) => {
      const dateA = a.date_created ? new Date(a.date_created).getTime() : 0;
      const dateB = b.date_created ? new Date(b.date_created).getTime() : 0;
      const dirA = String(getDirectionFromTask(a) ?? '').toLowerCase();
      const dirB = String(getDirectionFromTask(b) ?? '').toLowerCase();
      const orderA = a.order_id ?? a.task_id ?? 0;
      const orderB = b.order_id ?? b.task_id ?? 0;
      let cmp = 0;
      if (sortOrder === 'rfp') cmp = Number(orderA) - Number(orderB);
      else if (sortOrder === 'manual') cmp = dateA - dateB;
      else if (sortOrder === 'direction') cmp = dirA.localeCompare(dirB);
      else cmp = dateA - dateB;
      return sortDirection === 'latest' ? -cmp : cmp;
    });
  }, [filteredByMode, sortOrder, sortDirection]);

  const statItems = [
    { key: 'unassigned', label: 'Unassigned', count: counts.unassigned ?? 0, highlight: activeTab === 'unassigned' && !scheduledOrdersOnly, icon: 'clock' },
    { key: 'assigned', label: 'Assigned', count: counts.assigned ?? 0, highlight: activeTab === 'assigned' && !scheduledOrdersOnly, icon: 'user-check' },
    { key: 'completed', label: 'Completed', count: counts.completed ?? 0, highlight: activeTab === 'completed' && !scheduledOrdersOnly, icon: 'check' },
  ];

  const problemStatItems = [
    { key: 'cancelled', label: 'Cancelled', count: problemCounts.cancelled ?? 0, highlight: problemTaskFilter === 'cancelled', icon: 'ban' },
    { key: 'declined', label: 'Declined', count: problemCounts.declined ?? 0, highlight: problemTaskFilter === 'declined', icon: 'user-x' },
    { key: 'failed', label: 'Failed', count: problemCounts.failed ?? 0, highlight: problemTaskFilter === 'failed', icon: 'alert' },
  ];

  const showAllInList =
    taskMode === 'problem' ||
    scheduledOrdersOnly ||
    (taskMode === 'active' && activeTab === 'completed');

  return (
    <div className="panel tasks-panel">
      <div className="panel-header tasks-panel-header">
        <span className="panel-header-title-wrap tasks-panel-header-title">Tasks</span>
        <div className="tasks-panel-date-wrap" ref={calendarRef}>
          <button
            type="button"
            className="panel-header-date tasks-panel-header-date tasks-panel-date-trigger"
            onClick={() => (calendarOpen ? setCalendarOpen(false) : openCalendar())}
            aria-label="Select date and time"
            title="Choose which day’s tasks to show (and time for scheduling)"
            aria-expanded={calendarOpen}
            data-panel-clock={panelTimeTick}
          >
            <span className="panel-header-date-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z"/></svg>
            </span>
            <span className="tasks-panel-date-text">
              {toDisplayDateLong(selectedDateTime)} {toDisplayTime12h(new Date())}
            </span>
          </button>
          {calendarOpen && createPortal(
            <div
              className="tasks-panel-calendar-popover tasks-panel-calendar-widget tasks-panel-calendar-portal"
              data-calendar-popover
              style={{
                position: 'fixed',
                left: popoverRect.left,
                top: popoverRect.top + 4,
                zIndex: 10000,
                width: 320,
                minWidth: 320,
              }}
              onKeyDown={(e) => e.key === 'Escape' && setCalendarOpen(false)}
              role="dialog"
              aria-label="Choose date"
            >
              <div className="tasks-panel-calendar-input-bar">
                {toDatePickerLabel(selectedDateTime)}
              </div>
              <div className="tasks-panel-calendar-nav">
                <button type="button" className="tasks-panel-calendar-nav-btn" onClick={goPrevMonth} aria-label="Previous month">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                </button>
                <button type="button" className="tasks-panel-calendar-nav-btn" onClick={goToday} aria-label="Today">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
                </button>
                <select
                  className="tasks-panel-calendar-month-select"
                  value={viewMonth}
                  onChange={(e) => {
                    const m = parseInt(e.target.value, 10);
                    setViewMonth(m);
                    const d = new Date(selectedDateTime);
                    d.setMonth(m - 1);
                    if (d.getMonth() !== m - 1) d.setDate(0);
                    setSelectedDateTime(d);
                  }}
                  aria-label="Select month"
                >
                  {MONTH_NAMES.map((name, i) => (
                    <option key={i} value={i + 1}>{name}</option>
                  ))}
                </select>
                <select
                  className="tasks-panel-calendar-year-select"
                  value={viewYear}
                  onChange={(e) => {
                    const y = parseInt(e.target.value, 10);
                    setViewYear(y);
                    const d = new Date(selectedDateTime);
                    d.setFullYear(y);
                    if (d.getFullYear() !== y) d.setDate(0);
                    setSelectedDateTime(d);
                  }}
                  aria-label="Select year"
                >
                  {(() => {
                    const y = new Date().getFullYear();
                    const years = [];
                    for (let i = y - 10; i <= y + 2; i++) years.push(i);
                    return years.map((yr) => <option key={yr} value={yr}>{yr}</option>);
                  })()}
                </select>
                <button type="button" className="tasks-panel-calendar-nav-btn" onClick={goNextMonth} aria-label="Next month">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
                </button>
              </div>
              <div className="tasks-panel-calendar-headers">
                {DAY_HEADERS.map((h) => (
                  <span key={h} className="tasks-panel-calendar-day-header">{h}</span>
                ))}
              </div>
              <div className="tasks-panel-calendar-grid">
                {calendarGrid.map((cell, idx) => (
                  <button
                    key={`${cell.year}-${cell.month}-${cell.day}-${idx}`}
                    type="button"
                    className={`tasks-panel-calendar-day ${cell.isOther ? 'tasks-panel-calendar-day-other' : ''} ${isSelected(cell) ? 'tasks-panel-calendar-day-selected' : ''}`}
                    onClick={() => selectDay(cell)}
                  >
                    {cell.day}
                  </button>
                ))}
              </div>
              <div className="tasks-panel-calendar-time-row">
                <label className="tasks-panel-calendar-label">Time</label>
                <input
                  type="time"
                  className="tasks-panel-time-input"
                  value={selectedDateTime.toTimeString().slice(0, 5)}
                  onChange={(e) => {
                    const [h, m] = (e.target.value || '00:00').split(':').map(Number);
                    const d = new Date(selectedDateTime);
                    d.setHours(h, m, 0, 0);
                    setSelectedDateTime(d);
                  }}
                />
              </div>
              <div className="tasks-panel-calendar-actions">
                <button type="button" className="tasks-panel-calendar-today" onClick={() => { setSelectedDateTime(new Date()); setCalendarOpen(false); }}>
                  Today
                </button>
                <button type="button" className="tasks-panel-calendar-close" onClick={() => setCalendarOpen(false)}>
                  Close
                </button>
              </div>
            </div>,
            document.body
          )}
        </div>
        <div className="tasks-panel-header-actions tasks-panel-header-controls">
          <div className="tasks-panel-view-switch" role="tablist" aria-label="Task view">
            <button
              type="button"
              role="tab"
              aria-selected={taskMode === 'active'}
              className={`tasks-panel-view-switch-seg ${taskMode === 'active' ? 'is-active' : ''}`}
              title="Normal workflow: unassigned, assigned, and completed tasks"
              onClick={() => {
                setTaskMode('active');
                setScheduledOrdersOnly(false);
              }}
            >
              Active
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={taskMode === 'problem'}
              className={`tasks-panel-view-switch-seg ${taskMode === 'problem' ? 'is-active' : ''}`}
              title="Cancelled, declined, or failed tasks that need attention"
              onClick={() => {
                setTaskMode('problem');
                setScheduledOrdersOnly(false);
              }}
            >
              Problem
            </button>
          </div>
          <div className="tasks-panel-sort-wrap" ref={sortRef}>
            <button
              type="button"
              className={`tasks-panel-header-icon tasks-panel-sort-menu-trigger ${sortDropdownOpen ? 'active' : ''}`}
              aria-label="Sort list: order and direction"
              title="Change task sort (e.g. RFP, latest vs oldest)"
              aria-expanded={sortDropdownOpen}
              onClick={() => setSortDropdownOpen((o) => !o)}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 18h6v-2H3v2zm0-5h12v-2H3v2zm0-7v2h18V6H3z"/></svg>
            </button>
            {sortDropdownOpen && (
              <div className="tasks-panel-sort-dropdown">
                <div className="tasks-panel-sort-section">
                  <span className="tasks-panel-sort-label">Sorting order</span>
                  {SORT_ORDER_OPTIONS.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      className={`tasks-panel-sort-option ${sortOrder === key ? 'active' : ''}`}
                      onClick={() => { setSortOrder(key); setSortDropdownOpen(false); }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="tasks-panel-sort-section">
                  <span className="tasks-panel-sort-label">Order</span>
                  {SORT_DIRECTION_OPTIONS.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      className={`tasks-panel-sort-option ${sortDirection === key ? 'active' : ''}`}
                      onClick={() => { setSortDirection(key); setSortDropdownOpen(false); }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className={`tasks-panel-sort-indicator${scheduledOrdersOnly && taskMode === 'active' ? ' tasks-panel-sort-indicator--scheduled' : ''}`}>
        <div className="tasks-panel-sort-indicator-row">
          <span className="tasks-panel-sort-indicator-text">
            {taskMode === 'problem' ? (
              <>
                <span className="tasks-panel-view-mode-label">Problem tasks</span>
                <span className="tasks-panel-sort-indicator-sep" aria-hidden="true"> · </span>
              </>
            ) : null}
            {taskMode === 'active' && scheduledOrdersOnly ? (
              <>
                <span className="tasks-panel-sort-indicator-scheduled-label">Scheduled orders</span>
                <span className="tasks-panel-sort-indicator-sep" aria-hidden="true"> · </span>
              </>
            ) : null}
            <span>
              Sort: {SORT_ORDER_OPTIONS.find((o) => o.key === sortOrder)?.label ?? sortOrder} · {sortDirection === 'latest' ? 'Latest first' : 'Oldest first'}
            </span>
          </span>
          {taskMode === 'active' ? (
            <button
              type="button"
              className={`tasks-panel-scheduled-orders-btn${scheduledOrdersOnly ? ' is-active' : ''}`}
              onClick={() => setScheduledOrdersOnly((v) => !v)}
              aria-pressed={scheduledOrdersOnly}
              aria-label={scheduledOrdersOnly ? 'Exit scheduled orders view, show status tab list' : `Show scheduled orders${scheduledCount ? `, ${scheduledCount} on this date` : ''}`}
              title={
                scheduledOrdersOnly
                  ? 'Return to unassigned / assigned / completed tabs'
                  : `Show only future scheduled orders for this date${scheduledCount ? ` (${scheduledCount})` : ''}`
              }
            >
              Scheduled Orders
              {scheduledCount > 0 ? (
                <span className="tasks-panel-scheduled-orders-count">{scheduledCount}</span>
              ) : null}
            </button>
          ) : null}
        </div>
      </div>
      <div className={`panel-stats panel-stats--tasks${taskMode === 'problem' ? ' panel-stats--tasks-problem' : ''}`}>
        {taskMode === 'active'
          ? statItems.map(({ key, label, count, highlight, icon }) => (
            <button
              key={key}
              type="button"
              className={`panel-stats-item ${highlight ? 'highlight' : ''} ${activeTab === key && !scheduledOrdersOnly ? 'active' : ''}`}
              data-stat-key={key}
              onClick={() => {
                setScheduledOrdersOnly(false);
                setActiveTab(key);
              }}
              aria-pressed={activeTab === key && !scheduledOrdersOnly}
              aria-label={`${label}: ${count}`}
              title={
                key === 'unassigned'
                  ? 'Tasks not yet assigned to a rider'
                  : key === 'assigned'
                    ? 'Tasks accepted or in progress with a rider'
                    : 'Delivered or completed tasks for this date'
              }
            >
              <span className="panel-stats-icon" aria-hidden="true">
                {icon === 'clock' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                )}
                {icon === 'user-check' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/></svg>
                )}
                {icon === 'check' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                )}
              </span>
              <span className="panel-stats-number">{count}</span>
              <span className="panel-stats-label">{label}</span>
            </button>
          ))
          : problemStatItems.map(({ key, label, count, highlight, icon }) => (
            <button
              key={key}
              type="button"
              className={`panel-stats-item panel-stats-item--problem ${highlight ? 'highlight' : ''} ${problemTaskFilter === key ? 'active' : ''}`}
              data-stat-key={key}
              onClick={() => persistProblemFilter(key)}
              aria-pressed={problemTaskFilter === key}
              aria-label={`${label}: ${count}`}
              title={
                key === 'cancelled'
                  ? 'Orders cancelled before or during delivery'
                  : key === 'declined'
                    ? 'Tasks the rider declined'
                    : 'Tasks that could not be completed'
              }
            >
              <span className="panel-stats-icon" aria-hidden="true">
                {icon === 'ban' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                )}
                {icon === 'user-x' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5m0-5-5 5"/></svg>
                )}
                {icon === 'alert' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                )}
              </span>
              <span className="panel-stats-number">{count}</span>
              <span className="panel-stats-label">{label}</span>
            </button>
          ))}
      </div>
      <div className={`panel-body ${filtered.length === 0 ? 'empty' : ''}`}>
        {loading && filtered.length === 0 && 'Loading…'}
        {!loading && filtered.length === 0 && (
          scheduledOrdersOnly
            ? 'No scheduled orders for this date'
            : taskMode === 'problem'
              ? `No ${problemTaskFilter} tasks for this date`
              : 'No tasks'
        )}
        {filtered.length > 0 && (
          <ul className="task-card-list">
            {(showAllInList ? filtered : filtered.slice(0, 20)).map((t) => {
              const statusNorm = normStatus(t.status);
              const created = t.date_created ? new Date(t.date_created) : null;
              const minsWaiting = created ? Math.max(0, Math.floor((Date.now() - created.getTime()) / 60000)) : null;
              const waitingMins = minsWaiting !== null ? (minsWaiting >= 60 ? `${Math.floor(minsWaiting / 60)} hr ${minsWaiting % 60} mins` : `${minsWaiting}mins`) : null;
              const isUnassigned = statusNorm === 'unassigned';
              const isAssigned = statusNorm === 'assigned';
              const isAcknowledged = statusNorm === 'acknowledged';
              const isStarted = statusNorm === 'started';
              const isInProgress = statusNorm === 'inprogress';
              const isCompleted = COMPLETED_TASK_STATUSES.has(statusNorm);
              const isProblemStatus = PROBLEM_TASK_STATUSES.has(statusNorm);
              const isCritical = taskCriticalEnabled && isUnassigned && minsWaiting !== null && minsWaiting >= taskCriticalMinutes;
              const driverName = (t.driver_name || '').trim();
              const advanceLines = getAdvanceOrderLines(t, t.date_created);
              const showRfpBanner = Boolean(t.timeline_ready_for_pickup);
              const mapFocusCoords = taskDropoffLatLng(t);
              const canFocusMap = Boolean(mapFocusCoords && onFocusTaskOnMap);
              const deliveryAddress = sanitizeLocationDisplayName(t.delivery_address) || '—';
              const locationZone = deliveryAddress !== '—' ? getLocationZone(deliveryAddress) : 'default';
              const direction = getDirectionFromTask(t);
              const merchantRaw =
                t.restaurant_name ||
                (t.dropoff_merchant && !/^\d+$/.test(String(t.dropoff_merchant).trim()) ? t.dropoff_merchant : null) ||
                '—';
              const merchantName = sanitizeMerchantDisplayName(merchantRaw) || '—';
              const shortMerchantName = merchantName.length > 40 ? `${merchantName.slice(0, 40)}…` : merchantName;
              const shortDeliveryAddress = deliveryAddress.length > 90 ? `${deliveryAddress.slice(0, 90)}…` : deliveryAddress;
              return (
                <li
                  key={t.task_source === 'errand' ? `errand-${t.order_id ?? t.task_id}` : t.task_id}
                  className={`task-card-v2${isCritical ? ' task-card-v2-critical' : ''}`}
                  style={canFocusMap ? { cursor: 'pointer' } : undefined}
                  onClick={canFocusMap ? () => onFocusTaskOnMap(t) : undefined}
                >
                  <div className="task-card-v2-top">
                    <div className="task-card-v2-direction" title="Delivery direction">
                      <span className="task-card-v2-direction-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="currentColor" style={{ transform: `rotate(${directionArrowRotation(direction)}deg)` }}>
                          <path d="M12 4l-6 8h4v8h4v-8h4L12 4z"/>
                        </svg>
                      </span>
                      <span className="task-card-v2-direction-label">{directionDisplayLabel(direction)}</span>
                    </div>
                    <span className="task-card-v2-order">
                      <span className="task-card-v2-order-label">Order No.</span>
                      <span className="task-card-v2-order-num">{shortTaskOrderDigits(t.order_id, t.task_id)}</span>
                      {t.task_source === 'errand' && (
                        <span className="task-card-v2-errand-badge" title="Mangan Order (ErrandWib)">
                          MANGAN
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="task-card-v2-merchant-row">
                    <span className="task-card-v2-icon task-card-v2-icon-pin" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
                    </span>
                    <span className="task-card-v2-merchant-name">{shortMerchantName}</span>
                    {(isUnassigned || isProblemStatus) && (
                      <button
                        type="button"
                        className="btn-assign-driver"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetailsFromRow(t.task_id, t);
                        }}
                      >
                        {isUnassigned ? 'Assign Driver' : 'Re-assign Rider'}
                      </button>
                    )}
                  </div>
                  {showRfpBanner ? (
                    <TaskCardReadyForPickupBanner className="task-card-v2-rfp-banner--below-pickup" />
                  ) : null}
                  <div className="task-card-v2-row task-card-v2-customer-row">
                    <span className="task-card-v2-icon task-card-v2-icon-user" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                    </span>
                    <span className="task-card-v2-customer">{t.customer_name || '—'}</span>
                  </div>
                  <div className="task-card-v2-address-wrap">
                    <div className="task-card-v2-address-zone">
                      <span className={`task-location-chip task-location-chip--${locationZone}`} title={`Location zone: ${getLocationZoneLabel(locationZone)}`}>
                        {getLocationZoneLabel(locationZone)}
                      </span>
                    </div>
                    <div
                      className="task-card-v2-address"
                      title={deliveryAddress || undefined}
                    >
                      {shortDeliveryAddress}
                    </div>
                  </div>
                  {advanceLines && (
                    <div className="task-card-v2-advance" role="status" aria-label="Advance order schedule">
                      <span className="task-card-v2-advance-line">{advanceLines.deliveryLine}</span>
                      {advanceLines.orderedLine ? (
                        <span className="task-card-v2-advance-line">{advanceLines.orderedLine}</span>
                      ) : null}
                      {advanceLines.noteLine ? (
                        <span className="task-card-v2-advance-line task-card-v2-advance-note">{advanceLines.noteLine}</span>
                      ) : null}
                    </div>
                  )}
                  {isUnassigned && waitingMins && (
                    <div className="task-card-v2-waiting">
                      <span className="task-card-v2-icon" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
                      </span>
                      <span className="task-card-v2-waiting-duration">{waitingMins}</span> waiting
                    </div>
                  )}
                  {(isAssigned || isAcknowledged || isStarted || isInProgress || isCompleted || isProblemStatus) && (
                    <div className="task-card-v2-driver task-card-v2-status">
                      <span className={`task-card-v2-status-badge ${statusClass(statusNorm)}`}>{statusLabel(statusNorm)}</span>
                      {driverName && <span className="task-card-v2-driver-name">{driverName}</span>}
                    </div>
                  )}
                  <div className="task-card-v2-footer">
                    <button
                      type="button"
                      className="task-card-details"
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetailsFromRow(t.task_id, t);
                      }}
                      aria-label={`View details for order ${t.order_id ?? t.task_id}`}
                    >
                      <span>View details</span>
                      <svg className="task-card-details-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
