'use strict';

const { loadTableColumnSet } = require('./mobile2DeviceRegLookup');

const SESSION_TABLE = 'mt_rider_session';
const DEVICE_TABLE = 'mt_rider_device_reg';

let cachedColumns = new Map();

function normalizeString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function normalizePlatform(v) {
  const s = normalizeString(v);
  return s ? s.toLowerCase() : null;
}

function truthyFlag(v) {
  if (v == null || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

function isSchemaCompatError(err) {
  return err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');
}

async function getColumnSet(pool, table) {
  const cached = cachedColumns.get(table);
  if (cached) return cached;
  try {
    const cols = await loadTableColumnSet(pool, table);
    cachedColumns.set(table, cols);
    return cols;
  } catch (_) {
    const empty = new Set();
    cachedColumns.set(table, empty);
    return empty;
  }
}

function resetColumnCache(table) {
  if (table) {
    cachedColumns.delete(table);
    return;
  }
  cachedColumns = new Map();
}

function sessionReason(reason) {
  return normalizeString(reason) || 'session_invalidated';
}

function resolveSessionContext(raw = {}, extras = {}) {
  const deviceUuid =
    normalizeString(raw.device_uuid) ||
    normalizeString(raw.deviceUuid) ||
    normalizeString(raw.install_uuid) ||
    normalizeString(raw.installUuid) ||
    normalizeString(raw.device_uiid) ||
    normalizeString(raw.deviceUiid);
  const pushToken =
    normalizeString(raw.push_token) ||
    normalizeString(raw.pushToken) ||
    normalizeString(raw.fcm_token) ||
    normalizeString(raw.fcmToken) ||
    normalizeString(raw.device_id) ||
    normalizeString(raw.new_device_id) ||
    normalizeString(raw.deviceId);
  const deviceName =
    normalizeString(raw.device_name) ||
    normalizeString(raw.deviceName) ||
    normalizeString(raw.device_model) ||
    normalizeString(raw.deviceModel) ||
    normalizeString(raw.device_label) ||
    normalizeString(extras.deviceName);
  const appVersion = normalizeString(raw.app_version) || normalizeString(raw.appVersion) || normalizeString(extras.appVersion);
  const devicePlatform =
    normalizePlatform(raw.device_platform) ||
    normalizePlatform(raw.platform) ||
    normalizePlatform(raw.devicePlatform) ||
    normalizePlatform(extras.devicePlatform);

  return {
    deviceId: deviceUuid || pushToken,
    deviceUuid,
    deviceName,
    devicePlatform,
    pushToken,
    appVersion,
    ipAddress: normalizeString(extras.ipAddress),
    pushEnabled: extras.pushEnabled == null ? 1 : truthyFlag(extras.pushEnabled) ? 1 : 0,
  };
}

function authStatePayload(state) {
  return {
    valid_token: state.valid ? 1 : 0,
    token_present: state.tokenPresent ? 1 : 0,
    invalid_token: state.valid || !state.tokenPresent ? 0 : 1,
    token_status: state.tokenStatus,
    token_reason: state.reason || null,
    auth_state: state.valid ? 'authenticated' : 'unauthenticated',
  };
}

async function revokeOtherDriverSessions(pool, driverId, keepAuthToken, reason) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0) return;
  try {
    if (keepAuthToken) {
      await pool.query(
        `UPDATE ${SESSION_TABLE}
         SET is_active = 0, revoked_at = NOW(), revoked_reason = ?, date_modified = CURRENT_TIMESTAMP
         WHERE driver_id = ? AND auth_token <> ? AND (is_active IS NULL OR is_active = 1)`,
        [sessionReason(reason), did, keepAuthToken]
      );
    } else {
      await pool.query(
        `UPDATE ${SESSION_TABLE}
         SET is_active = 0, revoked_at = NOW(), revoked_reason = ?, date_modified = CURRENT_TIMESTAMP
         WHERE driver_id = ? AND (is_active IS NULL OR is_active = 1)`,
        [sessionReason(reason), did]
      );
    }
  } catch (e) {
    if (isSchemaCompatError(e)) return;
    throw e;
  }
}

