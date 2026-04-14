'use strict';

const { normalizeFoodTaskStatusKey } = require('./dashboardRiderNotify');
const { safeSendRiderOrderPush } = require('../services/riderOrderPushService');

function orderIdNum(orderId) {
  const n = parseInt(String(orderId), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function driverIdNum(driverId) {
  const n = parseInt(String(driverId), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fireAndForget(promise) {
  promise.catch((e) => console.warn('[rider_order_push]', e.message || e));
}

/**
 * After admin assigns or reassigns a rider on a food task (mt_driver_task).
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ orderId: unknown, prevDriverId: unknown, newDriverId: unknown }} ctx
 */
function notifyRiderOrderPushAfterAdminAssignFireAndForget(pool, ctx) {
  void pool;
  const oid = orderIdNum(ctx.orderId);
  const newId = driverIdNum(ctx.newDriverId);
  if (!oid || !newId) return;

  const prevId = driverIdNum(ctx.prevDriverId);
  if (prevId && prevId === newId) return;
  const prevOk = prevId != null && prevId > 0;
  const eventKey =
    prevOk && prevId !== newId ? 'RIDER_REASSIGNED' : 'RIDER_ORDER_ASSIGNED';

  fireAndForget(
    safeSendRiderOrderPush({
      orderId: oid,
      driverId: newId,
      eventKey,
      remarks: null,
      orderStatus: 'assigned',
    })
  );
}

/**
 * After task status changes (admin dashboard or rider app).
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ orderId: unknown, driverId: unknown, prevStatus: unknown, newStatus: unknown }} ctx
 */
function notifyRiderOrderPushAfterTaskStatusFireAndForget(pool, ctx) {
  void pool;
  const oid = orderIdNum(ctx.orderId);
  if (!oid) return;

  const driverId = driverIdNum(ctx.driverId);
  const prevS = normalizeFoodTaskStatusKey(ctx.prevStatus);
  const nextS = normalizeFoodTaskStatusKey(ctx.newStatus);

  if ((nextS === 'cancelled' || nextS === 'unassigned') && driverId) {
    fireAndForget(
      safeSendRiderOrderPush({
        orderId: oid,
        driverId,
        eventKey: 'RIDER_ORDER_CANCELLED',
        remarks: String(ctx.newStatus != null ? ctx.newStatus : ''),
        orderStatus: String(nextS),
      })
    );
    return;
  }

  if (!driverId) return;

  if (nextS === 'ready_for_pickup' && prevS !== 'ready_for_pickup') {
    fireAndForget(
      safeSendRiderOrderPush({
        orderId: oid,
        driverId,
        eventKey: 'RIDER_READY_FOR_PICKUP',
        remarks: null,
        orderStatus: String(ctx.newStatus != null ? ctx.newStatus : ''),
      })
    );
    return;
  }

  const terminal = new Set(['unassigned', 'cancelled', 'canceled', 'declined', 'failed']);
  if (terminal.has(nextS)) return;
  if (prevS === nextS) return;

  fireAndForget(
    safeSendRiderOrderPush({
      orderId: oid,
      driverId,
      eventKey: 'RIDER_DELIVERY_UPDATED',
      remarks: `${prevS} → ${nextS}`,
      orderStatus: String(ctx.newStatus != null ? ctx.newStatus : ''),
    })
  );
}

module.exports = {
  notifyRiderOrderPushAfterAdminAssignFireAndForget,
  notifyRiderOrderPushAfterTaskStatusFireAndForget,
};
