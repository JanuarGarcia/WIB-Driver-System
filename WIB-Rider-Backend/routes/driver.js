const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/db');
const { success, error } = require('../lib/response');
const { validateApiKey, resolveDriver, optionalDriver } = require('../middleware/auth');

const uploadDir = path.join(__dirname, '..', 'uploads', 'profiles');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif'].some((e) => ext.endsWith(e))) {
      cb(null, true);
    } else {
      cb(new Error('Only images allowed'));
    }
  },
});

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function todayRaw() {
  return Math.floor(Date.now() / 1000).toString();
}

/** mt_order.payment_status may be absent on older DBs; retry without it once. */
let mtOrderPaymentStatusColumn = true;

/**
 * Rider task rows with payment fields from mt_order (same shape for list + detail).
 * @param {string} whereSql SQL after JOIN, starting with WHERE
 * @param {unknown[]} params
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function queryRiderTaskRows(whereSql, params) {
  const payStatusExpr = mtOrderPaymentStatusColumn ? 'o.payment_status AS payment_status' : 'NULL AS payment_status';
  const sql = `SELECT t.task_id, t.order_id, t.task_description, t.trans_type AS trans_type_raw, t.contact_number, t.email_address, t.customer_name, t.delivery_date,
      NULL AS delivery_time, t.delivery_address, t.task_lat, t.task_lng,
      COALESCE(NULLIF(TRIM(m.restaurant_name), ''), NULLIF(TRIM(m2.restaurant_name), ''), t.dropoff_merchant) AS merchant_name,
      t.drop_address AS merchant_address,
      t.status, t.status AS status_raw, NULL AS order_status,
      o.payment_type AS payment_type,
      ${payStatusExpr},
      CAST(COALESCE(o.total_w_tax, o.sub_total) AS CHAR) AS order_total_amount,
      t.date_created
    FROM mt_driver_task t
    LEFT JOIN mt_order o ON o.order_id = t.order_id
    LEFT JOIN mt_merchant m ON o.merchant_id = m.merchant_id
    LEFT JOIN mt_merchant m2 ON t.dropoff_merchant REGEXP '^[0-9]+$' AND m2.merchant_id = t.dropoff_merchant
    ${whereSql}`;
  try {
    const [rows] = await pool.query(sql, params);
    return rows || [];
  } catch (e) {
    if (
      mtOrderPaymentStatusColumn &&
      e.code === 'ER_BAD_FIELD_ERROR' &&
      /payment_status/i.test(String(e.sqlMessage || ''))
    ) {
      mtOrderPaymentStatusColumn = false;
      return queryRiderTaskRows(whereSql, params);
    }
    throw e;
  }
}

// ---- Public (api_key only) ----
router.post('/Login', validateApiKey, async (req, res) => {
  const { username, password, device_id, device_platform } = req.body;
  if (!username || !password) {
    return error(res, 'Username and password required');
  }
  const [[driver]] = await pool.query(
    'SELECT driver_id AS id, username, password AS password_hash, on_duty FROM mt_driver WHERE username = ?',
    [username]
  );
  if (!driver) {
    return error(res, 'Invalid credentials');
  }
  const stored = (driver.password_hash || '').trim();
  const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');
  const isMd5 = /^[a-f0-9]{32}$/i.test(stored);
  let passwordOk = false;
  if (isBcrypt) {
    passwordOk = await bcrypt.compare(password, stored);
  } else if (isMd5) {
    passwordOk = crypto.createHash('md5').update(password).digest('hex').toLowerCase() === stored.toLowerCase();
  } else {
    passwordOk = password === stored;
  }
  if (!passwordOk) {
    return error(res, 'Invalid credentials');
  }
  const token = uuidv4();
  const nowUnix = Math.floor(Date.now() / 1000);
  const updates = [token, device_id || null, (device_platform || '').toLowerCase() || null, driver.id];
  try {
    await pool.query(
      'UPDATE mt_driver SET token = ?, device_id = ?, device_platform = ?, last_login = NOW(), last_online = ? WHERE driver_id = ?',
      [updates[0], updates[1], updates[2], nowUnix, driver.id]
    );
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      await pool.query(
        'UPDATE mt_driver SET token = ?, device_id = ?, device_platform = ?, last_login = NOW() WHERE driver_id = ?',
        updates
      );
    } else throw e;
  }
  if (!isBcrypt && stored) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE mt_driver SET password = ? WHERE driver_id = ?', [hash, driver.id]);
  }
  return success(res, {
    token,
    username: driver.username,
    todays_date: todayStr(),
    todays_date_raw: todayRaw(),
    on_duty: driver.on_duty ?? 1,
    duty_status: driver.on_duty,
    location_accuracy: 2,
    enabled_push: 1,
    topic_new_task: null,
    topic_alert: null,
  });
});

async function getDriverSettingsMap() {
  try {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    if (rows && rows.length > 0) return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (e) {
    // settings table may not exist
  }
  try {
    const [rows] = await pool.query('SELECT option_name AS `key`, option_value AS value FROM mt_option');
    return Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  } catch (e) {
    return {};
  }
}

router.post('/GetAppSettings', validateApiKey, optionalDriver, async (req, res) => {
  const settings = await getDriverSettingsMap();
  const driver = req.driver;
  const appName = (settings.app_name != null && String(settings.app_name).trim() !== '') ? String(settings.app_name).trim() : (settings.website_title || 'WIB Driver');
  const configuredApiKey = settings.driver_api_hash_key || settings.api_hash_key || process.env.API_HASH_KEY || '';
  const envMobileApiUrlRaw = (process.env.MOBILE_API_URL || '').trim();
  const envMobileApiUrl = envMobileApiUrlRaw ? envMobileApiUrlRaw.replace(/\/+$/, '') : '';
  const mobileApiUrl = configuredApiKey && String(configuredApiKey).trim() ? envMobileApiUrl : '';
  const details = {
    app_language: settings.app_default_language || 'en',
    app_name: appName,
    mobile_api_url: mobileApiUrl,
    valid_token: !!driver,
    todays_date: todayStr(),
    todays_date_raw: todayRaw(),
    on_duty: driver?.on_duty ?? 0,
    token: driver ? (await getTokenForDriverId(driver.id)) : null,
    duty_status: driver?.on_duty,
    location_accuracy: 2,
    enabled_push: 1,
    topic_new_task: null,
    topic_alert: null,
    notification_sound_url: null,
    track_interval: 15000,
    map_provider: 'google',
    translation: {},
  };
  return success(res, details);
});

async function getTokenForDriverId(driverId) {
  const [[r]] = await pool.query('SELECT token FROM mt_driver WHERE driver_id = ?', [driverId]);
  return r?.token || null;
}

// ---- Protected (api_key + token) ----
router.post('/Logout', validateApiKey, resolveDriver, async (req, res) => {
  const oldUnix = Math.floor(Date.now() / 1000) - 35 * 60;
  try {
    await pool.query('UPDATE mt_driver SET token = NULL, last_online = ? WHERE driver_id = ?', [oldUnix, req.driver.id]);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      await pool.query('UPDATE mt_driver SET token = NULL WHERE driver_id = ?', [req.driver.id]);
    } else throw e;
  }
  return success(res, null);
});

router.post('/reRegisterDevice', validateApiKey, resolveDriver, async (req, res) => {
  const { new_device_id, device_platform } = req.body;
  await pool.query(
    'UPDATE mt_driver SET device_id = ?, device_platform = ? WHERE driver_id = ?',
    [new_device_id || null, (device_platform || '').toLowerCase() || null, req.driver.id]
  );
  return success(res, null);
});

router.post('/ChangeDutyStatus', validateApiKey, resolveDriver, async (req, res) => {
  const onDuty = parseInt(req.body.on_duty, 10);
  const val = onDuty === 1 ? 1 : 0;
  if (val !== 1) {
    const oldUnix = Math.floor(Date.now() / 1000) - 35 * 60;
    try {
      await pool.query('UPDATE mt_driver SET on_duty = ?, last_online = ? WHERE driver_id = ?', [val, oldUnix, req.driver.id]);
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        await pool.query('UPDATE mt_driver SET on_duty = ? WHERE driver_id = ?', [val, req.driver.id]);
      } else throw e;
    }
  } else {
    const nowUnix = Math.floor(Date.now() / 1000);
    try {
      await pool.query(
        'UPDATE mt_driver SET on_duty = ?, last_online = ?, last_login = NOW() WHERE driver_id = ?',
        [val, nowUnix, req.driver.id]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        try {
          await pool.query('UPDATE mt_driver SET on_duty = ?, last_login = NOW() WHERE driver_id = ?', [val, req.driver.id]);
        } catch (e2) {
          if (e2.code === 'ER_BAD_FIELD_ERROR') {
            await pool.query('UPDATE mt_driver SET on_duty = ? WHERE driver_id = ?', [val, req.driver.id]);
          } else throw e2;
        }
      } else throw e;
    }
  }
  return success(res, null);
});

router.post('/UpdateDriverLocation', validateApiKey, resolveDriver, async (req, res) => {
  const { lat, lng, accuracy, altitude, device_id, device_platform, on_duty, driver_id } = req.body;
  const did = driver_id ? parseInt(driver_id, 10) : req.driver.id;
  const numLat = parseFloat(lat);
  const numLng = parseFloat(lng);
  if (Number.isNaN(numLat) || Number.isNaN(numLng)) {
    return error(res, 'Invalid lat/lng');
  }
  // Current position in mt_driver; last_online = now so driver appears online (option 1)
  const nowUnix = Math.floor(Date.now() / 1000);
  try {
    await pool.query(
      'UPDATE mt_driver SET location_lat = ?, location_lng = ?, date_modified = NOW(), last_online = ? WHERE driver_id = ?',
      [numLat, numLng, nowUnix, did]
    );
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      await pool.query(
        'UPDATE mt_driver SET location_lat = ?, location_lng = ?, date_modified = NOW() WHERE driver_id = ?',
        [numLat, numLng, did]
      );
    } else throw e;
  }
  // History in mt_driver_track_location
  await pool.query(
    `INSERT INTO mt_driver_track_location (driver_id, latitude, longitude, altitude, accuracy, date_created, device_platform)
     VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
    [did, numLat, numLng, altitude || null, accuracy || null, (device_platform || '').toLowerCase() || null]
  );
  if (device_id || device_platform != null) {
    await pool.query(
      'UPDATE mt_driver SET device_id = COALESCE(?, device_id), device_platform = COALESCE(?, device_platform), on_duty = COALESCE(?, on_duty) WHERE driver_id = ?',
      [device_id || null, device_platform || null, on_duty != null ? parseInt(on_duty, 10) : null, did]
    );
  }
  return success(res, null, 'Location set');
});

router.post('/GetProfile', validateApiKey, resolveDriver, async (req, res) => {
  const [[d]] = await pool.query(
    `SELECT CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name, d.phone, d.location_address AS address, d.transport_type_id, d.transport_description,
      d.licence_plate, d.color, d.profile_photo, d.team_id, t.team_name, d.email
     FROM mt_driver d LEFT JOIN mt_driver_team t ON d.team_id = t.team_id WHERE d.driver_id = ?`,
    [req.driver.id]
  );
  // Hardcoded to match old backend transportType() – no transport_types table
  const transportList = {
    '': 'Please select',
    truck: 'Truck',
    car: 'Car',
    bike: 'Bike',
    bicycle: 'Bicycle',
    scooter: 'Scooter',
    walk: 'Walk',
  };
  const profilePhoto = d?.profile_photo ? (d.profile_photo.startsWith('http') ? d.profile_photo : `${BASE_URL}${d.profile_photo.startsWith('/') ? '' : '/'}${d.profile_photo}`) : null;
  return success(res, {
    full_name: d?.full_name,
    team_name: d?.team_name,
    email: d?.email,
    phone: d?.phone,
    address: d?.address,
    transport_type_id: d?.transport_type_id,
    transport_type_id2: d?.transport_type_id,
    transport_description: d?.transport_description,
    licence_plate: d?.licence_plate,
    color: d?.color,
    profile_photo: profilePhoto,
    transport_list: transportList,
  });
});

router.post('/UpdateProfile', validateApiKey, resolveDriver, async (req, res) => {
  const { phone, team_name, username, address, driver_address } = req.body;
  const addr = address || driver_address;
  if (username != null) {
    await pool.query('UPDATE mt_driver SET first_name = ?, last_name = ? WHERE driver_id = ?', [username.trim(), '', req.driver.id]);
  }
  if (phone != null) await pool.query('UPDATE mt_driver SET phone = ? WHERE driver_id = ?', [phone, req.driver.id]);
  if (addr != null) await pool.query('UPDATE mt_driver SET location_address = ? WHERE driver_id = ?', [addr, req.driver.id]);
  if (team_name != null) {
    const [[t]] = await pool.query('SELECT team_id FROM mt_driver_team WHERE team_name = ? LIMIT 1', [team_name]);
    await pool.query('UPDATE mt_driver SET team_id = ? WHERE driver_id = ?', [t?.team_id ?? null, req.driver.id]);
  }
  return success(res, null);
});

router.post('/UpdateVehicle', validateApiKey, resolveDriver, async (req, res) => {
  const { transport_type_id, transport_description, licence_plate, color } = req.body;
  await pool.query(
    'UPDATE mt_driver SET transport_type_id = ?, transport_description = ?, licence_plate = ?, color = ? WHERE driver_id = ?',
    [transport_type_id || null, transport_description || null, licence_plate || null, color || null, req.driver.id]
  );
  return success(res, null);
});

router.post('/GetTaskByDate', validateApiKey, resolveDriver, async (req, res) => {
  const date = req.body.date || todayStr();
  const rows = await queryRiderTaskRows(
    'WHERE (t.delivery_date = ? OR DATE(t.delivery_date) = ?) AND (t.driver_id IS NULL OR t.driver_id = ?) ORDER BY t.task_id',
    [date, date, req.driver.id]
  );
  const data = rows.map((r) => ({
    ...r,
    date_created: r.date_created ? new Date(r.date_created).toISOString() : null,
  }));
  return success(res, { data });
});

router.post('/GetTaskDetails', validateApiKey, resolveDriver, async (req, res) => {
  const taskId = parseInt(req.body.task_id, 10);
  if (!taskId) return error(res, 'task_id required');
  const rows = await queryRiderTaskRows('WHERE t.task_id = ? LIMIT 1', [taskId]);
  const r = rows[0];
  if (!r) return error(res, 'Task not found');
  r.date_created = r.date_created ? new Date(r.date_created).toISOString() : null;
  return success(res, r);
});

router.post('/ChangeTaskStatus', validateApiKey, resolveDriver, async (req, res) => {
  const { task_id, status_raw, reason } = req.body;
  const tid = parseInt(task_id, 10);
  if (!tid) return error(res, 'task_id required');
  const status = (status_raw || 'completed').toString().toLowerCase();
  const [updateResult] = await pool.query(
    'UPDATE mt_driver_task SET status = ?, date_modified = NOW() WHERE task_id = ? AND driver_id = ?',
    [status, tid, req.driver.id]
  );
  if (!updateResult.affectedRows) {
    return error(res, 'Task not found or not assigned to you');
  }
  try {
    const [[task]] = await pool.query('SELECT order_id FROM mt_driver_task WHERE task_id = ?', [tid]);
    const remarks = reason != null && String(reason).trim() ? String(reason).trim() : '';
    await pool.query(
      'INSERT INTO mt_order_history (order_id, task_id, status, remarks, date_created, update_by_type) VALUES (?, ?, ?, ?, NOW(), ?)',
      [task?.order_id || null, tid, status, remarks, 'driver']
    );
  } catch (_) {
    /* mt_order_history optional — do not fail status update */
  }
  return success(res, null);
});

