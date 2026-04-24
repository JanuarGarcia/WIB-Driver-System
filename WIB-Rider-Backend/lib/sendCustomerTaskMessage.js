const { sendPushToFcmToken } = require('../services/fcm');
const { fetchClientFcmTokenAndDeviceRef } = require('./customerFcmToken');
const { insertMtMobile2PushLog } = require('./mtMobile2PushLogs');
const { fetchMobile2DeviceRegContextForClient } = require('./mobile2DeviceRegLookup');
const { deriveErrandDriverTaskStatus, isTerminal } = require('./errandDriverStatus');
const { fetchErrandLatestHistoryStatusByOrderIds } = require('./errandOrders');

/** @type {Map<string, number>} */
const rateLastSent = new Map();
/** Min interval between customer pushes per driver+task (notify + custom message share this bucket). */
const RATE_MS = 15_000;
const NOTIFY_BODY_MAX = 230;
const MESSAGE_MAX = 500;

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeVersionTokens(versionRaw) {
  return String(versionRaw || '')
    .trim()
    .split(/[.\-_+]/)
    .map((part) => {
      const n = parseInt(String(part), 10);
      return Number.isFinite(n) ? n : 0;
    });
}

function isVersionAtLeast(versionRaw, minVersionRaw) {
  const a = normalizeVersionTokens(versionRaw);
  const b = normalizeVersionTokens(minVersionRaw);
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

function isOutdatedVersionBlocked(appVersion) {
  if (envFlag('RIDER_APP_FORCE_COMPATIBILITY', true)) return null;

  const minVersion = String(process.env.RIDER_APP_MIN_SUPPORTED_VERSION || '').trim();
  if (!minVersion) return null;

  const appVersionNormalized = String(appVersion || '').trim();
  const allowUnknown = envFlag('RIDER_APP_ALLOW_UNKNOWN_VERSION', true);
  if (!appVersionNormalized) {
    return allowUnknown
      ? null
      : 'Please update your Rider app to continue';
  }

  if (isVersionAtLeast(appVersionNormalized, minVersion)) return null;

  const enforceAfterRaw = String(process.env.RIDER_APP_MIN_SUPPORTED_ENFORCE_AFTER || '').trim();
  if (!enforceAfterRaw) return null;
  const enforceAfter = new Date(enforceAfterRaw);
  if (Number.isNaN(enforceAfter.getTime())) return null;

  const graceDays = Math.max(0, envInt('RIDER_APP_VERSION_GRACE_DAYS', 14));
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  if (Date.now() < enforceAfter.getTime() + graceMs) return null;

  return `Please update your Rider app to at least version ${minVersion}`;
}

function pruneRateMap() {
  if (rateLastSent.size < 5000) return;
  const now = Date.now();
  for (const [k, t] of rateLastSent) {
    if (now - t > RATE_MS * 3) rateLastSent.delete(k);
  }
}

/**
 * @param {number} driverId
 * @param {string} scopeKey
 * @returns {boolean} true if allowed
 */
function allowRateLimit(driverId, scopeKey) {
  pruneRateMap();
  const k = `${driverId}:${scopeKey}`;
  const now = Date.now();
  const last = rateLastSent.get(k) || 0;
  if (now - last < RATE_MS) return false;
  rateLastSent.set(k, now);
  return true;
}

/**
 * Driver task status is "active delivery" for customer messaging (matches in-progress / en-route ladder).
 * @param {unknown} statusRaw
 */
function isStandardTaskInProgress(statusRaw) {
  const key = String(statusRaw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_/g, '');
  return (
    key === 'started' ||
    key === 'inprogress' ||
    key === 'verification' ||
    key === 'pendingverification'
  );
}

function errandOrderDriverId(row) {
  if (row.driver_id == null || String(row.driver_id).trim() === '') return null;
  const n = parseInt(String(row.driver_id), 10);
  return Number.isFinite(n) ? n : null;
}

async function resolveCustomerPushTarget(clientPool, clientTable, clientId) {
  const legacy = await fetchClientFcmTokenAndDeviceRef(clientPool, clientTable, clientId);

  if (clientTable === 'mt_client') {
    try {
      const mobile2 = await fetchMobile2DeviceRegContextForClient(clientPool, clientId);
      if (mobile2?.deviceId) {
        return {
          token: String(mobile2.deviceId).trim(),
          deviceRef: mobile2.installUuid ? String(mobile2.installUuid).trim() : legacy.deviceRef,
          devicePlatform: mobile2.devicePlatform ? String(mobile2.devicePlatform).trim() : null,
          source: 'mt_mobile2_device_reg',
        };
      }
    } catch (_) {}
  }

  return {
    token: legacy.token,
    deviceRef: legacy.deviceRef,
    devicePlatform: null,
    source: clientTable,
  };
}

function truncNotifyBody(s) {
  const t = String(s || '');
  if (t.length <= NOTIFY_BODY_MAX) return t;
  return `${t.slice(0, NOTIFY_BODY_MAX - 1)}…`;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('mysql2/promise').Pool} errandWibPool
 * @param {{ id: number }} driver
 * @param {Record<string, unknown>} body
 * @returns {Promise<{ err: string | null, details: Record<string, unknown> | null }>}
 */
async function sendCustomerTaskMessage(pool, errandWibPool, driver, body) {
  const b = body || {};
  const appVersion = b.app_version ?? b.appVersion;
  const versionBlockReason = isOutdatedVersionBlocked(appVersion);
  if (versionBlockReason) {
    return { err: versionBlockReason, details: null };
  }

  const taskIdRaw = parseInt(String(b.task_id ?? b.taskId ?? ''), 10);
  if (!Number.isFinite(taskIdRaw) || taskIdRaw === 0) {
    return { err: 'task_id required', details: null };
  }

  const message = String(b.message ?? '').trim();
  if (!message) return { err: 'message required', details: null };
  if (message.length > MESSAGE_MAX) return { err: `message must be at most ${MESSAGE_MAX} characters`, details: null };

  const pushTitle = String(b.push_title ?? b.pushTitle ?? '').trim();
  const pushMessage = String(b.push_message ?? b.pushMessage ?? '').trim();
  const pushType = String(b.push_type ?? b.pushType ?? '').trim();
  if (!pushTitle) return { err: 'push_title required', details: null };
  if (!pushMessage) return { err: 'push_message required', details: null };
  if (!pushType) return { err: 'push_type required', details: null };

  const orderIdBody = parseInt(String(b.order_id ?? b.orderId ?? ''), 10);
  const driverId = driver.id;

  /** @type {number|null} */
  let clientId = null;
  /** @type {number|null} */
  let standardOrderId = null;
  /** @type {number|null} */
  let errandOrderId = null;
  /** @type {number} app task_id including negative errand synthetic */
  let storedTaskId = taskIdRaw;
  /** @type {'mt_client' | 'st_client'} */
  let clientTable = 'mt_client';
  /** @type {import('mysql2/promise').Pool} */
  let clientPool = pool;

  if (taskIdRaw < 0) {
    const absSynthetic = Math.abs(taskIdRaw);
    const oid =
      Number.isFinite(orderIdBody) && orderIdBody > 0 ? orderIdBody : absSynthetic;
    if (!oid) return { err: 'order_id required for errand task', details: null };
    if (Number.isFinite(orderIdBody) && orderIdBody > 0 && orderIdBody !== absSynthetic) {
      return { err: 'order_id does not match errand task_id', details: null };
    }

    let row;
    try {
      const [[r]] = await errandWibPool.query('SELECT * FROM st_ordernew WHERE order_id = ? LIMIT 1', [oid]);
      row = r;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return { err: 'Errand orders unavailable', details: null };
      throw e;
    }
    if (!row) return { err: 'Task not found', details: null };
    const assigned = errandOrderDriverId(row);
    if (assigned !== driverId) {
      return { err: 'Task not found or not assigned to you', details: null };
    }

    const histMap = await fetchErrandLatestHistoryStatusByOrderIds(errandWibPool, [oid]);
    const latestHist = histMap.get(String(oid)) || null;
    const canonical = deriveErrandDriverTaskStatus(
      row.delivery_status,
      row.status ?? row.order_status,
      latestHist,
      assigned
    );
    if (isTerminal(canonical) || !isStandardTaskInProgress(canonical)) {
      return { err: 'Task is not in progress', details: null };
    }

    const cid = row.client_id != null ? parseInt(String(row.client_id), 10) : NaN;
    if (!Number.isFinite(cid) || cid <= 0) {
      return { err: 'Customer not found for this order', details: null };
    }
    clientId = cid;
    errandOrderId = oid;
    clientTable = 'st_client';
    clientPool = errandWibPool;

    if (!allowRateLimit(driverId, `e:${oid}`)) {
      return { err: 'Please wait before sending another message for this task', details: null };
    }
  } else {
    const tid = taskIdRaw;
    const [[task]] = await pool.query(
      'SELECT task_id, order_id, driver_id, status FROM mt_driver_task WHERE task_id = ? LIMIT 1',
      [tid]
    );
    if (!task || task.driver_id !== driverId) {
      return { err: 'Task not found or not assigned to you', details: null };
    }

    if (Number.isFinite(orderIdBody) && orderIdBody > 0) {
      const tOid = task.order_id != null ? parseInt(String(task.order_id), 10) : NaN;
      if (Number.isFinite(tOid) && tOid > 0 && tOid !== orderIdBody) {
        return { err: 'order_id does not match task', details: null };
      }
    }

    if (!isStandardTaskInProgress(task.status)) {
      return { err: 'Task is not in progress', details: null };
    }

    const oid = task.order_id != null ? parseInt(String(task.order_id), 10) : 0;
    if (!Number.isFinite(oid) || oid <= 0) {
      return { err: 'Order not linked to this task', details: null };
    }
    standardOrderId = oid;

    let orderRow;
    try {
      const [[or]] = await pool.query('SELECT client_id FROM mt_order WHERE order_id = ? LIMIT 1', [oid]);
      orderRow = or;
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        return { err: 'Order customer lookup unavailable', details: null };
      }
      throw e;
    }
    const cid = orderRow?.client_id != null ? parseInt(String(orderRow.client_id), 10) : NaN;
    if (!Number.isFinite(cid) || cid <= 0) {
      return { err: 'Customer not found for this order', details: null };
    }
    clientId = cid;

    if (!allowRateLimit(driverId, `m:${tid}`)) {
      return { err: 'Please wait before sending another message for this task', details: null };
    }
  }

  const { token: fcmToken, deviceRef, devicePlatform } = await resolveCustomerPushTarget(clientPool, clientTable, clientId);
  const notifyBody = truncNotifyBody(pushMessage);

  let messageId;
  try {
    const [ins] = await pool.query(
      `INSERT INTO mt_driver_customer_message
       (driver_id, client_id, task_id, order_id, errand_order_id, message_text, push_title, push_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [driverId, clientId, storedTaskId, standardOrderId, errandOrderId, message, pushTitle, pushType]
    );
    messageId = ins.insertId;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return {
        err: 'Message storage is not configured — run sql/mt_driver_customer_message.sql on the primary database',
        details: null,
      };
    }
    throw e;
  }

  const dataPayload = {
    push_type: pushType,
    type: pushType,
    task_id: String(storedTaskId),
    message_id: String(messageId),
    show_popup: '1',
    popup_enabled: 'true',
    popup_title: pushTitle,
    popup_message: notifyBody,
    popup_type: pushType,
    local_notification_title: pushTitle,
    local_notification_body: notifyBody,
    local_notification_type: pushType,
  };
  if (standardOrderId != null && standardOrderId > 0) {
    dataPayload.order_id = String(standardOrderId);
  }
  if (errandOrderId != null && errandOrderId > 0) {
    dataPayload.order_id = String(errandOrderId);
    dataPayload.errand_order_id = String(errandOrderId);
  }

  const pushResult = await sendPushToFcmToken(fcmToken, pushTitle, notifyBody, dataPayload, {
    useCustomerAndroidChannel: true,
  });

  const logJson = JSON.stringify({
    source: 'driver_customer_message',
    ok: pushResult.success,
    messageId: pushResult.messageId || null,
    error: pushResult.error || null,
    push_type: pushType,
    show_popup: 1,
    popup_enabled: true,
    popup_title: pushTitle,
    popup_message: notifyBody,
    popup_type: pushType,
    local_notification_title: pushTitle,
    local_notification_body: notifyBody,
    local_notification_type: pushType,
  });

  await insertMtMobile2PushLog(pool, {
    clientId,
    deviceId: fcmToken ? fcmToken.slice(0, 512) : null,
    deviceUiid: deviceRef ? deviceRef.slice(0, 255) : null,
    devicePlatform: devicePlatform ? devicePlatform.slice(0, 40) : null,
    title: pushTitle,
    body: notifyBody,
    pushType,
    status: pushResult.success ? 'sent' : 'failed',
    jsonResponse: logJson.slice(0, 65000),
  });

  if (!fcmToken) {
    return {
      err: null,
      details: {
        message_id: messageId,
        push_sent: false,
        push_error: 'Customer has no push token registered',
      },
    };
  }

  return {
    err: null,
    details: {
      message_id: messageId,
      push_sent: !!pushResult.success,
      ...(pushResult.success ? {} : { push_error: pushResult.error || 'Push failed' }),
    },
  };
}

const DEFAULT_NOTIFY_TITLE = 'Update from your rider';
const DEFAULT_NOTIFY_BODY =
  'Your rider is trying to reach you. Open the app to view your order.';

/**
 * One-tap notify for the rider app: same validation and rate limit as {@link sendCustomerTaskMessage},
 * fixed title/body/type (customer app can key off `push_type` `rider_customer_notify`).
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('mysql2/promise').Pool} errandWibPool
 * @param {{ id: number }} driver
 * @param {Record<string, unknown>} body
 */
async function sendCustomerTaskNotify(pool, errandWibPool, driver, body) {
  const b = body || {};
  const message = String(b.message ?? DEFAULT_NOTIFY_BODY).trim() || DEFAULT_NOTIFY_BODY;
  const pushTitle = String(b.push_title ?? b.pushTitle ?? DEFAULT_NOTIFY_TITLE).trim() || DEFAULT_NOTIFY_TITLE;
  const pushType = String(b.push_type ?? b.pushType ?? 'rider_customer_notify').trim() || 'rider_customer_notify';
  const pushMessage =
    String(b.push_message ?? b.pushMessage ?? message).trim() || message;
  return sendCustomerTaskMessage(pool, errandWibPool, driver, {
    task_id: b.task_id ?? b.taskId,
    order_id: b.order_id ?? b.orderId,
    app_version: b.app_version ?? b.appVersion,
    message,
    push_title: pushTitle,
    push_message: pushMessage,
    push_type: pushType,
  });
}

module.exports = { sendCustomerTaskMessage, sendCustomerTaskNotify, resolveCustomerPushTarget };
