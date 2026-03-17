import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const BAGUIO_CENTER = [16.4023, 120.596];
const DEFAULT_ZOOM = 13;

/** Normalize API point to [lat, lng]. */
function toPosition(p) {
  const lat = p.lat ?? p.latitude;
  const lng = p.lng ?? p.longitude;
  if (lat == null || lng == null) return null;
  return [Number(lat), Number(lng)];
}

function TrackbackFitBounds({ positions }) {
  const map = useMap();
  useEffect(() => {
    if (!positions || positions.length < 2) return;
    try {
      map.fitBounds(positions, { padding: [24, 24], maxZoom: 16 });
    } catch (_) {}
  }, [map, positions]);
  return null;
}

/** Start pin (green). */
const startIcon = new L.DivIcon({
  className: 'trackback-pin-wrap trackback-pin-start',
  html: '<div class="trackback-pin"><span class="trackback-pin-dot"></span></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});
/** End pin (primary). */
const endIcon = new L.DivIcon({
  className: 'trackback-pin-wrap trackback-pin-end',
  html: '<div class="trackback-pin"><span class="trackback-pin-dot"></span></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

export default function TrackbackMap({ points = [] }) {
  const positions = useMemo(() => {
    const out = [];
    for (const p of points) {
      const pos = toPosition(p);
      if (pos) out.push(pos);
    }
    return out;
  }, [points]);

  if (positions.length === 0) {
    return (
      <div className="track-map-placeholder track-map-empty">
        <p className="text-muted">No track points to display.</p>
      </div>
    );
  }

  const first = positions[0];
  const last = positions[positions.length - 1];
  const isSinglePoint = positions.length === 1;
  const mapCenter = first || BAGUIO_CENTER;

  return (
    <div className="track-map-placeholder track-map-wrap">
      <MapContainer
        center={mapCenter}
        zoom={DEFAULT_ZOOM}
        className="leaflet-map trackback-leaflet-map"
        style={{ width: '100%', height: '100%', minHeight: 320 }}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {positions.length >= 2 && <TrackbackFitBounds positions={positions} />}
        {positions.length >= 2 && (
          <Polyline
            positions={positions}
            pathOptions={{
              color: 'var(--color-primary, #4f632d)',
              weight: 4,
              opacity: 0.9,
            }}
          />
        )}
        {first && <Marker position={first} icon={startIcon} zIndexOffset={10} />}
        {!isSinglePoint && last && <Marker position={last} icon={endIcon} zIndexOffset={10} />}
      </MapContainer>
    </div>
  );
}