router.post('/GetNotifications', validateApiKey, resolveDriver, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT push_id, push_title, push_message, push_type, date_created, is_read, task_id, order_id FROM mt_driver_pushlog WHERE driver_id = ? ORDER BY date_created DESC LIMIT 100',
    [req.driver.id]
  );
  const data = rows.map((r) => ({
    ...r,
    date_created: r.date_created ? new Date(r.date_created).toISOString() : null,
  }));
  return success(res, data);
});

router.post('/ClearNotifications', validateApiKey, resolveDriver, async (req, res) => {
  await pool.query('UPDATE mt_driver_pushlog SET is_read = 1 WHERE driver_id = ?', [req.driver.id]);
  return success(res, null);
});

router.post('/ForgotPassword', validateApiKey, async (req, res) => {
  const { email } = req.body;
  if (!email) return error(res, 'Email required');
  return success(res, null, 'If the email exists, a reset link has been sent.');
});

router.post('/ChangePassword', validateApiKey, resolveDriver, async (req, res) => {
  const { current_password, new_password } = req.body;
  const [[d]] = await pool.query('SELECT password AS password_hash FROM mt_driver WHERE driver_id = ?', [req.driver.id]);
  if (!d || !(await bcrypt.compare(current_password, d.password_hash))) {
    return error(res, 'Current password is wrong');
  }
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE mt_driver SET password = ? WHERE driver_id = ?', [hash, req.driver.id]);
  return success(res, null);
});

