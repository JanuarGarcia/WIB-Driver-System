import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
if (typeof window !== 'undefined') window.L = L;
import Map, { Marker as MapboxMarker, Source, Layer } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  LoadScript,
  GoogleMap,
  Marker as GoogleMarker,
  DirectionsService,
  DirectionsRenderer,
  useGoogleMap,
} from '@react-google-maps/api';
import { resolveUploadUrl } from '../api';
import { sanitizeMerchantDisplayName, shortTaskOrderDigits } from '../utils/displayText';
import { statusLabel } from '../api';
import {
  riderLeafletPopupHtml,
  merchantLeafletPopupHtmlStyled,
  taskLeafletPopupHtmlStyled,
  riderMarkerTitle,
} from '../utils/mapPopup';

const MAP_LEGEND_HIDDEN_KEY = 'wib_map_legend_hidden';

function HtmlPopupBody({ html }) {
  return <div className="map-popup-html-root" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Dashboard-only: pin type key for admins (matches map pins: circle rider vs teardrop merchant). */
function MapLegend() {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(MAP_LEGEND_HIDDEN_KEY) !== '1';
    } catch (_) {
      return true;
    }
  });
  const collapse = () => {
    try {
      localStorage.setItem(MAP_LEGEND_HIDDEN_KEY, '1');
    } catch (_) {}
    setExpanded(false);
  };
  const expand = () => {
    try {
      localStorage.removeItem(MAP_LEGEND_HIDDEN_KEY);
    } catch (_) {}
    setExpanded(true);
  };
  if (!expanded) {
    return (
      <button type="button" className="map-legend-reveal" onClick={expand} aria-label="Show map legend">
        Map legend
      </button>
    );
  }
  return (
    <div className="map-legend" aria-label="Map legend">
      <div className="map-legend-header">
        <div className="map-legend-title">Map legend</div>
        <button type="button" className="map-legend-hide" onClick={collapse} aria-label="Hide map legend">
          Hide
        </button>
      </div>
      <ul className="map-legend-list">
        <li className="map-legend-item">
          <span className="map-legend-swatch map-legend-swatch--rider" aria-hidden />
          <span className="map-legend-text">
            <strong>Active rider</strong>
            <span className="map-legend-desc">On duty, live in app</span>
          </span>
        </li>
        <li className="map-legend-item">
          <span className="map-legend-swatch map-legend-swatch--merchant" aria-hidden />
          <span className="map-legend-text">
            <strong>Merchant</strong>
            <span className="map-legend-desc">Pickup / store</span>
          </span>
        </li>
        <li className="map-legend-item">
          <span className="map-legend-swatch map-legend-swatch--task" aria-hidden />
          <span className="map-legend-text">
            <strong>Open task</strong>
            <span className="map-legend-desc">Delivery drop-off</span>
          </span>
        </li>
      </ul>
    </div>
  );
}

/** Orange delivery pin for Google Maps (distinct from default red pin + rider/merchant styling). */
const GOOGLE_TASK_PIN_ICON = (() => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48"><path fill="#ea580c" stroke="#ffffff" stroke-width="2" d="M18 3C10.8 3 5 8.8 5 16c0 11 13 29 13 29s13-18 13-29C31 8.8 25.2 3 18 3z"/><circle cx="18" cy="16" r="5.5" fill="#ffffff"/></svg>';
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: { width: 36, height: 48 },
    anchor: { x: 18, y: 48 },
  };
})();

/** Circle + stem — colors match --map-pin-rider-fill (Google icons cannot use CSS vars). */
const GOOGLE_RIDER_PIN_ICON = (() => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="52" viewBox="0 0 40 52"><path fill="#2563eb" stroke="#fff" stroke-width="2.5" d="M20 44 L14 32 L26 32 Z"/><circle cx="20" cy="18" r="14" fill="#2563eb" stroke="#fff" stroke-width="3"/><circle cx="20" cy="18" r="5" fill="#fff"/></svg>';
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: { width: 40, height: 52 },
    anchor: { x: 20, y: 52 },
  };
})();

/** Teardrop — colors match --map-pin-merchant-fill */
const GOOGLE_MERCHANT_PIN_ICON = (() => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="52" viewBox="0 0 40 52"><path fill="#7c3aed" stroke="#fff" stroke-width="2" d="M20 4C12 4 6 10 6 18c0 12 14 30 14 30s14-18 14-30c0-8-6-14-14-14z"/><rect x="12" y="12" width="16" height="10" rx="2" fill="#fff" opacity="0.92"/></svg>';
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: { width: 40, height: 52 },
    anchor: { x: 20, y: 48 },
  };
})();

