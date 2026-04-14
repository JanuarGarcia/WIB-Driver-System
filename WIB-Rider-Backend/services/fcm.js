let admin = null;
let app = null;

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
 * FCM token for admin/driver pushes: prefer `mt_driver.device_id`, else latest eligible row in `mt_rider_device_reg`
 * (Flutter rider app registers here; `mt_driver.device_id` is often empty).
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} driverId
 * @returns {Promise<string>}
 */
async function resolveDriverFcmToken(pool, driverId) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0) return '';

  const [[d]] = await pool.query('SELECT device_id FROM mt_driver WHERE driver_id = ?', [did]);
  const fromDriver = d?.device_id != null && String(d.device_id).trim() ? String(d.device_id).trim() : '';
  if (fromDriver) return fromDriver;

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
    return t || '';
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return '';
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        return (await loadFromReg(false)) || '';
      } catch (e2) {
        if (e2.code === 'ER_NO_SUCH_TABLE') return '';
        throw e2;
      }
    }
    throw e;
  }
}

async function initFirebase() {
  if (app) return app;
  const { pool } = require('../config/db');
  try {
    const [[row]] = await pool.query(
      "SELECT option_value AS value FROM mt_option WHERE option_name = 'fcm_service_account_json' LIMIT 1"
    );
    const raw = row?.value;
    if (!raw || !String(raw).trim()) return null;
    const serviceAccount = JSON.parse(raw);
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

async function sendPushToDriver(driverId, title, body, data = {}) {
  const { pool } = require('../config/db');
  const token = await resolveDriverFcmToken(pool, driverId);
  if (!token) return { success: false, error: 'No device token' };
  return sendPushToFcmToken(token, title, body, data);
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
 * Optional FCM_CUSTOMER_ANDROID_CHANNEL_ID must match a channel created in the customer app (Android 8+).
 */
async function sendPushToFcmToken(fcmToken, title, body, data = {}) {
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

  const channelId = String(process.env.FCM_CUSTOMER_ANDROID_CHANNEL_ID || '').trim();
  const androidNotification = {
    title: titleStr,
    body: bodyStr,
    sound: 'default',
  };
  if (channelId) {
    androidNotification.channelId = channelId;
  }

  try {
    const result = await app.messaging().send({
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
    });
    return { success: true, messageId: result };
  } catch (e) {
    return { success: false, error: e.message };
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
  return sendPushToFcmToken(token, title, body, data);
}

module.exports = {
  initFirebase,
  resetFirebase,
  sendPushToDriver,
  sendPushToAllDrivers,
  sendPushToFcmToken,
  sendPushToDevice,
};
