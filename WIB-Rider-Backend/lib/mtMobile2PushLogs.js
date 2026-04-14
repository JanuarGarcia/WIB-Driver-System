/**
 * Persist rows to mt_mobile2_push_logs (customer app / ops visibility).
 * Column set is detected from INFORMATION_SCHEMA (trigger_id, client_name, device_platform, etc.).
 */

'use strict';

const { loadTableColumnSet } = require('./mobile2DeviceRegLookup');

/** @type {{ db: string, cols: Set<string> } | null} */
let pushLogsColumnCache = null;

/**
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<Set<string>>}
 */
async function getMtMobile2PushLogsColumns(pool) {
  const db = pool && pool.config && pool.config.connectionConfig ? String(pool.config.connectionConfig.database || '') : '';
  if (pushLogsColumnCache && pushLogsColumnCache.db === db && pushLogsColumnCache.cols) {
    return pushLogsColumnCache.cols;
  }
  const cols = await loadTableColumnSet(pool, 'mt_mobile2_push_logs');
  pushLogsColumnCache = { db, cols };
  return cols;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{
 *   clientId: number,
 *   deviceId: string|null,
 *   deviceUiid?: string|null,
 *   clientName?: string|null,
 *   devicePlatform?: string|null,
 *   triggerId?: number|null,
 *   broadcastId?: number|null,
 *   title: string,
 *   body: string,
 *   pushType: string,
 *   status: string,
 *   jsonResponse: string,
 * }} row
 */
async function insertMtMobile2PushLog(pool, row) {
  const {
    clientId,
    deviceId,
    deviceUiid,
    clientName,
    devicePlatform,
    triggerId,
    broadcastId,
    title,
    body,
    pushType,
    status,
    jsonResponse,
  } = row;

  let cols;
  try {
    cols = await getMtMobile2PushLogsColumns(pool);
  } catch (e) {
    console.warn('[mt_mobile2_push_logs] column load:', e.message || String(e));
    return;
  }
  if (!cols.has('client_id')) {
    console.warn('[mt_mobile2_push_logs] table has no client_id column');
    return;
  }

  const trig =
    triggerId != null && String(triggerId).trim() !== '' && Number.isFinite(Number(triggerId)) && Number(triggerId) > 0
      ? Number(triggerId)
      : 0;

  /** @type {{ col: string, val: unknown }[]} */
  const pieces = [];
  const add = (col, val) => {
    if (!cols.has(col)) return;
    pieces.push({ col, val });
  };

  add('broadcast_id', broadcastId != null ? Number(broadcastId) || 0 : 0);
  if (cols.has('trigger_id')) {
    add('trigger_id', trig);
  }
  add('push_type', pushType);
  add('client_id', clientId);
  add('client_name', clientName != null && String(clientName).trim() ? String(clientName).trim() : null);
  add('device_platform', devicePlatform != null && String(devicePlatform).trim() ? String(devicePlatform).trim() : null);
  add('device_id', deviceId != null && String(deviceId).trim() ? String(deviceId).trim().slice(0, 512) : null);

  if (cols.has('device_uiid')) {
    add('device_uiid', deviceUiid != null && String(deviceUiid).trim() ? String(deviceUiid).trim().slice(0, 255) : null);
  } else if (cols.has('device_uuid')) {
    add('device_uuid', deviceUiid != null && String(deviceUiid).trim() ? String(deviceUiid).trim().slice(0, 255) : null);
  }

  if (cols.has('push_title')) add('push_title', title);
  if (cols.has('push_message')) add('push_message', body);

  add('status', status);
  add('json_response', jsonResponse);

  const fieldList = pieces.map((p) => `\`${p.col}\``).join(', ');
  const placeholders = pieces.map(() => '?').join(', ');
  const args = pieces.map((p) => p.val);

  const sql = `INSERT INTO mt_mobile2_push_logs (${fieldList}, date_created) VALUES (${placeholders}, NOW())`;

  try {
    await pool.query(sql, args);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') {
      pushLogsColumnCache = null;
    }
    /* FK on trigger_id (e.g. task_id stored but column references mt_mobile2_order_trigger only): retry without trigger_id */
    const isFk =
      Number(e.errno) === 1452 ||
      String(e.code || '') === 'ER_NO_REFERENCED_ROW_2' ||
      /Cannot add or update a child row|foreign key constraint/i.test(String(e.sqlMessage || e.message || ''));
    if (isFk) {
      try {
        const filtered = pieces.filter((p) => p.col !== 'trigger_id');
        if (filtered.length && filtered.length < pieces.length) {
          const fl2 = filtered.map((p) => `\`${p.col}\``).join(', ');
          const ph2 = filtered.map(() => '?').join(', ');
          await pool.query(`INSERT INTO mt_mobile2_push_logs (${fl2}, date_created) VALUES (${ph2}, NOW())`, filtered.map((p) => p.val));
          return;
        }
      } catch (_) {
        /* fall through */
      }
    }
    console.warn('[mt_mobile2_push_logs] insert:', e.message || String(e));
  }
}

module.exports = { insertMtMobile2PushLog };
