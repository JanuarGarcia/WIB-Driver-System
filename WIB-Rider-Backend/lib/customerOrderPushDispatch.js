/**
 * Server-to-server: tell the customer API to send FCM for order updates (same as ops dispatch-order; URL from customerDispatchOrderUrl).
 * Env: CUSTOMER_API_BASE_URL (or WIBEATS_API_BASE_URL), PUSH_DISPATCH_SECRET
 */

'use strict';

const { insertMtMobile2PushLog } = require('./mtMobile2PushLogs');
const { fetchClientFcmTokenAndDeviceRef } = require('./customerFcmToken');
const {
  fetchMobile2DeviceRegContextForClient,
  fetchMtClientDisplayName,
  resolvePushLogTriggerId,
} = require('./mobile2DeviceRegLookup');
const { normalizeFoodTaskStatusKey } = require('./dashboardRiderNotify');

const COPY_RIDER_ASSIGNED = {
  title: 'DELIVERY REQUEST RECEIVED',
  message: 'Your order has been matched with a rider. Mapanen idjay restaurant to prepare your pickup.',
};

const COPY_DRIVER_STARTED = {
  title: 'DELIVERY DRIVER STARTED',
  message: 'Our rider has picked up your food and is now traveling towards your location. Konting pasensya lang kabsat.',
};

const COPY_DRIVER_IN_PROGRESS = {
  title: 'DELIVERY IN PROGRESS',
  message: 'Your rider is en route with your order. You can follow updates anytime in the app.',
};

const COPY_DRIVER_ARRIVED = {
  title: 'DELIVERY DRIVER ARRIVED',
  message:
    'Our rider is near your location. Konting kembot nalang kakain na, para ready nalang po ng cash or proof of online payment. Labyu!',
};

const COPY_ACKNOWLEDGED = {
  title: 'DELIVERY REQUEST RECEIVED',
  message: 'Our rider has accepted your order. Mapanen idjay restaurant',
};

const COPY_COMPLETE = {
  title: 'DELIVERY SUCCESSFUL',
  message:
    "Thank you for supporting our rider via WhenInBaguio app. Each order contributes significantly to the welfare of our rider's family.",
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
  return c === 'inprogress';
}

function statusImpliesStarted(raw) {
  const c = compactStatusKey(raw);
  return c === 'started';
}

function statusImpliesAcknowledged(raw) {
  const c = compactStatusKey(raw);
  return c === 'acknowledged' || c === 'accepted' || c === 'accept' || c === 'assigned' || c === 'new';
}

function statusImpliesComplete(raw) {
  const c = compactStatusKey(raw);
  return c === 'successful' || c === 'delivered' || c === 'completed';
}

/**
 * Stages for old customer app pushes: `started` and `inprogress` are separate (distinct notifications).
 * ready_for_pickup / picked up / en-route phrases do not reuse started or inprogress copy (return `other`).
 *
 * @param {unknown} raw
 * @returns {'prep'|'started_only'|'in_progress_only'|'underway_arrived'|'complete'|'negative'|'other'}
 */
function stageForCustomerFoodStatusPush(raw) {
  const norm = normalizeFoodTaskStatusKey(raw);
  const n = String(norm || '').toLowerCase().trim();
  const c = compactStatusKey(raw);
  if (!n) return 'other';
  if (n === 'successful' || n === 'delivered' || n === 'completed' || n === 'complete') return 'complete';
  if (
    n === 'cancelled' ||
    n === 'canceled' ||
    n === 'unassigned' ||
    n === 'declined' ||
    n === 'failed' ||
    n === 'rejected'
  ) {
    return 'negative';
  }
  if (n === 'acknowledged' || n === 'assigned' || n === 'new') return 'prep';
  if (c === 'verification' || c === 'pendingverification') return 'underway_arrived';
  if (c.includes('arrived') || (c.includes('reached') && c.includes('destination'))) return 'underway_arrived';
  if (n === 'started') return 'started_only';
  if (n === 'inprogress' || n === 'in_progress') return 'in_progress_only';
  return 'other';
}

/**
 * Buckets aligned with {@link normalizeFoodTaskStatusKey} so rider milestones like
 * ready_for_pickup / en-route phrases trigger customer dispatch (mobile v2), not only started/inprogress.
 *
 * @param {unknown} raw
 * @returns {'prep'|'underway'|'complete'|'negative'|'other'}
 */