router.post('/joinQueue', validateApiKey, resolveDriver, async (req, res) => {
  const [[existing]] = await pool.query('SELECT id FROM mt_driver_queue WHERE driver_id = ? AND left_at IS NULL LIMIT 1', [req.driver.id]);
  if (!existing) {
    await pool.query(
      'INSERT INTO mt_driver_queue (driver_id, status, joined_at) VALUES (?, ?, NOW())',
      [req.driver.id, 'joined']
    );
  }
  const [order] = await pool.query('SELECT driver_id, joined_at FROM mt_driver_queue WHERE left_at IS NULL ORDER BY joined_at ASC');
  const row = order.find((r) => r.driver_id === req.driver.id);
  const pos = row ? order.findIndex((r) => r.driver_id === req.driver.id) + 1 : 0;
  return success(res, { in_queue: true, position: pos, joined_at: row?.joined_at ? new Date(row.joined_at).toISOString() : new Date().toISOString() });
});

router.post('/leaveQueue', validateApiKey, resolveDriver, async (req, res) => {
  await pool.query('UPDATE mt_driver_queue SET left_at = NOW(), status = ? WHERE driver_id = ? AND left_at IS NULL', ['left', req.driver.id]);
  return success(res, null);
});

router.post('/queuePosition', validateApiKey, resolveDriver, async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT joined_at FROM mt_driver_queue WHERE driver_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1', [req.driver.id]);
    if (!r) {
      return success(res, { in_queue: false, position: null, joined_at: null });
    }
    const [order] = await pool.query('SELECT driver_id FROM mt_driver_queue WHERE left_at IS NULL ORDER BY joined_at ASC');
    const pos = order.findIndex((row) => row.driver_id === req.driver.id) + 1;
    return success(res, { in_queue: true, position: pos, joined_at: r.joined_at ? new Date(r.joined_at).toISOString() : null });
  } catch (e) {
    return success(res, { in_queue: false, position: null, joined_at: null }, 'Queue position unavailable');
  }
});

