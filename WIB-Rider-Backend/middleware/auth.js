const { pool } = require('../config/db');
const { error } = require('../lib/response');

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

/** Resolve driver by token (query or body). Attach req.driver. Uses existing table mt_driver. */
async function resolveDriver(req, res, next) {
  const token = getDriverTokenFromRequest(req);
  if (!token) {
    return error(res, 'Token required', 2);
  }
  const [[driver]] = await pool.query(
    `SELECT driver_id AS id, username, CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name, team_id, on_duty, device_id, device_platform FROM mt_driver WHERE token = ?`,
    [token]
  );
  if (!driver) {
    return error(res, 'Invalid token', 2);
  }
  req.driverTokenState = 'valid';
  req.driver = driver;
  next();
}

/** Optional: resolve driver if token present; req.driver may be null. */
async function optionalDriver(req, res, next) {
  const token = getDriverTokenFromRequest(req);
  if (!token) {
    req.driverTokenState = 'missing';
    req.driver = null;
    return next();
  }
  const [[driver]] = await pool.query(
    `SELECT driver_id AS id, username, CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name, team_id, on_duty FROM mt_driver WHERE token = ?`,
    [token]
  );
  req.driverTokenState = driver ? 'valid' : 'invalid';
  req.driver = driver || null;
  next();
}

module.exports = {
  validateApiKey,
  resolveDriver,
  optionalDriver,
  getApiKey,
  getDriverTokenFromRequest,
};