function bucketForCustomerFoodStatusPush(raw) {
  const norm = normalizeFoodTaskStatusKey(raw);
  const n = String(norm || '').toLowerCase().trim();
  if (!n) return 'other';
  if (n === 'successful' || n === 'delivered' || n === 'completed' || n === 'complete') return 'complete';
  if (
    n === 'cancelled' ||
    n === 'canceled' ||
    n === 'unassigned' ||
    n === 'declined' ||
    n === 'failed' ||
    n === 'rejected'
  ) {
    return 'negative';
  }
  if (n === 'acknowledged' || n === 'assigned' || n === 'new') return 'prep';
  if (n === 'started' || n === 'inprogress' || n === 'in_progress') return 'underway';
  if (n === 'ready_for_pickup' || n === 'readyforpickup' || n === 'readypickup') return 'underway';
  if (n === 'verification' || n === 'pending_verification') return 'underway';
  const c = n.replace(/_/g, '');
  if (c.includes('pickedup') || (c.includes('picked') && c.includes('up'))) return 'underway';
  if (c.includes('outfor') || c.includes('outfordelivery')) return 'underway';
  if (c.includes('heading') && (c.includes('customer') || c.includes('dropoff'))) return 'underway';
  return 'other';
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

/** Strip one layer of surrounding quotes (some host panels store env values quoted). */
function trimEnvSecret(raw) {
  let v = String(raw || '').trim();
  if (v.length >= 2) {
    const a = v[0];
    const b = v[v.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}

/**
 * Full URL for customer POST /api/push/dispatch-order (same contract as ops).
 * If base already ends with /api (e.g. https://host/mobileappv2/api), append /push/dispatch-order only.
 */
function customerDispatchOrderUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.toLowerCase().endsWith('/api')) {
    return `${base}/push/dispatch-order`;
  }
  return `${base}/api/push/dispatch-order`;
}

function getCustomerDispatchConfig() {
  const customerRaw = process.env.CUSTOMER_API_BASE_URL;
  const legacyRaw = process.env.WIBEATS_API_BASE_URL;
  const pickedRaw = customerRaw != null && String(customerRaw).trim() !== '' ? customerRaw : legacyRaw;

  const baseUrl = String(pickedRaw || '')
    .trim()
    .replace(/\/+$/, '');

  const baseUrlSource =
    customerRaw != null && String(customerRaw).trim() !== ''
      ? 'CUSTOMER_API_BASE_URL'
      : legacyRaw != null && String(legacyRaw).trim() !== ''
        ? 'WIBEATS_API_BASE_URL'
        : 'none';

  const secret = trimEnvSecret(process.env.PUSH_DISPATCH_SECRET);
  const hasSecret = Boolean(secret && String(secret).trim());

  const ok = Boolean(baseUrl && hasSecret);
  const reason = !baseUrl ? 'missing_base_url' : !hasSecret ? 'missing_secret' : null;

  return { baseUrl, baseUrlSource, secret, hasSecret, ok, reason };
}

/**
 * Diagnostics helper for production: returns *effective* config without exposing secrets.
 * @returns {{ baseUrl: string, baseUrlSource: string, ok: boolean, reason: string|null, hasSecret: boolean, dispatchUrl: string }}
 */
function diagnoseCustomerDispatchConfig() {
  const cfg = getCustomerDispatchConfig();
  return {
    baseUrl: cfg.baseUrl,
    baseUrlSource: cfg.baseUrlSource,
    ok: cfg.ok,
    reason: cfg.reason,
    hasSecret: cfg.hasSecret,
    dispatchUrl: customerDispatchOrderUrl(cfg.baseUrl),
  };
}

/**
 * Customer dispatch-order often returns HTTP 200 with JSON like
 * `{ success:true, sent:0, skipped:"no_fcm_tokens" }` — treat as non-delivery for logging / warnings.
 *
 * @param {string} text
 * @returns {{ deliveryOk: boolean, fcmSent: number|null, customerSkipped: string|null }}
 */
function interpretCustomerDispatchResponseBody(text) {
  const raw = String(text || '').trim();
  if (!raw) return { deliveryOk: true, fcmSent: null, customerSkipped: null };
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.success === false) {
      return { deliveryOk: false, fcmSent: 0, customerSkipped: j.skipped != null ? String(j.skipped) : 'success_false' };
    }
    const sent = j.sent;
    const tokensTried = j.tokens_tried;
    let sentN = null;
    if (typeof sent === 'number' && Number.isFinite(sent)) sentN = sent;
    else if (sent != null && String(sent).trim() !== '' && Number.isFinite(Number(sent))) sentN = Number(sent);
    if (sentN !== null) {
      return {
        deliveryOk: sentN > 0,
        fcmSent: sentN,
        customerSkipped: j.skipped != null ? String(j.skipped) : null,
      };
    }
    let triedN = null;
    if (typeof tokensTried === 'number' && Number.isFinite(tokensTried)) triedN = tokensTried;
    else if (tokensTried != null && String(tokensTried).trim() !== '' && Number.isFinite(Number(tokensTried))) {
      triedN = Number(tokensTried);
    }
    if (triedN !== null && triedN === 0 && j.skipped) {
      return { deliveryOk: false, fcmSent: 0, customerSkipped: String(j.skipped) };
    }
    return { deliveryOk: true, fcmSent: null, customerSkipped: j.skipped != null ? String(j.skipped) : null };
  } catch (_) {
    return { deliveryOk: true, fcmSent: null, customerSkipped: null };
  }
}

