/**
 * Dashboard (dispatcher) notifications — persisted on primary DB so all Node workers and restarts see the same inbox.
 */

/**
 * @typedef {{ id: string, riderId: string, title: string, message: string, type: string, viewed: boolean, createdAt: Date }} RiderNotification
 */

/**
 * Timeline / photo fan-out dedupe across workers (INSERT IGNORE).
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} key
 * @returns {Promise<boolean>} true if this is the first time for this key (caller should notify)
 */
async function tryConsumeTimelineNotifyKey(pool, key) {
  const k = String(key || '').trim().slice(0, 190);
  if (!k) return false;
  try {
    const [r] = await pool.query(
      'INSERT IGNORE INTO mt_dashboard_notification_dedupe (dedupe_key) VALUES (?)',
      [k]
    );
    return r.affectedRows === 1;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return false;
    return false;
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} riderId
 * @returns {Promise<RiderNotification[]>}
 */
async function listUnreadForRider(pool, riderId) {
  const aid = parseInt(String(riderId), 10);
  if (!Number.isFinite(aid)) return [];
  try {
    const [rows] = await pool.query(
      `SELECT id, admin_id, title, message, type, viewed, date_created
       FROM mt_dashboard_rider_notification
       WHERE admin_id = ? AND viewed = 0
       ORDER BY date_created DESC, id DESC
       LIMIT 100`,
      [aid]
    );
    return (rows || []).map((row) => ({
      id: String(row.id),
      riderId: String(row.admin_id),
      title: row.title,
      message: row.message != null ? String(row.message) : '',
      type: row.type || 'info',
      viewed: Boolean(row.viewed),
      createdAt: row.date_created instanceof Date ? row.date_created : new Date(row.date_created),
    }));
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} riderId
 * @param {string[]} notificationIds
 * @returns {Promise<number>}
 */
async function markViewedForRider(pool, riderId, notificationIds) {
  const aid = parseInt(String(riderId), 10);
  if (!Number.isFinite(aid)) return 0;
  const numericIds = (notificationIds || [])
    .map((x) => parseInt(String(x), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (numericIds.length === 0) return 0;
  const ph = numericIds.map(() => '?').join(',');
  try {
    const [r] = await pool.query(
      `UPDATE mt_dashboard_rider_notification SET viewed = 1 WHERE admin_id = ? AND viewed = 0 AND id IN (${ph})`,
      [aid, ...numericIds]
    );
    return r.affectedRows || 0;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return 0;
    throw e;
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} riderId
 * @param {{ title?: string, message?: string, type?: string }} payload
 * @returns {Promise<RiderNotification>}
 */
async function createForRider(pool, riderId, payload) {
  const aid = parseInt(String(riderId), 10);
  if (!Number.isFinite(aid)) throw new Error('Invalid rider id');
  const title = (payload?.title || 'Notification').toString().trim() || 'Notification';
  const message = payload?.message != null ? String(payload.message) : '';
  const type = (payload?.type || 'info').toString().trim() || 'info';
  const [r] = await pool.query(
    `INSERT INTO mt_dashboard_rider_notification (admin_id, title, message, type) VALUES (?, ?, ?, ?)`,
    [aid, title, message, type]
  );
  const id = r.insertId;
  const row = {
    id: String(id),
    riderId: String(aid),
    title,
    message,
    type,
    viewed: false,
    createdAt: new Date(),
  };
  return row;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 */
async function _clearAll(pool) {
  await pool.query('DELETE FROM mt_dashboard_rider_notification');
  await pool.query('DELETE FROM mt_dashboard_notification_dedupe');
}

module.exports = {
  listUnreadForRider,
  markViewedForRider,
  createForRider,
  tryConsumeTimelineNotifyKey,
  _clearAll,
};
