import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import TaskPanel from '../components/TaskPanel';
import TaskDetailsModal from '../components/TaskDetailsModal';
import ActivityTimelineToastStack from '../components/ActivityTimelineToastStack';
import MapView from '../components/MapView';
import MapErrorBoundary from '../components/MapErrorBoundary';
import AgentPanel from '../components/AgentPanel';
import { useMapMerchantFilterSelection } from '../components/MapMerchantFilter';
import { hydrateMapMerchantFilterFromServer } from '../utils/mapMerchantFilterPrefs';
import { api } from '../api';

const MOBILE_DASHBOARD_MQ = '(max-width: 768px)';
import { useTeamFilter } from '../context/TeamFilterContext';
import {
  DASHBOARD_TASKS_MAP_DATE_EVENT,
  readDashboardTasksMapDateFromStorage,
  todayDateStrLocal,
  tasksWithMapCoordinates,
  taskDropoffLatLng,
  riderGpsFromLocations,
} from '../utils/mapTasks';

function nextMapTaskFocus(prev, lat, lng) {
  return { nonce: (prev?.nonce ?? 0) + 1, lat, lng };
}
import { buildActivePanelDriverIdSet } from '../utils/agentPanelRiders';

export default function Dashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedTeamId } = useTeamFilter();
  const [taskDetailsId, setTaskDetailsId] = useState(null);
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
    setTaskDetailsId(id);
  }, []);

  const handleOpenTaskDetailsFromPanel = useCallback(
    (id) => openTaskDetails(id, { initialTab: 'details' }),
    [openTaskDetails]
  );

  const [mobileSection, setMobileSection] = useState('tasks'); // 'tasks' | 'map' | 'agents' for small screens
  const [mapResizeTrigger, setMapResizeTrigger] = useState(0);
  const [mapTaskFocusRequest, setMapTaskFocusRequest] = useState(null);

  const handleFocusTaskOnMap = useCallback((task) => {
    const p = taskDropoffLatLng(task);
    if (!p) return;
    setMapTaskFocusRequest((prev) => nextMapTaskFocus(prev, p.lat, p.lng));
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
  const [tasksMapDateStr, setTasksMapDateStr] = useState(() => readDashboardTasksMapDateFromStorage() || todayDateStrLocal());
  const [rawMapTasks, setRawMapTasks] = useState([]);
  /** null = agent roster still loading (map shows all rider GPS pins); then filtered to Active panel roster. */
  const [activePanelDriverIdSet, setActivePanelDriverIdSet] = useState(null);

  const handleFocusRiderOnMap = useCallback(
    (driver) => {
      const p = riderGpsFromLocations(driver, locations);
      if (!p) return;
      setMapTaskFocusRequest((prev) => nextMapTaskFocus(prev, p.lat, p.lng));
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
    let cancelled = false;
    (async () => {
      try {
        const [loc, mer, taskList] = await Promise.all([
          api(driversLocationsUrl).catch(() => []),
          api('merchants/locations').catch(() => []),
          api(`tasks?date=${encodeURIComponent(tasksMapDateStr)}`).catch(() => []),
        ]);
        if (cancelled) return;
        setLocations(Array.isArray(loc) ? loc : []);
        setMerchants(Array.isArray(mer) ? mer : []);
        setRawMapTasks(Array.isArray(taskList) ? taskList : []);
      } catch {
        if (!cancelled) {
          setLocations([]);
          setMerchants([]);
          setRawMapTasks([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driversLocationsUrl, tasksMapDateStr, taskListRevision]);

  const refreshActivePanelDriverIds = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('date', new Date().toISOString().slice(0, 10));
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
        if (idSet === null) idSet = new Set();
      }
      setActivePanelDriverIdSet(idSet);
    } catch {
      setActivePanelDriverIdSet(new Set());
    }
  }, [selectedTeamId]);

  useEffect(() => {
    refreshActivePanelDriverIds();
  }, [refreshActivePanelDriverIds]);

  useEffect(() => {
    if (taskListRevision < 1) return;
    refreshActivePanelDriverIds();
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
      if (t.merchant_id == null || t.merchant_id === '') return true;
      return allowed.has(String(t.merchant_id));
    });
  }, [mapTasksWithCoords, selectedMapMerchantIds]);

  useEffect(() => {
    const sync = () => setTasksMapDateStr(readDashboardTasksMapDateFromStorage() || todayDateStrLocal());
    window.addEventListener(DASHBOARD_TASKS_MAP_DATE_EVENT, sync);
    return () => window.removeEventListener(DASHBOARD_TASKS_MAP_DATE_EVENT, sync);
  }, []);

  const mapShowsNoMarkers =
    filteredLocationsForMap.length === 0 && filteredMerchantsForMap.length === 0 && filteredMapTasks.length === 0;

  const refreshMapData = useCallback(() => {
    (async () => {
      try {
        const [loc, mer, taskList] = await Promise.all([
          api(driversLocationsUrl).catch(() => []),
          api('merchants/locations').catch(() => []),
          api(`tasks?date=${encodeURIComponent(tasksMapDateStr)}`).catch(() => []),
        ]);
        setLocations(Array.isArray(loc) ? loc : []);
        setMerchants(Array.isArray(mer) ? mer : []);
        setRawMapTasks(Array.isArray(taskList) ? taskList : []);
      } catch {
        setLocations([]);
        setMerchants([]);
        setRawMapTasks([]);
      }
    })();
    refreshActivePanelDriverIds();
  }, [driversLocationsUrl, tasksMapDateStr, refreshActivePanelDriverIds]);

  const refreshMapSettings = () => {
    api('settings')
      .then((s) => {
        const provider = (s.map_provider || '').toString().trim().toLowerCase();
        setMapProvider(provider === 'google' ? 'google' : 'mapbox');
        setGoogleApiKey(s.google_api_key || '');
        setMapboxToken((s.mapbox_access_token || '').toString().trim());
        const interval = parseInt(s.activity_refresh_interval, 10);
        setActivityRefreshIntervalSec(Number.isFinite(interval) && interval >= 5 ? interval : 60);
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

  const lastWindowFocusRefreshRef = useRef(0);
  useEffect(() => {
    if (location.pathname !== '/') return undefined;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastWindowFocusRefreshRef.current < 20000) return;
      lastWindowFocusRefreshRef.current = now;
      refreshMapData();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [location.pathname, refreshMapData]);

  useEffect(() => {
    if (location.pathname !== '/' || disableActivityTracking) return;
    const ms = Math.max(5000, activityRefreshIntervalSec * 1000);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshMapData();
    }, ms);
    return () => clearInterval(id);
  }, [location.pathname, disableActivityTracking, activityRefreshIntervalSec, driversLocationsUrl, refreshMapData]);

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
          <TaskDetailsModal
            taskId={taskDetailsId}
            initialTab={taskDetailsInitialTab}
            onClose={() => {
              setTaskDetailsId(null);
              setTaskDetailsInitialTab('details');
            }}
            onAssignDriver={(id) => { setTaskDetailsId(null); navigate(`/tasks?highlight=${id}`); }}
            onTaskListInvalidate={bumpTaskLists}
            onTaskDeleted={() => setTaskDetailsId(null)}
            directionsMapSettings={{
              mapProvider,
              mapboxToken,
              googleApiKey,
              googleMapStyle,
            }}
          />,
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
          </MapErrorBoundary>
        </div>
      </div>
      </div>
      <div className="dashboard-layout-panel dashboard-layout-agents">
        <AgentPanel
          ref={agentPanelRef}
          onOpenTaskDetails={handleOpenTaskDetailsFromPanel}
          onFocusRiderOnMap={handleFocusRiderOnMap}
          listRevision={taskListRevision}
          onTaskListInvalidate={bumpTaskLists}
          onQueueCountChange={setDriverQueueCount}
        />
      </div>
    </div>
    <ActivityTimelineToastStack
      dateStr={tasksMapDateStr}
      onOpenTaskTimeline={(id) => openTaskDetails(id, { initialTab: 'timeline' })}
    />
    </>
  );
}
