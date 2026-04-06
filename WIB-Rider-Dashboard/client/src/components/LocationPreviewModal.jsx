import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { mapboxLeafletRasterTileUrl } from '../utils/mapboxDirections';

/** Blue rider-style pin (timeline / “this location”). */
function primaryPinIcon() {
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

/** Green pin — rider start (or pickup when no GPS on history). */
function startPinIcon() {
  return new L.DivIcon({
    className: 'leaflet-pin-wrap',
    html: `<div class="leaflet-pin leaflet-pin-start">
      <div class="leaflet-pin-head"><span class="leaflet-pin-start-core" aria-hidden="true"></span></div>
      <div class="leaflet-pin-point"></div>
    </div>`,
    iconSize: [40, 52],
    iconAnchor: [20, 52],
  });
}

const PRIMARY_PIN = primaryPinIcon();
const START_PIN = startPinIcon();

function MapInvalidateOnMount() {
  const map = useMap();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try {
        map.invalidateSize();
      } catch (_) {}
    });
    const t2 = setTimeout(() => {
      try {
        map.invalidateSize();
      } catch (_) {}
    }, 200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t2);
    };
  }, [map]);
  return null;
}

function LocationPreviewFitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points || points.length === 0) return;
    const run = () => {
      try {
        if (points.length === 1) {
          map.setView(points[0], 17, { animate: false });
        } else {
          const b = L.latLngBounds(points);
          map.fitBounds(b, { padding: [36, 36], maxZoom: 17, animate: false });
        }
      } catch (_) {}
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, [map, points]);
  return null;
}

/**
 * In-app location preview (Leaflet). Uses Mapbox raster tiles when a token is set (same stack as the dashboard map).
 */
export default function LocationPreviewModal({
  onClose,
  lat,
  lng,
  caption,
  mapboxToken = '',
  startLat,
  startLng,
  startLegendLabel = 'Accepted here',
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;

  const sLa = startLat != null ? Number(startLat) : NaN;
  const sLn = startLng != null ? Number(startLng) : NaN;
  const hasStart = Number.isFinite(sLa) && Number.isFinite(sLn);

  const thresh = 0.00006;
  const startDistinct = hasStart && (Math.abs(sLa - la) >= thresh || Math.abs(sLn - ln) >= thresh);

  const points = useMemo(() => {
    const out = [[la, ln]];
    if (startDistinct) out.unshift([sLa, sLn]);
    return out;
  }, [la, ln, sLa, sLn, startDistinct]);

  const token = String(mapboxToken || '').trim();
  const useMapboxTiles = token.length > 0;
  const tileUrl = useMemo(() => (useMapboxTiles ? mapboxLeafletRasterTileUrl(token) : ''), [useMapboxTiles, token]);

  const mapKey = `${la.toFixed(5)},${ln.toFixed(5)},${startDistinct ? `${sLa.toFixed(5)},${sLn.toFixed(5)}` : 'ns'}`;

  return (
    <div
      className="task-modal-nested-overlay location-preview-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="modal-box location-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="location-preview-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="location-preview-header">
          <button type="button" className="location-preview-back" onClick={onClose}>
            ← Back
          </button>
          <h2 id="location-preview-title" className="location-preview-title">
            Location
          </h2>
          <button type="button" className="location-preview-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {caption ? <p className="location-preview-caption">{caption}</p> : null}
        {startDistinct ? (
          <div className="location-preview-map-legend" aria-hidden="true">
            <span className="location-preview-legend-item location-preview-legend-item--start">
              <span className="location-preview-legend-swatch location-preview-legend-swatch--start" />
              {startLegendLabel}
            </span>
            <span className="location-preview-legend-item">
              <span className="location-preview-legend-swatch location-preview-legend-swatch--primary" />
              This point
            </span>
          </div>
        ) : null}
        <div
          className={`location-preview-map-wrap map-container leaflet-map-wrap${useMapboxTiles ? ' leaflet-mapbox-wrap' : ''}`}
        >
          <MapContainer
            key={mapKey}
            center={[la, ln]}
            zoom={17}
            className="leaflet-map location-preview-leaflet"
            style={{ width: '100%', height: '100%', minHeight: 280 }}
            scrollWheelZoom
          >
            <MapInvalidateOnMount />
            <LocationPreviewFitBounds points={points} />
            {useMapboxTiles ? (
              <TileLayer
                attribution='&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
                url={tileUrl}
                crossOrigin="anonymous"
                tileSize={512}
                zoomOffset={-1}
                maxZoom={19}
                minZoom={0}
              />
            ) : (
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
            )}
            {startDistinct ? <Marker position={[sLa, sLn]} icon={START_PIN} /> : null}
            <Marker position={[la, ln]} icon={PRIMARY_PIN} />
            {startDistinct ? (
              <Polyline
                positions={[
                  [sLa, sLn],
                  [la, ln],
                ]}
                pathOptions={{ color: '#64748b', weight: 4, opacity: 0.75, dashArray: '8 6', lineJoin: 'round' }}
              />
            ) : null}
          </MapContainer>
        </div>
        {!useMapboxTiles ? (
          <p className="location-preview-map-hint muted">
            Add a Mapbox access token under Settings → Map API keys to match the dashboard map style.
          </p>
        ) : null}
      </div>
    </div>
  );
}
