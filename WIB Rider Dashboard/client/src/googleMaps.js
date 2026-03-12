/**
 * Google Maps Geocoding and Distance Matrix helpers.
 * Use the same API key as in Settings → Map API Keys (enable Geocoding API and Distance Matrix API).
 */

const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const DISTANCE_MATRIX_BASE = 'https://maps.googleapis.com/maps/api/distancematrix/json';

/**
 * Geocode an address to lat/lng.
 * @param {string} apiKey - Google API key
 * @param {string} address - Address string
 * @returns {Promise<{ lat: number, lng: number, formatted_address: string } | null>}
 */
export async function geocodeAddress(apiKey, address) {
  if (!apiKey || !address || !String(address).trim()) return null;
  const url = `${GEOCODE_BASE}?address=${encodeURIComponent(String(address).trim())}&key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.[0]) return null;
  const r = data.results[0];
  return {
    lat: r.geometry?.location?.lat,
    lng: r.geometry?.location?.lng,
    formatted_address: r.formatted_address || address,
  };
}

/**
 * Get distance and duration between origins and destinations.
 * @param {string} apiKey - Google API key
 * @param {{ origins: string[]|{lat:number,lng:number}[], destinations: string[]|{lat:number,lng:number}[] }} params
 * @returns {Promise<{ rows: { elements: { distance?: { text, value }, duration?: { text, value }, status: string }[] }[] } | null>}
 */
export async function getDistanceMatrix(apiKey, { origins, destinations }) {
  if (!apiKey || !origins?.length || !destinations?.length) return null;
  const toParam = (v) => (typeof v === 'string' ? v : `${v.lat},${v.lng}`);
  const originsStr = (Array.isArray(origins) ? origins : [origins]).map(toParam).join('|');
  const destStr = (Array.isArray(destinations) ? destinations : [destinations]).map(toParam).join('|');
  const url = `${DISTANCE_MATRIX_BASE}?origins=${encodeURIComponent(originsStr)}&destinations=${encodeURIComponent(destStr)}&key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') return null;
  return { rows: data.rows || [] };
}
