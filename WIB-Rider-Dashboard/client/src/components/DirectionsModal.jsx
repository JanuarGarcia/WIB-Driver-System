import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LoadScript, GoogleMap, DirectionsService, DirectionsRenderer } from '@react-google-maps/api';
import { fetchMapboxDrivingRoute, mapboxLeafletRasterTileUrl } from '../utils/mapboxDirections';

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDistanceM(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return `${Math.round(n)} m`;
  return `${(n / 1000).toFixed(1)} km`;
}

function formatDurationSec(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Small maneuver glyph (legacy-style step icons). */
function StepManeuverIcon({ modifier, type }) {
  const m = String(modifier || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  let rotate = 0;
  if (m.includes('sharp left')) rotate = -135;
  else if (m.includes('sharp right')) rotate = 135;
  else if (m.includes('slight left')) rotate = -45;
  else if (m.includes('slight right')) rotate = 45;
  else if (m.includes('uturn')) rotate = 180;
  else if (m.includes('left') && !m.includes('right')) rotate = -90;
  else if (m.includes('right') && !m.includes('left')) rotate = 90;
  if (t === 'arrive' || t === 'end of road') {
    return (
      <span className="directions-step-icon directions-step-icon--flag" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M14 6l-1-2H5v17h2v-7h5l1 2h7V6h-6z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="directions-step-icon" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ transform: `rotate(${rotate}deg)` }}>
        <path d="M12 4v16M12 4l-4 4M12 4l4 4" />
      </svg>
    </span>
  );
}

function RouteFitBounds({ positions }) {
  const map = useMap();
  useEffect(() => {
    if (!positions || positions.length < 2) return;
    try {
      const b = L.latLngBounds(positions);
      map.fitBounds(b, { padding: [28, 28], maxZoom: 17 });
    } catch (_) {}
  }, [map, positions]);
  return null;
}

function MapInvalidateWhenReady() {
  const map = useMap();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try {
        map.invalidateSize();
      } catch (_) {}
    });
    const t = setTimeout(() => {
      try {
        map.invalidateSize();
      } catch (_) {}
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [map]);
  return null;
}

function bluePinIcon() {
  return new L.DivIcon({
    className: 'leaflet-pin-wrap',
    html: `<div class="leaflet-pin leaflet-pin-rider">
      <div class="leaflet-pin-head"><span class="leaflet-pin-rider-core" aria-hidden="true"></span></div>
      <div class="leaflet-pin-point"></div>
    </div>`,
    iconSize: [40, 52],
    iconAnchor: [20, 52],
  });
}

const BLUE_PIN = bluePinIcon();

function MapboxRouteMap({ mapboxToken, positions, originLatLng, destLatLng }) {
  const center = positions[Math.floor(positions.length / 2)] || originLatLng;
  const tileUrl = useMemo(() => mapboxLeafletRasterTileUrl(mapboxToken), [mapboxToken]);
  return (
    <div className="directions-modal-map map-container leaflet-map-wrap leaflet-mapbox-wrap">
      <MapContainer center={center} zoom={14} className="leaflet-map directions-modal-leaflet" style={{ width: '100%', height: '100%', minHeight: 260 }} scrollWheelZoom>
        <MapInvalidateWhenReady />
        <TileLayer
          attribution='&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
          url={tileUrl}
          crossOrigin="anonymous"
          tileSize={512}
          zoomOffset={-1}
          maxZoom={19}
          minZoom={0}
        />
        <RouteFitBounds positions={positions} />
        {positions.length >= 2 && (
          <Polyline positions={positions} pathOptions={{ color: '#ea580c', weight: 6, opacity: 0.92, lineJoin: 'round', lineCap: 'round' }} />
        )}
        {originLatLng && <Marker position={originLatLng} icon={BLUE_PIN} />}
        {destLatLng && <Marker position={destLatLng} icon={BLUE_PIN} />}
      </MapContainer>
    </div>
  );
}

function parseGoogleMapStyles(styleJson) {
  if (!styleJson || typeof styleJson !== 'string' || !styleJson.trim()) return undefined;
  try {
    const parsed = JSON.parse(styleJson.trim());
    return Array.isArray(parsed) ? parsed : undefined;
  } catch (_) {
    return undefined;
  }
}

const GMAP_CENTER = { lat: 16.4023, lng: 120.596 };