async function createRiderSession(pool, driverId, authToken, ctx) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0 || !normalizeString(authToken)) return null;
  try {
    const [result] = await pool.query(
      `INSERT INTO ${SESSION_TABLE}
       (driver_id, auth_token, device_id, device_uuid, device_name, device_platform, push_token, app_version, ip_address, is_active, last_seen_at, date_created, date_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW(), NOW())`,
      [
        did,
        String(authToken).trim(),
        ctx.deviceId,
        ctx.deviceUuid,
        ctx.deviceName,
        ctx.devicePlatform,
        ctx.pushToken,
        ctx.appVersion,
        ctx.ipAddress,
      ]
    );
    return result && result.insertId ? Number(result.insertId) : null;
  } catch (e) {
    if (isSchemaCompatError(e)) return null;
    throw e;
  }
}

async function touchRiderSession(pool, authToken, ctx = {}) {
  const token = normalizeString(authToken);
  if (!token) return;
  try {
    await pool.query(
      `UPDATE ${SESSION_TABLE}
       SET last_seen_at = NOW(),
           device_id = COALESCE(?, device_id),
           device_uuid = COALESCE(?, device_uuid),
           device_name = COALESCE(?, device_name),
           device_platform = COALESCE(?, device_platform),
           push_token = COALESCE(?, push_token),
           app_version = COALESCE(?, app_version),
           ip_address = COALESCE(?, ip_address),
           date_modified = CURRENT_TIMESTAMP
       WHERE auth_token = ?`,
      [
        ctx.deviceId ?? null,
        ctx.deviceUuid ?? null,
        ctx.deviceName ?? null,
        ctx.devicePlatform ?? null,
        ctx.pushToken ?? null,
        ctx.appVersion ?? null,
        ctx.ipAddress ?? null,
        token,
      ]
    );
  } catch (e) {
    if (isSchemaCompatError(e)) return;
    throw e;
  }
}

async function deactivateOtherDeviceRows(pool, driverId, keepPushToken, keepAuthToken, reason) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0) return;
  const parts = ['driver_id = ?'];
  const params = [did];
  if (keepPushToken) {
    parts.push('device_id <> ?');
    params.push(keepPushToken);
  } else if (keepAuthToken) {
    parts.push('(auth_token IS NULL OR auth_token <> ?)');
    params.push(keepAuthToken);
  }
  try {
    await pool.query(
      `UPDATE ${DEVICE_TABLE}
       SET push_enabled = 0, is_active = 0, revoked_at = NOW(), revoked_reason = ?, date_modified = CURRENT_TIMESTAMP
       WHERE ${parts.join(' AND ')}`,
      [sessionReason(reason), ...params]
    );
    return;
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') {
      if (e.code === 'ER_NO_SUCH_TABLE') return;
      throw e;
    }
  }

  try {
    await pool.query(
      `UPDATE ${DEVICE_TABLE}
       SET push_enabled = 0, date_modified = CURRENT_TIMESTAMP
       WHERE ${parts.join(' AND ')}`,
      params
    );
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return;
    throw e;
  }
}

