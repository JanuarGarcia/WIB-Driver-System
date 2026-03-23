import { useMemo, useEffect, useState, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
if (typeof window !== 'undefined') window.L = L;
import Map, { Marker as MapboxMarker, Source, Layer } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import { LoadScript, GoogleMap, Marker as GoogleMarker, DirectionsService, DirectionsRenderer } from '@react-google-maps/api';

const BAGUIO_CENTER = [16.4023, 120.596];
const BAGUIO_VIEW = { longitude: 120.596, latitude: 16.4023, zoom: 13 };
const MAP_STYLE = { width: '100%', height: '100%', minHeight: 400 };

function merchantLogoUrl(logo) {
  if (!logo || !String(logo).trim()) return null;
  const s = String(logo).trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return `/uploads/merchants/${encodeURIComponent(s)}`;
}

function PinMarker({ type, imageUrl, title }) {
  const resolvedUrl = type === 'merchant' && imageUrl ? merchantLogoUrl(imageUrl) || imageUrl : imageUrl;
  const hasImage = type === 'merchant' && resolvedUrl && String(resolvedUrl).trim().length > 0;
  return (
    <div className="map-pin-wrap" title={title || undefined}>
      <div className={`map-pin map-pin-${type} ${hasImage ? 'map-pin-has-image' : ''}`}>
        <div className="map-pin-head">
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
  return new L.DivIcon({
    className: 'leaflet-pin-wrap',
    html: `<div class="leaflet-pin leaflet-pin-${type} ${hasImage ? 'leaflet-pin-has-image' : ''}">
      <div class="leaflet-pin-head">${imgHtml}</div>
      <div class="leaflet-pin-point"></div>
    </div>`,
    iconSize: [40, 52],
    iconAnchor: [20, 52],
  });
}

const riderPinIcon = leafletPinIcon('rider', null);

function useRiderAndMerchantMarkers(locations, merchants) {
  const riderMarkers = useMemo(
    () => (locations || []).filter((loc) => loc.lat != null && loc.lng != null),
    [locations]
  );
  const merchantMarkers = useMemo(
    () => (merchants || []).filter((m) => m.lat != null && m.lng != null),
    [merchants]
  );
  return { riderMarkers, merchantMarkers };
}

const BAGUIO_BOUNDS_MAX_SPAN = 1.5; // degrees lat/lng — only fit bounds when markers are within this range of each other

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

function LeafletFitBounds({ locations, merchants, disabled }) {
  const map = useMap();
  const points = useMemo(() => {
    if (disabled) return [];
    const out = [];
    (locations || []).forEach((loc) => { if (loc.lat != null && loc.lng != null) out.push([Number(loc.lat), Number(loc.lng)]); });
    (merchants || []).forEach((m) => { if (m.lat != null && m.lng != null) out.push([Number(m.lat), Number(m.lng)]); });
    return out;
  }, [locations, merchants, disabled]);
  useEffect(() => {
    if (disabled || points.length < 2) return;
    try {
      const lats = points.map((p) => p[0]);
      const lngs = points.map((p) => p[1]);
      const spanLat = Math.max(...lats) - Math.min(...lats);
      const spanLng = Math.max(...lngs) - Math.min(...lngs);
      if (spanLat > BAGUIO_BOUNDS_MAX_SPAN || spanLng > BAGUIO_BOUNDS_MAX_SPAN) {
        return;
      }
      map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
    } catch (_) {}
  }, [map, points]);
  return null;
}

function LeafletMapView({ locations, merchants, center, zoom }) {
  const { riderMarkers, merchantMarkers } = useRiderAndMerchantMarkers(locations, merchants);
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
        {fitBoundsDisabled && <LeafletSetView center={mapCenter} zoom={mapZoom} />}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <LeafletFitBounds locations={riderMarkers} merchants={merchantMarkers} disabled={fitBoundsDisabled} />
        {riderMarkers.map((loc, idx) => (
          <Marker key={`rider-${loc.driver_id ?? idx}`} position={[Number(loc.lat), Number(loc.lng)]} icon={riderPinIcon}>
            <Popup><strong>Rider</strong>{loc.full_name && <><br />{loc.full_name}</>}{loc.on_duty != null && <><br />{loc.on_duty ? 'On duty' : 'Off duty'}</>}</Popup>
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
              <Popup><strong>Merchant</strong>{m.restaurant_name && <><br />{m.restaurant_name}</>}</Popup>
            </Marker>
          );
        })}
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
function LeafletMapboxMarkersLayer({ riderMarkers, merchantMarkers }) {
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
      const popupContent = `<strong>Rider</strong>${loc.full_name ? `<br />${loc.full_name}` : ''}${loc.on_duty != null ? `<br />${loc.on_duty ? 'On duty' : 'Off duty'}` : ''}`;
      marker.bindPopup(popupContent);
      group.addLayer(marker);
    });
    (merchantMarkers || []).forEach((m, idx) => {
      const logo = m.logo_url ?? m.logo ?? m.image_url;
      const logoImgUrl = merchantLogoUrl(logo);
      const marker = L.marker([Number(m.lat), Number(m.lng)], { icon: leafletPinIcon('merchant', logoImgUrl) });
      const popupContent = `<strong>Merchant</strong>${m.restaurant_name ? `<br />${m.restaurant_name}` : ''}`;
      marker.bindPopup(popupContent);
      group.addLayer(marker);
    });
  }, [riderMarkers, merchantMarkers]);
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

