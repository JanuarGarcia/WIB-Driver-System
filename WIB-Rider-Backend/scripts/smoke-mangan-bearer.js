/**
 * Smoke test for the legacy Mangan driver API bearer flow.
 *
 * Usage:
 *   node -r dotenv/config scripts/smoke-mangan-bearer.js <username> <password> [base_url] [protected_path]
 *
 * Examples:
 *   node -r dotenv/config scripts/smoke-mangan-bearer.js rider@example.com secret
 *   node -r dotenv/config scripts/smoke-mangan-bearer.js rider@example.com secret https://order.wheninbaguioeat.com /driver/profile
 *
 * Env:
 *   MANGAN_DRIVER_API_BASE_URL - default base URL when 3rd arg omitted
 *   MANGAN_DRIVER_API_KEY - optional mobile API key; sent as Authorization: Bearer on /driver/login
 *   MANGAN_DRIVER_SEND_API_KEY_ON_LOGIN - set to 1/true/on to also include `api_key` in the /driver/login JSON body
 *   MANGAN_DRIVER_SEND_API_KEY_ON_ACTIONS - set to 1/true/on to include `api_key` on protected action bodies
 *   MANGAN_SMOKE_PATH - default protected path when 4th arg omitted (default /driver/profile)
 *   MANGAN_SMOKE_METHOD - optional method for protected call (default POST)
 *   MANGAN_SMOKE_BODY - optional JSON body for the protected call
 *   MANGAN_PROFILE_PATH - optional profile endpoint for driver_uuid discovery (default /driver/profile)
 *   MANGAN_PROFILE_METHOD - optional method for profile discovery (default POST)
 *   MANGAN_PROFILE_BODY - optional JSON body for profile discovery
 *   MANGAN_SHIFT_PATH - optional shift endpoint for schedule_uuid discovery (default /driver/getshift)
 *   MANGAN_SHIFT_METHOD - optional method for shift discovery (default POST)
 *   MANGAN_SHIFT_BODY - optional JSON body for shift discovery
 *   MANGAN_CURRENT_SHIFT_PATH - optional fallback endpoint for schedule_uuid discovery (default /driver/currentShift)
 *   MANGAN_CURRENT_SHIFT_METHOD - optional method for currentShift discovery (default POST)
 *   MANGAN_CURRENT_SHIFT_BODY - optional JSON body for currentShift discovery
 */
'use strict';

require('dotenv').config();
const http = require('http');
const https = require('https');

function normalizeBaseUrl(v) {
  return String(v || '').trim().replace(/\/+$/, '');
}

function optionalApiKey() {
  const raw = process.env.MANGAN_DRIVER_API_KEY;
  return raw != null && String(raw).trim() !== '' ? String(raw).trim() : '';
}

function truthyEnv(v) {
  if (v == null || v === '') return false;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function includeApiKeyOnLogin() {
  return truthyEnv(process.env.MANGAN_DRIVER_SEND_API_KEY_ON_LOGIN);
}

function includeApiKeyOnActions() {
  return truthyEnv(process.env.MANGAN_DRIVER_SEND_API_KEY_ON_ACTIONS);
}

function requestJson(urlStr, { method = 'POST', headers = {}, body } = {}) {
  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? https : http;
  const hasBody = body !== undefined;
  const payload = hasBody ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          Accept: 'application/json',
          ...(hasBody ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => {
          chunks += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = chunks ? JSON.parse(chunks) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, raw: chunks, json });
        });
      }
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function bodyPreview(raw, max = 300) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseOptionalJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch (e) {
    console.error(`FAIL: MANGAN_SMOKE_BODY must be valid JSON (${e.message || String(e)})`);
    process.exit(1);
  }
}

function normalizePath(v, fallback) {
  const s = String(v || '').trim();
  if (!s) return fallback;
  return s.startsWith('/') ? s : `/${s}`;
}

