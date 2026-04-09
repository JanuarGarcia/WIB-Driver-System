/**
 * Server-to-server: tell the customer API to send FCM for order updates (same as ops POST /api/push/dispatch-order).
 * Env: CUSTOMER_API_BASE_URL (or WIBEATS_API_BASE_URL), PUSH_DISPATCH_SECRET
 */

'use strict';

const { insertMtMobile2PushLog } = require('./mtMobile2PushLogs');
const { fetchClientFcmTokenAndDeviceRef } = require('./customerFcmToken');

const COPY_RIDER_ASSIGNED = {
  title: 'Rider assigned',
  message: 'Your order now has a dedicated rider and will be on its way shortly.',
};

const COPY_IN_PROGRESS = {
  title: 'Delivery in progress',
  message: 'Your rider is en route with your order. You can follow updates anytime in the app.',
};

const COPY_COMPLETE = {
  title: 'Order complete',
  message: 'Your delivery has been completed. Thank you for choosing us—we hope you enjoy your meal.',
};

function isEffectivelyUnassignedDriverId(driverId) {
  if (driverId == null || driverId === '') return true;
  const n = parseInt(String(driverId), 10);
  return !Number.isFinite(n) || n <= 0;
}

/** Normalize status for bucket checks (spaces, underscores, hyphens). */
function compactStatusKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, '');
}

function statusImpliesInProgress(raw) {
  const c = compactStatusKey(raw);
  return c === 'started' || c === 'inprogress';
}

function statusImpliesComplete(raw) {
  const c = compactStatusKey(raw);
  return c === 'successful' || c === 'delivered' || c === 'completed';
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number|string} orderId
 * @returns {Promise<number|null>}
 */
async function fetchFoodOrderClientId(pool, orderId) {
  const oid = parseInt(String(orderId), 10);
  if (!Number.isFinite(oid) || oid <= 0) return null;
  try {
    const [[row]] = await pool.query('SELECT client_id FROM mt_order WHERE order_id = ? LIMIT 1', [oid]);
    if (!row) return null;
    const cid = row.client_id != null ? parseInt(String(row.client_id), 10) : NaN;
    return Number.isFinite(cid) && cid > 0 ? cid : null;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return null;
    throw e;
  }
}

