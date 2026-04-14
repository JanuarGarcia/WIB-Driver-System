/**
 * Keep mt_order.status in sync with rider task milestones (rider app + dashboard).
 * Supports CEO-requested flow: Acknowledge -> Started -> Inprogress -> Successful.
 */

'use strict';

const { appendMtOrderStatusForLegacyAdmin } = require('./mtOrderLegacyStatsSync');

function compactTaskStatus(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, '');
}

function mapTaskStatusToMtOrderStatus(raw) {
  const c = compactTaskStatus(raw);
  if (!c) return null;
  if (c === 'acknowledged' || c === 'accept' || c === 'accepted' || c === 'assigned' || c === 'new') {
    return String(process.env.MT_ORDER_STATUS_ACKNOWLEDGED || 'Acknowledge').trim() || 'Acknowledge';
  }
  if (c === 'started') {
    return String(process.env.MT_ORDER_STATUS_STARTED || 'Started').trim() || 'Started';
  }
  if (c === 'inprogress') {
    return String(process.env.MT_ORDER_STATUS_INPROGRESS || 'Inprogress').trim() || 'Inprogress';
  }
  if (c === 'successful' || c === 'delivered' || c === 'completed') {
    return (
      String(process.env.MT_ORDER_STATUS_SUCCESSFUL || process.env.MT_ORDER_DELIVERED_STATUS || 'Successful').trim() ||
      'Successful'
    );
  }
  if (c === 'declined' || c === 'rejected' || c === 'reject') {
    return String(process.env.MT_ORDER_STATUS_DECLINED || 'Declined').trim() || 'Declined';
  }
  if (c === 'cancelled' || c === 'canceled') {
    return String(process.env.MT_ORDER_STATUS_CANCELLED || 'Cancel').trim() || 'Cancel';
  }
  if (c === 'failed') {
    return String(process.env.MT_ORDER_STATUS_FAILED || 'Failed').trim() || 'Failed';
  }
  return null;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} orderId
 * @param {unknown} taskStatusRaw - mt_driver_task.status after update
 * @returns {Promise<void>}
 */
async function updateMtOrderStatusIfDeliveryComplete(pool, orderId, taskStatusRaw) {
  if (!orderId || orderId <= 0) return;
  const status = mapTaskStatusToMtOrderStatus(taskStatusRaw);
  if (!status) return;

  try {
    await pool.query('UPDATE mt_order SET status = ? WHERE order_id = ?', [status, orderId]);
  } catch (e) {
    if (
      e.code === 'ER_BAD_FIELD_ERROR' ||
      e.errno === 1265 ||
      (e.message && /Data truncated|Incorrect.*enum/i.test(String(e.message)))
    ) {
      console.warn('[mt_order] status column update skipped:', e.message || String(e));
    } else {
      throw e;
    }
  }

  try {
    await appendMtOrderStatusForLegacyAdmin(pool, orderId, status);
  } catch (e) {
    console.warn('[mt_order_status] legacy stats_id sync skipped:', e.message || String(e));
  }
}

module.exports = {
  mapTaskStatusToMtOrderStatus,
  updateMtOrderStatusIfDeliveryComplete,
};