function getPathValue(obj, dottedPath) {
  const parts = String(dottedPath || '')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function pickUuidCandidate(json, candidatePaths) {
  for (const path of candidatePaths) {
    const raw = getPathValue(json, path);
    if (raw != null && String(raw).trim() !== '') return String(raw).trim();
  }
  return null;
}

function extractDriverUuid(json) {
  return pickUuidCandidate(json, [
    'details.driver_uuid',
    'data.driver_uuid',
    'driver_uuid',
    'details.driver.driver_uuid',
    'details.driver.uuid',
    'details.driverUuid',
    'data.driver.driver_uuid',
    'data.driver.uuid',
    'details.uuid',
    'data.uuid',
  ]);
}

function extractScheduleUuid(json) {
  return pickUuidCandidate(json, [
    'details.schedule_uuid',
    'data.schedule_uuid',
    'schedule_uuid',
    'details.data.0.schedule_uuid',
    'details.data.0.uuid',
    'details.schedules.0.schedule_uuid',
    'details.schedules.0.uuid',
    'details.shift.schedule_uuid',
    'details.shift.uuid',
    'details.schedule.uuid',
    'details.schedule.schedule_uuid',
    'details.current_shift.schedule_uuid',
    'details.current_shift.uuid',
    'data.0.schedule_uuid',
    'data.0.uuid',
    'data.current_shift.schedule_uuid',
    'data.current_shift.uuid',
    'data.shift.schedule_uuid',
    'data.shift.uuid',
    'data.schedule.uuid',
    'data.schedule.schedule_uuid',
  ]);
}

async function requestProtectedJson(baseUrl, token, path, method, body, apiKey) {
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const nextBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? { ...body }
      : body;
  if (apiKey && includeApiKeyOnActions() && nextBody && typeof nextBody === 'object' && nextBody.api_key == null) {
    nextBody.api_key = apiKey;
  }
  return requestJson(url, {
    method,
    headers: { Authorization: `token ${token}` },
    body: nextBody,
  });
}

async function smokeManganBearer(opts) {
  const username = opts.username;
  const password = opts.password;
  const baseUrl = normalizeBaseUrl(opts.baseUrl || 'https://order.wheninbaguioeat.com');
  const protectedPath = String(opts.protectedPath || '/driver/profile').trim() || '/driver/profile';
  const protectedMethod = String(opts.protectedMethod || 'POST').trim().toUpperCase() || 'POST';
  const protectedBody = opts.protectedBody;
  const profilePath = normalizePath(opts.profilePath || process.env.MANGAN_PROFILE_PATH || '/driver/profile', '/driver/profile');
  const profileMethod = String(opts.profileMethod || process.env.MANGAN_PROFILE_METHOD || 'POST').trim().toUpperCase() || 'POST';
  const profileBody = opts.profileBody !== undefined ? opts.profileBody : parseOptionalJson(process.env.MANGAN_PROFILE_BODY);
  const shiftPath = normalizePath(opts.shiftPath || process.env.MANGAN_SHIFT_PATH || '/driver/getshift', '/driver/getshift');
  const shiftMethod = String(opts.shiftMethod || process.env.MANGAN_SHIFT_METHOD || 'POST').trim().toUpperCase() || 'POST';
  const shiftBody = opts.shiftBody !== undefined ? opts.shiftBody : parseOptionalJson(process.env.MANGAN_SHIFT_BODY);
  const currentShiftPath = normalizePath(
    opts.currentShiftPath || process.env.MANGAN_CURRENT_SHIFT_PATH || '/driver/currentShift',
    '/driver/currentShift'
  );
  const currentShiftMethod =
    String(opts.currentShiftMethod || process.env.MANGAN_CURRENT_SHIFT_METHOD || 'POST').trim().toUpperCase() || 'POST';
  const currentShiftBody =
    opts.currentShiftBody !== undefined ? opts.currentShiftBody : parseOptionalJson(process.env.MANGAN_CURRENT_SHIFT_BODY);
  const apiKey = optionalApiKey();

  if (!username || !password) {
    console.error('Usage: node -r dotenv/config scripts/smoke-mangan-bearer.js <username> <password> [base_url] [protected_path]');
    process.exit(1);
  }
  if (!baseUrl) {
    console.error('FAIL: missing base URL (set arg 3 or MANGAN_DRIVER_API_BASE_URL)');
    process.exit(1);
  }

  const loginUrl = `${baseUrl}/driver/login`;
  console.log(`Login: ${loginUrl}`);
  const loginBody = { username, password };
  if (apiKey && includeApiKeyOnLogin()) loginBody.api_key = apiKey;
  const loginHeaders = {};
  if (apiKey) {
    // Live Mangan accepts the mobile API key as Authorization: Bearer on /driver/login.
    loginHeaders.Authorization = `Bearer ${apiKey}`;
  }
  const login = await requestJson(loginUrl, {
    method: 'POST',
    headers: loginHeaders,
    body: loginBody,
  });

  if (!(login.status >= 200 && login.status < 500)) {
    console.error(
      `Login HTTP status: ${login.status} location=${login.headers?.location || ''} preview=${bodyPreview(login.raw)}`
    );
  }
  assert(login.status >= 200 && login.status < 500, `unexpected login HTTP status ${login.status}`);
  if (!(login.json && typeof login.json === 'object')) {
    console.error(
      `Login non-JSON response: status=${login.status} location=${login.headers?.location || ''} preview=${bodyPreview(login.raw)}`
    );
  }
  assert(login.json && typeof login.json === 'object', `expected login JSON, got ${bodyPreview(login.raw)}`);
  assert(login.json.code === 1, `login failed code=${login.json.code} msg=${login.json.msg || ''}`);
  const token = login.json?.details?.user_token;
  assert(token && String(token).trim(), 'expected details.user_token from /driver/login');
  console.log('PASS: login returned user_token');

  const protectedUrl = `${baseUrl}${protectedPath.startsWith('/') ? protectedPath : `/${protectedPath}`}`;
  console.log(`Protected: ${protectedMethod} ${protectedUrl}`);
  const protectedRes = await requestProtectedJson(baseUrl, token, protectedPath, protectedMethod, protectedBody, apiKey);

  assert(protectedRes.status !== 401, `protected endpoint returned 401 (${protectedRes.raw.slice(0, 300)})`);
  assert(protectedRes.status >= 200 && protectedRes.status < 500, `unexpected protected HTTP status ${protectedRes.status}`);

  const rawLower = String(protectedRes.raw || '').toLowerCase();
  const jsonMsg = String(protectedRes.json?.msg || '').toLowerCase();
  const authRejected =
    rawLower.includes('invalid token') ||
    rawLower.includes('not login') ||
    rawLower.includes('unauthorized') ||
    jsonMsg.includes('invalid token') ||
    jsonMsg.includes('not login') ||
    jsonMsg.includes('unauthorized');
  assert(!authRejected, `protected endpoint rejected token auth (${protectedRes.raw.slice(0, 300)})`);

  console.log(`PASS: token auth request accepted (HTTP ${protectedRes.status})`);
  if (protectedRes.json) {
    console.log(`Response JSON: ${JSON.stringify(protectedRes.json).slice(0, 500)}`);
  } else if (protectedRes.raw) {
    console.log(`Response Raw: ${protectedRes.raw.slice(0, 500)}`);
  } else {
    console.log('Response: <empty body>');
  }

  let driverUuid = null;
  let scheduleUuid = null;

  if (normalizePath(protectedPath, protectedPath) === profilePath && protectedRes.json) {
    driverUuid = extractDriverUuid(protectedRes.json);
  }
  const normalizedProtectedPath = normalizePath(protectedPath, protectedPath);
  if ((normalizedProtectedPath === shiftPath || normalizedProtectedPath === currentShiftPath) && protectedRes.json) {
    scheduleUuid = extractScheduleUuid(protectedRes.json);
  }

  if (!driverUuid) {
    const profileRes = await requestProtectedJson(baseUrl, token, profilePath, profileMethod, profileBody, apiKey);
    assert(profileRes.status !== 401, `profile endpoint returned 401 (${profileRes.raw.slice(0, 300)})`);
    driverUuid = extractDriverUuid(profileRes.json);
    if (driverUuid) {
      console.log(`PASS: profile returned driver_uuid=${driverUuid}`);
    } else {
      console.log(`WARN: profile response did not include driver_uuid (path=${profilePath})`);
    }
  } else {
    console.log(`PASS: protected response returned driver_uuid=${driverUuid}`);
  }

  if (!scheduleUuid) {
    const attempts = [
      { label: 'shift', path: shiftPath, method: shiftMethod, body: shiftBody },
      { label: 'currentShift', path: currentShiftPath, method: currentShiftMethod, body: currentShiftBody },
    ];
    for (const attempt of attempts) {
      const shiftRes = await requestProtectedJson(baseUrl, token, attempt.path, attempt.method, attempt.body, apiKey);
      assert(shiftRes.status !== 401, `${attempt.label} endpoint returned 401 (${shiftRes.raw.slice(0, 300)})`);
      scheduleUuid = extractScheduleUuid(shiftRes.json);
      if (scheduleUuid) {
        console.log(`PASS: ${attempt.label} returned schedule_uuid=${scheduleUuid}`);
        break;
      }
      console.log(`WARN: ${attempt.label} response did not include schedule_uuid (path=${attempt.path})`);
    }
  } else {
    console.log(`PASS: protected response returned schedule_uuid=${scheduleUuid}`);
  }

  const envSummary = {
    baseUrl,
    userToken: token,
    driverUuid,
    scheduleUuid,
  };
  console.log(`Env JSON: ${JSON.stringify(envSummary)}`);
  return envSummary;
}

async function main() {
  await smokeManganBearer({
    username: process.argv[2],
    password: process.argv[3],
    baseUrl: process.argv[4] || process.env.MANGAN_DRIVER_API_BASE_URL || 'https://order.wheninbaguioeat.com',
    protectedPath: process.argv[5] || process.env.MANGAN_SMOKE_PATH || '/driver/profile',
    protectedMethod: process.env.MANGAN_SMOKE_METHOD || 'POST',
    protectedBody: parseOptionalJson(process.env.MANGAN_SMOKE_BODY),
  });
}

module.exports = {
  extractDriverUuid,
  extractScheduleUuid,
  normalizeBaseUrl,
  requestProtectedJson,
  requestJson,
  smokeManganBearer,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
