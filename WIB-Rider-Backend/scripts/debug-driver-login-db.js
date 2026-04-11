/**
 * Run against the same DB as the API (copy .env from server or set DB_* in shell).
 *
 *   node -r dotenv/config scripts/debug-driver-login-db.js [loginKey]
 *
 * Prints DATABASE(), row counts for username lookup, and sample HEX(username) for near matches.
 */
require('dotenv').config();
const { pool, databaseNames } = require('../config/db');

function mtDriverUsernameNormalizedLowerExpr() {
  let col = 'COALESCE(`username`,\'\')';
  col = `REPLACE(${col}, UNHEX('EFBBBF'), '')`;
  col = `REPLACE(${col}, UNHEX('E2808B'), '')`;
  col = `REPLACE(${col}, UNHEX('E2808C'), '')`;
  col = `REPLACE(${col}, UNHEX('E2808D'), '')`;
  return `LOWER(TRIM(${col}))`;
}

async function main() {
  const loginKey = process.argv[2] || 'test123';
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '3306';
  console.log('Using DB_HOST=%s DB_PORT=%s DB_NAME=%s (from .env or defaults)', host, port, databaseNames.primary);
  const [[dbRow]] = await pool.query('SELECT DATABASE() AS db, @@hostname AS mysql_host, USER() AS mysql_user');
  console.log('Live DATABASE():', dbRow?.db);
  console.log('@@hostname:', dbRow?.mysql_host);
  console.log('USER():', dbRow?.mysql_user);
  console.log('Login key length:', loginKey.length);

  const [[cPlain]] = await pool.query(
    'SELECT COUNT(*) AS c FROM mt_driver WHERE LOWER(TRIM(`username`)) = LOWER(?)',
    [loginKey]
  );
  const [[cNorm]] = await pool.query(
    `SELECT COUNT(*) AS c FROM mt_driver WHERE ${mtDriverUsernameNormalizedLowerExpr()} = LOWER(?)`,
    [loginKey]
  );
  console.log('COUNT LOWER(TRIM(username))=:', Number(cPlain?.c ?? 0));
  console.log('COUNT unicode-stripped username=:', Number(cNorm?.c ?? 0));

  const [samples] = await pool.query(
    'SELECT driver_id, username, LENGTH(username) AS len, HEX(username) AS username_hex FROM mt_driver WHERE `username` LIKE ? LIMIT 8',
    [`%${loginKey.replace(/%/g, '')}%`]
  );
  console.log('Sample rows WHERE username LIKE %key% (max 8):', samples?.length ?? 0);
  for (const r of samples || []) {
    console.log(' ', { driver_id: r.driver_id, username: r.username, len: r.len, username_hex: r.username_hex });
  }

  await pool.end();
}

main().catch((e) => {
  if (e && e.code === 'ECONNREFUSED') {
    console.error(
      '\nECONNREFUSED: nothing is listening for MySQL at DB_HOST/DB_PORT.\n' +
        '- Local: start MySQL, or set DB_* in WIB-Rider-Backend/.env.\n' +
        '- Production data from your PC: DB_HOST on the server is often "localhost" (only valid ON that server). ' +
        'Use your host’s remote MySQL hostname, or an SSH tunnel (ssh -L 3307:127.0.0.1:3306 user@server then DB_HOST=127.0.0.1 DB_PORT=3307).\n' +
        '- Or run this script over SSH on the same machine as the rider API.\n'
    );
  }
  console.error(e);
  process.exit(1);
});
