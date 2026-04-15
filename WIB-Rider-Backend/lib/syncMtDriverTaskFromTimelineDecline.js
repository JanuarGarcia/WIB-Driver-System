/**
 * When another system writes mt_order_history (e.g. status "decline"), align mt_driver_task.status
 * so the rider dashboard "Declined" bucket matches the activity timeline.
 */

'use strict';

const { classifyTimelineHistoryForDashboardNotify } = require('./dashboardTimelineNotifyClassify');
const { updateMtOrderStatusIfDeliveryComplete } = require('./mtOrderStatusSync');
const { foodTaskNotifyFromStatus, notifyAllDashboardAdminsFireAndForget } = require('./dashboardRiderNotify');

function normalizeTaskStatusKey(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

function actorFromHistoryRow(row) {
  if (!row || typeof row !== 'object') return '';
  const n = row.update_by_name != null ? String(row.update_by_name).trim() : '';
  return n || '';
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} taskId
 * @param {Record<string, unknown>} historyRow - raw or feed-shaped row for classifyTimelineHistoryForDashboardNotify
 * @returns {Promise<{ updated: boolean }>}
 */
async function syncMtDriverTaskFromDeclineHistory(pool, taskId, historyRow) {
  const tid = Number(taskId);
  if (!Number.isFinite(tid) || tid <= 0) return { updated: false };
  if (classifyTimelineHistoryForDashboardNotify(historyRow) !== 'declined') return { updated: false };

  let cur;
  try {
    const [[row]] = await pool.query(
      'SELECT status, order_id, task_description FROM mt_driver_task WHERE task_id = ? LIMIT 1',
      [tid]
    );
    cur = row;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return { updated: false };
    throw e;
  }
  if (!cur) return { updated: false };

  const curKey = normalizeTaskStatusKey(cur.status);
  const skip = new Set(['successful', 'completed', 'delivered', 'declined', 'cancelled', 'canceled', 'failed']);
  if (skip.has(curKey)) return { updated: false };

  let result;
  try {
    [result] = await pool.query(
      "UPDATE mt_driver_task SET status = 'declined', date_modified = NOW() WHERE task_id = ?",
      [tid]
    );
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return { updated: false };
    throw e;
  }
  if (!result || !result.affectedRows) return { updated: false };

  const oid = cur.order_id != null ? parseInt(String(cur.order_id), 10) : NaN;
  if (Number.isFinite(oid) && oid > 0) {
    try {
      await updateMtOrderStatusIfDeliveryComplete(pool, oid, 'declined');
    } catch (_) {
      /* optional */
    }
  }

  const actor = actorFromHistoryRow(historyRow);
  const payload = foodTaskNotifyFromStatus(
    tid,
    cur.order_id,
    cur.task_description != null ? String(cur.task_description) : '',
    'declined',
    actor
  );
  if (payload) notifyAllDashboardAdminsFireAndForget(pool, { ...payload, activityAt: historyRow.date_created || null });

  return { updated: true };
}

module.exports = { syncMtDriverTaskFromDeclineHistory };
