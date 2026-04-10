import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import TaskPanel from '../components/TaskPanel';
import MapErrorBoundary from '../components/MapErrorBoundary';

const MapView = lazy(() => import('../components/MapView'));
import TaskDetailsModal from '../components/TaskDetailsModal';
import TaskDetailsModalErrorBoundary from '../components/TaskDetailsModalErrorBoundary';
const ActivityTimelineToastStack = lazy(() => import('../components/ActivityTimelineToastStack'));

/** Matches MapView MAP_STYLE so layout does not jump while the map chunk loads. */
const MAP_CHUNK_FALLBACK_STYLE = {
  width: '100%',
  height: '100%',
  minHeight: 400,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#e8e8e8',
  color: '#666',
};
import AgentPanel from '../components/AgentPanel';
import { useMapMerchantFilterSelection } from '../components/MapMerchantFilter';
import { hydrateMapMerchantFilterFromServer } from '../utils/mapMerchantFilterPrefs';
import { api, userFacingApiError, apiEventSourceUrl } from '../api';
import { RIDER_NOTIFICATIONS_POLL_EVENT } from '../hooks/useNotifications';
import { getToken } from '../auth';

const MOBILE_DASHBOARD_MQ = '(max-width: 768px)';
const MAP_DATA_MIN_REFRESH_MS = 1200;
const MERCHANTS_REFRESH_MS = 60000;
const ACTIVE_DRIVER_IDS_REFRESH_MS = 10000;
const MAP_AUTO_REFRESH_MIN_MS = 15000;
const MAP_AUTO_REFRESH_MAX_MS = 45000;
const DASHBOARD_MAP_CACHE_PREFIX = 'wib-dashboard-map-cache-v1';
import { useTeamFilter } from '../context/TeamFilterContext';
import {
  DASHBOARD_TASKS_MAP_DATE_KEY,
  DASHBOARD_TASKS_MAP_DATE_EVENT,
  notifyDashboardTasksMapDateChanged,
  readDashboardTasksMapDateFromStorage,
  readEffectiveDashboardTaskDate,
  todayDateStrLocal,
  tasksWithMapCoordinates,
  taskDropoffLatLng,
  riderGpsFromLocations,
  riderMapFocusZoom,
} from '../utils/mapTasks';

/** `{ nonce, lat, lng, zoom? }` — optional `zoom` for rider focus vs default task zoom in MapView. */
function nextDashboardMapFocus(prev, lat, lng, zoom) {
  const o = { nonce: (prev?.nonce ?? 0) + 1, lat, lng };
  if (zoom != null && Number.isFinite(Number(zoom))) o.zoom = Number(zoom);
  return o;
}

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
import { buildActivePanelDriverIdSet } from '../utils/agentPanelRiders';