async function findReusableDriverSession(pool, driverId, rawContext, opts = {}) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0) return null;
  const ctx = resolveSessionContext(rawContext, opts);
  const clauses = [];
  const params = [did];

  if (ctx.deviceUuid) {
    clauses.push('device_uuid = ?');
    params.push(ctx.deviceUuid);
  }
  if (ctx.pushToken) {
    clauses.push('push_token = ?');
    params.push(ctx.pushToken);
    clauses.push('device_id = ?');
    params.push(ctx.pushToken);
  }
  if (!clauses.length) return null;

  try {
    const [rows] = await pool.query(
      `SELECT id, auth_token, driver_id, device_id, device_uuid, device_name, device_platform, push_token
       FROM ${SESSION_TABLE}
       WHERE driver_id = ?
         AND (is_active IS NULL OR is_active = 1 OR is_active = '1')
         AND revoked_at IS NULL
         AND (${clauses.join(' OR ')})
       ORDER BY id DESC
       LIMIT 1`,
      params
    );
    const row = rows && rows[0];
    if (!row || !normalizeString(row.auth_token)) return null;
    return {
      id: parseInt(String(row.id), 10),
      authToken: normalizeString(row.auth_token),
      driverId: parseInt(String(row.driver_id), 10),
      deviceId: normalizeString(row.device_id),
      deviceUuid: normalizeString(row.device_uuid),
      deviceName: normalizeString(row.device_name),
      devicePlatform: normalizePlatform(row.device_platform),
      pushToken: normalizeString(row.push_token),
    };
  } catch (e) {
    if (isSchemaCompatError(e)) return null;
    throw e;
  }
}

async function findActiveSessionForDevice(pool, rawContext, opts = {}) {
  const ctx = resolveSessionContext(rawContext, opts);
  const clauses = [];
  const params = [];

  if (ctx.deviceUuid) {
    clauses.push('s.device_uuid = ?');
    params.push(ctx.deviceUuid);
  }
  if (ctx.pushToken) {
    clauses.push('s.push_token = ?');
    params.push(ctx.pushToken);
    clauses.push('s.device_id = ?');
    params.push(ctx.pushToken);
  }
  if (!clauses.length) return null;

  try {
    const [rows] = await pool.query(
      `SELECT
         s.id AS session_id,
         s.auth_token,
         s.driver_id AS session_driver_id,
         s.device_id AS session_device_id,
         s.device_uuid AS session_device_uuid,
         s.device_name AS session_device_name,
         s.device_platform AS session_device_platform,
         s.push_token AS session_push_token,
         d.driver_id AS id,
         d.username,
         CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
         d.team_id,
         d.on_duty,
         d.device_id,
         d.device_platform
       FROM ${SESSION_TABLE} s
       INNER JOIN mt_driver d ON d.driver_id = s.driver_id
       WHERE (s.is_active IS NULL OR s.is_active = 1 OR s.is_active = '1')
         AND s.revoked_at IS NULL
         AND (${clauses.join(' OR ')})
       ORDER BY s.id DESC
       LIMIT 1`,
      params
    );
    const row = rows && rows[0];
    if (!row || !normalizeString(row.auth_token)) return null;
    return {
      valid: true,
      tokenPresent: true,
      tokenStatus: 'valid',
      reason: null,
      recovered: true,
      authToken: normalizeString(row.auth_token),
      driver: {
        id: row.id,
        username: row.username,
        full_name: row.full_name,
        team_id: row.team_id,
        on_duty: row.on_duty,
        device_id: row.device_id,
        device_platform: row.device_platform,
      },
      session: {
        id: row.session_id,
        driverId: row.session_driver_id,
        deviceId: row.session_device_id,
        deviceUuid: row.session_device_uuid,
        deviceName: row.session_device_name,
        devicePlatform: row.session_device_platform,
        pushToken: row.session_push_token,
      },
    };
  } catch (e) {
    if (isSchemaCompatError(e)) return null;
    throw e;
  }
}

