const bcrypt = require('bcryptjs');

function isRiderSignupEnabled(settings) {
  if (!settings || typeof settings !== 'object') return false;
  const raw = settings.enabled_signup;
  if (raw == null || raw === '') return false;
  const value = String(raw).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function normalizeRiderSignupStatus(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'pending' || value === 'inactive') return value;
  return 'active';
}

function pickBodyValue(body, keys) {
  if (!body || typeof body !== 'object') return '';
  for (const key of keys) {
    const value = body[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function splitFullName(fullName) {
  const text = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!text) return { first_name: '', last_name: '' };
  const parts = text.split(' ');
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return {
    first_name: parts.shift() || '',
    last_name: parts.join(' '),
  };
}

function normalizePhoneDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function resolveRiderSignupPayload(body) {
  const username =
    pickBodyValue(body, ['username', 'user_name', 'login', 'email', 'email_address', 'phone', 'mobile']) || '';
  const email =
    pickBodyValue(body, ['email', 'email_address']) ||
    (/@/.test(username) ? username : '');
  const phone =
    pickBodyValue(body, ['phone', 'mobile', 'mobile_number', 'contact_number', 'contact_phone']) || '';
  const firstName = pickBodyValue(body, ['first_name', 'firstname', 'fname']);
  const lastName = pickBodyValue(body, ['last_name', 'lastname', 'lname']);
  const fullName = pickBodyValue(body, ['full_name', 'name']);
  const splitName = !firstName && !lastName ? splitFullName(fullName) : { first_name: '', last_name: '' };

  return {
    username,
    password: pickBodyValue(body, ['password', 'pass', 'new_password']),
    first_name: firstName || splitName.first_name || '',
    last_name: lastName || splitName.last_name || '',
    email,
    phone,
    vehicle: pickBodyValue(body, ['vehicle', 'vehicle_name', 'transport_description']),
    device_id: pickBodyValue(body, ['device_id', 'device_token', 'new_device_id']),
    device_platform: pickBodyValue(body, ['device_platform', 'platform', 'os']),
    team_id: pickBodyValue(body, ['team_id']),
  };
}

function usernameNormalizedExpr() {
  let col = 'COALESCE(`username`, \'\')';
  col = `REPLACE(${col}, UNHEX('EFBBBF'), '')`;
  col = `REPLACE(${col}, UNHEX('E2808B'), '')`;
  col = `REPLACE(${col}, UNHEX('E2808C'), '')`;
  col = `REPLACE(${col}, UNHEX('E2808D'), '')`;
  return `LOWER(TRIM(${col}))`;
}

function phoneDigitsExpr(column) {
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(${column}, '')), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')`;
}

async function queryExists(pool, sql, params) {
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) && rows.length > 0;
}

