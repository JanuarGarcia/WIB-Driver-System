/**
 * Server-to-server: tell the customer API to send FCM for order updates (same as ops POST /api/push/dispatch-order).
 * Env: CUSTOMER_API_BASE_URL (or WIBEATS_API_BASE_URL), PUSH_DISPATCH_SECRET
 */

'use strict';

function isEffectivelyUnassignedDriverId(driverId) {
  if (driverId == null || driverId === '') return true;
  const n = parseInt(String(driverId), 10);
  return !Number.isFinite(n) || n <= 0;
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
 * @param {{ clientId: number, orderId: number }} args
 * @returns {Promise<{ ok?: boolean, skipped?: string, status?: number, body?: string, error?: string }>}
 */
async function postCustomerDispatchOrder({ clientId, orderId }) {
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
    title: 'Rider assigned',
    message: 'A rider has been assigned to your order.',
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

/**
 * After mt_driver_task is assigned to a rider: notify food-order customer once (unassigned → assigned only).
 * Never throws; logs failures. Skips if env not set, no order_id, guest client, or HTTP error.
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
    const logBase = { task_id: taskId, order_id: oid };
    try {
      const clientId = await fetchFoodOrderClientId(pool, oid);
      if (!clientId) return;

      const result = await postCustomerDispatchOrder({ clientId, orderId: oid });
      if (result.skipped) return;
      if (!result.ok) {
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
};
