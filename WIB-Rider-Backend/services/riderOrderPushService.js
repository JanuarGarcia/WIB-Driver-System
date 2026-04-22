'use strict';

const { pool } = require('../config/db');
const { sendPushToDevice, logDriverInboxNotification } = require('./fcm');
const { maybeDisableBadRiderToken } = require('../lib/riderPushFailureHelpers');

const DEVICE_TABLE = 'mt_rider_device_reg';
const LOG_TABLE = 'mt_rider_push_logs';

async function fetchRiderDevices(driverId) {
  const sql = `
    SELECT id, device_id, device_platform
    FROM \`${DEVICE_TABLE}\`
    WHERE driver_id = ?
      AND push_enabled = 1
      AND device_id IS NOT NULL
      AND TRIM(device_id) <> ''
  `;
  try {
    const [rows] = await pool.query(sql, [driverId]);
    if (Array.isArray(rows) && rows.length) return rows;
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

  // Backward-compatible fallback for rider apps that still update mt_driver.device_id on login/re-register
  // but do not yet call /api/riders/devices/register.
  try {
    const [legacyRows] = await pool.query(
      `SELECT driver_id AS id, device_id, device_platform
       FROM mt_driver
       WHERE driver_id = ?
         AND device_id IS NOT NULL
         AND TRIM(device_id) <> ''
       LIMIT 1`,
      [driverId]
    );
    return legacyRows || [];
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return [];
    throw e;
  }
}

function parseTemplate(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const enable = Number(obj.enable_push) === 1 || String(obj.enable_push).toLowerCase() === 'true';
  const title = obj.push?.title || obj.push_title || '';
  const body = obj.push?.body || obj.push_body || '';
  if (!enable || !String(title).trim() || !String(body).trim()) return null;
  return { title: String(title), body: String(body) };
}

async function getTemplateForEvent(eventKey) {
  const key = `notification_template_${String(eventKey || '').trim()}`;
  const [rows] = await pool.query('SELECT option_value FROM mt_option WHERE option_name = ? LIMIT 1', [key]);
  if (!rows || !rows.length) return null;
  return parseTemplate(rows[0].option_value);
}

function interpolate(str, ctx) {
  return String(str || '').replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : ''));
}

async function insertPushLogPending({ driverId, orderId, triggerId, pushType, title, body, deviceId }) {
  const sql = `
    INSERT INTO \`${LOG_TABLE}\`
      (driver_id, order_id, trigger_id, push_type, push_title, push_body, device_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `;
  const [r] = await pool.query(sql, [
    driverId,
    orderId || null,
    triggerId || null,
    pushType,
    title,
    body,
    deviceId,
  ]);
  return r.insertId;
}

async function finalizePushLog(logId, status, providerResponse, errorMessage) {
  await pool.query(
    `UPDATE \`${LOG_TABLE}\` SET status = ?, provider_response = ?, error_message = ?, date_modified = CURRENT_TIMESTAMP WHERE id = ?`,
    [
      status,
      providerResponse ? String(providerResponse).slice(0, 65000) : null,
      errorMessage ? String(errorMessage).slice(0, 2000) : null,
      logId,
    ]
  );
}

async function insertRiderOrderTrigger(orderId, driverId, eventKey, remarks) {
  const sql = `
    INSERT INTO mt_rider_order_trigger (order_id, driver_id, event_key, remarks)
    VALUES (?, ?, ?, ?)
  `;
  const [r] = await pool.query(sql, [orderId, driverId, eventKey, remarks || null]);
  return r.insertId;
}

/**
 * @param {object} opts
 * @param {number} opts.orderId
 * @param {number} opts.driverId
 * @param {string} opts.eventKey e.g. RIDER_ORDER_ASSIGNED
 * @param {string} [opts.remarks]
 * @param {number} [opts.triggerId] optional precomputed trigger row id
 * @param {string} [opts.orderStatus] for data payload
 */
async function sendRiderOrderPush(opts) {
  const { orderId, driverId, eventKey, remarks, triggerId, orderStatus } = opts;
  if (!driverId || !eventKey) return { skipped: true, reason: 'missing driver or event' };

  let tid = triggerId;
  try {
    if (!tid && orderId) {
      tid = await insertRiderOrderTrigger(orderId, driverId, eventKey, remarks);
    }
  } catch (e) {
    console.error('sendRiderOrderPush.trigger', e);
  }

  const tmpl = await getTemplateForEvent(eventKey);
  if (!tmpl) {
    console.info('sendRiderOrderPush.skip_no_template', { orderId, driverId, eventKey });
    return { skipped: true, reason: 'no_template' };
  }

  const ctx = { order_id: orderId, driver_id: driverId };
  const title = interpolate(tmpl.title, ctx);
  const body = interpolate(tmpl.body, ctx);
  const pushType = String(eventKey).toLowerCase();
  const devices = await fetchRiderDevices(driverId);
  if (!devices.length) {
    console.info('sendRiderOrderPush.skip_no_devices', { driverId, orderId, eventKey });
    return { skipped: true, reason: 'no_devices' };
  }

  const baseDataPayload = {
    type: pushType,
    push_type: pushType,
    order_id: String(orderId != null ? orderId : ''),
    task_id: String(orderId != null ? orderId : ''),
    driver_id: String(driverId),
    event_key: String(eventKey),
    status: String(orderStatus || ''),
    title,
    body,
    click_action: 'FLUTTER_NOTIFICATION_CLICK',
    screen: 'task_detail',
  };

  for (const d of devices) {
    let logId = 0;
    try {
      logId = await insertPushLogPending({
        driverId,
        orderId,
        triggerId: tid || null,
        pushType,
        title,
        body,
        deviceId: d.device_id,
      });
      const dataPayload = { ...baseDataPayload, push_id: String(logId) };
      const result = await sendPushToDevice(d.device_id, {
        title,
        body,
        data: dataPayload,
      });
      if (!result.success) {
        throw new Error(result.error || 'FCM send failed');
      }
      await finalizePushLog(logId, 'sent', JSON.stringify(result || {}), null);
      await logDriverInboxNotification(pool, {
        driverId,
        title,
        body,
        pushType,
        taskId: null,
        orderId,
      });
    } catch (e) {
      console.error('sendRiderOrderPush.device_error', {
        orderId,
        driverId,
        deviceId: d.device_id,
        err: e && e.message,
      });
      if (logId) {
        await finalizePushLog(logId, 'failed', null, e && e.message);
      }
      await maybeDisableBadRiderToken(driverId, d.device_id, e);
    }
  }
  return { skipped: false };
}

async function safeSendRiderOrderPush(opts) {
  try {
    return await sendRiderOrderPush(opts);
  } catch (e) {
    console.error('safeSendRiderOrderPush', e);
    return { skipped: true, reason: 'exception' };
  }
}

module.exports = {
  sendRiderOrderPush,
  safeSendRiderOrderPush,
};