async function upsertCurrentDeviceRow(pool, driverId, sessionId, authToken, ctx) {
  const did = parseInt(String(driverId), 10);
  const pushToken = normalizeString(ctx.pushToken);
  if (!Number.isFinite(did) || did <= 0 || !pushToken) return;

  const cols = await getColumnSet(pool, DEVICE_TABLE);
  if (!cols.size || !cols.has('driver_id') || !cols.has('device_id')) return;

  const updatePairs = [];
  const updateParams = [];
  if (cols.has('device_platform')) {
    updatePairs.push('device_platform = ?');
    updateParams.push(ctx.devicePlatform);
  }
  if (cols.has('device_uuid')) {
    updatePairs.push('device_uuid = COALESCE(?, device_uuid)');
    updateParams.push(ctx.deviceUuid);
  }
  if (cols.has('device_name')) {
    updatePairs.push('device_name = COALESCE(?, device_name)');
    updateParams.push(ctx.deviceName);
  }
  if (cols.has('push_enabled')) {
    updatePairs.push('push_enabled = ?');
    updateParams.push(ctx.pushEnabled);
  }
  if (cols.has('is_active')) {
    updatePairs.push('is_active = 1');
  }
  if (cols.has('session_id')) {
    updatePairs.push('session_id = ?');
    updateParams.push(sessionId);
  }
  if (cols.has('auth_token')) {
    updatePairs.push('auth_token = ?');
    updateParams.push(authToken);
  }
  if (cols.has('revoked_at')) updatePairs.push('revoked_at = NULL');
  if (cols.has('revoked_reason')) updatePairs.push('revoked_reason = NULL');
  if (cols.has('last_seen_at')) updatePairs.push('last_seen_at = NOW()');
  updatePairs.push('date_modified = CURRENT_TIMESTAMP');

  const updateSql = `UPDATE ${DEVICE_TABLE} SET ${updatePairs.join(', ')} WHERE driver_id = ? AND device_id = ?`;
  const [updated] = await pool.query(updateSql, [...updateParams, did, pushToken]);
  if (Number(updated?.affectedRows || 0) > 0) return;

  const insertCols = ['driver_id', 'device_id'];
  const insertVals = [did, pushToken];
  if (cols.has('device_platform')) {
    insertCols.push('device_platform');
    insertVals.push(ctx.devicePlatform);
  }
  if (cols.has('device_uuid')) {
    insertCols.push('device_uuid');
    insertVals.push(ctx.deviceUuid);
  }
  if (cols.has('device_name')) {
    insertCols.push('device_name');
    insertVals.push(ctx.deviceName);
  }
  if (cols.has('push_enabled')) {
    insertCols.push('push_enabled');
    insertVals.push(ctx.pushEnabled);
  }
  if (cols.has('is_active')) {
    insertCols.push('is_active');
    insertVals.push(1);
  }
  if (cols.has('session_id')) {
    insertCols.push('session_id');
    insertVals.push(sessionId);
  }
  if (cols.has('auth_token')) {
    insertCols.push('auth_token');
    insertVals.push(authToken);
  }
  if (cols.has('last_seen_at')) {
    insertCols.push('last_seen_at');
    insertVals.push(new Date());
  }

  const placeholders = insertCols.map(() => '?').join(', ');
  await pool.query(`INSERT INTO ${DEVICE_TABLE} (${insertCols.join(', ')}) VALUES (${placeholders})`, insertVals);
}

async function establishSingleDeviceSession(pool, driverId, authToken, rawContext, opts = {}) {
  const ctx = resolveSessionContext(rawContext, opts);
  await revokeOtherDriverSessions(pool, driverId, authToken, opts.revokedReason || 'logged_in_on_another_device');
  await deactivateOtherDeviceRows(pool, driverId, ctx.pushToken, authToken, opts.revokedReason || 'logged_in_on_another_device');
  const existingSessionId = parseInt(String(opts.existingSessionId), 10);
  const sessionId =
    Number.isFinite(existingSessionId) && existingSessionId > 0
      ? existingSessionId
      : await createRiderSession(pool, driverId, authToken, ctx);
  await touchRiderSession(pool, authToken, ctx);
  await upsertCurrentDeviceRow(pool, driverId, sessionId, authToken, ctx);
  return {
    sessionId,
    deviceId: ctx.deviceId,
    deviceUuid: ctx.deviceUuid,
    pushToken: ctx.pushToken,
    devicePlatform: ctx.devicePlatform,
    deviceName: ctx.deviceName,
  };
}

