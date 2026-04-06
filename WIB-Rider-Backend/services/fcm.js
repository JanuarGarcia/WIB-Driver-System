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
  const app = await initFirebase();
  if (!app) return { success: false, error: 'FCM not configured' };
  const { pool } = require('../config/db');
  const [[d]] = await pool.query('SELECT device_id FROM mt_driver WHERE driver_id = ?', [driverId]);
  if (!d?.device_id) return { success: false, error: 'No device token' };
  try {
    const result = await app.messaging().send({
      token: d.device_id,
      notification: { title, body },
      data: stringifyDataPayload(data),
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    return { success: true, messageId: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
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

module.exports = { initFirebase, resetFirebase, sendPushToDriver, sendPushToAllDrivers };
