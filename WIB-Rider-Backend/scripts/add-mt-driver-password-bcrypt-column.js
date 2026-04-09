/**
 * Adds mt_driver.password_bcrypt for rider apps: legacy mt_driver.password stays MD5/plain for the old app;
 * new app verifies bcrypt from password_bcrypt first.
 *
 * Run: node -r dotenv/config scripts/add-mt-driver-password-bcrypt-column.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wib_driver',
  });
  try {
    await pool.query(
      "ALTER TABLE mt_driver ADD COLUMN password_bcrypt VARCHAR(255) NULL DEFAULT NULL COMMENT 'bcrypt for new rider app; keep password for legacy'"
    );
    console.log('Added mt_driver.password_bcrypt');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log('mt_driver.password_bcrypt already exists');
    } else if (e.code === 'ER_NO_SUCH_TABLE') {
      console.warn('mt_driver table not found');
    } else throw e;
  }
  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