async function revokeSessionByToken(pool, authToken, reason, opts = {}) {
  const token = normalizeString(authToken);
  if (!token) return;
  try {
    await pool.query(
      `UPDATE ${SESSION_TABLE}
       SET is_active = 0, revoked_at = NOW(), revoked_reason = ?, date_modified = CURRENT_TIMESTAMP
       WHERE auth_token = ?`,
      [sessionReason(reason), token]
    );
  } catch (e) {
    if (!isSchemaCompatError(e)) throw e;
  }

  const conditions = ['auth_token = ?'];
  const params = [token];
  const deviceToken = normalizeString(opts.pushToken);
  if (!deviceToken) {
    try {
      await pool.query(
        `UPDATE ${DEVICE_TABLE}
         SET push_enabled = 0, is_active = 0, revoked_at = NOW(), revoked_reason = ?, date_modified = CURRENT_TIMESTAMP
         WHERE ${conditions.join(' AND ')}`,
        [sessionReason(reason), ...params]
      );
      return;
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') {
        if (e.code === 'ER_NO_SUCH_TABLE') return;
        throw e;
      }
    }
  }

  const simpleConds = ['driver_id = ?'];
  const simpleParams = [parseInt(String(opts.driverId), 10)];
  if (deviceToken) {
    simpleConds.push('device_id = ?');
    simpleParams.push(deviceToken);
  }
  try {
    await pool.query(
      `UPDATE ${DEVICE_TABLE}
       SET push_enabled = 0, date_modified = CURRENT_TIMESTAMP
       WHERE ${simpleConds.join(' AND ')}`,
      simpleParams
    );
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return;
    throw e;
  }
}

async function resolveDriverAuthState(pool, authToken) {
  const token = normalizeString(authToken);
  if (!token) {
    return {
      valid: false,
      tokenPresent: false,
      tokenStatus: 'missing',
      reason: 'missing_token',
      driver: null,
      session: null,
    };
  }

  try {
    const [rows] = await pool.query(
      `SELECT
         s.id AS session_id,
         s.driver_id AS session_driver_id,
         s.device_id AS session_device_id,
         s.device_uuid AS session_device_uuid,
         s.device_name AS session_device_name,
         s.device_platform AS session_device_platform,
         s.push_token AS session_push_token,
         s.is_active AS session_is_active,
         s.revoked_at AS session_revoked_at,
         s.revoked_reason AS session_revoked_reason,
         d.driver_id AS id,
         d.username,
         CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
         d.team_id,
         d.on_duty,
         d.device_id,
         d.device_platform
       FROM ${SESSION_TABLE} s
       INNER JOIN mt_driver d ON d.driver_id = s.driver_id
       WHERE s.auth_token = ?
       ORDER BY s.id DESC
       LIMIT 1`,
      [token]
    );
    const row = rows && rows[0];
    if (row) {
      const active = truthyFlag(row.session_is_active) && row.session_revoked_at == null;
      if (!active) {
        return {
          valid: false,
          tokenPresent: true,
          tokenStatus: 'invalid',
          reason: normalizeString(row.session_revoked_reason) || 'session_invalidated',
          driver: null,
          session: {
            id: row.session_id,
            driverId: row.session_driver_id,
            pushToken: row.session_push_token || null,
          },
        };
      }
      return {
        valid: true,
        tokenPresent: true,
        tokenStatus: 'valid',
        reason: null,
        driver: {
          id: row.id,
          username: row.username,
          full_name: row.full_name,
          team_id: row.team_id,
          on_duty: row.on_duty,
          device_id: row.device_id,
          device_platform: row.device_platform,
        },
        session: {
          id: row.session_id,
          driverId: row.session_driver_id,
          deviceId: row.session_device_id,
          deviceUuid: row.session_device_uuid,
          deviceName: row.session_device_name,
          devicePlatform: row.session_device_platform,
          pushToken: row.session_push_token,
        },
      };
    }
  } catch (e) {
    if (!isSchemaCompatError(e)) throw e;
  }

  const [[driver]] = await pool.query(
    `SELECT driver_id AS id, username, CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name, team_id, on_duty, device_id, device_platform
     FROM mt_driver WHERE token = ?`,
    [token]
  );
  if (!driver) {
    return {
      valid: false,
      tokenPresent: true,
      tokenStatus: 'invalid',
      reason: 'invalid_token',
      driver: null,
      session: null,
    };
  }
  return {
    valid: true,
    tokenPresent: true,
    tokenStatus: 'valid',
    reason: null,
    driver,
    session: null,
  };
}

