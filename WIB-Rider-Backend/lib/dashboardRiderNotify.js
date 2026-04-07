/**
 * Fan-out dashboard (dispatcher) notifications: in-memory store polled by WIB Rider Dashboard.
 * riderId === mt_admin_user.admin_id
 */

const riderNotificationService = require('../services/riderNotification.service');

/**
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<string[]>}
 */
async function fetchActiveAdminIds(pool) {
  const mapIds = (rows) =>
    [...new Set((rows || []).map((r) => String(r.admin_id)).filter((id) => id && id !== 'undefined'))];

  try {
    const [rows] = await pool.query(
      `SELECT admin_id FROM mt_admin_user
       WHERE (status IS NULL OR status = '' OR status = 0 OR status = 1 OR status = '1' OR status = 'active')`
    );
    const ids = mapIds(rows);
    if (ids.length > 0) return ids;
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') return [];
    /* Some schemas omit `status` — fall through */
  }

  try {
    const [rowsAll] = await pool.query('SELECT admin_id FROM mt_admin_user');
    return mapIds(rowsAll);
  } catch {
    return [];
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ title: string, message?: string, type?: string }} payload
 */
async function notifyAllDashboardAdmins(pool, payload) {
  const ids = await fetchActiveAdminIds(pool);
  const title = (payload?.title || 'Notification').toString().trim() || 'Notification';
  const message = payload?.message != null ? String(payload.message) : '';
  const type = (payload?.type || 'info').toString().trim() || 'info';
  for (const rid of ids) {
    try {
      riderNotificationService.createForRider(rid, { title, message, type });
    } catch {
      /* ignore per-admin */
    }
  }
}

function notifyAllDashboardAdminsFireAndForget(pool, payload) {
  notifyAllDashboardAdmins(pool, payload).catch(() => {});
}

/** Normalize driver/admin wording to a bucket for mt_driver_task-style statuses. */
function normalizeFoodTaskStatusKey(raw) {
  const s = (raw || '').toString().trim().toLowerCase().replace(/\s+/g, '_');
  const c = s.replace(/_/g, '');
  /* Driver apps vary: accept, accepted, acknowledge, Acknowledged, etc. */
  if (c === 'accepted' || c === 'accept') return 'acknowledged';
  if (c === 'acknowledge' || c === 'acknowledged') return 'acknowledged';
  if (c === 'delivered' || c === 'completed' || c === 'complete') return 'successful';
  if (c === 'canceled' || c === 'cancelled') return 'cancelled';
  return s;
}

/**
 * @returns {{ title: string, message: string, type: string }|null}
 */
function foodTaskNotifyFromStatus(taskId, orderId, taskDescription, rawStatus) {
  const norm = normalizeFoodTaskStatusKey(rawStatus);
  const label = (taskDescription && String(taskDescription).trim()) || `Task #${taskId}`;
  const ordBit = orderId != null && String(orderId).trim() !== '' ? ` · Order ${orderId}` : '';

  if (norm === 'acknowledged') {
    return { title: 'Task accepted', message: `${label}${ordBit}`, type: 'task_accepted' };
  }
  if (norm === 'successful' || norm === 'delivered' || norm === 'completed') {
    return { title: 'Task delivered', message: `${label}${ordBit}`, type: 'task_done' };
  }
  if (norm === 'assigned' || norm === 'new') {
    return { title: 'Task assigned', message: `${label}${ordBit}`, type: 'task_assigned' };
  }
  if (norm === 'started' || norm === 'inprogress' || norm === 'in_progress') {
    return { title: 'Task in progress', message: `${label}${ordBit}`, type: 'new_task' };
  }
  if (norm === 'unassigned' || norm === 'cancelled' || norm === 'canceled' || norm === 'declined' || norm === 'failed') {
    const pretty = norm.charAt(0).toUpperCase() + norm.slice(1).replace(/_/g, ' ');
    return { title: `Task ${pretty}`, message: `${label}${ordBit}`, type: 'default' };
  }
  return null;
}

/**
 * @returns {{ title: string, message: string, type: string }|null}
 */
function errandNotifyFromCanonical(orderId, label, canonical) {
  const c = (canonical || '').toString().trim().toLowerCase();
  const line = (label && String(label).trim()) || `Errand order #${orderId}`;

  if (c === 'acknowledged') {
    return { title: 'Errand accepted', message: line, type: 'task_accepted' };
  }
  if (c === 'successful' || c === 'delivered' || c === 'completed') {
    return { title: 'Errand completed', message: line, type: 'task_done' };
  }
  if (c === 'assigned') {
    return { title: 'Errand assigned', message: line, type: 'task_assigned' };
  }
  if (c === 'started' || c === 'inprogress' || c === 'verification' || c === 'pending_verification') {
    return null;
  }
  if (c === 'unassigned' || c === 'cancelled' || c === 'declined' || c === 'failed') {
    return { title: `Errand ${c.replace(/_/g, ' ')}`, message: line, type: 'default' };
  }
  return null;
}

module.exports = {
  fetchActiveAdminIds,
  notifyAllDashboardAdmins,
  notifyAllDashboardAdminsFireAndForget,
  foodTaskNotifyFromStatus,
  errandNotifyFromCanonical,
};
