/**
 * Keep mt_order.status in sync with rider task milestones (rider app + dashboard).
 * Supports CEO-requested flow: Acknowledge -> Started -> Inprogress -> Successful.
 */

'use strict';

function compactTaskStatus(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, '');
}

function mapTaskStatusToMtOrderStatus(raw) {
  const c = compactTaskStatus(raw);
  if (!c) return null;
  if (c === 'acknowledged' || c === 'accept' || c === 'accepted') {
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
      return;
    }
    throw e;
  }
}

module.exports = {
  mapTaskStatusToMtOrderStatus,
  updateMtOrderStatusIfDeliveryComplete,
};
