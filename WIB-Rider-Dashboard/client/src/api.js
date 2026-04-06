import { getToken } from './auth';

// Prefer explicit env-configured base URL (useful for phones / other devices).
// Fallback: dev hits backend directly; production uses /api — the dashboard Node app (server.js) proxies
// /api/* -> BACKEND_URL/admin/api/*. Do NOT use /admin/api in the browser on rider-dashboard.* or the
// SPA will serve index.html for those paths (no proxy). Static-only deploys: set VITE_API_URL to full backend + /admin/api.
const API =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://localhost:3000/admin/api' : '/api');

/** Origin where `/uploads/...` is served (matches API app in app.js). */
export function uploadsOrigin() {
  const raw = String(import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw.replace(/\/admin\/api\/?$/i, '').replace(/\/$/, '');
  }
  if (import.meta.env.DEV) return 'http://localhost:3000';
  return '';
}

/** Turn relative upload paths into absolute URLs when the API is on another host (e.g. Vite dev or split deploy). */
export function resolveUploadUrl(path) {
  if (path == null || typeof path !== 'string') return path;
  const p = path.trim();
  if (!p) return p;
  const lower = p.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:')
  ) {
    return p;
  }
  const rel = p.startsWith('/') ? p : `/${p}`;
  const origin = uploadsOrigin();
  return origin ? `${origin}${rel}` : rel;
}

/** Coalesce concurrent identical GETs (e.g. dashboard map + task list share `tasks?date=…`). */
const inFlightGetByKey = new Map();

export async function api(path, options = {}) {
  const base = API.replace(/\/$/, '');
  const url = API.startsWith('http')
    ? (path.startsWith('/') ? base + path : `${base}/${path}`)
    : (path.startsWith('/') ? path : `${API}/${path}`);
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const token = getToken();
  if (token) headers['x-dashboard-token'] = token;

  const runFetch = async () => {
    const res = await fetch(url, {
      ...options,
      headers,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      if (text.trimStart().startsWith('<!')) {
        throw {
          error:
            'Server returned HTML instead of JSON (often the SPA index or a 404 page). Set VITE_API_URL at build time to your API base, e.g. https://your-host/admin/api, or proxy /admin/api on this host to the Node backend.',
        };
      }
      throw { error: 'Invalid response from server', message: e.message };
    }
    if (!res.ok) throw data;
    return data;
  };

  if (method === 'GET' && !options.body && !options.skipDedupe) {
    const dedupeKey = `${token || ''}|${url}`;
    const existing = inFlightGetByKey.get(dedupeKey);
    if (existing) return existing;
    const p = runFetch().finally(() => {
      queueMicrotask(() => {
        if (inFlightGetByKey.get(dedupeKey) === p) inFlightGetByKey.delete(dedupeKey);
      });
    });
    inFlightGetByKey.set(dedupeKey, p);
    return p;
  }

  return runFetch();
}

export function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleString();
}

/** Calendar date only (no time) — use for order delivery_date, etc. */
export function formatDateOnly(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) {
    const s = String(d).trim();
    return s.length >= 10 ? s.slice(0, 10) : s || '—';
  }
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Activity timeline: "March 21, 2026, 2:14 PM" (no seconds). */
export function formatActivityTimelineDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const datePart = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const timePart = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${datePart}, ${timePart}`;
}

/** Compact timeline time (legacy rider UI style): "Mar 24, 26 8:56 am". */
export function formatActivityTimelineDateTimeShort(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const mon = dt.toLocaleDateString('en-US', { month: 'short' });
  const day = dt.getDate();
  const yy = String(dt.getFullYear()).slice(-2);
  const timePart = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  return `${mon}-${day}-${yy} ${timePart}`;
}

/** Normalize status strings for class lookup ("Ready For Pickup", "initial_order", etc.). */
function statusClassKey(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

/** Status class for tags - matches WIB Driver app + classic rider Activity Timeline */
export function statusClass(s) {
  if (!s) return 'status-default';
  const v = statusClassKey(s);
  if (v === 'failed') return 'status-red';
  if (['declined', 'cancelled', 'canceled'].includes(v)) return 'status-amber';
  if (
    ['assigned', 'unassigned', 'acknowledged', 'successful', 'completed', 'delivered'].includes(v)
  ) {
    return 'status-green';
  }
  if (
    [
      'started',
      'inprogress',
      'photo',
      'verification',
      'preparing',
      'readypickup',
      'readyforpickup',
      'initialorder',
      'deliveryonitsway',
      'arrivedat',
      'advanceorder',
    ].includes(v)
  ) {
    return 'status-blue';
  }
  return 'status-default';
}

/** Status badge label - matches WIB Driver app task_details_screen _statusBadgeLabel */
export function statusLabel(s) {
  if (!s || !String(s).trim()) return 'UNKNOWN';
  const v = String(s).toLowerCase().trim();
  switch (v) {
    case 'acknowledged': return 'ACCEPTED';
    case 'started': return 'STARTED';
    case 'inprogress': return 'IN PROGRESS';
    case 'successful': return 'DELIVERED';
    case 'failed': return 'FAILED';
    case 'declined': return 'REJECTED';
    case 'cancelled':
    case 'canceled': return 'CANCELLED';
    default: return v.toUpperCase();
  }
}

/** Same as statusClass - for display class (Status column only) */
export function statusDisplayClass(s) {
  return statusClass(s);
}

/** Centralized backend: MercifulGod pool only (admin session required). */
export function centralMercifulGodPing() {
  return api('central/merciful-god/ping');
}

/** Centralized backend: ErrandWib pool only. */
export function centralErrandWibPing() {
  return api('central/errand-wib/ping');
}

/** Combined snapshot (default pool + both named databases). */
export function centralUnifiedOverview() {
  return api('central/unified-overview');
}
