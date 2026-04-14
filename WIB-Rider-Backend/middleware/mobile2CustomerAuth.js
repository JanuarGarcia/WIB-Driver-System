'use strict';

const { pool } = require('../config/db');
const { validateApiKey } = require('./auth');
const { error } = require('../lib/response');
const { loadTableColumnSet } = require('../lib/mobile2DeviceRegLookup');

let mtClientTokenColCache = null;

async function resolveMtClientTokenColumn() {
  if (mtClientTokenColCache) return mtClientTokenColCache;
  const cols = await loadTableColumnSet(pool, 'mt_client');
  if (cols.has('token')) mtClientTokenColCache = 'token';
  else if (cols.has('access_token')) mtClientTokenColCache = 'access_token';
  else if (cols.has('session_token')) mtClientTokenColCache = 'session_token';
  else mtClientTokenColCache = null;
  return mtClientTokenColCache;
}

function getCustomerTokenFromRequest(req) {
  const raw =
    req.query?.token ??
    req.body?.token ??
    req.body?.access_token ??
    (req.headers.authorization && req.headers.authorization.replace(/^Bearer\s+/i, ''));
  if (raw == null || raw === '') return null;
  const token = String(raw).trim();
  return token || null;
}

function requireMobile2CustomerAuth(req, res, next) {
  validateApiKey(req, res, async () => {
    try {
      const token = getCustomerTokenFromRequest(req);
      if (!token) return error(res, 'Invalid token', 2);

      const tokenCol = await resolveMtClientTokenColumn();
      if (!tokenCol) return error(res, 'Customer token auth is not configured', 2);

      const [rows] = await pool.query(
        `SELECT client_id, first_name, last_name FROM mt_client WHERE \`${tokenCol}\` = ? LIMIT 1`,
        [token]
      );
      const row = rows && rows[0];
      if (!row) return error(res, 'Invalid token', 2);

      const clientId = parseInt(String(row.client_id), 10);
      if (!Number.isFinite(clientId) || clientId <= 0) return error(res, 'Invalid token', 2);

      req.customer = {
        client_id: clientId,
        first_name: row.first_name || '',
        last_name: row.last_name || '',
      };
      return next();
    } catch (e) {
      console.error('[mobile2CustomerAuth] auth failed', e);
      return error(res, 'Authentication failed', 2);
    }
  });
}

module.exports = { requireMobile2CustomerAuth };
