/**
 * Resolve Mobile App v2 device rows from mt_mobile2_device_reg (FCM token lives here, not on mt_client).
 */

'use strict';

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} table
 * @returns {Promise<Set<string>>}
 */
async function loadTableColumnSet(pool, table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return new Set((rows || []).map((r) => String(r.c)));
}

/**
 * Latest eligible device for logging / token preview (same rules as customer dispatch: token or install id).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} clientId
 * @returns {Promise<{ deviceId: string|null, devicePlatform: string|null, installUuid: string|null, clientFullName: string|null }>}
 */
async function fetchMobile2DeviceRegContextForClient(pool, clientId) {
  const cid = parseInt(String(clientId), 10);
  const empty = { deviceId: null, devicePlatform: null, installUuid: null, clientFullName: null };
  if (!Number.isFinite(cid) || cid <= 0) return empty;

  let cols;
  try {
    cols = await loadTableColumnSet(pool, 'mt_mobile2_device_reg');
  } catch (_) {
    return empty;
  }
  const uuidCol = cols.has('device_uiid') ? 'device_uiid' : cols.has('device_uuid') ? 'device_uuid' : null;
  if (!uuidCol) return empty;

  const pushClause = cols.has('push_enabled')
    ? ` AND (d.push_enabled IS NULL OR d.push_enabled = 1 OR d.push_enabled = '1' OR LOWER(TRIM(CAST(d.push_enabled AS CHAR))) = 'true')`
    : '';

  const sql = `
    SELECT d.device_id,
           d.device_platform,
           d.\`${uuidCol}\` AS install_uuid,
           TRIM(CONCAT(COALESCE(c.first_name,''),' ',COALESCE(c.last_name,''))) AS client_full_name
    FROM mt_mobile2_device_reg d
    LEFT JOIN mt_client c ON c.client_id = d.client_id
    WHERE d.client_id = ?
      ${pushClause}
      AND (
        (d.device_id IS NOT NULL AND TRIM(d.device_id) <> '')
        OR (d.\`${uuidCol}\` IS NOT NULL AND TRIM(d.\`${uuidCol}\`) <> '')
      )
    ORDER BY d.id DESC
    LIMIT 1
  `;

  try {
    const [rows] = await pool.query(sql, [cid]);
    const r = rows && rows[0];
    if (!r) return empty;
    const deviceId = r.device_id != null && String(r.device_id).trim() ? String(r.device_id).trim() : null;
    const installUuid = r.install_uuid != null && String(r.install_uuid).trim() ? String(r.install_uuid).trim() : null;
    const devicePlatform =
      r.device_platform != null && String(r.device_platform).trim() ? String(r.device_platform).trim().toLowerCase() : null;
    const clientFullName =
      r.client_full_name != null && String(r.client_full_name).trim() ? String(r.client_full_name).trim() : null;
    return { deviceId, devicePlatform, installUuid, clientFullName };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return empty;
    throw e;
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} clientId
 * @returns {Promise<string|null>}
 */
async function fetchMtClientDisplayName(pool, clientId) {
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  try {
    const [rows] = await pool.query(
      `SELECT TRIM(CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,''))) AS nm
       FROM mt_client WHERE client_id = ? LIMIT 1`,
      [cid]
    );
    const v = rows && rows[0] && rows[0].nm != null ? String(rows[0].nm).trim() : '';
    return v || null;
  } catch (_) {
    return null;
  }
}

/**
 * Prefer mt_mobile2_order_trigger.id for this order; else use rider task_id for correlation.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} orderId
 * @param {number} taskId
 * @returns {Promise<number|null>}
 */
async function resolvePushLogTriggerId(pool, orderId, taskId) {
  const oid = parseInt(String(orderId), 10);
  try {
    if (Number.isFinite(oid) && oid > 0) {
      const [rows] = await pool.query(
        'SELECT id FROM mt_mobile2_order_trigger WHERE order_id = ? ORDER BY id DESC LIMIT 1',
        [oid]
      );
      const id = rows && rows[0] && rows[0].id != null ? parseInt(String(rows[0].id), 10) : NaN;
      if (Number.isFinite(id) && id > 0) return id;
    }
  } catch (_) {
    /* table missing */
  }
  const tid = parseInt(String(taskId), 10);
  if (Number.isFinite(tid) && tid > 0) return tid;
  return null;
}

module.exports = {
  loadTableColumnSet,
  fetchMobile2DeviceRegContextForClient,
  fetchMtClientDisplayName,
  resolvePushLogTriggerId,
};
