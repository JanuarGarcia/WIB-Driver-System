/**
 * When another system writes mt_order_history (e.g. status "decline"/"cancel"), align mt_driver_task.status
 * so the rider dashboard buckets match the activity timeline.
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

function statusForTimelineCategory(cat) {
  const c = String(cat || '').toLowerCase().trim();
  if (c === 'declined') return 'declined';
  if (c === 'cancelled' || c === 'canceled') return 'cancelled';
  return null;
}

function normalizeHistoryBlobKey(v) {
  return String(v || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

function rowLooksLikeActiveResetAfterTerminal(row) {
  const cat = String(classifyTimelineHistoryForDashboardNotify(row) || '')
    .toLowerCase()
    .trim();
  if (cat === 'accepted' || cat === 'ready_for_pickup' || cat === 'preparing' || cat === 'started' || cat === 'inprogress' || cat === 'created') {
    return true;
  }

  const keys = [row && row.status, row && row.description, row && row.remarks, row && row.reason, row && row.notes]
    .map(normalizeHistoryBlobKey)
    .filter(Boolean);

  return keys.some(
    (key) =>
      key === 'new' ||
      key === 'created' ||
      key === 'queued' ||
      key === 'unassigned' ||
      key === 'assigned' ||
      key === 'acknowledged' ||
      key === 'accepted' ||
      key === 'accept' ||
      key === 'driverassigned' ||
      key === 'orderassigned' ||
      key === 'started' ||
      key === 'inprogress' ||
      key === 'preparing' ||
      key === 'readyforpickup' ||
      key === 'readypickup' ||
      key.includes('reassigned')
  );
}

function historyRowComesAfter(candidate, reference) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (!reference || typeof reference !== 'object') return true;

  const refTime = reference.date_created ? new Date(reference.date_created).getTime() : NaN;
  const candTime = candidate.date_created ? new Date(candidate.date_created).getTime() : NaN;
  if (Number.isFinite(refTime) && Number.isFinite(candTime) && candTime !== refTime) return candTime > refTime;

  const refId = reference.id != null ? Number(reference.id) : NaN;
  const candId = candidate.id != null ? Number(candidate.id) : NaN;
  if (Number.isFinite(refId) && Number.isFinite(candId) && candId !== refId) return candId > refId;

  if (Number.isFinite(refTime) && !Number.isFinite(candTime)) return false;
  if (!Number.isFinite(refTime) && Number.isFinite(candTime)) return true;
  if (Number.isFinite(refId) && !Number.isFinite(candId)) return false;
  if (!Number.isFinite(refId) && Number.isFinite(candId)) return true;
  return false;
}

async function hasLaterActiveResetHistory(pool, taskId, historyRow) {
  try {
    const [rows] = await pool.query(
      `SELECT id, status, description, remarks, reason, notes, date_created
       FROM mt_order_history
       WHERE task_id = ?
       ORDER BY date_created ASC, id ASC`,
      [taskId]
    );
    for (const row of rows || []) {
      if (!historyRowComesAfter(row, historyRow)) continue;
      if (rowLooksLikeActiveResetAfterTerminal(row)) return true;
    }
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return false;
    throw e;
  }
  return false;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} taskId
 * @param {Record<string, unknown>} historyRow - raw or feed-shaped row for classifyTimelineHistoryForDashboardNotify
 * @returns {Promise<{ updated: boolean, status?: string }>}
 */
async function syncMtDriverTaskFromTerminalTimelineHistory(pool, taskId, historyRow) {
  const tid = Number(taskId);
  if (!Number.isFinite(tid) || tid <= 0) return { updated: false };
  const cat = classifyTimelineHistoryForDashboardNotify(historyRow);
  const target = statusForTimelineCategory(cat);
  if (!target) return { updated: false };
  if (await hasLaterActiveResetHistory(pool, tid, historyRow)) return { updated: false };

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
      'UPDATE mt_driver_task SET status = ?, date_modified = NOW() WHERE task_id = ?',
      [target, tid]
    );
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return { updated: false };
    throw e;
  }
  if (!result || !result.affectedRows) return { updated: false };

  const oid = cur.order_id != null ? parseInt(String(cur.order_id), 10) : NaN;
  if (Number.isFinite(oid) && oid > 0) {
    try {
      await updateMtOrderStatusIfDeliveryComplete(pool, oid, target);
    } catch (_) {
      /* optional */
    }
  }

  const actor = actorFromHistoryRow(historyRow);
  const payload = foodTaskNotifyFromStatus(
    tid,
    cur.order_id,
    cur.task_description != null ? String(cur.task_description) : '',
    target,
    actor
  );
  if (payload) notifyAllDashboardAdminsFireAndForget(pool, { ...payload, activityAt: historyRow.date_created || null });

  return { updated: true, status: target };
}

module.exports = { syncMtDriverTaskFromTerminalTimelineHistory };
