import { getToken } from '../auth';

/* Dev: same-origin /api → Vite proxy (vite.config.js) → backend /admin/api. Override with VITE_API_URL if needed. */
const API_BASE = import.meta.env.VITE_API_URL || '/api';

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) h['x-dashboard-token'] = t;
  return h;
}

/**
 * GET /rider/notifications — unread only, scoped to session admin (riderId on server).
 */
export async function fetchRiderNotifications() {
  const r = await fetch(`${API_BASE}/rider/notifications`, {
    headers: authHeaders(),
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : r.statusText || 'Request failed');
  return data;
}

/**
 * POST /rider/notifications/mark-viewed
 * @param {string[]} notificationIds
 */
export async function markRiderNotificationsViewed(notificationIds) {
  const r = await fetch(`${API_BASE}/rider/notifications/mark-viewed`, {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'same-origin',
    body: JSON.stringify({ notificationIds }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : r.statusText || 'Request failed');
  return data;
}

/**
 * POST /dev/create-notification (non-production or ALLOW_DEV_NOTIFICATIONS=1 on backend)
 */
export async function devCreateNotification(body) {
  const r = await fetch(`${API_BASE}/dev/create-notification`, {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : r.statusText || 'Request failed');
  return data;
}
