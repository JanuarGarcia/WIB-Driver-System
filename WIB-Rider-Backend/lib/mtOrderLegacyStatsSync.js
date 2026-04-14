/**
 * Legacy merchant admin (e.g. wheninbaguioeat.com/admin) often shows order status from
 * mt_order.stats_id -> mt_order_status, not only mt_order.status. Append a status row and
 * repoint stats_id so dashboard / driver task updates match the old admin list.
 */

'use strict';

function legacyStatsSyncDisabled() {
  const v = process.env.MT_ORDER_LEGACY_STATS_SYNC;
  return v === '0' || v === 'false' || v === 'off';
}

/**
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} pool
 * @param {number} orderId
 * @param {string} description - same label written to mt_order.status when possible
 * @returns {Promise<void>}
 */
async function appendMtOrderStatusForLegacyAdmin(pool, orderId, description) {
  if (legacyStatsSyncDisabled()) return;
  const oid = parseInt(String(orderId), 10);
  if (!Number.isFinite(oid) || oid <= 0) return;
  const label = String(description || '').trim();
  if (!label) return;

  let merchantId = null;
  try {
    const [[row]] = await pool.query('SELECT merchant_id FROM mt_order WHERE order_id = ? LIMIT 1', [oid]);
    if (row?.merchant_id != null && String(row.merchant_id).trim() !== '') {
      const m = parseInt(String(row.merchant_id), 10);
      if (Number.isFinite(m) && m > 0) merchantId = m;
    }
  } catch (_) {
    return;
  }

  /** @type {Array<[string, unknown[]]>} */
  const attempts = [];
  if (merchantId != null) {
    attempts.push([
      'INSERT INTO mt_order_status (merchant_id, description, date_created) VALUES (?, ?, NOW())',
      [merchantId, label],
    ]);
    attempts.push([
      'INSERT INTO mt_order_status (order_id, merchant_id, description, date_created) VALUES (?, ?, ?, NOW())',
      [oid, merchantId, label],
    ]);
  }
  attempts.push([
    'INSERT INTO mt_order_status (order_id, description, date_created) VALUES (?, ?, NOW())',
    [oid, label],
  ]);
  if (merchantId == null) {
    attempts.push([
      'INSERT INTO mt_order_status (merchant_id, description, date_created) VALUES (?, ?, NOW())',
      [0, label],
    ]);
  }

  let insertId = null;
  for (const [sql, params] of attempts) {
    try {
      const [result] = await pool.query(sql, params);
      const id = result && result.insertId != null ? Number(result.insertId) : NaN;
      if (Number.isFinite(id) && id > 0) {
        insertId = id;
        break;
      }
    } catch (e) {
      const code = e && e.code;
      if (
        code === 'ER_BAD_FIELD_ERROR' ||
        code === 'ER_NO_SUCH_TABLE' ||
        code === 'ER_NO_REFERENCED_ROW_2' ||
        code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' ||
        code === 'ER_WARN_DATA_OUT_OF_RANGE'
      ) {
        continue;
      }
      if (code === 'ER_DUP_ENTRY') continue;
    }
  }

  if (!insertId) return;

  try {
    await pool.query('UPDATE mt_order SET stats_id = ? WHERE order_id = ?', [insertId, oid]);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') return;
    if (e.errno === 1265 || (e.message && /Data truncated|Incorrect.*enum/i.test(String(e.message)))) return;
    throw e;
  }
}

module.exports = {
  appendMtOrderStatusForLegacyAdmin,
};
