/**
 * POST /driver/api/Login smoke checks (happy path + wrong user + wrong password).
 *
 * Usage (from repo root, with server + MySQL running and .env configured):
 *   node -r dotenv/config scripts/smoke-driver-login.js <username> <correct_password> [api_key]
 *
 * Env:
 *   SMOKE_BASE — API origin, default http://localhost:3000 (path /driver/api/Login is appended)
 *   API_HASH_KEY or DRIVER_API_KEY — used if api_key arg omitted (must match mt_option.driver_api_hash_key when that row exists)
 */
require('dotenv').config();
const http = require('http');
const https = require('https');

function postJson(urlStr, body) {
  const u = new URL(urlStr.replace(/\/+$/, ''));
  const lib = u.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: '/driver/api/Login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => {
          chunks += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(chunks) });
          } catch {
            resolve({ status: res.statusCode, raw: chunks });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

async function main() {
  const user = process.argv[2];
  const pass = process.argv[3];
  const apiKeyArg = process.argv[4];
  const apiKey = apiKeyArg || process.env.DRIVER_API_KEY || process.env.API_HASH_KEY || '';
  const baseRaw = (process.env.SMOKE_BASE || 'http://localhost:3000').trim().replace(/\/+$/, '');
  const base = baseRaw.endsWith('/driver/api') ? baseRaw : `${baseRaw}/driver/api`;

  if (!user || !pass) {
    console.error('Usage: node -r dotenv/config scripts/smoke-driver-login.js <username> <password> [api_key]');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('Missing api_key: pass as 4th argument or set API_HASH_KEY / DRIVER_API_KEY in .env');
    process.exit(1);
  }

  const ok = await postJson(base, { api_key: apiKey, username: user, password: pass });
  assert(ok.body && typeof ok.body === 'object', `expected JSON, got ${JSON.stringify(ok).slice(0, 200)}`);
  assert(ok.body.code === 1, `expected code 1, got ${ok.body.code} msg=${ok.body.msg}`);
  assert(ok.body.details && ok.body.details.token, 'expected details.token');
  console.log('PASS: login ok, token present');

  const badUser = await postJson(base, {
    api_key: apiKey,
    username: `___nonexistent_${Date.now()}___`,
    password: pass,
  });
  assert(badUser.body.code !== 1, 'wrong user should not return code 1');
  assert(
    String(badUser.body.msg || '').includes('No rider account matches'),
    `wrong user msg, got: ${badUser.body.msg}`
  );
  console.log('PASS: wrong user → no rider account message');

  const badPass = await postJson(base, { api_key: apiKey, username: user, password: '___wrong_password___' });
  assert(badPass.body.code !== 1, 'wrong password should not return code 1');
  assert(String(badPass.body.msg || '').includes('Incorrect password'), `wrong pass msg, got: ${badPass.body.msg}`);
  console.log('PASS: wrong password → Incorrect password');
  console.log('All smoke checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
