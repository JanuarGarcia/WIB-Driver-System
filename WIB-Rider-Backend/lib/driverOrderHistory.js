/**
 * Driver-app activity timeline: merge `mt_order_history` for a task and normalize timestamps
 * for Flutter `TaskOrderHistoryEntry` (date_created, dateCreated, created_at, date_updated, updated_at).
 */

/** DB column names that may hold the event time (read-only; mapped to Flutter keys server-side). */
const MT_HISTORY_SOURCE_TS_KEYS = [
  'date_created',
  'created_at',
  'date_updated',
  'updated_at',
  'date_added',
  'time_stamp',
  'timestamp',
  'dt_created',
  'date_modified',
  'logged_at',
  'history_date',
];

/**
 * @param {Record<string, unknown>|null|undefined} row
 * @returns {string|null} ISO or MySQL-style datetime string
 */
function pickMtOrderHistoryTimestamp(row) {
  if (!row || typeof row !== 'object') return null;
  for (const k of MT_HISTORY_SOURCE_TS_KEYS) {
    const v = row[k];
    if (v == null) continue;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} row raw mt_order_history row (e.g. from SELECT *)
 * @returns {Record<string, unknown>}
 */
function normalizeDriverOrderHistoryEntry(row) {
  if (!row || typeof row !== 'object') return row;
  const ts = pickMtOrderHistoryTimestamp(row);
  const statusStr = row.status != null ? String(row.status).trim() : '';
  const out = { ...row };
  if (ts) {
    out.date_created = ts;
    out.dateCreated = ts;
    out.created_at = ts;
    out.date_updated = ts;
    out.updated_at = ts;
  }
  if (statusStr) {
    out.status = statusStr;
    const rawExisting = row.status_raw != null ? String(row.status_raw).trim() : '';
    out.status_raw = rawExisting || statusStr;
  }
  return out;
}

/**
 * Rows for this task_id plus order-level rows (same order_id, task_id NULL/0).
 * Uses SELECT * so uncommon timestamp columns are still mapped server-side.
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} taskId
 * @param {number|null|undefined} orderId
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function fetchDriverMergedOrderHistory(pool, taskId, orderId) {
  const byId = new Map();
  try {
    const [taskRows] = await pool.query('SELECT * FROM mt_order_history WHERE task_id = ?', [taskId]);
    for (const row of taskRows || []) {
      if (row && row.id != null) byId.set(Number(row.id), row);
    }
    const oid =
      orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0'
        ? parseInt(String(orderId), 10)
        : NaN;
    if (Number.isFinite(oid) && oid > 0) {
      const [orderOnlyRows] = await pool.query(
        'SELECT * FROM mt_order_history WHERE order_id = ? AND (task_id IS NULL OR task_id = 0)',
        [oid]
      );
      for (const row of orderOnlyRows || []) {
        if (row && row.id != null) byId.set(Number(row.id), row);
      }
    }
    const merged = Array.from(byId.values()).map(normalizeDriverOrderHistoryEntry);
    merged.sort((a, b) => {
      const ta = a.date_created ? new Date(a.date_created).getTime() : 0;
      const tb = b.date_created ? new Date(b.date_created).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return Number(a.id) - Number(b.id);
    });
    return merged;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return [];
    }
    throw e;
  }
}

module.exports = {
  fetchDriverMergedOrderHistory,
  normalizeDriverOrderHistoryEntry,
  pickMtOrderHistoryTimestamp,
};
