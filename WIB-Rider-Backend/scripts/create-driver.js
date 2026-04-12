/**
 * Create a test driver. Usage: node -r dotenv/config scripts/create-driver.js [username] [password]
 * Default: driver1 / driver1
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const username = process.argv[2] || 'driver1';
const password = process.argv[3] || 'driver1';

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wib_driver',
  });
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO mt_driver (username, password, first_name, last_name, on_duty) VALUES (?, ?, ?, ?, 0) ON DUPLICATE KEY UPDATE password = ?, first_name = ?, last_name = ?',
    [username, hash, username, '', hash, username, '']
  );
  console.log('Driver created/updated:', username);
  const apiKey = process.env.API_HASH_KEY || '<API_HASH_KEY_or_mt_option.driver_api_hash_key>';
  const base = (process.env.SMOKE_BASE || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  console.log('\nSmoke test (curl):');
  console.log(
    `curl -sS -X POST "${base}/driver/api/Login" -H "Content-Type: application/json" -d "{\\"api_key\\":\\"${apiKey}\\",\\"username\\":\\"${username}\\",\\"password\\":\\"${password}\\"}"`
  );
  console.log('\nOr: npm run smoke-driver-login --', username, password);
  pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