async function findDriverSignupConflict(pool, payload) {
  const username = String(payload?.username || '').trim();
  const email = String(payload?.email || '').trim();
  const phoneDigits = normalizePhoneDigits(payload?.phone);

  if (username) {
    const usernameChecks = [
      ['SELECT 1 FROM mt_driver WHERE LOWER(TRIM(`username`)) = LOWER(?) LIMIT 1', [username]],
      [`SELECT 1 FROM mt_driver WHERE ${usernameNormalizedExpr()} = LOWER(?) LIMIT 1`, [username]],
    ];
    for (const [sql, params] of usernameChecks) {
      try {
        if (await queryExists(pool, sql, params)) return 'Username already exists';
        break;
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }
  }

  if (email) {
    const emailChecks = [
      ['SELECT 1 FROM mt_driver WHERE LOWER(TRIM(COALESCE(email, \'\'))) = LOWER(?) LIMIT 1', [email]],
      ['SELECT 1 FROM mt_driver WHERE LOWER(TRIM(COALESCE(email_address, \'\'))) = LOWER(?) LIMIT 1', [email]],
    ];
    for (const [sql, params] of emailChecks) {
      try {
        if (await queryExists(pool, sql, params)) return 'Email already exists';
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }
  }

  if (phoneDigits.length >= 7) {
    for (const column of ['phone', 'contact_phone', 'mobile', 'mobile_number']) {
      try {
        if (await queryExists(pool, `SELECT 1 FROM mt_driver WHERE ${phoneDigitsExpr(column)} = ? LIMIT 1`, [phoneDigits])) {
          return 'Phone number already exists';
        }
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }
  }

  return null;
}

async function createDriverSignup(pool, payload) {
  const username = String(payload?.username || '').trim();
  const password = String(payload?.password || '');
  const hash = await bcrypt.hash(password, 10);
  const firstName = String(payload?.first_name || '').trim() || null;
  const lastName = String(payload?.last_name || '').trim() || null;
  const email = String(payload?.email || '').trim() || null;
  const phone = String(payload?.phone || '').trim() || null;
  const vehicle = String(payload?.vehicle || '').trim() || null;
  const status = normalizeRiderSignupStatus(payload?.status);
  const teamIdRaw = String(payload?.team_id || '').trim();
  const teamId = teamIdRaw !== '' && Number.isFinite(parseInt(teamIdRaw, 10)) ? parseInt(teamIdRaw, 10) : null;

  const insertAttempts = [
    {
      sql: `INSERT INTO mt_driver
        (user_type, user_id, on_duty, first_name, last_name, email, phone, username, password, password_bcrypt,
         team_id, transport_type_id, transport_description, licence_plate, color, status,
         enabled_push, is_signup, date_created, date_modified)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      params: ['driver', 0, 0, firstName, lastName, email, phone, username, hash, hash, teamId, null, vehicle, null, null, status, 1, 1],
    },
    {
      sql: `INSERT INTO mt_driver
        (user_type, user_id, on_duty, first_name, last_name, email, phone, username, password,
         team_id, transport_type_id, transport_description, licence_plate, color, status,
         enabled_push, is_signup, date_created, date_modified)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      params: ['driver', 0, 0, firstName, lastName, email, phone, username, hash, teamId, null, vehicle, null, null, status, 1, 1],
    },
    {
      sql: `INSERT INTO mt_driver
        (user_type, user_id, on_duty, first_name, last_name, email, phone, username, password,
         team_id, transport_description, status, enabled_push, is_signup)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: ['driver', 0, 0, firstName, lastName, email, phone, username, hash, teamId, vehicle, status, 1, 1],
    },
    {
      sql: `INSERT INTO mt_driver
        (username, password, first_name, last_name, email, phone, team_id, transport_description, status, on_duty)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      params: [username, hash, firstName, lastName, email, phone, teamId, vehicle, status],
    },
    {
      sql: 'INSERT INTO mt_driver (username, password) VALUES (?, ?)',
      params: [username, hash],
    },
  ];

  let insertResult = null;
  let lastError = null;
  for (const attempt of insertAttempts) {
    try {
      [insertResult] = await pool.query(attempt.sql, attempt.params);
      break;
    } catch (e) {
      lastError = e;
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  if (!insertResult) throw lastError || new Error('Failed to create rider signup');

  const driverId = insertResult.insertId;
  const deviceId = String(payload?.device_id || '').trim();
  const devicePlatform = String(payload?.device_platform || '').trim().toLowerCase() || null;
  if (driverId && deviceId) {
    try {
      await pool.query(
        'UPDATE mt_driver SET device_id = ?, device_platform = ? WHERE driver_id = ?',
        [deviceId, devicePlatform, driverId]
      );
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  return {
    driverId,
    username,
    status,
  };
}

function riderSignupSuccessMessage(status) {
  if (status === 'pending') return 'Registration submitted. Your rider account is pending review.';
  if (status === 'inactive') return 'Registration submitted. Your rider account is inactive until approved.';
  return 'Registration successful. You can now log in.';
}

module.exports = {
  createDriverSignup,
  findDriverSignupConflict,
  isRiderSignupEnabled,
  normalizeRiderSignupStatus,
  resolveRiderSignupPayload,
  riderSignupSuccessMessage,
};