async function fetchActiveRiderDevices(pool, driverId) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0) return [];

  const deviceCols = await getColumnSet(pool, DEVICE_TABLE);
  const sessionCols = await getColumnSet(pool, SESSION_TABLE);
  if (deviceCols.size) {
    const select = ['d.id', 'd.device_id', 'd.device_platform'];
    if (deviceCols.has('device_uuid')) select.push('d.device_uuid');
    if (deviceCols.has('device_name')) select.push('d.device_name');
    const where = ['d.driver_id = ?', "d.device_id IS NOT NULL", "TRIM(d.device_id) <> ''"];
    if (deviceCols.has('push_enabled')) {
      where.push("(d.push_enabled IS NULL OR d.push_enabled = 1 OR d.push_enabled = '1' OR LOWER(TRIM(CAST(d.push_enabled AS CHAR))) = 'true')");
    }
    if (deviceCols.has('is_active')) {
      where.push("(d.is_active IS NULL OR d.is_active = 1 OR d.is_active = '1')");
    }

    let join = '';
    if (sessionCols.size && deviceCols.has('session_id')) {
      join = ` INNER JOIN ${SESSION_TABLE} s ON s.id = d.session_id `;
      where.push("(s.is_active IS NULL OR s.is_active = 1 OR s.is_active = '1')");
      if (sessionCols.has('revoked_at')) where.push('s.revoked_at IS NULL');
    } else if (sessionCols.size && deviceCols.has('auth_token')) {
      join = ` INNER JOIN ${SESSION_TABLE} s ON s.auth_token = d.auth_token `;
      where.push("(s.is_active IS NULL OR s.is_active = 1 OR s.is_active = '1')");
      if (sessionCols.has('revoked_at')) where.push('s.revoked_at IS NULL');
    }

    try {
      const [rows] = await pool.query(
        `SELECT ${select.join(', ')}
         FROM ${DEVICE_TABLE} d
         ${join}
         WHERE ${where.join(' AND ')}
         ORDER BY d.date_modified DESC, d.id DESC`,
        [did]
      );
      if (Array.isArray(rows) && rows.length) return rows;
    } catch (e) {
      if (!isSchemaCompatError(e)) throw e;
    }
  }

  try {
    const [legacyRows] = await pool.query(
      `SELECT driver_id AS id, device_id, device_platform
       FROM mt_driver
       WHERE driver_id = ?
         AND device_id IS NOT NULL
         AND TRIM(device_id) <> ''
       LIMIT 1`,
      [did]
    );
    return legacyRows || [];
  } catch (e) {
    if (isSchemaCompatError(e)) return [];
    throw e;
  }
}

module.exports = {
  SESSION_TABLE,
  DEVICE_TABLE,
  authStatePayload,
  establishSingleDeviceSession,
  fetchActiveRiderDevices,
  findActiveSessionForDevice,
  findReusableDriverSession,
  resetColumnCache,
  resolveDriverAuthState,
  resolveSessionContext,
  revokeOtherDriverSessions,
  revokeSessionByToken,
  sessionReason,
  touchRiderSession,
};
