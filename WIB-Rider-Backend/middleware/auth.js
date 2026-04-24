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
  const [[row]] = await pool.query(STORED_API_KEY_QUERY);
  const stored = row?.option_value || process.env.API_HASH_KEY || 'GodissoGood@33';
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
  const state = await resolveDriverAuthState(pool, token);
  req.driverTokenState = state.tokenStatus;
  req.driverTokenReason = state.reason || null;
  req.driver = state.driver || null;
  req.driverSession = state.session || null;
  req.driverAuthToken = token;
  if (!state.valid || !state.driver) {
    const msg = state.reason === 'logged_in_on_another_device' ? 'Session expired: logged in on another device' : 'Invalid token';
    return sendAuthEnvelope(res, state.reason === 'missing_token' ? 401 : 403, msg, state);
  }
  await touchRiderSession(pool, token, resolveSessionContext(req.body || {}, {
    devicePlatform: req.body?.device_platform,
    appVersion: req.body?.app_version ?? req.body?.appVersion,
    ipAddress: req.ip || req.connection?.remoteAddress || null,
  }));
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
  const state = await resolveDriverAuthState(pool, token);
  req.driverTokenState = state.tokenStatus;
  req.driverTokenReason = state.reason || null;
  req.driver = state.driver || null;
  req.driverSession = state.session || null;
  req.driverAuthToken = token;
  if (state.valid) {
    await touchRiderSession(pool, token, resolveSessionContext(req.body || {}, {
      devicePlatform: req.body?.device_platform,
      appVersion: req.body?.app_version ?? req.body?.appVersion,
      ipAddress: req.ip || req.connection?.remoteAddress || null,
    }));
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
