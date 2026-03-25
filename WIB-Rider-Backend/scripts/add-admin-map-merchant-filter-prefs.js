/**
 * Ensures `mt_admin_user_preferences` exists for per-admin dashboard map merchant filter.
 * The filter is stored in `map_merchant_filter_ids` per `admin_id` (also auto-created on first API use).
 *
 * Legacy: `dashboard_map_merchant_filter_ids` in `settings` / `mt_option` is still read once per admin
 * to migrate their first load if they had the old shared filter.
 *
 * Run: node -r dotenv/config scripts/add-admin-map-merchant-filter-prefs.js
 */
require('dotenv').config();
const { pool } = require('../config/db');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mt_admin_user_preferences (
      admin_id INT NOT NULL PRIMARY KEY,
      map_merchant_filter_ids TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('Ensured mt_admin_user_preferences (per-admin map merchant filter).');
  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
