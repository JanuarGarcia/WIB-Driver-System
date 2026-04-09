/**
 * Adds mt_driver.client_id (nullable FK-style link to mt_client.client_id) for unified rider/driver login.
 * Run: node -r dotenv/config scripts/add-mt-driver-client-id.js
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
      'ALTER TABLE mt_driver ADD COLUMN client_id INT NULL DEFAULT NULL COMMENT \'Links to mt_client.client_id for shared rider+driver login\''
    );
    console.log('Added mt_driver.client_id');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log('mt_driver.client_id already exists; skipping add column.');
    } else throw e;
  }
  try {
    await pool.query('CREATE UNIQUE INDEX uq_mt_driver_client_id ON mt_driver (client_id)');
    console.log('Created unique index uq_mt_driver_client_id');
  } catch (e) {
    if (e.code === 'ER_DUP_KEYNAME') {
      console.log('Unique index uq_mt_driver_client_id already exists; skipping.');
    } else if (e.code === 'ER_DUP_ENTRY') {
      console.warn('Could not create unique index: duplicate non-null client_id values exist. Fix data then re-run.');
    } else throw e;
  }
  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