function getCustomerDispatchConfig() {
  const baseUrl = String(process.env.CUSTOMER_API_BASE_URL || process.env.WIBEATS_API_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const secret = String(process.env.PUSH_DISPATCH_SECRET || '').trim();
  return { baseUrl, secret, ok: Boolean(baseUrl && secret) };
}

/**
 * @param {{ clientId: number, orderId: number, title: string, message: string }} args
 * @returns {Promise<{ ok?: boolean, skipped?: string, status?: number, body?: string, error?: string }>}
 */
async function postCustomerDispatchOrder({ clientId, orderId, title, message }) {
  const { baseUrl, secret, ok } = getCustomerDispatchConfig();
  if (!ok) return { skipped: 'not_configured' };

  const oid = parseInt(String(orderId), 10);
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(oid) || oid <= 0 || !Number.isFinite(cid) || cid <= 0) {
    return { skipped: 'invalid_ids' };
  }

  const url = `${baseUrl}/api/push/dispatch-order`;
  const body = JSON.stringify({
    client_id: String(cid),
    order_id: String(oid),
    title: String(title || 'Order update').trim() || 'Order update',
    message: String(message != null ? message : '').trim(),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Push-Dispatch-Secret': secret,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, body: text };
    }
    return { ok: true, status: res.status, body: text };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : e.message || String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

function logDispatchFailure(logBase, clientId, result) {
  const snippet =
    result.body != null
      ? String(result.body).slice(0, 500)
      : result.error != null
        ? String(result.error)
        : '';
  console.warn('[customer_order_push] dispatch failed', {
    ...logBase,
    client_id: clientId,
    http_status: result.status,
    detail: snippet,
  });
}

/**
 * Mirror ops: each rider-triggered order dispatch is recorded in mt_mobile2_push_logs (push_type order).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {{
 *   clientId: number,
 *   orderId: number,
 *   taskId: number,
 *   pushKind: string,
 *   title: string,
 *   message: string,
 *   dispatchResult: { ok?: boolean, status?: number, body?: string, error?: string },
 * }} meta
 */
async function recordDispatchOrderPushLog(pool, meta) {
  const { clientId, orderId, taskId, pushKind, title, message, dispatchResult } = meta;
  try {
    const { token, deviceRef } = await fetchClientFcmTokenAndDeviceRef(pool, 'mt_client', clientId);
    const ok = dispatchResult.ok === true;
    const jsonResponse = JSON.stringify({
      source: 'rider_backend_dispatch_order',
      order_id: orderId,
      task_id: taskId,
      push: pushKind,
      http_status: dispatchResult.status ?? null,
      ok,
      error: dispatchResult.error || null,
      body_snippet:
        dispatchResult.body != null ? String(dispatchResult.body).slice(0, 2000) : null,
    });
    await insertMtMobile2PushLog(pool, {
      clientId,
      deviceId: token ? token.slice(0, 512) : null,
      deviceUiid: deviceRef ? deviceRef.slice(0, 255) : null,
      title,
      body: message,
      pushType: 'order',
      status: ok ? 'sent' : 'failed',
      jsonResponse: jsonResponse.slice(0, 65000),
    });
  } catch (e) {
    console.warn('[customer_order_push] mt_mobile2_push_logs insert failed', e.message || String(e));
  }
}

/**
 * After mt_driver_task is assigned to a rider: notify food-order customer once (unassigned → assigned only).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ taskId: number, orderId: unknown, prevDriverId: unknown }} ctx
 */
function notifyCustomerRiderAssignedForFoodTaskFireAndForget(pool, ctx) {
  const taskId = ctx.taskId;
  if (!isEffectivelyUnassignedDriverId(ctx.prevDriverId)) return;

  const oid = ctx.orderId != null ? parseInt(String(ctx.orderId), 10) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return;

  if (!getCustomerDispatchConfig().ok) return;

  (async () => {
    const logBase = { task_id: taskId, order_id: oid, push: 'rider_assigned' };
    try {
      const clientId = await fetchFoodOrderClientId(pool, oid);
      if (!clientId) return;

      const result = await postCustomerDispatchOrder({
        clientId,
        orderId: oid,
        title: COPY_RIDER_ASSIGNED.title,
        message: COPY_RIDER_ASSIGNED.message,
      });
      if (result.skipped) return;
      if (!result.ok) logDispatchFailure(logBase, clientId, result);
      await recordDispatchOrderPushLog(pool, {
        clientId,
        orderId: oid,
        taskId,
        pushKind: 'rider_assigned',
        title: COPY_RIDER_ASSIGNED.title,
        message: COPY_RIDER_ASSIGNED.message,
        dispatchResult: result,
      });
    } catch (e) {
      console.warn('[customer_order_push] unexpected', { ...logBase, err: e.message || String(e) });
    }
  })();
}

/**
 * In-progress (started / in progress) and completion pushes — once per transition into each bucket.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ taskId: number, orderId: unknown, prevStatusRaw: unknown, newStatusRaw: unknown }} ctx
 */
function notifyCustomerFoodTaskStatusPushFireAndForget(pool, ctx) {
  const taskId = ctx.taskId;
  const prev = ctx.prevStatusRaw;
  const next = ctx.newStatusRaw;

  let pushKind = null;
  if (statusImpliesInProgress(next) && !statusImpliesInProgress(prev)) {
    pushKind = 'in_progress';
  } else if (statusImpliesComplete(next) && !statusImpliesComplete(prev)) {
    pushKind = 'complete';
  }
  if (!pushKind) return;

  const oid = ctx.orderId != null ? parseInt(String(ctx.orderId), 10) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return;

  if (!getCustomerDispatchConfig().ok) return;

  const copy = pushKind === 'in_progress' ? COPY_IN_PROGRESS : COPY_COMPLETE;

  (async () => {
    const logBase = { task_id: taskId, order_id: oid, push: pushKind };
    try {
      const clientId = await fetchFoodOrderClientId(pool, oid);
      if (!clientId) return;

      const result = await postCustomerDispatchOrder({
        clientId,
        orderId: oid,
        title: copy.title,
        message: copy.message,
      });
      if (result.skipped) return;
      if (!result.ok) logDispatchFailure(logBase, clientId, result);
      await recordDispatchOrderPushLog(pool, {
        clientId,
        orderId: oid,
        taskId,
        pushKind,
        title: copy.title,
        message: copy.message,
        dispatchResult: result,
      });
    } catch (e) {
      console.warn('[customer_order_push] unexpected', { ...logBase, err: e.message || String(e) });
    }
  })();
}

module.exports = {
  isEffectivelyUnassignedDriverId,
  fetchFoodOrderClientId,
  postCustomerDispatchOrder,
  notifyCustomerRiderAssignedForFoodTaskFireAndForget,
  notifyCustomerFoodTaskStatusPushFireAndForget,
  statusImpliesInProgress,
  statusImpliesComplete,
};
