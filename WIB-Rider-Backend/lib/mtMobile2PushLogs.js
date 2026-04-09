/**
 * Persist rows to mt_mobile2_push_logs (customer app / ops visibility).
 * Schema variants: with or without device_uiid column.
 */

'use strict';

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{
 *   clientId: number,
 *   deviceId: string|null,
 *   deviceUiid?: string|null,
 *   title: string,
 *   body: string,
 *   pushType: string,
 *   status: string,
 *   jsonResponse: string,
 * }} row
 */
async function insertMtMobile2PushLog(pool, row) {
  const { clientId, deviceId, deviceUiid, title, body, pushType, status, jsonResponse } = row;
  const attempts = [
    {
      sql: `INSERT INTO mt_mobile2_push_logs (client_id, device_id, device_uiid, push_title, push_message, push_type, status, json_response, date_created)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      args: [clientId, deviceId, deviceUiid ?? null, title, body, pushType, status, jsonResponse],
    },
    {
      sql: `INSERT INTO mt_mobile2_push_logs (client_id, device_id, push_title, push_message, push_type, status, json_response, date_created)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      args: [clientId, deviceId, title, body, pushType, status, jsonResponse],
    },
  ];
  for (const p of attempts) {
    try {
      await pool.query(p.sql, p.args);
      return;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
        /* try narrower insert */
      } else {
        console.warn('[mt_mobile2_push_logs] insert:', e.message);
      }
    }
  }
}

module.exports = { insertMtMobile2PushLog };
