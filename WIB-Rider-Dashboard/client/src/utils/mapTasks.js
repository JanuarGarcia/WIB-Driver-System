/** Session key: Tasks panel writes selected list date so the dashboard map can match it. */
export const DASHBOARD_TASKS_MAP_DATE_KEY = 'wib-dashboard-tasks-map-date';

export const DASHBOARD_TASKS_MAP_DATE_EVENT = 'wib-dashboard-tasks-map-date-changed';

export function readDashboardTasksMapDateFromStorage() {
  try {
    const v = sessionStorage.getItem(DASHBOARD_TASKS_MAP_DATE_KEY);
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  } catch (_) {}
  return null;
}

export function todayDateStrLocal() {
  const x = new Date();
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const d = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Task list + map date on load/refresh. If session has a calendar day before local today, use today.
 * Future dates (e.g. scheduled orders) are kept. (YYYY-MM-DD string compare.)
 */
export function readEffectiveDashboardTaskDate() {
  const today = todayDateStrLocal();
  const stored = readDashboardTasksMapDateFromStorage();
  if (!stored) return today;
  if (stored < today) return today;
  return stored;
}

export function notifyDashboardTasksMapDateChanged() {
  try {
    window.dispatchEvent(new Event(DASHBOARD_TASKS_MAP_DATE_EVENT));
  } catch (_) {}
}

/** Normalize API task status for comparison (matches TaskPanel / AgentPanel). */
export function normalizeTaskStatusKey(status) {
  return String(status ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

/** Only these statuses get an orange task pin (excludes delivered/successful/completed and other terminal states). */
export const TASK_MAP_MARKER_STATUS_SET = new Set([
  'unassigned',
  'assigned',
  'inprogress',
  'started',
  'acknowledged',
  'verification',
  'pendingverification',
  'pending_verification',
]);

/** Coordinates from ErrandWib `st_client_address` summary on task detail (`client_address`). */
function latLngFromClientAddress(ca) {
  if (!ca || typeof ca !== 'object') return null;
  const pairs = [
    ['latitude', 'longitude'],
    ['google_lat', 'google_lng'],
    ['lat', 'lng'],
    ['map_lat', 'map_lng'],
    ['delivery_latitude', 'delivery_longitude'],
    ['location_lat', 'location_lng'],
    ['geo_lat', 'geo_lng'],
  ];
  for (const [la, ln] of pairs) {
    if (ca[la] == null || ca[ln] == null) continue;
    const plat = Number(ca[la]);
    const plng = Number(ca[ln]);
    if (Number.isFinite(plat) && Number.isFinite(plng)) return { lat: plat, lng: plng };
  }
  return null;
}

/**
 * Valid drop-off coordinates for a task row (`task_lat` / `task_lng`).
 * @param {Record<string, unknown>|null|undefined} t - task object from API
 * @param {Record<string, unknown>|null|undefined} [detailPayload] - full GET task/errand-orders response; uses `client_address` for Errand when present
 */
export function taskDropoffLatLng(t, detailPayload) {
  if (!t || typeof t !== 'object') return null;
  if (detailPayload && typeof detailPayload === 'object') {
    const fromDetail = latLngFromClientAddress(detailPayload.client_address);
    if (fromDetail) return fromDetail;
  }
  const fromTaskNested = latLngFromClientAddress(t.client_address);
  if (fromTaskNested) return fromTaskNested;
  const lat = t.task_lat != null ? Number(t.task_lat) : NaN;
  const lng = t.task_lng != null ? Number(t.task_lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** Match agent-panel driver row to `drivers/locations` entry (`driver_id`, `lat`, `lng`). */
export function riderGpsFromLocations(driver, locations) {
  if (!driver || typeof driver !== 'object' || !Array.isArray(locations)) return null;
  const did = String(driver.driver_id ?? driver.id ?? '').trim();
  if (!did) return null;
  const loc = locations.find((l) => String(l.driver_id ?? '') === did);
  if (!loc) return null;
  const lat = loc.lat != null ? Number(loc.lat) : NaN;
  const lng = loc.lng != null ? Number(loc.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

const EARTH_RADIUS_M = 6371000;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLng = toR(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Map zoom when focusing a rider from the agent panel (tighter than task drop-off). */
export const DASHBOARD_RIDER_FOCUS_ZOOM = 18;
/** When another rider is within `RIDER_MAP_FOCUS_CLUSTER_RADIUS_M`, zoom in further so pins separate. */
export const DASHBOARD_RIDER_FOCUS_ZOOM_CLUSTERED = 19;

const RIDER_MAP_FOCUS_CLUSTER_RADIUS_M = 70;

/**
 * Choose zoom for “focus this rider on the map” so overlapping pins are easier to pick apart.
 * @param {number} lat
 * @param {number} lng
 * @param {Array<Record<string, unknown>>|null|undefined} locations - `drivers/locations` rows
 */
export function riderMapFocusZoom(lat, lng, locations) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Array.isArray(locations)) {
    return DASHBOARD_RIDER_FOCUS_ZOOM;
  }
  let within = 0;
  for (const loc of locations) {
    if (!loc || typeof loc !== 'object') continue;
    const la = loc.lat != null ? Number(loc.lat) : NaN;
    const ln = loc.lng != null ? Number(loc.lng) : NaN;
    if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
    if (haversineMeters(lat, lng, la, ln) <= RIDER_MAP_FOCUS_CLUSTER_RADIUS_M) within += 1;
  }
  return within >= 2 ? DASHBOARD_RIDER_FOCUS_ZOOM_CLUSTERED : DASHBOARD_RIDER_FOCUS_ZOOM;
}

/**
 * Tasks that can be drawn on the map (delivery coordinates).
 * @param {Array<Record<string, unknown>>|null|undefined} tasks
 * @returns {Array<{ task_id: *, lat: number, lng: number, merchant_id?: *, delivery_address?: string, restaurant_name?: string, status?: string, order_id?: *, landmark?: string }>}
 */
export function tasksWithMapCoordinates(tasks) {
  return (tasks || [])
    .map((t) => {
      let lat = NaN;
      let lng = NaN;
      if (t.task_source === 'errand') {
        const cc = latLngFromClientAddress(t.client_address);
        if (cc && Number.isFinite(cc.lat) && Number.isFinite(cc.lng)) {
          lat = cc.lat;
          lng = cc.lng;
        }
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        lat = t.task_lat != null ? Number(t.task_lat) : NaN;
        lng = t.task_lng != null ? Number(t.task_lng) : NaN;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const cc = latLngFromClientAddress(t.client_address);
        if (cc) {
          lat = cc.lat;
          lng = cc.lng;
        }
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const landmarkRaw = t.delivery_landmark != null ? String(t.delivery_landmark).trim() : '';
      return {
        task_id: t.task_id,
        lat,
        lng,
        task_source: t.task_source,
        merchant_id: t.merchant_id ?? t.merchantId,
        delivery_address: t.delivery_address,
        restaurant_name: t.restaurant_name,
        status: t.status,
        order_id: t.order_id,
        landmark: landmarkRaw || undefined,
      };
    })
    .filter(Boolean)
    .filter((row) => TASK_MAP_MARKER_STATUS_SET.has(normalizeTaskStatusKey(row.status)));
}
