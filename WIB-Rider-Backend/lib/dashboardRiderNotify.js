/**
 * Fan-out dashboard (dispatcher) notifications — in-memory store (see riderNotification.service).
 * riderId === mt_admin_user.admin_id
 */

const riderNotificationService = require('../services/riderNotification.service');

/** @param {{ id?: number|string, username?: string|null, full_name?: string|null }|null|undefined} driver */
function formatActorFromDriver(driver) {
  if (!driver) return '';
  const full = (driver.full_name || '').trim().replace(/\s+/g, ' ');
  if (full) return full;
  const u = (driver.username || '').trim();
  if (u) return u;
  if (driver.id != null && String(driver.id).trim() !== '') return `Driver #${driver.id}`;
  return '';
}

/** @param {{ username?: string|null, first_name?: string|null, last_name?: string|null }|null|undefined} adminUser */
function formatActorFromAdminUser(adminUser) {
  if (!adminUser) return '';
  const fn = (adminUser.first_name || '').trim();
  const ln = (adminUser.last_name || '').trim();
  const name = [fn, ln].filter(Boolean).join(' ').trim();
  if (name) return name;
  const u = (adminUser.username || '').trim();
  if (u) return u;
  return '';
}

/**
 * @param {{ title: string, message: string, type: string }|null} payload
 * @param {string} [actorLabel]
 * @returns {{ title: string, message: string, type: string }|null}
 */
function attachActorToPayload(payload, actorLabel) {
  if (!payload) return null;
  const a = (actorLabel || '').trim();
  if (!a) return payload;
  const base = payload.message != null ? String(payload.message).trim() : '';
  const suffix = ` · By ${a}`;
  return { ...payload, message: base ? `${base}${suffix}` : `By ${a}` };
}

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
  const s = (raw || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const c = s.replace(/_/g, '');
  /* Driver apps vary: accept, accepted, task_accepted, task-accepted, acknowledge, etc. */
  if (c === 'accepted' || c === 'accept' || c === 'taskaccepted' || c === 'accepttask' || c === 'taskaccept') {
    return 'acknowledged';
  }
  if (c === 'acknowledge' || c === 'acknowledged' || (c.includes('acknowledg') && !c.includes('unacknowledg'))) {
    return 'acknowledged';
  }
  if (c === 'delivered' || c === 'completed' || c === 'complete') return 'successful';
  if (c === 'canceled' || c === 'cancelled') return 'cancelled';
  return s;
}

/**
 * @param {string} [actorLabel] — rider or admin display name (shown as " · By …" on the message)
 * @returns {{ title: string, message: string, type: string }|null}
 */
function foodTaskNotifyFromStatus(taskId, orderId, taskDescription, rawStatus, actorLabel) {
  const norm = normalizeFoodTaskStatusKey(rawStatus);
  const label = (taskDescription && String(taskDescription).trim()) || `Task #${taskId}`;
  const ordBit = orderId != null && String(orderId).trim() !== '' ? ` · Order ${orderId}` : '';

  let out = null;
  if (norm === 'acknowledged') {
    out = { title: 'Task accepted', message: `${label}${ordBit}`, type: 'task_accepted' };
  } else if (norm === 'successful' || norm === 'delivered' || norm === 'completed') {
    out = { title: 'Task delivered', message: `${label}${ordBit}`, type: 'task_done' };
  } else if (norm === 'assigned' || norm === 'new') {
    out = { title: 'Task assigned', message: `${label}${ordBit}`, type: 'task_assigned' };
  } else if (norm === 'started' || norm === 'inprogress' || norm === 'in_progress') {
    out = { title: 'Task in progress', message: `${label}${ordBit}`, type: 'new_task' };
  } else if (
    norm === 'unassigned' ||
    norm === 'cancelled' ||
    norm === 'canceled' ||
    norm === 'declined' ||
    norm === 'failed' ||
    norm === 'rejected'
  ) {
    const pretty = norm.charAt(0).toUpperCase() + norm.slice(1).replace(/_/g, ' ');
    out = { title: `Task ${pretty}`, message: `${label}${ordBit}`, type: 'default' };
  }
  return attachActorToPayload(out, actorLabel);
}

/**
 * @param {string} [actorLabel] — rider or admin display name (shown as " · By …" on the message)
 * @returns {{ title: string, message: string, type: string }|null}
 */
function errandNotifyFromCanonical(orderId, label, canonical, actorLabel) {
  const c = (canonical || '').toString().trim().toLowerCase();
  const line = (label && String(label).trim()) || `Errand order #${orderId}`;

  let out = null;
  if (c === 'acknowledged') {
    out = { title: 'Errand accepted', message: line, type: 'task_accepted' };
  } else if (c === 'successful' || c === 'delivered' || c === 'completed') {
    out = { title: 'Errand completed', message: line, type: 'task_done' };
  } else if (c === 'assigned') {
    out = { title: 'Errand assigned', message: line, type: 'task_assigned' };
  } else if (c === 'started' || c === 'inprogress' || c === 'verification' || c === 'pending_verification') {
    out = null;
  } else if (c === 'unassigned' || c === 'cancelled' || c === 'declined' || c === 'failed') {
    out = { title: `Errand ${c.replace(/_/g, ' ')}`, message: line, type: 'default' };
  }
  return attachActorToPayload(out, actorLabel);
}

module.exports = {
  fetchActiveAdminIds,
  notifyAllDashboardAdmins,
  notifyAllDashboardAdminsFireAndForget,
  foodTaskNotifyFromStatus,
  errandNotifyFromCanonical,
  formatActorFromDriver,
  formatActorFromAdminUser,
  attachActorToPayload,
};
