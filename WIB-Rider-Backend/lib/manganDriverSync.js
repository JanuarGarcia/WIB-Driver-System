/**
 * Server-to-server calls to the legacy Mangan rider API (PHP DriverController)
 * so order status changes trigger the same customer notifications as the native Mangan rider app.
 *
 * IMPORTANT: Mangan PHP validates the *logged-in driver* matches st_ordernew.driver_id.
 * So we must login as that assigned Mangan driver (st_driver) for the given order.
 *
 * Requires per-driver Mangan login stored on Mangan DB st_driver (recommended),
 * or a single fallback Mangan login (dev/test only).
 */

const { URL } = require('url');

/** @type {Map<string, { token: string, expiresAtMs: number }>} */
const tokenCache = new Map();

const ALLOWED_ACTIONS = new Set([
  'acceptorder',
  'declineorder',
  'onthewayvendor',
  'arrivedatvendor',
  'waitingfororder',
  'orderpickup',
  'onthewaycustomer',
  'arrivedatcustomer',
  'orderdelivered',
  'deliveryfailed',
]);

/** Default WIB errand canonical status → Mangan driver action (path segment under /driver/). */
const DEFAULT_CANONICAL_TO_ACTION = {
  assigned: 'acceptorder',
  acknowledged: 'onthewayvendor',
  started: 'arrivedatvendor',
  inprogress: 'orderpickup',
  verification: 'onthewaycustomer',
  pending_verification: 'arrivedatcustomer',
  successful: 'orderdelivered',
  failed: 'deliveryfailed',
  declined: 'declineorder',
};

function truthyEnv(v) {
  if (v == null || v === '') return false;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function isEnabled() {
  return truthyEnv(process.env.MANGAN_DRIVER_SYNC_ENABLED);
}

function getBaseUrl() {
  const raw = (process.env.MANGAN_DRIVER_API_BASE_URL || 'https://order.wheninbaguioeat.com').trim().replace(/\/$/, '');
  return raw;
}

function parseCustomMap() {
  const raw = process.env.MANGAN_SYNC_STATUS_MAP_JSON;
  if (!raw || !String(raw).trim()) return null;
  try {
    const o = JSON.parse(String(raw));
    if (o && typeof o === 'object') return /** @type {Record<string, string>} */ (o);
  } catch {
    /* ignore */
  }
  return null;
}

function canonicalToAction(canonical) {
  const custom = parseCustomMap();
  if (custom && custom[canonical]) return custom[canonical];
  return DEFAULT_CANONICAL_TO_ACTION[canonical] || null;
}

/**
 * @param {import('mysql2/promise').Pool} errandPool Mangan/ErrandWib pool (must contain st_driver + st_ordernew)
 * @param {number} manganDriverId st_driver.driver_id
 */
async function resolveManganCredentials(errandPool, manganDriverId) {
  const userCol = (process.env.MANGAN_ST_DRIVER_USER_COL || 'wib_sync_username').trim() || 'wib_sync_username';
  const passCol = (process.env.MANGAN_ST_DRIVER_PASS_COL || 'wib_sync_password').trim() || 'wib_sync_password';
  try {
    const [[row]] = await errandPool.query(
      `SELECT \`${userCol}\` AS u, \`${passCol}\` AS p, email, password
       FROM st_driver WHERE driver_id = ? LIMIT 1`,
      [manganDriverId]
    );
    // Preferred: explicit WIB sync creds (plaintext you control).
    if (row?.u && row?.p) {
      return { username: String(row.u).trim(), password: String(row.p) };
    }
    // Fallback: try native Mangan driver email/password columns (often hashed; works only if /driver/login expects hashed input).
    if (row?.email && row?.password) {
      return { username: String(row.email).trim(), password: String(row.password) };
    }
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  const fu = process.env.MANGAN_SYNC_FALLBACK_USERNAME;
  const fp = process.env.MANGAN_SYNC_FALLBACK_PASSWORD;
  if (fu && fp) return { username: String(fu).trim(), password: String(fp) };
  return null;
}

/** @param {string} seg JWT payload segment (base64url) */
function b64UrlToUtf8(seg) {
  const s = String(seg).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64').toString('utf8');
}

/** @param {string} jwt */
function jwtExpiryMs(jwt) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length < 2) return 0;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      payload = JSON.parse(b64UrlToUtf8(parts[1]));
    }
    if (payload.exp && Number.isFinite(Number(payload.exp))) return Number(payload.exp) * 1000;
  } catch {
    /* ignore */
  }
  return 0;
}

function cacheKey(driverId, username) {
  return `${driverId}:${username}`;
}

/**
 * @param {string} baseUrl
 * @param {string} username
 * @param {string} password
 */