const BAGUIO_CENTER = [16.4023, 120.596];
const BAGUIO_LATLNG = { lat: 16.4023, lng: 120.596 };
const BAGUIO_VIEW = { longitude: 120.596, latitude: 16.4023, zoom: 13 };
const MAP_STYLE = { width: '100%', height: '100%', minHeight: 400 };
/** Metro framing for a lone pin (matches typical Baguio dashboard load). */
const DASHBOARD_SINGLE_MARKER_ZOOM = 14;
const FIT_BOUNDS_PADDING_PX = 64;

/**
 * Fingerprint of all pin coordinates. Any added/removed/moved marker changes the string.
 * (Bounding-box–only checks miss refits when the hull grows in a way still “inside” the old box
 * after a partial first load — e.g. tasks first, then distant riders.)
 */
function pointsSignatureFromLatLngArrays(points) {
  if (!points.length) return '';
  const sorted = [...points].sort((a, b) => {
    const d = a[0] - b[0];
    if (d !== 0) return d;
    return a[1] - b[1];
  });
  return sorted.map(([la, ln]) => `${Number(la).toFixed(5)},${Number(ln).toFixed(5)}`).join(';');
}

function pointsSignatureFromLatLngObjs(pts) {
  if (!pts.length) return '';
  const pairs = pts.map((p) => [Number(p.lat), Number(p.lng)]);
  return pointsSignatureFromLatLngArrays(pairs);
}

function merchantMapTitle(restaurantName) {
  const s = sanitizeMerchantDisplayName(restaurantName);
  return s || 'Merchant';
}

function taskMapTitle(t) {
  let base;
  if (t.order_id != null || t.task_id != null) {
    base = `Order no. ${shortTaskOrderDigits(t.order_id, t.task_id)}`;
  } else base = 'Task (delivery)';
  const lm = String(t.landmark || '').trim();
  if (!lm) return base;
  const short = lm.length > 36 ? `${lm.slice(0, 33)}…` : lm;
  return `${base} · ${short}`;
}

function merchantLogoUrl(logo) {
  if (!logo || !String(logo).trim()) return null;
  const s = String(logo).trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return resolveUploadUrl(`/uploads/merchants/${encodeURIComponent(s)}`);
}

function PinMarker({ type, imageUrl, title }) {
  const resolvedUrl = type === 'merchant' && imageUrl ? merchantLogoUrl(imageUrl) || imageUrl : imageUrl;
  const hasImage = type === 'merchant' && resolvedUrl && String(resolvedUrl).trim().length > 0;
  return (
    <div className="map-pin-wrap" title={title || undefined}>
      <div className={`map-pin map-pin-${type} ${hasImage ? 'map-pin-has-image' : ''}`}>
        <div className="map-pin-head">
          {type === 'rider' ? <span className="map-pin-rider-core" aria-hidden="true" /> : null}
          {type === 'task' ? <span className="map-pin-task-inner" aria-hidden="true" /> : null}
          {hasImage ? (
            <img src={resolvedUrl} alt="" className="map-pin-img" />
          ) : null}
        </div>
        <div className="map-pin-point" />
      </div>
    </div>
  );
}

