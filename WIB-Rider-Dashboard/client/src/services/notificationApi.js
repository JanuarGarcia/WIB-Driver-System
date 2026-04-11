import { getToken } from '../auth';
import { looksLikeHtmlResponse, API_BASE } from '../api';

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
  const text = await r.text();
  if (looksLikeHtmlResponse(text)) {
    throw new Error(
      'Notifications API returned a web page (wrong URL or /api not proxied to the rider API). Check hosting and VITE_API_URL.'
    );
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Notifications API returned invalid JSON.');
  }
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : r.statusText || 'Request failed');
  if (data.notifications != null && !Array.isArray(data.notifications)) {
    throw new Error('Notifications API returned an unexpected shape.');
  }
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
  const text = await r.text();
  if (looksLikeHtmlResponse(text)) {
    throw new Error('Mark-viewed API returned HTML instead of JSON.');
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Mark-viewed API returned invalid JSON.');
  }
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

/**
 * Global mt_order_history cursor (no date filter). after_history_id=0 → { cursor } only; N → fan-out new rows, return new cursor.
 * @param {number} afterHistoryId
 * @returns {Promise<{ cursor: number, processed: number }>}
 */
export async function fetchOrderHistoryNotifySince(afterHistoryId) {
  const id = Number(afterHistoryId);
  const q = Number.isFinite(id) && id >= 0 ? id : 0;
  const r = await fetch(`${API_BASE}/order-history/notify-since?after_history_id=${encodeURIComponent(String(q))}`, {
    headers: authHeaders(),
    credentials: 'same-origin',
  });
  const text = await r.text();
  if (looksLikeHtmlResponse(text)) {
    throw new Error('Notify-since API returned HTML instead of JSON.');
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Notify-since API returned invalid JSON.');
  }
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : r.statusText || 'Request failed');
  return {
    cursor: Number(data.cursor) || 0,
    processed: Number(data.processed) || 0,
  };
}

/**
 * Global st_ordernew_history cursor (Mangan). Same contract as fetchOrderHistoryNotifySince.
 * @param {number} afterHistoryId
 * @returns {Promise<{ cursor: number, processed: number }>}
 */
export async function fetchErrandNotifySince(afterHistoryId) {
  const id = Number(afterHistoryId);
  const q = Number.isFinite(id) && id >= 0 ? id : 0;
  const r = await fetch(`${API_BASE}/order-history/errand-notify-since?after_history_id=${encodeURIComponent(String(q))}`, {
    headers: authHeaders(),
    credentials: 'same-origin',
  });
  const text = await r.text();
  if (looksLikeHtmlResponse(text)) {
    throw new Error('Errand notify-since API returned HTML instead of JSON.');
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Errand notify-since API returned invalid JSON.');
  }
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : r.statusText || 'Request failed');
  return {
    cursor: Number(data.cursor) || 0,
    processed: Number(data.processed) || 0,
  };
}

/**
 * Global mt_driver_task_photo cursor (rider proof uploads).
 * @param {number} afterPhotoRowId
 * @returns {Promise<{ cursor: number, processed: number }>}
 */
export async function fetchTaskPhotoNotifySince(afterPhotoRowId) {
  const id = Number(afterPhotoRowId);
  const q = Number.isFinite(id) && id >= 0 ? id : 0;
  const r = await fetch(`${API_BASE}/order-history/task-photo-notify-since?after_photo_id=${encodeURIComponent(String(q))}`, {
    headers: authHeaders(),
    credentials: 'same-origin',
  });
  const text = await r.text();
  if (looksLikeHtmlResponse(text)) {
    throw new Error('Task photo notify-since API returned HTML instead of JSON.');
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Task photo notify-since API returned invalid JSON.');
  }
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : r.statusText || 'Request failed');
  return {
    cursor: Number(data.cursor) || 0,
    processed: Number(data.processed) || 0,
  };
}