async function loginMangan(baseUrl, username, password) {
  const url = new URL('/driver/login', `${baseUrl}/`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Mangan login: non-JSON (${res.status})`);
  }
  const code = json?.code;
  const token = json?.details?.user_token;
  if (code !== 1 || !token) {
    const msg = json?.msg || 'login failed';
    throw new Error(`Mangan login: ${msg}`);
  }
  return String(token);
}

/**
 * @param {number} driverId
 * @param {{ username: string, password: string }} creds
 */
async function getBearerToken(driverId, creds) {
  const base = getBaseUrl();
  const ck = cacheKey(driverId, creds.username);
  const cached = tokenCache.get(ck);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now + 60_000) {
    return cached.token;
  }
  const token = await loginMangan(base, creds.username, creds.password);
  const exp = jwtExpiryMs(token);
  const expiresAtMs = exp > now ? exp : now + 45 * 60_000;
  tokenCache.set(ck, { token, expiresAtMs });
  return token;
}

/**
 * @param {string} baseUrl
 * @param {string} bearer
 * @param {string} action
 * @param {Record<string, unknown>} body
 */
async function postDriverAction(baseUrl, bearer, action, body) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Invalid Mangan action: ${action}`);
  }
  const url = new URL(`/driver/${action}`, `${baseUrl}/`);
  const timeoutMs = Math.min(Math.max(parseInt(String(process.env.MANGAN_SYNC_TIMEOUT_MS || '20000'), 10) || 20000, 5000), 60000);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: res.status, raw: text.slice(0, 500) };
    }
    return { ok: res.ok, httpStatus: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

function shouldIgnoreFailureMessage(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('cannot be the same as current') ||
    m.includes('same as current status') ||
    m.includes('not login') ||
    m.includes('not assigned')
  );
}

/**
 * @param {object} opts
 * @param {import('mysql2/promise').Pool} opts.mainPool Unused for auth; kept for backward compatibility
 * @param {import('mysql2/promise').Pool} opts.errandPool Must contain st_ordernew + st_driver
 * @param {{ id: number, username?: string|null }=} opts.driver WIB driver (optional; not used for Mangan auth)
 * @param {number} opts.orderId st_ordernew.order_id
 * @param {string|null|undefined} opts.orderUuid Mangan order UUID
 * @param {string} opts.canonical errandDriverStatus canonical
 * @param {{ reason?: string, otpCode?: string, proofBase64?: string, imageType?: string, overrideAction?: string }} [opts.extras]
 */
async function syncErrandStatusToMangan(opts) {
  if (!isEnabled()) return { skipped: true, reason: 'disabled' };

  const { errandPool, orderId, orderUuid: uuidIn, canonical, extras } = opts;
  let orderUuid = uuidIn != null && String(uuidIn).trim() !== '' ? String(uuidIn).trim() : '';
  let manganDriverId = null;
  try {
    const [[row]] = await errandPool.query('SELECT order_uuid, driver_id FROM st_ordernew WHERE order_id = ? LIMIT 1', [orderId]);
    if (!orderUuid && row?.order_uuid != null) orderUuid = String(row.order_uuid).trim();
    const d = row?.driver_id != null ? parseInt(String(row.driver_id), 10) : NaN;
    manganDriverId = Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    /* ignore */
  }
  if (!orderUuid) return { skipped: true, reason: 'no_order_uuid' };
  if (!manganDriverId) return { skipped: true, reason: 'no_assigned_mangan_driver' };

  const creds = await resolveManganCredentials(errandPool, manganDriverId);
  if (!creds) {
    return { skipped: true, reason: 'no_credentials' };
  }

  let action =
    extras?.overrideAction && ALLOWED_ACTIONS.has(extras.overrideAction) ? extras.overrideAction : canonicalToAction(canonical);
  if (!action) {
    return { skipped: true, reason: 'no_action_for_status', canonical };
  }

  const baseUrl = getBaseUrl();
  let bearer;
  try {
    bearer = await getBearerToken(manganDriverId, creds);
  } catch (e) {
    return { ok: false, phase: 'login', error: e.message || String(e) };
  }

  /** @type {Record<string, unknown>} */
  const body = { order_uuid: orderUuid };
  if (action === 'declineorder' || action === 'deliveryfailed') {
    if (extras?.reason) body.reason = String(extras.reason);
  }
  if (action === 'orderdelivered') {
    if (extras?.otpCode) body.otp_code = String(extras.otpCode);
    if (extras?.proofBase64) body.file_data = String(extras.proofBase64);
    if (extras?.imageType) body.image_type = String(extras.imageType);
  }

  let result;
  try {
    result = await postDriverAction(baseUrl, bearer, action, body);
  } catch (e) {
    const name = e.name === 'AbortError' ? 'timeout' : e.message || String(e);
    return { ok: false, phase: 'request', action, error: name };
  }

  const json = result.json;
  const code = json?.code;
  const msg = json?.msg != null ? String(json.msg) : '';

  if (result.httpStatus === 401) {
    tokenCache.delete(cacheKey(manganDriverId, creds.username));
  }

  if (code === 1) {
    return { ok: true, action, details: json?.details };
  }

  if (shouldIgnoreFailureMessage(msg)) {
    return { ok: true, action, ignored: true, msg };
  }

  return { ok: false, phase: 'mangan', action, httpStatus: result.httpStatus, code, msg, raw: result.raw };
}

function logOutcome(orderId, canonical, out) {
  if (!truthyEnv(process.env.MANGAN_SYNC_LOG)) return;
  const payload = { orderId, canonical, ...out };
  console.info('[mangan-sync]', JSON.stringify(payload));
}

/**
 * Fire-and-forget: never throws to caller.
 */
function fireManganSync(opts) {
  if (!isEnabled()) return;
  syncErrandStatusToMangan(opts)
    .then((out) => logOutcome(opts.orderId, opts.canonical, out))
    .catch((e) => logOutcome(opts.orderId, opts.canonical, { ok: false, error: e.message || String(e) }));
}

module.exports = {
  isEnabled,
  syncErrandStatusToMangan,
  fireManganSync,
  canonicalToAction,
  ALLOWED_ACTIONS,
};
