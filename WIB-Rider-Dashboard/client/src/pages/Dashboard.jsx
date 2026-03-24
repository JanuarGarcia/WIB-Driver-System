import { useState, useEffect, useCallback, useMemo } from 'react';
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
import { useTeamFilter } from '../context/TeamFilterContext';
import {
  DASHBOARD_TASKS_MAP_DATE_EVENT,
  readDashboardTasksMapDateFromStorage,
  todayDateStrLocal,
  tasksWithMapCoordinates,
} from '../utils/mapTasks';
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
  const [directionsReq, setDirectionsReq] = useState(null); // { origin, destination, originCoords?, destinationCoords? }
  const [directionsSteps, setDirectionsSteps] = useState([]);
  const [directionsError, setDirectionsError] = useState(null);
  const [directionsLoading, setDirectionsLoading] = useState(false);
  const [mapboxRouteGeojson, setMapboxRouteGeojson] = useState(null); // GeoJSON LineString feature
  const [tasksMapDateStr, setTasksMapDateStr] = useState(() => readDashboardTasksMapDateFromStorage() || todayDateStrLocal());
  const [rawMapTasks, setRawMapTasks] = useState([]);
  /** null = not loaded yet; map shows no rider pins until set. Matches Agent panel "Active" tab roster. */
  const [activePanelDriverIdSet, setActivePanelDriverIdSet] = useState(null);

  const driversLocationsUrl = selectedTeamId
    ? `drivers/locations?team_id=${encodeURIComponent(selectedTeamId)}`
    : 'drivers/locations';

  useEffect(() => {
    api(driversLocationsUrl)
      .then(setLocations)
      .catch(() => setLocations([]));
  }, [driversLocationsUrl]);

  useEffect(() => {
    api('merchants/locations')
      .then(setMerchants)
      .catch(() => setMerchants([]));
  }, []);

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
    if (activePanelDriverIdSet === null) return [];
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

  useEffect(() => {
    api(`tasks?date=${encodeURIComponent(tasksMapDateStr)}`)
      .then((list) => setRawMapTasks(Array.isArray(list) ? list : []))
      .catch(() => setRawMapTasks([]));
  }, [tasksMapDateStr, taskListRevision]);

  const mapShowsNoMarkers =
    filteredLocationsForMap.length === 0 && filteredMerchantsForMap.length === 0 && filteredMapTasks.length === 0;

  const refreshMapData = useCallback(() => {
    api(driversLocationsUrl).then(setLocations).catch(() => setLocations([]));
    api('merchants/locations').then(setMerchants).catch(() => setMerchants([]));
    api(`tasks?date=${encodeURIComponent(tasksMapDateStr)}`)
      .then((list) => setRawMapTasks(Array.isArray(list) ? list : []))
      .catch(() => setRawMapTasks([]));
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
    refreshMapSettings();
  }, []);

  useEffect(() => {
    hydrateMapMerchantFilterFromServer();
  }, []);

  useEffect(() => {
    if (location.pathname !== '/') return;
    refreshMapSettings();
  }, [location.pathname]);

  useEffect(() => {
    if (location.pathname !== '/') return;
    const onFocus = () => { refreshMapSettings(); refreshMapData(); };
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

  const clearDirections = () => {
    setDirectionsReq(null);
    setDirectionsSteps([]);
    setDirectionsError(null);
    setDirectionsLoading(false);
    setMapboxRouteGeojson(null);
  };

  async function mapboxGeocode(token, query) {
    const q = (query || '').trim();
    if (!q) return null;
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${encodeURIComponent(token)}&limit=1`;
    const res = await fetch(url);
    const data = await res.json();
    const feat = Array.isArray(data?.features) ? data.features[0] : null;
    const center = Array.isArray(feat?.center) ? feat.center : null; // [lng, lat]
    if (!center || center.length < 2) return null;
    return { lng: Number(center[0]), lat: Number(center[1]), place_name: feat.place_name };
  }

  async function loadMapboxDirections({ origin, destination, originCoords, destinationCoords }) {
    const token = String(mapboxToken || '').trim();
    if (!token) throw new Error('Mapbox token is missing. Set it in Settings → Map API keys.');
    const o = originCoords || (await mapboxGeocode(token, origin));
    const d = destinationCoords || (await mapboxGeocode(token, destination));
    if (!o || !d) throw new Error('Unable to geocode origin/destination.');
    const coords = `${o.lng},${o.lat};${d.lng},${d.lat}`;
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?access_token=${encodeURIComponent(token)}&geometries=geojson&steps=true&overview=full`;
    const res = await fetch(url);
    const data = await res.json();
    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    const geom = route?.geometry;
    if (!geom || !Array.isArray(geom.coordinates)) throw new Error('No route returned from Mapbox.');
    const steps = (route?.legs?.[0]?.steps || []).map((s) => s?.maneuver?.instruction).filter(Boolean);
    setDirectionsSteps(steps);
    setMapboxRouteGeojson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: geom.coordinates },
    });
  }

  const handleShowDirections = (taskOrData) => {
    if (!taskOrData || typeof taskOrData !== 'object') {
      setDirectionsError('No task data for directions.');
      setDirectionsReq({ origin: '', destination: '' });
      setDirectionsLoading(false);
      setDirectionsSteps([]);
      setMapboxRouteGeojson(null);
      return;
    }
    // Accept either the task object or full details payload { task, order, merchant }
    const isPayload = taskOrData.task !== undefined || taskOrData.delivery_address !== undefined;
    const data = isPayload ? taskOrData : { task: taskOrData };
    const t = data.task != null ? data.task : taskOrData;
    const merchant = data.merchant || null;
    const destination = String(t?.delivery_address ?? '').trim();
    const originFromTask = String(t?.pickup_address ?? t?.drop_address ?? t?.merchant_address ?? '').trim();
    const originFromMerchant = merchant && [merchant.street, merchant.city, merchant.state, merchant.post_code].filter(Boolean).join(', ');
    const origin = originFromTask || String(originFromMerchant || '').trim();
    const destinationCoords =
      t?.task_lat != null && t?.task_lng != null
        ? { lat: Number(t.task_lat), lng: Number(t.task_lng) }
        : null;

    setMapboxRouteGeojson(null);
    setDirectionsSteps([]);

    if (!destination && !destinationCoords) {
      setDirectionsError('This task has no delivery address or coordinates to route to.');
      setDirectionsReq({ origin: origin || '', destination: '' });
      setDirectionsLoading(false);
      return;
    }

    setDirectionsError(null);
    setDirectionsReq({ origin, destination, destinationCoords });

    if (mapProvider !== 'mapbox') {
      setDirectionsLoading(true);
      return;
    }
    setDirectionsLoading(true);
    loadMapboxDirections({ origin, destination, destinationCoords })
      .then(() => { setDirectionsLoading(false); })
      .catch((e) => {
        setDirectionsError(e?.message || 'Failed to load directions');
        setMapboxRouteGeojson(null);
        setDirectionsLoading(false);
      });
  };

  return (
    <>
    <div className="dashboard-layout" data-mobile-section={mobileSection}>
      <nav className="dashboard-mobile-tabs" aria-label="Dashboard sections">
        <button
          type="button"
          className={`dashboard-mobile-tab ${mobileSection === 'tasks' ? 'active' : ''}`}
          onClick={() => setMobileSection('tasks')}
          aria-pressed={mobileSection === 'tasks'}
        >
          Tasks
        </button>
        <button
          type="button"
          className={`dashboard-mobile-tab ${mobileSection === 'map' ? 'active' : ''}`}
          onClick={() => setMobileSection('map')}
          aria-pressed={mobileSection === 'map'}
        >
          Map
        </button>
        <button
          type="button"
          className={`dashboard-mobile-tab ${mobileSection === 'agents' ? 'active' : ''}`}
          onClick={() => setMobileSection('agents')}
          aria-pressed={mobileSection === 'agents'}
        >
          Agents
        </button>
      </nav>
      <div className="dashboard-layout-panel dashboard-layout-tasks">
        <TaskPanel onOpenTaskDetails={handleOpenTaskDetailsFromPanel} listRevision={taskListRevision} />
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
            onShowDirections={(payload) => {
              handleShowDirections(payload);
              setTimeout(() => setTaskDetailsId(null), 0);
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
              mapProvider={mapProvider}
              apiKey={googleApiKey}
              mapboxToken={mapboxToken}
              center={mapShowsNoMarkers ? defaultMapCenter : undefined}
              zoom={mapShowsNoMarkers ? defaultMapZoom : undefined}
              googleMapStyle={googleMapStyle}
              directionsRequest={directionsReq}
              mapboxRouteGeojson={mapboxRouteGeojson}
              onGoogleDirections={(payload) => {
                setDirectionsLoading(false);
                if (!payload) return;
                if (payload.error) {
                  setDirectionsError(payload.error);
                  setDirectionsSteps([]);
                } else if (Array.isArray(payload.steps)) {
                  setDirectionsError(null);
                  setDirectionsSteps(payload.steps);
                }
              }}
            />
          </MapErrorBoundary>
        </div>
        {directionsReq != null && (directionsLoading || directionsError || directionsSteps.length > 0) && (
          <div id="direction_output" className="direction-output">
            <div className="direction-output-header">
              <strong>Directions</strong>
              <button type="button" className="btn btn-sm" onClick={clearDirections}>Clear</button>
            </div>
            {directionsLoading && <div className="direction-output-loading">Loading route…</div>}
            {directionsError && <div className="direction-output-error">{directionsError}</div>}
            {!directionsLoading && !directionsError && directionsSteps.length > 0 && (
              <ol className="direction-output-steps">
                {directionsSteps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            )}
          </div>
        )}
      </div>
      </div>
      <div className="dashboard-layout-panel dashboard-layout-agents">
        <AgentPanel onOpenTaskDetails={handleOpenTaskDetailsFromPanel} listRevision={taskListRevision} />
      </div>
    </div>
    <ActivityTimelineToastStack
      dateStr={tasksMapDateStr}
      onOpenTaskTimeline={(id) => openTaskDetails(id, { initialTab: 'timeline' })}
    />
    </>
  );
}