function GoogleDirectionsBody({ apiKey, googleMapStyle, origin, destination, destinationCoords, onParsed, onError }) {
  const [directionsResult, setDirectionsResult] = useState(null);
  const handledRef = useRef(false);
  const mapOptions = useMemo(() => {
    const opts = { zoomControl: true };
    const styles = parseGoogleMapStyles(googleMapStyle);
    if (styles && styles.length > 0) opts.styles = styles;
    return opts;
  }, [googleMapStyle]);

  const destForApi = useMemo(() => {
    const d = (destination || '').trim();
    if (d) return d;
    if (destinationCoords != null && Number.isFinite(Number(destinationCoords.lat)) && Number.isFinite(Number(destinationCoords.lng))) {
      return { lat: Number(destinationCoords.lat), lng: Number(destinationCoords.lng) };
    }
    return null;
  }, [destination, destinationCoords]);

  const originForApi = (origin || '').trim();

  const dirOptions = useMemo(
    () => ({
      origin: originForApi,
      destination: destForApi,
      travelMode: 'DRIVING',
    }),
    [originForApi, destForApi]
  );

  const handleDir = useCallback(
    (res, status) => {
      if (handledRef.current) return;
      if (status !== 'OK' || !res?.routes?.[0]) {
        handledRef.current = true;
        onError?.(status === 'ZERO_RESULTS' ? 'No driving route found.' : `Google directions: ${status || 'error'}`);
        return;
      }
      handledRef.current = true;
      const leg = res.routes[0].legs[0];
      const steps = (leg.steps || []).map((s) => ({
        instruction: stripHtml(s.instructions),
        distanceText: s.distance?.text || '',
        distanceM: s.distance?.value,
        modifier: '',
        type: '',
      }));
      onParsed?.({
        steps,
        summaryDistanceText: leg.distance?.text,
        summaryDurationText: leg.duration?.text,
        startAddress: leg.start_address,
        endAddress: leg.end_address,
      });
      setDirectionsResult(res);
    },
    [onError, onParsed]
  );

  if (!destForApi) {
    return <div className="directions-modal-error">Missing destination for directions.</div>;
  }
  if (!originForApi) {
    return (
      <div className="directions-modal-error">
        Add a pickup address on the task for in-app Google directions, or add a Mapbox token in Settings (it can geocode addresses automatically).
      </div>
    );
  }

  return (
    <LoadScript googleMapsApiKey={apiKey.trim()} loadingElement={<div className="directions-modal-map directions-modal-map--loading">Loading map…</div>}>
      <div className="directions-modal-map directions-modal-map--google">
        <GoogleMap mapContainerStyle={{ width: '100%', height: '100%', minHeight: 260 }} center={GMAP_CENTER} zoom={13} options={mapOptions}>
          <DirectionsService options={dirOptions} callback={handleDir} />
          {directionsResult ? <DirectionsRenderer options={{ directions: directionsResult, suppressMarkers: false }} /> : null}
        </GoogleMap>
      </div>
    </LoadScript>
  );
}

/**
 * In-app turn-by-turn directions (legacy-style): map + step list, no redirect.
 */
