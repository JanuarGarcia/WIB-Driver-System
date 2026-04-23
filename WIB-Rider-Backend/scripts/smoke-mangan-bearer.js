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
 *   MANGAN_DRIVER_API_KEY - optional legacy mobile API key
 *   MANGAN_DRIVER_SEND_API_KEY_ON_LOGIN - set to 1/true/on to include `api_key` on /driver/login
 *   MANGAN_DRIVER_SEND_API_KEY_ON_ACTIONS - set to 1/true/on to include `api_key` on protected action bodies
 *   MANGAN_SMOKE_PATH - default protected path when 4th arg omitted (default /driver/profile)
 *   MANGAN_SMOKE_METHOD - optional method for protected call (default POST)
 *   MANGAN_SMOKE_BODY - optional JSON body for the protected call
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

async function smokeManganBearer(opts) {
  const username = opts.username;
  const password = opts.password;
  const baseUrl = normalizeBaseUrl(opts.baseUrl || 'https://order.wheninbaguioeat.com');
  const protectedPath = String(opts.protectedPath || '/driver/profile').trim() || '/driver/profile';
  const protectedMethod = String(opts.protectedMethod || 'POST').trim().toUpperCase() || 'POST';
  const protectedBody = opts.protectedBody;
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
  const login = await requestJson(loginUrl, {
    method: 'POST',
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
  const nextBody =
    protectedBody && typeof protectedBody === 'object' && !Array.isArray(protectedBody)
      ? { ...protectedBody }
      : protectedBody;
  if (apiKey && includeApiKeyOnActions() && nextBody && typeof nextBody === 'object' && nextBody.api_key == null) {
    nextBody.api_key = apiKey;
  }
  const protectedRes = await requestJson(protectedUrl, {
    method: protectedMethod,
    headers: { Authorization: `Bearer ${token}` },
    body: nextBody,
  });

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
  assert(!authRejected, `protected endpoint rejected bearer token (${protectedRes.raw.slice(0, 300)})`);

  console.log(`PASS: bearer request accepted (HTTP ${protectedRes.status})`);
  if (protectedRes.json) {
    console.log(`Response JSON: ${JSON.stringify(protectedRes.json).slice(0, 500)}`);
  } else if (protectedRes.raw) {
    console.log(`Response Raw: ${protectedRes.raw.slice(0, 500)}`);
  } else {
    console.log('Response: <empty body>');
  }
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
  normalizeBaseUrl,
  requestJson,
  smokeManganBearer,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
