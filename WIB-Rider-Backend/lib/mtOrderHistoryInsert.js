/**
 * Best-effort INSERT into mt_order_history — column sets vary by deployment.
 * Populates update_by_id / update_by_name when columns exist (dashboard timeline + toasts).
 */

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{
 *   orderId: string|number|null,
 *   taskId: string|number|null,
 *   status: string,
 *   remarks: string,
 *   updateByType: string,
 *   actorId?: string|number|null,
 *   actorDisplayName?: string,
 *   latitude?: number|null,
 *   longitude?: number|null,
 * }} p
 */
async function insertMtOrderHistoryRow(pool, p) {
  const orderId = p.orderId ?? null;
  const taskId = p.taskId ?? null;
  const status = p.status ?? '';
  const remarks = p.remarks ?? '';
  const updateByType = p.updateByType || 'system';
  const actorId = p.actorId != null && String(p.actorId).trim() !== '' ? p.actorId : null;
  const actorName = (p.actorDisplayName || '').trim() || null;
  const lat = p.latitude;
  const lng = p.longitude;
  const hasGeo = typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);

  const tryQuery = async (sql, params) => {
    await pool.query(sql, params);
  };

  if (hasGeo) {
    try {
      await tryQuery(
        `INSERT INTO mt_order_history (order_id, task_id, status, remarks, date_created, update_by_type, update_by_id, update_by_name, latitude, longitude)
         VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
        [orderId, taskId, status, remarks, updateByType, actorId, actorName, lat, lng]
      );
      return;
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
    try {
      await tryQuery(
        `INSERT INTO mt_order_history (order_id, task_id, status, remarks, date_created, update_by_type, latitude, longitude)
         VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
        [orderId, taskId, status, remarks, updateByType, lat, lng]
      );
      return;
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  if (actorName || actorId != null) {
    try {
      await tryQuery(
        `INSERT INTO mt_order_history (order_id, task_id, status, remarks, date_created, update_by_type, update_by_id, update_by_name)
         VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
        [orderId, taskId, status, remarks, updateByType, actorId, actorName]
      );
      return;
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  await tryQuery(
    `INSERT INTO mt_order_history (order_id, task_id, status, remarks, date_created, update_by_type) VALUES (?, ?, ?, ?, NOW(), ?)`,
    [orderId, taskId, status, remarks, updateByType]
  );
}

module.exports = { insertMtOrderHistoryRow };