function leafletPinIcon(type, logoUrl) {
  const hasImage = type === 'merchant' && logoUrl && String(logoUrl).trim().length > 0;
  const safeUrl = hasImage ? String(logoUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') : '';
  const imgHtml = hasImage ? `<img src="${safeUrl}" alt="" class="leaflet-pin-img" loading="lazy" />` : '';
  const taskInner = type === 'task' ? '<span class="leaflet-pin-task-inner" aria-hidden="true"></span>' : '';
  const riderCore = type === 'rider' ? '<span class="leaflet-pin-rider-core" aria-hidden="true"></span>' : '';
  return new L.DivIcon({
    className: 'leaflet-pin-wrap',
    html: `<div class="leaflet-pin leaflet-pin-${type} ${hasImage ? 'leaflet-pin-has-image' : ''}">
      <div class="leaflet-pin-head">${riderCore}${taskInner}${imgHtml}</div>
      <div class="leaflet-pin-point"></div>
    </div>`,
    iconSize: [40, 52],
    iconAnchor: [20, 52],
  });
}

const riderPinIcon = leafletPinIcon('rider', null);
const taskPinIcon = leafletPinIcon('task', null);

function useDashboardMapMarkers(locations, merchants, taskMarkers) {
  const riderMarkers = useMemo(
    () => (locations || []).filter((loc) => loc.lat != null && loc.lng != null),
    [locations]
  );
  const merchantMarkers = useMemo(
    () => (merchants || []).filter((m) => m.lat != null && m.lng != null),
    [merchants]
  );
  const taskMapMarkers = useMemo(
    () =>
      (taskMarkers || []).filter((t) => {
        const lat = Number(t.lat);
        const lng = Number(t.lng);
        return Number.isFinite(lat) && Number.isFinite(lng);
      }),
    [taskMarkers]
  );
  return { riderMarkers, merchantMarkers, taskMapMarkers };
}

/** When center/zoom are controlled, update map view when they change (e.g. New Task modal after selecting address). */
function LeafletSetView({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (center != null && Array.isArray(center) && center.length >= 2 && zoom != null) {
      map.flyTo(center, zoom, { duration: 0.6 });
    }
  }, [map, center, zoom]);
  return null;
}

/** Leaflet measures the map once at mount; hidden mobile tabs or flex layout changes leave a wrong size until this runs. */
function LeafletMapSizeSync({ resizeTrigger = 0 }) {
  const map = useMap();
  const invalidate = useCallback(() => {
    try {
      map.invalidateSize({ animate: false });
    } catch (_) {}
  }, [map]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(invalidate);
    });
    return () => cancelAnimationFrame(id);
  }, [map, resizeTrigger, invalidate]);

  useEffect(() => {
    let container;
    try {
      container = map.getContainer();
    } catch (_) {
      return undefined;
    }
    if (!container) return undefined;
    let raf;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(invalidate);
    });
    ro.observe(container);
    const onResize = () => invalidate();
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [map, invalidate]);

  return null;
}

function LeafletFitBounds({ locations, merchants, taskMarkers, disabled, mapResizeTrigger = 0 }) {
  const map = useMap();
  const points = useMemo(() => {
    if (disabled) return [];
    const out = [];
    (locations || []).forEach((loc) => {
      if (loc.lat != null && loc.lng != null) out.push([Number(loc.lat), Number(loc.lng)]);
    });
    (merchants || []).forEach((m) => {
      if (m.lat != null && m.lng != null) out.push([Number(m.lat), Number(m.lng)]);
    });
    (taskMarkers || []).forEach((t) => {
      const la = Number(t.lat);
      const ln = Number(t.lng);
      if (Number.isFinite(la) && Number.isFinite(ln)) out.push([la, ln]);
    });
    return out;
  }, [locations, merchants, taskMarkers, disabled]);
  const pointsSig = useMemo(() => pointsSignatureFromLatLngArrays(points), [points]);
  const lastPointsSigRef = useRef('');
  const lastResizeTriggerRef = useRef(mapResizeTrigger);

  useEffect(() => {
    if (disabled) {
      lastPointsSigRef.current = '';
      return;
    }
    if (points.length === 0) {
      lastPointsSigRef.current = '';
      return;
    }

    const resizeBump = mapResizeTrigger !== lastResizeTriggerRef.current;
    lastResizeTriggerRef.current = mapResizeTrigger;
    const markersChanged = pointsSig !== lastPointsSigRef.current;
    if (!resizeBump && !markersChanged) return;

    const animate = lastPointsSigRef.current !== '' && !resizeBump;

    const run = () => {
      try {
        if (points.length === 1) {
          map.setView(points[0], DASHBOARD_SINGLE_MARKER_ZOOM, { animate });
        } else {
          const bounds = L.latLngBounds(points);
          map.fitBounds(bounds, {
            padding: [FIT_BOUNDS_PADDING_PX, FIT_BOUNDS_PADDING_PX],
            maxZoom: 15,
            animate,
          });
        }
        lastPointsSigRef.current = pointsSig;
      } catch (_) {}
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(run);
    });
  }, [map, points, pointsSig, disabled, mapResizeTrigger]);
  return null;
}

