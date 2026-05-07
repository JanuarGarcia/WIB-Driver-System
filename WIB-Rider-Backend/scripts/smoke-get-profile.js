/**
 * POST /driver/api/GetProfile smoke check (N consecutive calls, bounded by timeout).
 *
 * Usage (from WIB-Rider-Backend/, with server running and a valid token):
 *   node -r dotenv/config scripts/smoke-get-profile.js <token> [api_key] [count]
 *
 * Env:
 *   SMOKE_BASE — API origin, default http://localhost:3000 (path /driver/api/GetProfile is appended)
 *   API_HASH_KEY or DRIVER_API_KEY — used if api_key arg omitted
 */
require('dotenv').config();
const http = require('http');
const https = require('https');

function postForm(urlStr, form, timeoutMs = 10000) {
  const u = new URL(urlStr.replace(/\/+$/, ''));
  const lib = u.protocol === 'https:' ? https : http;
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: '/driver/api/GetProfile',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
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
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`client timeout after ${timeoutMs}ms`));
    });
    req.write(body);
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
  const token = process.argv[2];
  const apiKeyArg = process.argv[3];
  const countArg = process.argv[4];
  const apiKey = apiKeyArg || process.env.DRIVER_API_KEY || process.env.API_HASH_KEY || '';
  const count = Math.max(1, Math.min(500, parseInt(String(countArg || '100'), 10) || 100));
  const baseRaw = (process.env.SMOKE_BASE || 'http://localhost:3000').trim().replace(/\/+$/, '');
  const base = baseRaw.endsWith('/driver/api') ? baseRaw : `${baseRaw}/driver/api`;

  if (!token) {
    console.error('Usage: node -r dotenv/config scripts/smoke-get-profile.js <token> [api_key] [count]');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('Missing api_key: pass as 3rd argument or set API_HASH_KEY / DRIVER_API_KEY in .env');
    process.exit(1);
  }

  const t0 = Date.now();
  for (let i = 1; i <= count; i++) {
    const r = await postForm(base, { api_key: apiKey, token, app_version: 'smoke' }, 10000);
    assert(r.body && typeof r.body === 'object', `#${i}: expected JSON, got ${JSON.stringify(r).slice(0, 200)}`);
    assert(typeof r.body.code === 'number', `#${i}: missing body.code`);
    assert(r.body.code === 1, `#${i}: expected code 1, got ${r.body.code} msg=${r.body.msg}`);
    assert(r.body.details && typeof r.body.details === 'object', `#${i}: missing details`);
  }
  console.log(`PASS: ${count} consecutive GetProfile calls ok in ${Date.now() - t0}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