function LeafletMapboxView({ mapboxToken, locations, merchants, center, zoom, routeGeojson }) {
  const { riderMarkers, merchantMarkers } = useRiderAndMerchantMarkers(locations, merchants);
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
        <LeafletFitBounds locations={riderMarkers} merchants={merchantMarkers} disabled={fitBoundsDisabled} />
        <LeafletMapboxMarkersLayer riderMarkers={riderMarkers} merchantMarkers={merchantMarkers} />
      </MapContainer>
    </div>
  );
}

function MapboxMapView({ mapboxToken, locations, merchants, center, zoom }) {
  const { riderMarkers, merchantMarkers } = useRiderAndMerchantMarkers(locations, merchants);
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
            <PinMarker type="rider" title={loc.full_name || 'Rider'} />
          </MapboxMarker>
        ))}
        {merchantMarkers.map((m, idx) => (
          <MapboxMarker key={`merchant-${m.merchant_id ?? idx}`} longitude={Number(m.lng)} latitude={Number(m.lat)} anchor="bottom">
            <PinMarker
              type="merchant"
              imageUrl={m.image_url || m.logo_url || m.logo || m.photo || m.merchant_image}
              title={m.restaurant_name || 'Merchant'}
            />
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

function GoogleMapView({ apiKey, locations, merchants, center: centerProp, zoom: zoomProp, googleMapStyle, directionsRequest, onDirections }) {
  const [loadError, setLoadError] = useState(null);
  const { riderMarkers, merchantMarkers } = useRiderAndMerchantMarkers(locations, merchants);
  const [directionsResult, setDirectionsResult] = useState(null);
  const [directionsStatus, setDirectionsStatus] = useState(null);
  const center = useMemo(() => {
    if (centerProp != null && Array.isArray(centerProp) && centerProp.length >= 2) {
      return { lat: centerProp[0], lng: centerProp[1] };
    }
    return { lat: 16.4023, lng: 120.596 };
  }, [centerProp]);
  const zoom = zoomProp != null ? zoomProp : 13;
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
            <GoogleMarker key={`rider-${loc.driver_id ?? idx}`} position={{ lat: Number(loc.lat), lng: Number(loc.lng) }} title={loc.full_name || 'Rider'} />
          ))}
          {merchantMarkers.map((m, idx) => (
            <GoogleMarker key={`merchant-${m.merchant_id ?? idx}`} position={{ lat: Number(m.lat), lng: Number(m.lng) }} title={m.restaurant_name || 'Merchant'} />
          ))}
        </GoogleMap>
      )}
    </LoadScript>
  );
}

export default function MapView({ locations = [], merchants = [], mapProvider = 'mapbox', apiKey = '', mapboxToken = '', center, zoom, googleMapStyle, directionsRequest, mapboxRouteGeojson, onGoogleDirections }) {
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
    return <LeafletMapboxView mapboxToken={token} locations={locations} merchants={merchants} center={center} zoom={zoom} routeGeojson={mapboxRouteGeojson} />;
  }
  if (useGoogle) {
    return <GoogleMapView apiKey={apiKey.trim()} locations={locations} merchants={merchants} center={center} zoom={zoom} googleMapStyle={googleMapStyle} directionsRequest={directionsRequest} onDirections={onGoogleDirections} />;
  }
  return (
    <div className="map-container map-placeholder" style={MAP_STYLE}>
      <p>Select a map provider in <strong>Settings → Map API keys</strong> (Google Maps or Mapbox) and save your credentials.</p>
    </div>
  );
}