router.post('/UploadProfilePhoto', validateApiKey, resolveDriver, upload.single('photo'), async (req, res) => {
  if (!req.file) return error(res, 'No file uploaded');
  const ext = path.extname(req.file.originalname || '') || '.jpg';
  const newName = `driver_${req.driver.id}_${Date.now()}${ext}`;
  const newPath = path.join(uploadDir, newName);
  fs.renameSync(req.file.path, newPath);
  const urlPath = `/uploads/profiles/${newName}`;
  await pool.query('UPDATE mt_driver SET profile_photo = ? WHERE driver_id = ?', [urlPath, req.driver.id]);
  return success(res, null);
}, (err, req, res, next) => {
  if (err) return error(res, err.message || 'Upload failed');
  next();
});

// Log map API usage to mt_driver_mapsapicall (map_provider, api_functions, api_response, date_created, date_call, ip_address)
router.post('/LogMapApiCall', validateApiKey, optionalDriver, async (req, res) => {
  const { map_provider, api_functions, api_response } = req.body;
  const ip_address = req.body.ip_address || req.ip || req.connection?.remoteAddress || null;
  try {
    await pool.query(
      `INSERT INTO mt_driver_mapsapicall (map_provider, api_functions, api_response, date_created, date_call, ip_address)
       VALUES (?, ?, ?, NOW(), NOW(), ?)`,
      [map_provider || null, api_functions || null, api_response != null ? String(api_response) : null, ip_address]
    );
    return success(res, null);
  } catch (e) {
    return error(res, e.message || 'Log failed');
  }
});

module.exports = router;