/**
 * @param {{ clientId: number, orderId: number, title: string, message: string }} args
 * @returns {Promise<{ ok?: boolean, skipped?: string, status?: number, body?: string, error?: string, httpOk?: boolean, fcmSent?: number|null, customerSkipped?: string|null }>}
 */
async function postCustomerDispatchOrder({ clientId, orderId, title, message, pushType }) {
  const { baseUrl, baseUrlSource, secret, ok, reason } = getCustomerDispatchConfig();
  if (!ok) {
    return {
      ok: false,
      skipped: reason || 'not_configured',
      baseUrl,
      baseUrlSource,
      dispatchUrl: customerDispatchOrderUrl(baseUrl),
    };
  }

  const oid = parseInt(String(orderId), 10);
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(oid) || oid <= 0 || !Number.isFinite(cid) || cid <= 0) {
    return { skipped: 'invalid_ids' };
  }

  const url = customerDispatchOrderUrl(baseUrl);
  const body = JSON.stringify({
    client_id: String(cid),
    order_id: String(oid),
    title: String(title || 'Order update').trim() || 'Order update',
    message: String(message != null ? message : '').trim(),
    type: String(pushType || 'order_update').trim() || 'order_update',
    push_type: String(pushType || 'order_update').trim() || 'order_update',
    show_popup: 1,
    popup_enabled: true,
    popup_title: String(title || 'Order update').trim() || 'Order update',
    popup_message: String(message != null ? message : '').trim(),
    popup_type: String(pushType || 'order_update').trim() || 'order_update',
    local_notification_title: String(title || 'Order update').trim() || 'Order update',
    local_notification_body: String(message != null ? message : '').trim(),
    local_notification_type: String(pushType || 'order_update').trim() || 'order_update',
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
      return { ok: false, status: res.status, body: text, httpOk: false, baseUrl, baseUrlSource, dispatchUrl: url };
    }
    const interp = interpretCustomerDispatchResponseBody(text);
    return {
      ok: interp.deliveryOk,
      status: res.status,
      body: text,
      httpOk: true,
      fcmSent: interp.fcmSent,
      customerSkipped: interp.customerSkipped,
      baseUrl,
      baseUrlSource,
      dispatchUrl: url,
    };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : e.message || String(e);
    return { ok: false, error: msg, baseUrl, baseUrlSource, dispatchUrl: url };
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
    http_ok: result.httpOk === true,
    fcm_sent: result.fcmSent != null ? result.fcmSent : undefined,
    customer_skipped: result.customerSkipped || undefined,
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
 *   dispatchResult: { ok?: boolean, status?: number, body?: string, error?: string, httpOk?: boolean, fcmSent?: number|null, customerSkipped?: string|null },
 * }} meta
 */
