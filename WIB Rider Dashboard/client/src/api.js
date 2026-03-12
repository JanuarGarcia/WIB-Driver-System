import { getToken } from './auth';

// In dev, call backend directly to avoid proxy serving HTML on failure; in build use relative /api (proxied or same-origin).
const API = import.meta.env.DEV ? 'http://localhost:3000/admin/api' : '/api';

export async function api(path, options = {}) {
  const base = API.replace(/\/$/, '');
  const url = API.startsWith('http')
    ? (path.startsWith('/') ? base + path : `${base}/${path}`)
    : (path.startsWith('/') ? path : `${API}/${path}`);
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const token = getToken();
  if (token) headers['x-dashboard-token'] = token;
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
      throw { error: 'Server returned HTML instead of JSON. Is the backend running on port 3000?' };
    }
    throw { error: 'Invalid response from server', message: e.message };
  }
  if (!res.ok) throw data;
  return data;
}

export function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleString();
}

/** Status class for tags - matches WIB Driver app order/colors */
export function statusClass(s) {
  if (!s) return 'status-default';
  const v = String(s).toLowerCase();
  if (['assigned', 'unassigned', 'acknowledged', 'successful', 'completed', 'delivered'].includes(v)) return 'status-green';
  if (['started', 'inprogress'].includes(v)) return 'status-blue';
  if (v === 'failed') return 'status-red';
  if (['declined', 'cancelled', 'canceled'].includes(v)) return 'status-amber';
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
