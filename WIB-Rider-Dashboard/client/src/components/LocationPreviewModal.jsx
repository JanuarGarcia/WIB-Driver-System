import { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/** Blue rider-style pin (matches dashboard Leaflet markers / legacy “location” look). */
function locationPinIcon() {
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

const PIN = locationPinIcon();

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

/**
 * In-app location preview (Leaflet + OSM) — same stack as the main dashboard map, no Google redirect.
 */
export default function LocationPreviewModal({ onClose, lat, lng, caption }) {
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
        <div className="location-preview-map-wrap map-container leaflet-map-wrap">
          <MapContainer
            key={`${la.toFixed(5)},${ln.toFixed(5)}`}
            center={[la, ln]}
            zoom={17}
            className="leaflet-map location-preview-leaflet"
            style={{ width: '100%', height: '100%', minHeight: 280 }}
            scrollWheelZoom
          >
            <MapInvalidateOnMount />
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <Marker position={[la, ln]} icon={PIN} />
          </MapContainer>
        </div>
      </div>
    </div>
  );
}
