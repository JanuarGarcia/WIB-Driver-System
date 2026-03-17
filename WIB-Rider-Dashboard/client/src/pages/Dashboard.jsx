import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import TaskPanel from '../components/TaskPanel';
import TaskDetailsModal from '../components/TaskDetailsModal';
import MapView from '../components/MapView';
import MapErrorBoundary from '../components/MapErrorBoundary';
import AgentPanel from '../components/AgentPanel';
import { api } from '../api';
import { useTeamFilter } from '../context/TeamFilterContext';

export default function Dashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedTeamId } = useTeamFilter();
  const [taskDetailsId, setTaskDetailsId] = useState(null);
  const [mobileSection, setMobileSection] = useState('tasks'); // 'tasks' | 'map' | 'agents' for small screens
  const [locations, setLocations] = useState([]);
  const [merchants, setMerchants] = useState([]);
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

  const refreshMapData = () => {
    api(driversLocationsUrl).then(setLocations).catch(() => setLocations([]));
    api('merchants/locations').then(setMerchants).catch(() => setMerchants([]));
  };

  useEffect(() => {
    refreshMapSettings();
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
  }, [location.pathname]);

  useEffect(() => {
    if (location.pathname !== '/' || disableActivityTracking) return;
    const ms = Math.max(5000, activityRefreshIntervalSec * 1000);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshMapData();
    }, ms);
    return () => clearInterval(id);
  }, [location.pathname, disableActivityTracking, activityRefreshIntervalSec, driversLocationsUrl]);

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
        <TaskPanel onOpenTaskDetails={setTaskDetailsId} />
      </div>
      {taskDetailsId != null &&
        createPortal(
          <TaskDetailsModal
            taskId={taskDetailsId}
            onClose={() => setTaskDetailsId(null)}
            onAssignDriver={(id) => { setTaskDetailsId(null); navigate(`/tasks?highlight=${id}`); }}
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
              locations={locations}
              merchants={merchants}
              mapProvider={mapProvider}
              apiKey={googleApiKey}
              mapboxToken={mapboxToken}
              center={locations.length === 0 && merchants.length === 0 ? defaultMapCenter : undefined}
              zoom={locations.length === 0 && merchants.length === 0 ? defaultMapZoom : undefined}
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
        <AgentPanel />
      </div>
    </div>
  );
}