export default function Dashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedTeamId } = useTeamFilter();
  const [taskDetailsId, setTaskDetailsId] = useState(null);
  /** Same shape as a `tasks` list row — paints the modal instantly while full details fetch. */
  const [taskDetailsListSnapshot, setTaskDetailsListSnapshot] = useState(null);
  const [taskDetailsInitialTab, setTaskDetailsInitialTab] = useState('details');
  /** Bumped when task details modal mutates tasks so TaskPanel + AgentPanel refetch immediately. */
  const [taskListRevision, setTaskListRevision] = useState(0);
  const bumpTaskLists = useCallback(() => setTaskListRevision((n) => n + 1), []);

  const agentPanelRef = useRef(null);
  const [driverQueueCount, setDriverQueueCount] = useState(0);

  const handleViewDriverQueueFromMap = useCallback(() => {
    if (typeof window !== 'undefined' && window.matchMedia(MOBILE_DASHBOARD_MQ).matches) {
      setMobileSection('agents');
    }
    agentPanelRef.current?.openDriverQueue?.();
  }, []);

  const openTaskDetails = useCallback((id, opts) => {
    const tab =
      opts && (opts.initialTab === 'timeline' || opts.initialTab === 'order') ? opts.initialTab : 'details';
    setTaskDetailsInitialTab(tab);
    const snap = opts?.listTaskSnapshot;
    if (snap != null && typeof snap === 'object' && String(snap.task_id) === String(id)) {
      setTaskDetailsListSnapshot(snap);
    } else {
      setTaskDetailsListSnapshot(null);
    }
    setTaskDetailsId(id);
  }, []);

  useEffect(() => {
    const id = location.state && location.state.wibOpenTaskId;
    if (id == null || !Number.isFinite(Number(id)) || Number(id) === 0) return;
    openTaskDetails(id, { initialTab: 'details' });
    navigate(location.pathname + (location.search || ''), { replace: true, state: {} });
  }, [location.state, location.pathname, location.search, navigate, openTaskDetails]);

  const handleOpenTaskDetailsFromPanel = useCallback(
    (id, listRow) =>
      openTaskDetails(id, { initialTab: 'details', listTaskSnapshot: listRow }),
    [openTaskDetails]
  );

  const [mobileSection, setMobileSection] = useState('tasks'); // 'tasks' | 'map' | 'agents' for small screens
  const [mapResizeTrigger, setMapResizeTrigger] = useState(0);
  const [mapTaskFocusRequest, setMapTaskFocusRequest] = useState(null);

  const handleFocusTaskOnMap = useCallback((task) => {
    const p = taskDropoffLatLng(task);
    if (!p) return;
    setMapTaskFocusRequest((prev) => nextDashboardMapFocus(prev, p.lat, p.lng));
    if (typeof window !== 'undefined' && window.matchMedia(MOBILE_DASHBOARD_MQ).matches) {
      setMobileSection('map');
    }
  }, []);

  const handleResetMapView = useCallback(() => {
    setMapTaskFocusRequest(null);
    setMapResizeTrigger((n) => n + 1);
  }, []);

  const [locations, setLocations] = useState([]);
  const [merchants, setMerchants] = useState([]);
  const selectedMapMerchantIds = useMapMerchantFilterSelection();
  const [mapProvider, setMapProvider] = useState('mapbox');
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [mapboxToken, setMapboxToken] = useState('');
  const [activityRefreshIntervalSec, setActivityRefreshIntervalSec] = useState(60);
  const [disableActivityTracking, setDisableActivityTracking] = useState(false);
  const [defaultMapCenter, setDefaultMapCenter] = useState([12.8797, 121.774]);
  const [defaultMapZoom, setDefaultMapZoom] = useState(5);
  const [googleMapStyle, setGoogleMapStyle] = useState('');
  const [tasksMapDateStr, setTasksMapDateStr] = useState(() => readEffectiveDashboardTaskDate());
  const [rawMapTasks, setRawMapTasks] = useState([]);
  const realtimeRefreshAtRef = useRef(0);
  const mapDataInFlightRef = useRef(null);
  const lastMapDataRefreshAtRef = useRef(0);
  const lastMerchantsRefreshAtRef = useRef(0);
  const activeIdsInFlightRef = useRef(null);
  const lastActiveIdsRefreshAtRef = useRef(0);
  /** null = agent roster still loading (map shows all rider GPS pins); then filtered to Active panel roster. */
  const [activePanelDriverIdSet, setActivePanelDriverIdSet] = useState(null);
  const mapDataCacheKey = useMemo(
    () => `${DASHBOARD_MAP_CACHE_PREFIX}:${String(selectedTeamId ?? 'all')}:${tasksMapDateStr}`,
    [selectedTeamId, tasksMapDateStr]
  );
  const handleFocusRiderOnMap = useCallback(
    (driver) => {
      const p = riderGpsFromLocations(driver, locations);
      if (!p) return;
      const focusZoom = riderMapFocusZoom(p.lat, p.lng, locations);
      setMapTaskFocusRequest((prev) => nextDashboardMapFocus(prev, p.lat, p.lng, focusZoom));
      if (typeof window !== 'undefined' && window.matchMedia(MOBILE_DASHBOARD_MQ).matches) {
        setMobileSection('map');
      }
    },
    [locations]
  );

  const driversLocationsUrl = selectedTeamId
    ? `drivers/locations?team_id=${encodeURIComponent(selectedTeamId)}`
    : 'drivers/locations';

  useEffect(() => {
    const cached = readJsonSessionStorage(mapDataCacheKey, null);
    if (!cached || typeof cached !== 'object') return;
    const loc = Array.isArray(cached.locations) ? cached.locations : null;
    const mer = Array.isArray(cached.merchants) ? cached.merchants : null;
    const tasks = Array.isArray(cached.tasks) ? cached.tasks : null;
    if (loc) setLocations(loc);
    if (mer) setMerchants(mer);
    if (tasks) setRawMapTasks(tasks);
  }, [mapDataCacheKey]);

  const refreshActivePanelDriverIds = useCallback(async (opts = {}) => {
    const force = opts.force === true;
    const now = Date.now();
    if (!force && now - lastActiveIdsRefreshAtRef.current < ACTIVE_DRIVER_IDS_REFRESH_MS) return;
    if (activeIdsInFlightRef.current) return activeIdsInFlightRef.current;
    const request = (async () => {
      lastActiveIdsRefreshAtRef.current = now;
    const params = new URLSearchParams();
    params.set('date', todayDateStrLocal());
    if (selectedTeamId != null && selectedTeamId !== '') {
      params.set('team_id', String(selectedTeamId));
    }
    try {
      const res = await api(`driver/agent-dashboard?${params}`);
      const d = res?.details || {};
      let idSet = buildActivePanelDriverIdSet(d, selectedTeamId);
      if (idSet === null) {
        const rows = await api('drivers');
        let drivers = Array.isArray(rows) ? rows : [];
        if (selectedTeamId != null && selectedTeamId !== '') {
          drivers = drivers.filter((r) => String(r.team_id ?? '') === String(selectedTeamId));
        }
        const normalized = drivers.map((r) => ({
          ...r,
          id: r.id ?? r.driver_id,
          driver_id: r.driver_id ?? r.id,
          online_status: 'lost_connection',
          connection_status: 'Connection Lost',
          last_seen: r.status_updated_at ? new Date(r.status_updated_at).toLocaleString() : '—',
          total_task: r.total_task ?? 0,
        }));
        idSet = buildActivePanelDriverIdSet({ active: [], offline: [], total: normalized }, selectedTeamId);
        if (idSet === null) idSet = null;
      }
      setActivePanelDriverIdSet(idSet);
    } catch {
      // Keep all rider GPS pins visible on transient failures.
      setActivePanelDriverIdSet(null);
    }
    })();
    activeIdsInFlightRef.current = request;
    try {
      await request;
    } finally {
      activeIdsInFlightRef.current = null;
    }
  }, [selectedTeamId]);

  const refreshMapData = useCallback(
    async (opts = {}) => {
      const force = opts.force === true;
      const now = Date.now();
      if (!force && now - lastMapDataRefreshAtRef.current < MAP_DATA_MIN_REFRESH_MS) return;
      if (mapDataInFlightRef.current) return mapDataInFlightRef.current;
      const refreshMerchants = force || now - lastMerchantsRefreshAtRef.current >= MERCHANTS_REFRESH_MS;
      const request = (async () => {
        lastMapDataRefreshAtRef.current = now;
        try {
          const [loc, taskList] = await Promise.all([
            api(driversLocationsUrl).catch(() => []),
            api(`tasks?date=${encodeURIComponent(tasksMapDateStr)}`).catch(() => []),
          ]);
          const nextLoc = Array.isArray(loc) ? loc : [];
          const nextTasks = Array.isArray(taskList) ? taskList : [];
          setLocations(nextLoc);
          setRawMapTasks(nextTasks);
          writeJsonSessionStorage(mapDataCacheKey, {
            at: Date.now(),
            locations: nextLoc,
            merchants,
            tasks: nextTasks,
          });
          if (refreshMerchants) {
            const merchantsOrNull = await api('merchants/locations').catch(() => null);
            const nextMerchants = Array.isArray(merchantsOrNull) ? merchantsOrNull : merchants;
            setMerchants(nextMerchants);
            lastMerchantsRefreshAtRef.current = Date.now();
            writeJsonSessionStorage(mapDataCacheKey, {
              at: Date.now(),
              locations: nextLoc,
              merchants: nextMerchants,
              tasks: nextTasks,
            });
          }
        } catch {
          setLocations([]);
          setRawMapTasks([]);
          if (refreshMerchants) setMerchants([]);
        }
      })();
      mapDataInFlightRef.current = request;
      try {
        await request;
      } finally {
        mapDataInFlightRef.current = null;
      }
    },
    [driversLocationsUrl, tasksMapDateStr, mapDataCacheKey, merchants]
  );

  useEffect(() => {
    refreshMapData({ force: true });
  }, [refreshMapData, taskListRevision]);

  useEffect(() => {
    refreshActivePanelDriverIds({ force: true });
  }, [refreshActivePanelDriverIds]);

  useEffect(() => {
    if (taskListRevision < 1) return;
    refreshActivePanelDriverIds({ force: true });
  }, [taskListRevision, refreshActivePanelDriverIds]);

  const filteredMerchantsForMap = useMemo(() => {
    if (!selectedMapMerchantIds.length) return merchants;
    const allowed = new Set(selectedMapMerchantIds.map(String));
    return (merchants || []).filter((m) => allowed.has(String(m.merchant_id ?? m.id ?? '')));
  }, [merchants, selectedMapMerchantIds]);

  const locationsForMapActiveRiders = useMemo(() => {
    const locs = locations || [];
    /* Until agent-dashboard resolves, show all GPS pins so the map is not empty on first paint. */
    if (activePanelDriverIdSet === null) return locs;
    return locs.filter((loc) => activePanelDriverIdSet.has(String(loc.driver_id ?? '')));
  }, [locations, activePanelDriverIdSet]);

  const filteredLocationsForMap = useMemo(() => {
    if (!selectedMapMerchantIds.length) return locationsForMapActiveRiders;
    const allowed = new Set(selectedMapMerchantIds.map(String));
    return locationsForMapActiveRiders.filter((loc) => {
      const mid = loc.active_merchant_id;
      /* Riders with no in-progress task (active_merchant_id null) stay visible; only hide when busy for a merchant outside the filter. */
      if (mid == null || mid === '') return true;
      return allowed.has(String(mid));
    });
  }, [locationsForMapActiveRiders, selectedMapMerchantIds]);

  const mapTasksWithCoords = useMemo(() => tasksWithMapCoordinates(rawMapTasks), [rawMapTasks]);

  const filteredMapTasks = useMemo(() => {
    if (!selectedMapMerchantIds.length) return mapTasksWithCoords;
    const allowed = new Set(selectedMapMerchantIds.map(String));
    return mapTasksWithCoords.filter((t) => {
      /* Mangan (ErrandWib) uses st_merchant ids; map filter options come from mt_merchant only — never hide errand pins by that mismatch. */
      if (t.task_source === 'errand') return true;
      if (t.merchant_id == null || t.merchant_id === '') return true;
      return allowed.has(String(t.merchant_id));
    });
  }, [mapTasksWithCoords, selectedMapMerchantIds]);

  useEffect(() => {
    const sync = () => setTasksMapDateStr(readDashboardTasksMapDateFromStorage() || todayDateStrLocal());
    window.addEventListener(DASHBOARD_TASKS_MAP_DATE_EVENT, sync);
    return () => window.removeEventListener(DASHBOARD_TASKS_MAP_DATE_EVENT, sync);
  }, []);

  /** Tab left overnight: roll stale session date to local today so map + task panel match without manual refresh. */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const today = todayDateStrLocal();
      const stored = readDashboardTasksMapDateFromStorage();
      if (stored && stored < today) {
        try {
          sessionStorage.setItem(DASHBOARD_TASKS_MAP_DATE_KEY, today);
        } catch (_) {}
        notifyDashboardTasksMapDateChanged();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const mapShowsNoMarkers =
    filteredLocationsForMap.length === 0 && filteredMerchantsForMap.length === 0 && filteredMapTasks.length === 0;

  const refreshMapSettings = () => {
    api('settings')
      .then((s) => {
        const provider = (s.map_provider || '').toString().trim().toLowerCase();
        setMapProvider(provider === 'google' ? 'google' : 'mapbox');
        setGoogleApiKey(s.google_api_key || '');
        setMapboxToken((s.mapbox_access_token || '').toString().trim());
        const interval = parseInt(s.activity_refresh_interval, 10);
        const clamped = Number.isFinite(interval) && interval >= 5 ? interval : 60;
        setActivityRefreshIntervalSec(Math.min(clamped, 45));
        setDisableActivityTracking(s.disable_activity_tracking === '1');
        const country = (s.default_map_country || 'ph').toLowerCase();
        if (country === 'ph') {
          setDefaultMapCenter([12.8797, 121.774]);
          setDefaultMapZoom(5);
        }
        setGoogleMapStyle(s.google_map_style != null ? String(s.google_map_style) : '');
      })
      .catch(() => { setGoogleApiKey(''); setMapboxToken(''); });
  };

  useEffect(() => {
    hydrateMapMerchantFilterFromServer();
  }, []);

  useEffect(() => {
    if (location.pathname !== '/') return;
    refreshMapSettings();
  }, [location.pathname]);

  useEffect(() => {
    if (location.pathname !== '/') return;
    const id = window.setTimeout(() => {
      // Warm the lazy map chunk during idle time to reduce first-open wait.
      import('../components/MapView').catch(() => {});
    }, 250);
    return () => window.clearTimeout(id);
  }, [location.pathname]);

  const lastWindowFocusRefreshRef = useRef(0);
  useEffect(() => {
    if (location.pathname !== '/') return undefined;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastWindowFocusRefreshRef.current < 20000) return;
      lastWindowFocusRefreshRef.current = now;
      refreshMapData({ force: true });
      refreshActivePanelDriverIds({ force: true });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [location.pathname, refreshMapData, refreshActivePanelDriverIds]);

  useEffect(() => {
    if (location.pathname !== '/' || disableActivityTracking) return;
    const ms = Math.min(MAP_AUTO_REFRESH_MAX_MS, Math.max(MAP_AUTO_REFRESH_MIN_MS, activityRefreshIntervalSec * 1000));
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshMapData();
        refreshActivePanelDriverIds();
      }
    }, ms);
    return () => clearInterval(id);
  }, [location.pathname, disableActivityTracking, activityRefreshIntervalSec, driversLocationsUrl, refreshMapData, refreshActivePanelDriverIds]);

  useEffect(() => {
    if (location.pathname !== '/') return undefined;
    const token = getToken();
    if (!token) return undefined;
    const query = `token=${encodeURIComponent(token)}&date=${encodeURIComponent(tasksMapDateStr || '')}`;
    const es = new EventSource(apiEventSourceUrl('realtime/stream', query));
    let closed = false;

    const onRealtime = () => {
      if (closed) return;
      try {
        window.dispatchEvent(new CustomEvent(RIDER_NOTIFICATIONS_POLL_EVENT, { detail: { delayMs: 120 } }));
      } catch (_) {}
      bumpTaskLists();
      refreshMapData();
      refreshActivePanelDriverIds();
    };

    es.addEventListener('dashboard_update', onRealtime);
    es.onerror = () => {
      // EventSource auto-reconnects; keep existing polling fallback untouched.
    };

    return () => {
      closed = true;
      try {
        es.removeEventListener('dashboard_update', onRealtime);
      } catch (_) {}
      try {
        es.close();
      } catch (_) {}
    };
  }, [location.pathname, tasksMapDateStr, bumpTaskLists, refreshMapData, refreshActivePanelDriverIds]);

  useEffect(() => {
    if (location.pathname !== '/') return undefined;
    let timer = null;
    const onRealtime = (e) => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - realtimeRefreshAtRef.current < 1200) return;
      realtimeRefreshAtRef.current = now;
      if (timer) clearTimeout(timer);
      const delayMs =
        e && e.detail && typeof e.detail.delayMs === 'number' && Number.isFinite(e.detail.delayMs)
          ? Math.max(0, e.detail.delayMs)
          : 250;
      timer = setTimeout(() => {
        timer = null;
        bumpTaskLists();
        refreshMapData();
        refreshActivePanelDriverIds();
      }, delayMs);
    };
    window.addEventListener(RIDER_NOTIFICATIONS_POLL_EVENT, onRealtime);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(RIDER_NOTIFICATIONS_POLL_EVENT, onRealtime);
    };
  }, [location.pathname, bumpTaskLists, refreshMapData, refreshActivePanelDriverIds]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia(MOBILE_DASHBOARD_MQ).matches) return undefined;
    if (mobileSection !== 'map') return undefined;
    const bump = () => setMapResizeTrigger((n) => n + 1);
    const r0 = requestAnimationFrame(() => {
      requestAnimationFrame(bump);
    });
    const t = setTimeout(bump, 200);
    return () => {
      cancelAnimationFrame(r0);
      clearTimeout(t);
    };
  }, [mobileSection]);

  return (
    <>
    <div className="dashboard-layout" data-mobile-section={mobileSection}>
      <nav className="dashboard-mobile-tabs" aria-label="Dashboard sections">
        <button
          type="button"
          className={`dashboard-mobile-tab ${mobileSection === 'tasks' ? 'active' : ''}`}
          onClick={() => setMobileSection('tasks')}
          aria-pressed={mobileSection === 'tasks'}
          title="Task list and dispatch"
        >
          Tasks
        </button>
        <button
          type="button"
          className={`dashboard-mobile-tab ${mobileSection === 'map' ? 'active' : ''}`}
          onClick={() => setMobileSection('map')}
          aria-pressed={mobileSection === 'map'}
          title="Live map: riders, stores, open tasks"
        >
          Map
        </button>
        <button
          type="button"
          className={`dashboard-mobile-tab ${mobileSection === 'agents' ? 'active' : ''}`}
          onClick={() => setMobileSection('agents')}
          aria-pressed={mobileSection === 'agents'}
          title="Rider roster and driver queue"
        >
          Agents
        </button>
      </nav>
      <div className="dashboard-layout-panel dashboard-layout-tasks">
        <TaskPanel
          onOpenTaskDetails={handleOpenTaskDetailsFromPanel}
          onFocusTaskOnMap={handleFocusTaskOnMap}
          listRevision={taskListRevision}
        />
      </div>
      {taskDetailsId != null &&
        createPortal(
          <TaskDetailsModalErrorBoundary
            key={String(taskDetailsId)}
            onClose={() => {
              setTaskDetailsId(null);
              setTaskDetailsListSnapshot(null);
              setTaskDetailsInitialTab('details');
            }}
          >
            <TaskDetailsModal
              taskId={taskDetailsId}
              listTaskSnapshot={taskDetailsListSnapshot}
              initialTab={taskDetailsInitialTab}
              onClose={() => {
                setTaskDetailsId(null);
                setTaskDetailsListSnapshot(null);
                setTaskDetailsInitialTab('details');
              }}
              onAssignDriver={(id) => {
                setTaskDetailsId(null);
                setTaskDetailsListSnapshot(null);
                navigate(`/tasks?highlight=${id}`);
              }}
              onTaskListInvalidate={bumpTaskLists}
              onTaskDeleted={() => {
                setTaskDetailsId(null);
                setTaskDetailsListSnapshot(null);
              }}
              onFocusTaskOnMap={handleFocusTaskOnMap}
              directionsMapSettings={{
                mapProvider,
                mapboxToken,
                googleApiKey,
                googleMapStyle,
              }}
            />
          </TaskDetailsModalErrorBoundary>,
          document.body
        )}
      <div className="dashboard-layout-panel dashboard-layout-map">
      <div className="dashboard-map-wrap">
        <div id="map" className="dashboard-map-inner">
          <MapErrorBoundary
            fallback={({ reset }) => (
              <div className="map-container map-error-fallback" style={{ minHeight: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f5f5f5', borderRadius: 8 }}>
                <p style={{ margin: 0, color: '#b33' }}>Map failed to load.</p>
                <p style={{ margin: '8px 0 0', fontSize: '0.9rem' }}>Configure Google Maps or Mapbox in <strong>Settings → Map API keys</strong>, then try again.</p>
                <button type="button" className="btn" onClick={reset} style={{ marginTop: 12 }}>Try again</button>
              </div>
            )}
          >
            <Suspense
              fallback={
                <div className="map-container" style={MAP_CHUNK_FALLBACK_STYLE} aria-busy="true">
                  Loading map…
                </div>
              }
            >
              <MapView
                locations={filteredLocationsForMap}
                merchants={filteredMerchantsForMap}
                taskMarkers={filteredMapTasks}
                showLegend
                driverQueueCount={driverQueueCount}
                onViewDriverQueue={handleViewDriverQueueFromMap}
                mapProvider={mapProvider}
                apiKey={googleApiKey}
                mapboxToken={mapboxToken}
                center={mapShowsNoMarkers ? defaultMapCenter : undefined}
                zoom={mapShowsNoMarkers ? defaultMapZoom : undefined}
                googleMapStyle={googleMapStyle}
                mapResizeTrigger={mapResizeTrigger}
                focusTaskRequest={mapTaskFocusRequest}
                onResetMapView={handleResetMapView}
              />
            </Suspense>
          </MapErrorBoundary>
        </div>
      </div>
      </div>
      <div className="dashboard-layout-panel dashboard-layout-agents">
        <AgentPanel
          ref={agentPanelRef}
          onOpenTaskDetails={handleOpenTaskDetailsFromPanel}
          onFocusRiderOnMap={handleFocusRiderOnMap}
          onFocusTaskOnMap={handleFocusTaskOnMap}
          listRevision={taskListRevision}
          onTaskListInvalidate={bumpTaskLists}
          onQueueCountChange={setDriverQueueCount}
          riderLocations={locations}
        />
      </div>
    </div>
    <Suspense fallback={null}>
      <ActivityTimelineToastStack
        dateStr={tasksMapDateStr}
        onOpenTaskTimeline={(id) => openTaskDetails(id, { initialTab: 'timeline' })}
      />
    </Suspense>
    </>
  );
}
