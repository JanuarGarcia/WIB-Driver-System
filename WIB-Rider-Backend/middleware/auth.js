const { pool } = require('../config/db');
const { error } = require('../lib/response');
const { authStatePayload, resolveDriverAuthState, resolveSessionContext, touchRiderSession } = require('../lib/riderSessionService');

const STORED_API_KEY_QUERY = "SELECT option_value FROM mt_option WHERE option_name = 'driver_api_hash_key' LIMIT 1";

/** Get api_key from query or body (form or json). */
function getApiKey(req) {
  return req.query?.api_key || req.body?.api_key || null;
}

/** Session token from query, JSON body, or Authorization: Bearer (trimmed). */
function getDriverTokenFromRequest(req) {
  const raw =
    req.query?.token ??
    req.body?.token ??
    req.body?.access_token ??
    (req.headers.authorization && req.headers.authorization.replace(/^Bearer\s+/i, ''));
  if (raw == null || raw === '') return null;
  const t = String(raw).trim();
  return t || null;
}

/** Validate api_key against stored API Hash Key (mt_option.driver_api_hash_key). Call after body is parsed. */
async function validateApiKey(req, res, next) {
  const key = getApiKey(req);
  let stored = process.env.API_HASH_KEY || 'GodissoGood@33';
  try {
    const [[row]] = await pool.query(STORED_API_KEY_QUERY);
    stored = row?.option_value || stored;
  } catch (e) {
    // Many fresh installs don't have mt_option yet; keep serving the API using env/default key.
    if (e && e.code !== 'ER_NO_SUCH_TABLE') {
      console.error('[validateApiKey] db error', { requestId: req.requestId, code: e.code, message: e.message || String(e) });
      return res.status(503).json({
        code: 2,
        msg: 'Service unavailable (database)',
        details: null,
        request_id: req.requestId || null,
      });
    }
  }
  if (!key) {
    return error(res, 'API key is required', 2);
  }
  if (key !== stored) {
    return error(res, 'Invalid API key', 2);
  }
  next();
}

function sendAuthEnvelope(res, httpStatus, msg, state) {
  const details = authStatePayload(state);
  return res.status(httpStatus).json({ code: 2, msg, details });
}

/** Resolve driver by token (query or body). Attach req.driver. Uses existing table mt_driver. */
async function resolveDriver(req, res, next) {
  const token = getDriverTokenFromRequest(req);
  if (!token) {
    return sendAuthEnvelope(res, 401, 'Token required', {
      valid: false,
      tokenPresent: false,
      tokenStatus: 'missing',
      reason: 'missing_token',
    });
  }
  let state;
  try {
    state = await resolveDriverAuthState(pool, token);
  } catch (e) {
    console.error('[resolveDriver] db error', { requestId: req.requestId, code: e.code, message: e.message || String(e) });
    return res.status(503).json({
      code: 2,
      msg: 'Service unavailable (database)',
      details: authStatePayload({
        valid: false,
        tokenPresent: true,
        tokenStatus: 'unknown',
        reason: 'db_unavailable',
      }),
      request_id: req.requestId || null,
    });
  }
  req.driverTokenState = state.tokenStatus;
  req.driverTokenReason = state.reason || null;
  req.driver = state.driver || null;
  req.driverSession = state.session || null;
  req.driverAuthToken = token;
  if (!state.valid || !state.driver) {
    const msg = state.reason === 'logged_in_on_another_device' ? 'Session expired: logged in on another device' : 'Invalid token';
    return sendAuthEnvelope(res, state.reason === 'missing_token' ? 401 : 403, msg, state);
  }
  try {
    await touchRiderSession(
      pool,
      token,
      resolveSessionContext(req.body || {}, {
        devicePlatform: req.body?.device_platform,
        appVersion: req.body?.app_version ?? req.body?.appVersion,
        ipAddress: req.ip || req.connection?.remoteAddress || null,
      })
    );
  } catch (e) {
    // Don't fail the whole request just because we couldn't update "last seen".
    console.warn('[resolveDriver] could not touch session', { requestId: req.requestId, message: e.message || String(e) });
  }
  next();
}

/** Optional: resolve driver if token present; req.driver may be null. */
async function optionalDriver(req, res, next) {
  const token = getDriverTokenFromRequest(req);
  if (!token) {
    req.driverTokenState = 'missing';
    req.driverTokenReason = 'missing_token';
    req.driver = null;
    req.driverSession = null;
    req.driverAuthToken = null;
    return next();
  }
  let state;
  try {
    state = await resolveDriverAuthState(pool, token);
  } catch (e) {
    console.error('[optionalDriver] db error', { requestId: req.requestId, code: e.code, message: e.message || String(e) });
    req.driverTokenState = 'unknown';
    req.driverTokenReason = 'db_unavailable';
    req.driver = null;
    req.driverSession = null;
    req.driverAuthToken = token;
    return next();
  }
  req.driverTokenState = state.tokenStatus;
  req.driverTokenReason = state.reason || null;
  req.driver = state.driver || null;
  req.driverSession = state.session || null;
  req.driverAuthToken = token;
  if (state.valid) {
    try {
      await touchRiderSession(
        pool,
        token,
        resolveSessionContext(req.body || {}, {
          devicePlatform: req.body?.device_platform,
          appVersion: req.body?.app_version ?? req.body?.appVersion,
          ipAddress: req.ip || req.connection?.remoteAddress || null,
        })
      );
    } catch (e) {
      console.warn('[optionalDriver] could not touch session', { requestId: req.requestId, message: e.message || String(e) });
    }
  }
  next();
}

module.exports = {
  validateApiKey,
  resolveDriver,
  optionalDriver,
  getApiKey,
  getDriverTokenFromRequest,
};