function LeafletMapView({ locations, merchants, taskMarkers = [], center, zoom, mapResizeTrigger = 0 }) {
  const { riderMarkers, merchantMarkers, taskMapMarkers } = useDashboardMapMarkers(locations, merchants, taskMarkers);
  const mapCenter = center != null ? center : BAGUIO_CENTER;
  const mapZoom = zoom != null ? zoom : 13;
  const fitBoundsDisabled = center != null && zoom != null;
  return (
    <div className="map-container leaflet-map-wrap">
      <MapContainer
        center={mapCenter}
        zoom={mapZoom}
        className="leaflet-map"
        style={MAP_STYLE}
        scrollWheelZoom
      >
        <LeafletMapSizeSync resizeTrigger={mapResizeTrigger} />
        {fitBoundsDisabled && <LeafletSetView center={mapCenter} zoom={mapZoom} />}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <LeafletFitBounds
          locations={riderMarkers}
          merchants={merchantMarkers}
          taskMarkers={taskMapMarkers}
          disabled={fitBoundsDisabled}
          mapResizeTrigger={mapResizeTrigger}
        />
        {riderMarkers.map((loc, idx) => (
          <Marker key={`rider-${loc.driver_id ?? idx}`} position={[Number(loc.lat), Number(loc.lng)]} icon={riderPinIcon}>
            <Popup className="map-popup-leaflet" minWidth={260}>
              <HtmlPopupBody html={riderLeafletPopupHtml(loc)} />
            </Popup>
          </Marker>
        ))}
        {merchantMarkers.map((m, idx) => {
          const logo = m.logo_url ?? m.logo ?? m.image_url;
          const logoImgUrl = merchantLogoUrl(logo);
          return (
            <Marker
              key={`merchant-${m.merchant_id ?? idx}`}
              position={[Number(m.lat), Number(m.lng)]}
              icon={leafletPinIcon('merchant', logoImgUrl)}
            >
              <Popup className="map-popup-leaflet" minWidth={240}>
                <HtmlPopupBody html={merchantLeafletPopupHtmlStyled(m.restaurant_name)} />
              </Popup>
            </Marker>
          );
        })}
        {taskMapMarkers.map((t, idx) => (
          <Marker key={`task-${t.task_id ?? idx}`} position={[Number(t.lat), Number(t.lng)]} icon={taskPinIcon}>
            <Popup className="map-popup-leaflet" minWidth={260}>
              <HtmlPopupBody html={taskLeafletPopupHtmlStyled(t, statusLabel)} />
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}

/** Mapbox Static Tiles API URL for Leaflet; token from settings (not hardcoded). Use 512px tiles + zoomOffset -1 per Mapbox docs. */
function mapboxTileUrl(accessToken) {
  const token = encodeURIComponent(String(accessToken || '').trim());
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}?access_token=${token}`;
}

/** Individual pins at every zoom (no clustering) — matches legacy dashboard behavior. */
function LeafletMapboxMarkersLayer({ riderMarkers, merchantMarkers, taskMapMarkers }) {
  const map = useMap();
  const groupRef = useRef(null);
  useEffect(() => {
    const group = L.layerGroup();
    groupRef.current = group;
    map.addLayer(group);
    return () => {
      map.removeLayer(group);
      groupRef.current = null;
    };
  }, [map]);
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    group.clearLayers();
    (riderMarkers || []).forEach((loc, idx) => {
      const marker = L.marker([Number(loc.lat), Number(loc.lng)], { icon: riderPinIcon });
      marker.bindPopup(riderLeafletPopupHtml(loc));
      group.addLayer(marker);
    });
    (merchantMarkers || []).forEach((m, idx) => {
      const logo = m.logo_url ?? m.logo ?? m.image_url;
      const logoImgUrl = merchantLogoUrl(logo);
      const marker = L.marker([Number(m.lat), Number(m.lng)], { icon: leafletPinIcon('merchant', logoImgUrl) });
      marker.bindPopup(merchantLeafletPopupHtmlStyled(m.restaurant_name));
      group.addLayer(marker);
    });
    (taskMapMarkers || []).forEach((t, idx) => {
      const marker = L.marker([Number(t.lat), Number(t.lng)], { icon: taskPinIcon });
      marker.bindPopup(taskLeafletPopupHtmlStyled(t, statusLabel));
      group.addLayer(marker);
    });
  }, [riderMarkers, merchantMarkers, taskMapMarkers]);
  return null;
}

function LeafletMapboxTileError({ onTileError }) {
  const map = useMap();
  useEffect(() => {
    const layer = map.getPane('tilePane');
    if (!layer) return;
    const container = layer.parentElement;
    if (!container) return;
    const handler = () => { onTileError?.(); };
    map.on('tileerror', handler);
    return () => { map.off('tileerror', handler); };
  }, [map, onTileError]);
  return null;
}

function LeafletMapboxView({ mapboxToken, locations, merchants, taskMarkers = [], center, zoom, routeGeojson, showLegend = false, mapResizeTrigger = 0 }) {
  const { riderMarkers, merchantMarkers, taskMapMarkers } = useDashboardMapMarkers(locations, merchants, taskMarkers);
  const mapCenter = center != null && Array.isArray(center) && center.length >= 2 ? center : BAGUIO_CENTER;
  const mapZoom = zoom != null ? zoom : 13;
  const fitBoundsDisabled = center != null && zoom != null;
  const tileUrl = useMemo(() => mapboxTileUrl(mapboxToken), [mapboxToken]);
  const [tileError, setTileError] = useState(false);
  return (
    <div className="map-container leaflet-map-wrap leaflet-mapbox-wrap" style={{ position: 'relative' }}>
      {tileError && (
        <div className="mapbox-tile-error-banner" style={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 1000, background: '#fff3cd', padding: '8px 12px', borderRadius: 6, fontSize: '0.9rem' }}>
          Map tiles could not be loaded. In <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noopener noreferrer">Mapbox Studio</a>, ensure your token has no URL restrictions, or add this site&apos;s URL (e.g. <code>http://localhost:5173</code>) to the allowed list.
        </div>
      )}
      <MapContainer
        center={mapCenter}
        zoom={mapZoom}
        className="leaflet-map"
        style={MAP_STYLE}
        scrollWheelZoom
      >
        <LeafletMapSizeSync resizeTrigger={mapResizeTrigger} />
        {fitBoundsDisabled && <LeafletSetView center={mapCenter} zoom={mapZoom} />}
        <TileLayer
          attribution='&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
          url={tileUrl}
          crossOrigin="anonymous"
          tileSize={512}
          zoomOffset={-1}
          maxZoom={19}
          minZoom={0}
        />
        <LeafletMapboxTileError onTileError={() => setTileError(true)} />
        <LeafletFitBounds
          locations={riderMarkers}
          merchants={merchantMarkers}
          taskMarkers={taskMapMarkers}
          disabled={fitBoundsDisabled}
          mapResizeTrigger={mapResizeTrigger}
        />
        <LeafletMapboxMarkersLayer riderMarkers={riderMarkers} merchantMarkers={merchantMarkers} taskMapMarkers={taskMapMarkers} />
      </MapContainer>
      {showLegend ? <MapLegend /> : null}
    </div>
  );
}

function MapboxMapView({ mapboxToken, locations, merchants, taskMarkers = [], center, zoom }) {
  const { riderMarkers, merchantMarkers, taskMapMarkers } = useDashboardMapMarkers(locations, merchants, taskMarkers);
  const [loadError, setLoadError] = useState(null);
  const [mounted, setMounted] = useState(false);
  const initialView = useMemo(() => {
    if (center != null && zoom != null && Array.isArray(center) && center.length >= 2) {
      return { longitude: center[1], latitude: center[0], zoom };
    }
    return BAGUIO_VIEW;
  }, [center, zoom]);
  useEffect(() => {
    const t = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(t);
  }, []);
  return (
    <div className="map-container mapbox-map-wrap" style={{ position: 'relative', minHeight: 200 }}>
      {loadError && (
        <div className="mapbox-error-banner" style={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 1000, background: '#fff3cd', padding: '8px 12px', borderRadius: 6, fontSize: '0.9rem' }}>
          {loadError} Allow this site&apos;s URL in <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noopener noreferrer">Mapbox Studio</a> if the token is valid.
        </div>
      )}
      {!mounted ? (
        <div style={{ width: '100%', height: '100%', minHeight: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e8eaed' }}>Loading map…</div>
      ) : (
      <Map
        mapboxAccessToken={mapboxToken}
        initialViewState={initialView}
        style={MAP_STYLE}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        className="mapbox-map"
        onError={(e) => setLoadError(e.error?.message || 'Mapbox failed to load. Check your access token.')}
      >
        {routeGeojson && routeGeojson.type === 'Feature' && routeGeojson.geometry && (
          <Source id="wib-route" type="geojson" data={routeGeojson}>
            <Layer
              id="wib-route-line"
              type="line"
              layout={{ 'line-join': 'round', 'line-cap': 'round' }}
              paint={{ 'line-color': '#1d4ed8', 'line-width': 5, 'line-opacity': 0.85 }}
            />
          </Source>
        )}
        {riderMarkers.map((loc, idx) => (
          <MapboxMarker key={`rider-${loc.driver_id ?? idx}`} longitude={Number(loc.lng)} latitude={Number(loc.lat)} anchor="bottom">
            <PinMarker type="rider" title={riderMarkerTitle(loc)} />
          </MapboxMarker>
        ))}
        {merchantMarkers.map((m, idx) => (
          <MapboxMarker key={`merchant-${m.merchant_id ?? idx}`} longitude={Number(m.lng)} latitude={Number(m.lat)} anchor="bottom">
            <PinMarker
              type="merchant"
              imageUrl={m.image_url || m.logo_url || m.logo || m.photo || m.merchant_image}
              title={merchantMapTitle(m.restaurant_name)}
            />
          </MapboxMarker>
        ))}
        {taskMapMarkers.map((t, idx) => (
          <MapboxMarker key={`task-${t.task_id ?? idx}`} longitude={Number(t.lng)} latitude={Number(t.lat)} anchor="bottom">
            <PinMarker type="task" title={taskMapTitle(t)} />
          </MapboxMarker>
        ))}
      </Map>
      )}
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

function GoogleMapResizeSync({ resizeTrigger = 0 }) {
  const map = useGoogleMap();
  const trigger = useCallback(() => {
    try {
      if (typeof window !== 'undefined' && window.google?.maps?.event && map) {
        window.google.maps.event.trigger(map, 'resize');
      }
    } catch (_) {}
  }, [map]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(trigger);
    });
    return () => cancelAnimationFrame(id);
  }, [map, resizeTrigger, trigger]);

  useEffect(() => {
    if (!map || typeof map.getDiv !== 'function') return undefined;
    const el = map.getDiv();
    if (!el) return undefined;
    let raf;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(trigger);
    });
    ro.observe(el);
    const onResize = () => trigger();
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [map, trigger]);

  return null;
}

/** Dashboard-style auto framing: fit all pins on load; re-fit when the marker set changes (coordinates). */
function GoogleMapAutoFit({ points, mapResizeTrigger = 0, onViewCommitted }) {
  const map = useGoogleMap();
  const pointsSig = useMemo(() => pointsSignatureFromLatLngObjs(points), [points]);
  const lastPointsSigRef = useRef('');
  const lastResizeTriggerRef = useRef(mapResizeTrigger);
  const onCommittedRef = useRef(onViewCommitted);
  onCommittedRef.current = onViewCommitted;

  useEffect(() => {
    if (!map || typeof window === 'undefined' || !window.google?.maps) return;
    if (points.length === 0) {
      lastPointsSigRef.current = '';
      return;
    }

    const resizeBump = mapResizeTrigger !== lastResizeTriggerRef.current;
    lastResizeTriggerRef.current = mapResizeTrigger;
    const markersChanged = pointsSig !== lastPointsSigRef.current;
    if (!resizeBump && !markersChanged) return;

    const run = () => {
      try {
        if (points.length === 1) {
          map.setCenter(points[0]);
          map.setZoom(DASHBOARD_SINGLE_MARKER_ZOOM);
        } else {
          const b = new window.google.maps.LatLngBounds();
          points.forEach((p) => b.extend(p));
          map.fitBounds(b, {
            top: FIT_BOUNDS_PADDING_PX,
            right: FIT_BOUNDS_PADDING_PX,
            bottom: FIT_BOUNDS_PADDING_PX,
            left: FIT_BOUNDS_PADDING_PX,
          });
          const z = map.getZoom();
          if (typeof z === 'number' && z > 15) map.setZoom(15);
        }
        lastPointsSigRef.current = pointsSig;
        const c = map.getCenter();
        onCommittedRef.current?.({ lat: c.lat(), lng: c.lng() }, map.getZoom());
      } catch (_) {}
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(run);
    });
  }, [map, points, pointsSig, mapResizeTrigger]);

  return null;
}

function GoogleMapView({ apiKey, locations, merchants, taskMarkers = [], center: centerProp, zoom: zoomProp, googleMapStyle, directionsRequest, onDirections, mapResizeTrigger = 0 }) {
  const [loadError, setLoadError] = useState(null);
  const { riderMarkers, merchantMarkers, taskMapMarkers } = useDashboardMapMarkers(locations, merchants, taskMarkers);
  const [directionsResult, setDirectionsResult] = useState(null);
  const [directionsStatus, setDirectionsStatus] = useState(null);
  const autoFit = centerProp == null && zoomProp == null && !directionsRequest;
  const [autoCenter, setAutoCenter] = useState(() => ({ ...BAGUIO_LATLNG }));
  const [autoZoom, setAutoZoom] = useState(13);
  const commitAutoView = useCallback((c, z) => {
    setAutoCenter(c);
    setAutoZoom(z);
  }, []);

  const autoFitPoints = useMemo(() => {
    const out = [];
    (riderMarkers || []).forEach((loc) => {
      if (loc.lat != null && loc.lng != null) out.push({ lat: Number(loc.lat), lng: Number(loc.lng) });
    });
    (merchantMarkers || []).forEach((m) => {
      if (m.lat != null && m.lng != null) out.push({ lat: Number(m.lat), lng: Number(m.lng) });
    });
    (taskMapMarkers || []).forEach((t) => {
      const la = Number(t.lat);
      const ln = Number(t.lng);
      if (Number.isFinite(la) && Number.isFinite(ln)) out.push({ lat: la, lng: ln });
    });
    return out;
  }, [riderMarkers, merchantMarkers, taskMapMarkers]);

  useEffect(() => {
    if (!autoFit) return;
    if (autoFitPoints.length === 0) {
      setAutoCenter({ ...BAGUIO_LATLNG });
      setAutoZoom(13);
    }
  }, [autoFit, autoFitPoints.length]);

  const center = useMemo(() => {
    if (centerProp != null && Array.isArray(centerProp) && centerProp.length >= 2) {
      return { lat: centerProp[0], lng: centerProp[1] };
    }
    if (autoFit) return autoCenter;
    return { ...BAGUIO_LATLNG };
  }, [centerProp, autoFit, autoCenter]);
  const zoom = useMemo(() => {
    if (zoomProp != null) return zoomProp;
    if (autoFit) return autoZoom;
    return 13;
  }, [zoomProp, autoFit, autoZoom]);
  const mapOptions = useMemo(() => {
    const opts = { zoomControl: true };
    const styles = parseGoogleMapStyles(googleMapStyle);
    if (styles && styles.length > 0) opts.styles = styles;
    return opts;
  }, [googleMapStyle]);

  useEffect(() => {
    if (!directionsRequest) {
      setDirectionsResult(null);
      setDirectionsStatus(null);
    }
  }, [directionsRequest]);

  return (
    <LoadScript
      googleMapsApiKey={apiKey.trim()}
      onLoad={() => setLoadError(null)}
      onError={() => setLoadError('Failed to load Google Maps')}
      loadingElement={<div className="map-container" style={{ ...MAP_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e8e8e8' }}>Loading map…</div>}
    >
      {loadError ? (
        <div className="map-container" style={{ ...MAP_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e8e8e8', color: '#b33' }}>{loadError}</div>
      ) : (
        <GoogleMap mapContainerStyle={MAP_STYLE} mapContainerClassName="map-container" center={center} zoom={zoom} options={mapOptions}>
          {autoFit && autoFitPoints.length > 0 ? (
            <GoogleMapAutoFit
              points={autoFitPoints}
              mapResizeTrigger={mapResizeTrigger}
              onViewCommitted={commitAutoView}
            />
          ) : null}
          <GoogleMapResizeSync resizeTrigger={mapResizeTrigger} />
          {directionsRequest && directionsRequest.destination && (
            <DirectionsService
              options={{
                origin: directionsRequest.origin || center,
                destination: directionsRequest.destination,
                travelMode: 'DRIVING',
              }}
              callback={(res, status) => {
                const st = status || null;
                setDirectionsResult(res || null);
                setDirectionsStatus(st);
                if (st && st !== 'OK') {
                  onDirections?.({ error: `Google directions error: ${st}` });
                  return;
                }
                try {
                  const steps = (res?.routes?.[0]?.legs?.[0]?.steps || [])
                    .map((s) => s?.instructions)
                    .filter(Boolean)
                    .map((html) => String(html).replace(/<[^>]+>/g, '').trim())
                    .filter(Boolean);
                  if (steps.length > 0) onDirections?.({ steps });
                  else onDirections?.({ error: 'No directions steps returned from Google.' });
                } catch (_) {
                  onDirections?.({ error: 'Failed to parse directions.' });
                }
              }}
            />
          )}
          {directionsResult && (
            <DirectionsRenderer
              options={{
                directions: directionsResult,
                suppressMarkers: false,
                polylineOptions: { strokeColor: '#1d4ed8', strokeOpacity: 0.85, strokeWeight: 5 },
              }}
            />
          )}
          {riderMarkers.map((loc, idx) => (
            <GoogleMarker
              key={`rider-${loc.driver_id ?? idx}`}
              position={{ lat: Number(loc.lat), lng: Number(loc.lng) }}
              title={riderMarkerTitle(loc)}
              icon={GOOGLE_RIDER_PIN_ICON}
            />
          ))}
          {merchantMarkers.map((m, idx) => (
            <GoogleMarker
              key={`merchant-${m.merchant_id ?? idx}`}
              position={{ lat: Number(m.lat), lng: Number(m.lng) }}
              title={merchantMapTitle(m.restaurant_name)}
              icon={GOOGLE_MERCHANT_PIN_ICON}
            />
          ))}
          {taskMapMarkers.map((t, idx) => (
            <GoogleMarker
              key={`task-${t.task_id ?? idx}`}
              position={{ lat: Number(t.lat), lng: Number(t.lng) }}
              title={taskMapTitle(t)}
              icon={GOOGLE_TASK_PIN_ICON}
            />
          ))}
        </GoogleMap>
      )}
    </LoadScript>
  );
}

export default function MapView({
  locations = [],
  merchants = [],
  taskMarkers = [],
  mapProvider = 'mapbox',
  apiKey = '',
  mapboxToken = '',
  center,
  zoom,
  googleMapStyle,
  directionsRequest,
  mapboxRouteGeojson,
  onGoogleDirections,
  showLegend = false,
  /** Bump when the map container becomes visible or resizes (e.g. mobile tab switch). */
  mapResizeTrigger = 0,
}) {
  const token = String(mapboxToken || '').trim();
  const useMapbox = mapProvider === 'mapbox' && token.length > 0;
  const useGoogle = mapProvider === 'google' && apiKey && String(apiKey).trim().length > 0;

  if (mapProvider === 'mapbox' && token.length === 0) {
    return (
      <div className="map-container map-placeholder" style={MAP_STYLE}>
        <p>Mapbox is selected but no token is set.</p>
        <p>Go to <strong>Settings → Map API Keys</strong>, choose Mapbox, paste your access token (starts with <code>pk.</code>), then Save.</p>
      </div>
    );
  }
  if (mapProvider === 'google' && (!apiKey || !String(apiKey).trim())) {
    return (
      <div className="map-container map-placeholder" style={MAP_STYLE}>
        <p>Google Maps is selected but no API key is set.</p>
        <p>Go to <strong>Settings → Map API Keys</strong>, choose Google Maps, enter your API key, then Save.</p>
      </div>
    );
  }
  if (useMapbox) {
    return (
      <LeafletMapboxView
        mapboxToken={token}
        locations={locations}
        merchants={merchants}
        taskMarkers={taskMarkers}
        center={center}
        zoom={zoom}
        routeGeojson={mapboxRouteGeojson}
        showLegend={showLegend}
        mapResizeTrigger={mapResizeTrigger}
      />
    );
  }
  if (useGoogle) {
    return (
      <GoogleMapView
        apiKey={apiKey.trim()}
        locations={locations}
        merchants={merchants}
        taskMarkers={taskMarkers}
        center={center}
        zoom={zoom}
        googleMapStyle={googleMapStyle}
        directionsRequest={directionsRequest}
        onDirections={onGoogleDirections}
        mapResizeTrigger={mapResizeTrigger}
      />
    );
  }
  return (
    <div className="map-container map-placeholder" style={MAP_STYLE}>
      <p>Select a map provider in <strong>Settings → Map API keys</strong> (Google Maps or Mapbox) and save your credentials.</p>
    </div>
  );
}
