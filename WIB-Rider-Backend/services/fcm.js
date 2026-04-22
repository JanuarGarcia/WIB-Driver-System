'use strict';

const fs = require('fs');
const path = require('path');

let admin = null;
let app = null;

/** Max wait per FCM `send()` so dashboard “Send push” does not hang on bad network / FCM stalls. */
function fcmSendTimeoutMs() {
  const n = parseInt(String(process.env.FCM_SEND_TIMEOUT_MS || '25000'), 10);
  if (Number.isFinite(n) && n >= 5000 && n <= 60000) return n;
  return 25000;
}

/** FCM data payload values must be strings. */
function stringifyDataPayload(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    out[String(k)] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

async function resetFirebase() {
  try {
    const adm = require('firebase-admin');
    if (adm.apps && adm.apps.length) {
      await Promise.all(adm.apps.map((a) => (a && typeof a.delete === 'function' ? a.delete() : Promise.resolve())));
    }
  } catch (e) {
    console.warn('FCM reset:', e.message);
  }
  admin = null;
  app = null;
}

/**
 * FCM token for admin/driver pushes: prefer latest `mt_rider_device_reg` (Flutter rider app),
 * then fall back to `mt_driver.device_id` (legacy / login path). Avoids stale `mt_driver` tokens.
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} driverId
 * @returns {Promise<string>}
 */
async function resolveDriverFcmToken(pool, driverId) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0) return '';

  const loadFromReg = async (withPushEnabled) => {
    const pushClause = withPushEnabled
      ? ` AND (push_enabled IS NULL OR push_enabled = 1 OR push_enabled = '1' OR LOWER(TRIM(CAST(push_enabled AS CHAR))) = 'true')`
      : '';
    const [rows] = await pool.query(
      `SELECT device_id FROM mt_rider_device_reg
       WHERE driver_id = ?
         AND device_id IS NOT NULL AND TRIM(device_id) <> ''${pushClause}
       ORDER BY id DESC
       LIMIT 1`,
      [did]
    );
    const r = rows && rows[0];
    return r?.device_id != null && String(r.device_id).trim() ? String(r.device_id).trim() : '';
  };

  try {
    let t = await loadFromReg(true);
    if (t) return t;
    t = await loadFromReg(false);
    if (t) return t;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      /* fall through to mt_driver */
    } else if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        const t2 = await loadFromReg(false);
        if (t2) return t2;
      } catch (e2) {
        if (e2.code !== 'ER_NO_SUCH_TABLE') throw e2;
      }
    } else {
      throw e;
    }
  }

  const [[d]] = await pool.query('SELECT device_id FROM mt_driver WHERE driver_id = ?', [did]);
  const fromDriver = d?.device_id != null && String(d.device_id).trim() ? String(d.device_id).trim() : '';
  return fromDriver || '';
}

async function initFirebase() {
  if (app) return app;
  const { pool } = require('../config/db');
  try {
    let serviceAccount = null;

    try {
      const [[row]] = await pool.query(
        "SELECT option_value AS value FROM mt_option WHERE option_name = 'fcm_service_account_json' LIMIT 1"
      );
      const raw = row?.value;
      if (raw && String(raw).trim()) {
        serviceAccount = JSON.parse(raw);
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
        console.warn('FCM DB config load failed:', e.message);
      }
    }

    if (!serviceAccount) {
      const rawPath = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
      if (rawPath) {
        const candidates = path.isAbsolute(rawPath)
          ? [rawPath]
          : [path.resolve(process.cwd(), rawPath), path.resolve(__dirname, '..', rawPath)];
        for (const candidate of candidates) {
          if (!fs.existsSync(candidate)) continue;
          const rawJson = fs.readFileSync(candidate, 'utf8');
          serviceAccount = JSON.parse(rawJson);
          break;
        }
      }
    }

    if (!serviceAccount) return null;
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    app = admin;
    return app;
  } catch (e) {
    console.warn('FCM init failed:', e.message);
    return null;
  }
}

