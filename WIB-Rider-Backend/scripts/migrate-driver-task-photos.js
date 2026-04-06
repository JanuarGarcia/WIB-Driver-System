/**
 * Download proof-of-delivery files from a legacy public URL into uploads/driver/.
 *
 * Your DB rows only store photo_name (e.g. abc_123.jpg.jpg). Files were served as:
 *   https://OLD_HOST/upload/driver/<photo_name>
 *
 * Usage (from WIB-Rider-Backend):
 *   npx dotenv-cli -e .env -- node scripts/migrate-driver-task-photos.js
 *   or:  node -r dotenv/config scripts/migrate-driver-task-photos.js
 *
 * Env:
 *   DB_*                     — same as the app (see config/db.js)
 *   OLD_PHOTO_BASE_URL       — e.g. https://wheninbaguioeat.com (no trailing slash)
 *   DRY_RUN=1                — list URLs only, do not download
 *   FORCE=1                  — overwrite existing files
 *   LIMIT=100                — max rows to process (optional, for testing)
 *
 * Requires: Node 18+ (global fetch) or upgrade Node.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { pool } = require('../config/db');

const OLD_BASE = (process.env.OLD_PHOTO_BASE_URL || 'https://wheninbaguioeat.com').replace(/\/$/, '');
const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const LIMIT = process.env.LIMIT ? Math.max(1, parseInt(process.env.LIMIT, 10)) : null;
const MAX_BYTES = 20 * 1024 * 1024;

const driverDir = path.join(__dirname, '..', 'uploads', 'driver');

/** Match admin.js taskProofDriverBasename for legacy driver filenames. */
function driverBasename(photoName) {
  let s = String(photoName || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^<+/, '').replace(/>+$/, '').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = u.pathname || '';
    } catch {
      return '';
    }
  }
  s = path.basename(s);
  if (!s || s === '.' || s === '..') return '';
  return s;
}

function fetchBuffer(urlString) {
  return new Promise((resolve, reject) => {
    const follow = (urlStr, depth) => {
      if (depth > 8) {
        reject(new Error('Too many redirects'));
        return;
      }
      let u;
      try {
        u = new URL(urlStr);
      } catch (e) {
        reject(e);
        return;
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        {
          method: 'GET',
          headers: { 'User-Agent': 'WIB-migrate-driver-photos/1.0' },
          timeout: 60000,
        },
        (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            const next = new URL(res.headers.location, u).href;
            follow(next, depth + 1);
            return;
          }
          if (code !== 200) {
            res.resume();
            reject(new Error(`HTTP ${code}`));
            return;
          }
          const chunks = [];
          let total = 0;
          res.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_BYTES) {
              res.destroy();
              reject(new Error(`File larger than ${MAX_BYTES} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
      req.end();
    };
    follow(urlString, 0);
  });
}

async function main() {
  if (!fs.existsSync(driverDir)) {
    fs.mkdirSync(driverDir, { recursive: true });
  }

  let rows;
  try {
    const limitSql = LIMIT ? ` LIMIT ${LIMIT}` : '';
    const [r] = await pool.query(
      `SELECT DISTINCT TRIM(photo_name) AS photo_name FROM mt_driver_task_photo
       WHERE photo_name IS NOT NULL AND TRIM(photo_name) <> ''
       ORDER BY photo_name${limitSql}`
    );
    rows = r || [];
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      console.error('Table mt_driver_task_photo does not exist.');
      process.exit(1);
    }
    throw e;
  }

  console.log(`OLD_PHOTO_BASE_URL=${OLD_BASE}`);
  console.log(`Found ${rows.length} distinct photo_name value(s). DRY_RUN=${DRY}\n`);

  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const row of rows) {
    const raw = row.photo_name;
    const base = driverBasename(raw);
    if (!base) {
      console.warn(`Skip (empty basename): ${JSON.stringify(raw)}`);
      skip += 1;
      continue;
    }

    let sourceUrl;
    if (/^https?:\/\//i.test(String(raw).trim())) {
      sourceUrl = String(raw).trim();
    } else {
      const enc = base.split('/').map((seg) => encodeURIComponent(seg)).join('/');
      sourceUrl = `${OLD_BASE}/upload/driver/${enc}`;
    }

    const dest = path.join(driverDir, base);

    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`exists  ${base}`);
      skip += 1;
      continue;
    }

    if (DRY) {
      console.log(`would fetch ${sourceUrl} -> uploads/driver/${base}`);
      continue;
    }

    try {
      const buf = await fetchBuffer(sourceUrl);
      if (!buf || buf.length === 0) {
        console.error(`empty   ${base}`);
        fail += 1;
        continue;
      }
      fs.writeFileSync(dest, buf);
      console.log(`saved   ${base} (${buf.length} bytes)`);
      ok += 1;
    } catch (err) {
      console.error(`FAIL    ${base}  ${err.message}`);
      fail += 1;
    }
  }

  console.log(`\nDone. saved=${ok} skipped=${skip} failed=${fail}`);
  if (DRY) console.log('Run without DRY_RUN=1 to download.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
