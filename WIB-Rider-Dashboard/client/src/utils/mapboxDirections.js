/**
 * Mapbox Directions API helpers (same routing as dashboard; geometry works with Leaflet/OSM).
 */

export async function mapboxGeocode(token, query) {
  const q = (query || '').trim();
  if (!q) return null;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${encodeURIComponent(token)}&limit=1`;
  const res = await fetch(url);
  const data = await res.json();
  const feat = Array.isArray(data?.features) ? data.features[0] : null;
  const center = Array.isArray(feat?.center) ? feat.center : null;
  if (!center || center.length < 2) return null;
  return { lng: Number(center[0]), lat: Number(center[1]), place_name: feat.place_name };
}

/**
 * @returns {Promise<{
 *   positions: [number,number][],
 *   steps: { instruction: string, distanceM: number, durationS: number, type?: string, modifier?: string }[],
 *   distanceM: number,
 *   durationS: number,
 *   originLatLng: [number,number],
 *   destLatLng: [number,number],
 * }>}
 */
export async function fetchMapboxDrivingRoute({
  mapboxToken,
  origin,
  destination,
  originCoords,
  destinationCoords,
}) {
  const token = String(mapboxToken || '').trim();
  if (!token) throw new Error('Mapbox access token is required for directions.');

  const o = originCoords
    ? { lng: Number(originCoords.lng), lat: Number(originCoords.lat) }
    : await mapboxGeocode(token, origin);
  const d = destinationCoords
    ? { lng: Number(destinationCoords.lng), lat: Number(destinationCoords.lat) }
    : await mapboxGeocode(token, destination);

  if (!o || !Number.isFinite(o.lat) || !Number.isFinite(o.lng)) {
    throw new Error('Unable to find start point. Check pickup / merchant address.');
  }
  if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lng)) {
    throw new Error('Unable to find destination. Check delivery address or coordinates.');
  }

  const coords = `${o.lng},${o.lat};${d.lng},${d.lat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?access_token=${encodeURIComponent(token)}&geometries=geojson&steps=true&overview=full`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code && String(data.code).toLowerCase() !== 'ok') {
    throw new Error(data.message || `Directions error: ${data.code}`);
  }
  const route = Array.isArray(data?.routes) && data.routes.length > 0 ? data.routes[0] : null;
  const geom = route?.geometry;
  if (!geom || !Array.isArray(geom.coordinates)) {
    throw new Error('No route returned. Try adjusting addresses.');
  }

  /** Leaflet [lat,lng] */
  const positions = geom.coordinates.map(([lng, lat]) => [Number(lat), Number(lng)]);

  const rawSteps = route?.legs?.[0]?.steps || [];
  const steps = rawSteps.map((s) => {
    const m = s.maneuver || {};
    return {
      instruction: (m.instruction || '').trim() || 'Continue',
      distanceM: Number(s.distance) || 0,
      durationS: Number(s.duration) || 0,
      type: m.type || '',
      modifier: m.modifier || '',
    };
  });

  return {
    positions,
    steps,
    distanceM: Number(route.distance) || 0,
    durationS: Number(route.duration) || 0,
    originLatLng: [o.lat, o.lng],
    destLatLng: [d.lat, d.lng],
  };
}
