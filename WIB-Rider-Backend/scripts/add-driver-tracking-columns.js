/**
 * Adds last_online to mt_driver and driver_tracking_option to settings if missing.
 * Run: node -r dotenv/config scripts/add-driver-tracking-columns.js
 */
require('dotenv').config();
const { pool } = require('../config/db');

async function main() {
  try {
    await pool.query(`
      ALTER TABLE mt_driver
      ADD COLUMN last_online INT NULL DEFAULT NULL
      AFTER last_login
    `);
    console.log('Added mt_driver.last_online');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') console.log('mt_driver.last_online already exists');
    else throw e;
  }

  try {
    const [[r]] = await pool.query('SELECT 1 FROM settings WHERE `key` = ? LIMIT 1', ['driver_tracking_option']);
    if (!r) {
      await pool.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', ['driver_tracking_option', '1']);
      console.log('Added settings.driver_tracking_option = 1');
    }
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      console.log('settings table not found; ensure driver_tracking_option is set in your options/settings.');
    } else throw e;
  }

  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
