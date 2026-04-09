/**
 * Fan-out dashboard (dispatcher) notifications — persisted (see riderNotification.service + mt_dashboard_rider_notification).
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
  const activityAt = riderNotificationService.coerceActivityAt(payload?.activityAt);
  const title = (payload?.title || 'Notification').toString().trim() || 'Notification';
  const message = payload?.message != null ? String(payload.message) : '';
  const type = (payload?.type || 'info').toString().trim() || 'info';
  if (ids.length === 0) return;
  const numericIds = ids.map((rid) => parseInt(String(rid), 10)).filter((n) => Number.isFinite(n) && n > 0);
  if (numericIds.length === 0) return;
  try {
    const values = numericIds.map((adminId) => [adminId, title, message, type, activityAt]);
    await pool.query(
      'INSERT INTO mt_dashboard_rider_notification (admin_id, title, message, type, activity_at) VALUES ?',
      [values]
    );
  } catch {
    for (const rid of numericIds) {
      try {
        await riderNotificationService.createForRider(pool, String(rid), { title, message, type, activityAt });
      } catch {
        /* ignore per-admin */
      }
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
  if (c === 'readyforpickup' || c === 'readypickup') return 'ready_for_pickup';
  if (c.includes('ready') && c.includes('pickup') && !c.includes('notready')) return 'ready_for_pickup';
  /* In-progress phrases (driver / PHP) before generic "accepted" fuzzy match. */
  if (!c.includes('notinprogress') && c.includes('inprogress')) return 'inprogress';
  if (c.includes('reached') && c.includes('destination')) return 'inprogress';
  if (c.includes('reachedthedestination') || c.includes('reacheddestination')) return 'inprogress';
  if (c.includes('arrived') && (c.includes('destination') || c.includes('dropoff') || c.includes('location'))) {
    return 'inprogress';
  }
  if (c.includes('enroute') || c.includes('ontheway') || c.includes('onitsway')) return 'inprogress';
  /* Legacy / PHP: phrase status containing "accepted" — after started/inprogress checks (return s) would otherwise miss. */
  if (
    c.includes('accepted') &&
    !c.includes('unaccepted') &&
    !c.includes('notaccepted') &&
    !c.includes('disaccepted') &&
    !c.includes('started') &&
    !c.includes('inprogress')
  ) {
    return 'acknowledged';
  }
  return s;
}

/**
 * @param {string} [actorLabel] — rider or admin display name (shown as " · By …" on the message)
 * @returns {{ title: string, message: string, type: string }|null}
 */
function foodTaskNotifyFromStatus(taskId, orderId, taskDescription, rawStatus, actorLabel) {
  const norm = normalizeFoodTaskStatusKey(rawStatus);
  const hasOrder = orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0';
  const label = hasOrder ? `Order #${String(orderId).trim()}` : `Task #${taskId}`;
  const taskBit = ` · Task #${taskId}`;

  let out = null;
  if (norm === 'acknowledged') {
    out = { title: 'Task accepted', message: `${label}${taskBit}`, type: 'task_accepted' };
  } else if (norm === 'successful' || norm === 'delivered' || norm === 'completed') {
    out = { title: 'Task delivered', message: `${label}${taskBit}`, type: 'task_done' };
  } else if (norm === 'assigned' || norm === 'new') {
    out = { title: 'Task assigned', message: `${label}${taskBit}`, type: 'task_assigned' };
  } else if (norm === 'ready_for_pickup' || norm === 'readyforpickup' || norm === 'readypickup') {
    // Dispatchers must always get an inbox + popup for merchant-ready milestones.
    out = { title: 'Ready for pickup', message: `${label}${taskBit}`, type: 'ready_pickup' };
  } else if (norm === 'started' || norm === 'inprogress' || norm === 'in_progress') {
    out = { title: 'Task in progress', message: `${label}${taskBit}`, type: 'new_task' };
  } else if (
    norm === 'unassigned' ||
    norm === 'cancelled' ||
    norm === 'canceled' ||
    norm === 'declined' ||
    norm === 'failed' ||
    norm === 'rejected'
  ) {
    const pretty = norm.charAt(0).toUpperCase() + norm.slice(1).replace(/_/g, ' ');
    out = { title: `Task ${pretty}`, message: `${label}${taskBit}`, type: 'default' };
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