async function recordDispatchOrderPushLog(pool, meta) {
  const { clientId, orderId, taskId, pushKind, title, message, dispatchResult } = meta;
  try {
    const [m2, triggerIdRaw, nameFallback] = await Promise.all([
      fetchMobile2DeviceRegContextForClient(pool, clientId),
      resolvePushLogTriggerId(pool, orderId),
      fetchMtClientDisplayName(pool, clientId),
    ]);
    const legacy = await fetchClientFcmTokenAndDeviceRef(pool, 'mt_client', clientId);
    const token =
      (m2.deviceId && String(m2.deviceId).trim()) || (legacy.token && String(legacy.token).trim()) || null;
    const deviceRef =
      (m2.installUuid && String(m2.installUuid).trim()) ||
      (legacy.deviceRef && String(legacy.deviceRef).trim()) ||
      null;
    const devicePlatform = m2.devicePlatform && String(m2.devicePlatform).trim() ? m2.devicePlatform : null;
    const clientName =
      (m2.clientFullName && String(m2.clientFullName).trim()) ||
      (nameFallback && String(nameFallback).trim()) ||
      null;

    const ok = dispatchResult.ok === true;
    const jsonResponse = JSON.stringify({
      source: 'rider_backend_dispatch_order',
      order_id: orderId,
      task_id: taskId,
      push: pushKind,
      show_popup: 1,
      popup_enabled: true,
      popup_title: title,
      popup_message: message,
      popup_type: pushKind,
      local_notification_title: title,
      local_notification_body: message,
      local_notification_type: pushKind,
      base_url: dispatchResult.baseUrl ?? null,
      base_url_source: dispatchResult.baseUrlSource ?? null,
      dispatch_url: dispatchResult.dispatchUrl ?? null,
      skipped: dispatchResult.skipped ?? null,
      http_status: dispatchResult.status ?? null,
      http_ok: dispatchResult.httpOk === true,
      ok,
      fcm_sent: dispatchResult.fcmSent != null ? dispatchResult.fcmSent : null,
      customer_skipped: dispatchResult.customerSkipped ?? null,
      error: dispatchResult.error || null,
      body_snippet:
        dispatchResult.body != null ? String(dispatchResult.body).slice(0, 2000) : null,
    });
    await insertMtMobile2PushLog(pool, {
      clientId,
      deviceId: token ? token.slice(0, 512) : null,
      deviceUiid: deviceRef ? deviceRef.slice(0, 255) : null,
      clientName,
      devicePlatform,
      triggerId: triggerIdRaw,
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
  const prevRaw = ctx.prevDriverId;
  const nextRaw = ctx.newDriverId;
  const prevId = prevRaw != null && String(prevRaw).trim() !== '' ? parseInt(String(prevRaw), 10) : 0;
  const nextId = nextRaw != null && String(nextRaw).trim() !== '' ? parseInt(String(nextRaw), 10) : 0;
  // Send when assignment truly changes (unassigned->assigned OR reassigned to another driver).
  if (Number.isFinite(prevId) && Number.isFinite(nextId) && prevId > 0 && nextId > 0 && prevId === nextId) return;
  if (!Number.isFinite(nextId) || nextId <= 0) return;

  const oid = ctx.orderId != null ? parseInt(String(ctx.orderId), 10) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return;

  const cfg = getCustomerDispatchConfig();
  if (!cfg.baseUrl) return;

  (async () => {
    const logBase = { task_id: taskId, order_id: oid, push: 'rider_assigned', prev_driver_id: prevId, new_driver_id: nextId };
    try {
      const clientId = await fetchFoodOrderClientId(pool, oid);
      if (!clientId) return;

      const result = await postCustomerDispatchOrder({
        clientId,
        orderId: oid,
        title: COPY_RIDER_ASSIGNED.title,
        message: COPY_RIDER_ASSIGNED.message,
        pushType: 'rider_assigned',
      });
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
 * Customer order pushes: prep, started-only, inprogress-only, arrived, complete — one dispatch per transition into each stage.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ taskId: number, orderId: unknown, prevStatusRaw: unknown, newStatusRaw: unknown }} ctx
 */
function notifyCustomerFoodTaskStatusPushFireAndForget(pool, ctx) {
  const taskId = ctx.taskId;
  const prev = ctx.prevStatusRaw;
  const next = ctx.newStatusRaw;

  const prevS = stageForCustomerFoodStatusPush(prev);
  const nextS = stageForCustomerFoodStatusPush(next);

  let pushKind = null;
  if (nextS === 'prep' && prevS !== 'prep' && prevS !== 'negative') {
    pushKind = 'acknowledged';
  } else if (nextS === 'started_only' && prevS !== 'started_only' && prevS !== 'complete' && prevS !== 'negative') {
    pushKind = 'driver_started';
  } else if (
    nextS === 'in_progress_only' &&
    prevS !== 'in_progress_only' &&
    prevS !== 'complete' &&
    prevS !== 'negative'
  ) {
    pushKind = 'in_progress';
  } else if (nextS === 'underway_arrived' && prevS !== 'underway_arrived' && prevS !== 'complete' && prevS !== 'negative') {
    pushKind = 'driver_arrived';
  } else if (nextS === 'complete' && prevS !== 'complete' && prevS !== 'negative') {
    pushKind = 'complete';
  }
  if (!pushKind) return;

  const oid = ctx.orderId != null ? parseInt(String(ctx.orderId), 10) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return;

  const cfg = getCustomerDispatchConfig();
  if (!cfg.baseUrl) return;

  const copy =
    pushKind === 'acknowledged'
      ? COPY_ACKNOWLEDGED
      : pushKind === 'driver_started'
        ? COPY_DRIVER_STARTED
        : pushKind === 'in_progress'
          ? COPY_DRIVER_IN_PROGRESS
          : pushKind === 'driver_arrived'
            ? COPY_DRIVER_ARRIVED
            : COPY_COMPLETE;

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
        pushType: pushKind,
      });
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
  customerDispatchOrderUrl,
  interpretCustomerDispatchResponseBody,
  bucketForCustomerFoodStatusPush,
  postCustomerDispatchOrder,
  notifyCustomerRiderAssignedForFoodTaskFireAndForget,
  notifyCustomerFoodTaskStatusPushFireAndForget,
  statusImpliesAcknowledged,
  statusImpliesStarted,
  statusImpliesInProgress,
  statusImpliesComplete,
  diagnoseCustomerDispatchConfig,
};