function toPositiveInt(v) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function insertDriverInboxRow(pool, params) {
  const variants = [
    {
      sql: `INSERT INTO mt_driver_pushlog (driver_id, push_title, push_message, push_type, task_id, order_id, date_created, date_process, is_read)
            VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 0)`,
      values: [params.driverId, params.title, params.body, params.pushType, params.taskId, params.orderId],
    },
    {
      sql: `INSERT INTO mt_driver_pushlog (driver_id, push_title, push_message, push_type, task_id, order_id, date_created, is_read)
            VALUES (?, ?, ?, ?, ?, ?, NOW(), 0)`,
      values: [params.driverId, params.title, params.body, params.pushType, params.taskId, params.orderId],
    },
    {
      sql: `INSERT INTO mt_driver_pushlog (driver_id, push_title, push_message, push_type, task_id, order_id, date_created)
            VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      values: [params.driverId, params.title, params.body, params.pushType, params.taskId, params.orderId],
    },
    {
      sql: `INSERT INTO mt_driver_pushlog (driver_id, push_title, push_message, push_type, date_created)
            VALUES (?, ?, ?, ?, NOW())`,
      values: [params.driverId, params.title, params.body, params.pushType],
    },
  ];

  for (const variant of variants) {
    try {
      const [result] = await pool.query(variant.sql, variant.values);
      return result && result.insertId ? Number(result.insertId) : null;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return null;
      if (e.code === 'ER_BAD_FIELD_ERROR') continue;
      throw e;
    }
  }
  return null;
}

async function logDriverInboxNotification(pool, { driverId, title, body, pushType, taskId, orderId }) {
  const did = toPositiveInt(driverId);
  if (!did) return null;
  try {
    return await insertDriverInboxRow(pool, {
      driverId: did,
      title: String(title != null ? title : '').trim() || 'Notification',
      body: String(body != null ? body : '').trim() || String(title != null ? title : '').trim() || 'Notification',
      pushType: String(pushType != null ? pushType : '').trim() || 'admin_push',
      taskId: toPositiveInt(taskId),
      orderId: toPositiveInt(orderId),
    });
  } catch (_) {
    return null;
  }
}

async function sendPushToDriver(driverId, title, body, data = {}) {
  const { pool } = require('../config/db');
  const token = await resolveDriverFcmToken(pool, driverId);
  if (!token) return { success: false, error: 'No device token' };
  const payloadData = data && typeof data === 'object' ? { ...data } : {};
  if (payloadData.push_nonce == null) {
    payloadData.push_nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  if (payloadData.type != null && payloadData.push_type == null) {
    payloadData.push_type = payloadData.type;
  }
  if (payloadData.click_action == null) {
    payloadData.click_action = 'FLUTTER_NOTIFICATION_CLICK';
  }
  if (
    payloadData.screen == null &&
    (payloadData.task_id != null || payloadData.order_id != null || payloadData.errand_order_id != null)
  ) {
    payloadData.screen = 'task_detail';
  }
  const result = await sendPushToFcmToken(token, title, body, payloadData, { useCustomerAndroidChannel: false });
  if (result && result.success) {
    await logDriverInboxNotification(pool, {
      driverId,
      title,
      body,
      pushType: payloadData.push_type || payloadData.type,
      taskId: payloadData.task_id ?? payloadData.taskId,
      orderId: payloadData.order_id ?? payloadData.orderId ?? payloadData.errand_order_id,
    });
  }
  return result;
}

async function sendPushToAllDrivers(title, body, data = {}) {
  const app = await initFirebase();
  if (!app) return { success: false, error: 'FCM not configured' };
  const { pool } = require('../config/db');
  const [rows] = await pool.query('SELECT driver_id AS id, device_id FROM mt_driver WHERE device_id IS NOT NULL AND device_id != ""');
  const tokens = rows.map((r) => r.device_id).filter(Boolean);
  if (tokens.length === 0) return { success: true, sent: 0 };
  try {
    const result = await app.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringifyDataPayload(data),
      android: { priority: 'high' },
    });
    return { success: true, sent: result.successCount, failed: result.failureCount };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Customer-app FCM: must include both `notification` (system tray when background/quit) and
 * string `title`/`body` in `data` so Flutter/React Native can show a local notification in foreground.
 * Optional FCM_CUSTOMER_ANDROID_CHANNEL_ID — only when opts.useCustomerAndroidChannel (customer app sends).
 * Rider/admin pushes omit it so Android uses the app default channel unless FCM_RIDER_ANDROID_CHANNEL_ID is set.
 */
async function sendPushToFcmToken(fcmToken, title, body, data = {}, options = {}) {
  const app = await initFirebase();
  if (!app) return { success: false, error: 'FCM not configured' };
  const tok = fcmToken != null ? String(fcmToken).trim() : '';
  if (!tok) return { success: false, error: 'No device token' };

  const titleStr = String(title != null ? title : '').trim() || 'Notification';
  const bodyStr = String(body != null ? body : '').trim() || titleStr;

  const payloadData = stringifyDataPayload(data);
  const mergedData = {
    ...payloadData,
    title: titleStr,
    body: bodyStr,
  };

  const useCustomerChannel = options.useCustomerAndroidChannel === true;
  const customerChannel = String(process.env.FCM_CUSTOMER_ANDROID_CHANNEL_ID || '').trim();
  const riderChannel = String(process.env.FCM_RIDER_ANDROID_CHANNEL_ID || process.env.FCM_DRIVER_ANDROID_CHANNEL_ID || '').trim();
  const channelId = useCustomerChannel ? customerChannel : riderChannel;

  const androidNotification = {
    title: titleStr,
    body: bodyStr,
    sound: 'default',
  };
  if (channelId) {
    androidNotification.channelId = channelId;
  }

  const message = {
    token: tok,
    notification: { title: titleStr, body: bodyStr },
    data: mergedData,
    android: {
      priority: 'high',
      notification: androidNotification,
    },
    apns: {
      headers: {
        'apns-priority': '10',
      },
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };

  const ms = fcmSendTimeoutMs();
  try {
    const result = await Promise.race([
      app.messaging().send(message),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`FCM send timed out after ${ms}ms`)), ms);
      }),
    ]);
    return { success: true, messageId: result };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * Generic FCM send by registration token (e.g. mt_rider_device_reg.device_id).
 * Uses the same notification + data merge as customer pushes for Flutter foreground handling.
 * @param {string} token
 * @param {{ title?: string, body?: string, data?: Record<string, unknown>, fcmApp?: string }} [opts]
 */
async function sendPushToDevice(token, opts = {}) {
  const title = opts.title != null ? String(opts.title) : '';
  const body = opts.body != null ? String(opts.body) : '';
  const data = opts.data && typeof opts.data === 'object' ? opts.data : {};
  void opts.fcmApp;
  return sendPushToFcmToken(token, title, body, data, { useCustomerAndroidChannel: false });
}

module.exports = {
  initFirebase,
  resetFirebase,
  logDriverInboxNotification,
  sendPushToDriver,
  sendPushToAllDrivers,
  sendPushToFcmToken,
  sendPushToDevice,
};