export default function DirectionsModal({
  onClose,
  taskId,
  origin,
  destination,
  destinationCoords,
  mapProvider,
  mapboxToken,
  googleApiKey,
  googleMapStyle,
  externalMapsUrl,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const token = String(mapboxToken || '').trim();
  const gKey = String(googleApiKey || '').trim();
  const useMapboxRouting = token.length > 0;
  const useGoogleRouting = !useMapboxRouting && mapProvider === 'google' && gKey.length > 0;

  const [loading, setLoading] = useState(useMapboxRouting);
  const [error, setError] = useState(null);
  const [mapboxData, setMapboxData] = useState(null);
  const [googleMeta, setGoogleMeta] = useState(null);

  useEffect(() => {
    if (!useMapboxRouting) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMapboxData(null);
    fetchMapboxDrivingRoute({
      mapboxToken: token,
      origin,
      destination,
      originCoords: null,
      destinationCoords,
    })
      .then((data) => {
        if (!cancelled) setMapboxData(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || 'Failed to load directions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [useMapboxRouting, token, origin, destination, destinationCoords]);

  const handleGoogleParsed = useCallback((meta) => {
    setGoogleMeta(meta);
    setError(null);
  }, []);

  const handleGoogleErr = useCallback((msg) => {
    setError(msg);
  }, []);

  const steps = mapboxData?.steps || googleMeta?.steps || [];
  const summaryLine =
    mapboxData != null
      ? [formatDistanceM(mapboxData.distanceM), formatDurationSec(mapboxData.durationS)].filter(Boolean).join(', ')
      : googleMeta
        ? [googleMeta.summaryDistanceText, googleMeta.summaryDurationText].filter(Boolean).join(', ')
        : '';

  const startLabel = mapboxData ? stripHtml(origin) || 'Start' : googleMeta?.startAddress || stripHtml(origin) || 'Start';
  const endLabel = mapboxData ? stripHtml(destination) || 'Destination' : googleMeta?.endAddress || stripHtml(destination) || 'Destination';

  return (
    <div className="task-modal-nested-overlay directions-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-box directions-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="directions-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="directions-modal-header">
          <h2 id="directions-modal-title" className="directions-modal-title">
            Task ID: {taskId ?? '—'}
          </h2>
          <button type="button" className="directions-modal-header-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <button type="button" className="directions-modal-close-link" onClick={onClose}>
          Close
        </button>

        {useMapboxRouting && loading && <div className="directions-modal-loading">Loading route…</div>}
        {error && <div className="directions-modal-error">{error}</div>}

        {useMapboxRouting && !loading && !error && mapboxData && (
          <>
            <MapboxRouteMap
              mapboxToken={token}
              positions={mapboxData.positions}
              originLatLng={mapboxData.originLatLng}
              destLatLng={mapboxData.destLatLng}
            />
            {summaryLine ? <div className="directions-modal-summary">{summaryLine}</div> : null}
            <div className="directions-modal-addresses">
              <div className="directions-modal-address directions-modal-address--from">
                <span className="directions-modal-address-label">From</span>
                <span>{startLabel}</span>
              </div>
              <div className="directions-modal-address directions-modal-address--to">
                <span className="directions-modal-address-label">To</span>
                <span>{endLabel}</span>
              </div>
            </div>
            <ol className="directions-modal-steps">
              {steps.map((step, i) => (
                <li key={i} className="directions-modal-step">
                  <StepManeuverIcon modifier={step.modifier} type={step.type} />
                  <span className="directions-modal-step-text">{stripHtml(step.instruction)}</span>
                  <span className="directions-modal-step-dist">{formatDistanceM(step.distanceM)}</span>
                </li>
              ))}
            </ol>
          </>
        )}

        {useGoogleRouting && !error && (
          <GoogleDirectionsBody
            key={`${origin}|${destination}|${destinationCoords?.lat}|${destinationCoords?.lng}`}
            apiKey={gKey}
            googleMapStyle={googleMapStyle}
            origin={origin}
            destination={destination}
            destinationCoords={destinationCoords}
            onParsed={handleGoogleParsed}
            onError={handleGoogleErr}
          />
        )}
        {useGoogleRouting && error && <div className="directions-modal-error">{error}</div>}
        {useGoogleRouting && googleMeta && !error && (
          <>
            {summaryLine ? <div className="directions-modal-summary">{summaryLine}</div> : null}
            <div className="directions-modal-addresses">
              <div className="directions-modal-address directions-modal-address--from">
                <span className="directions-modal-address-label">From</span>
                <span>{googleMeta.startAddress || startLabel}</span>
              </div>
              <div className="directions-modal-address directions-modal-address--to">
                <span className="directions-modal-address-label">To</span>
                <span>{googleMeta.endAddress || endLabel}</span>
              </div>
            </div>
            <ol className="directions-modal-steps">
              {steps.map((step, i) => (
                <li key={i} className="directions-modal-step">
                  <StepManeuverIcon modifier={step.modifier} type={step.type} />
                  <span className="directions-modal-step-text">{step.instruction}</span>
                  <span className="directions-modal-step-dist">{step.distanceText || formatDistanceM(step.distanceM)}</span>
                </li>
              ))}
            </ol>
          </>
        )}

        {!useMapboxRouting && !useGoogleRouting && (
          <div className="directions-modal-error">
            Add a <strong>Mapbox</strong> access token or <strong>Google Maps</strong> API key under Settings → Map API keys to show directions here. You can still open Google Maps below.
          </div>
        )}

        <div className="directions-modal-footer">
          {externalMapsUrl ? (
            <a className="btn btn-primary" href={externalMapsUrl} target="_blank" rel="noopener noreferrer">
              Open in Google Maps
            </a>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
