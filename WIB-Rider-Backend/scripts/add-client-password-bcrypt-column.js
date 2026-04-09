/**
 * Adds password_bcrypt to mt_client (primary DB) and optionally st_client (ErrandWib DB).
 * Legacy `password` stays MD5/plain for the old rider app; new app verifies bcrypt from password_bcrypt first.
 *
 * Run: node -r dotenv/config scripts/add-client-password-bcrypt-column.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function addColumn(pool, label, table) {
  try {
    await pool.query(
      `ALTER TABLE ${table} ADD COLUMN password_bcrypt VARCHAR(255) NULL DEFAULT NULL COMMENT 'bcrypt hash; keep legacy password column for old apps'`
    );
    console.log(`[${label}] Added ${table}.password_bcrypt`);
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log(`[${label}] ${table}.password_bcrypt already exists`);
    } else if (e.code === 'ER_NO_SUCH_TABLE') {
      console.warn(`[${label}] Table ${table} not found — skip`);
    } else throw e;
  }
}

async function main() {
  const primary = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wib_driver',
  });
  await addColumn(primary, 'primary', 'mt_client');
  await primary.end();

  const errandDb = process.env.DB_ERRANDWIB_NAME || 'wheninba_ErrandWib';
  const errand = mysql.createPool({
    host: process.env.DB_ERRANDWIB_HOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_ERRANDWIB_PORT || process.env.DB_PORT || '3306', 10),
    user: process.env.DB_ERRANDWIB_USER || process.env.DB_USER || 'root',
    password: process.env.DB_ERRANDWIB_PASSWORD || process.env.DB_PASSWORD || '',
    database: errandDb,
  });
  try {
    await addColumn(errand, 'errand', 'st_client');
  } catch (e) {
    console.warn('[errand] skip st_client:', e.message || e);
  }
  await errand.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
