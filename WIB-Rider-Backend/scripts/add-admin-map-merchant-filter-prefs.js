/**
 * Legacy: map merchant filter is stored globally under option key
 * `dashboard_map_merchant_filter_ids` in `settings` or `mt_option` (created on first save from the dashboard).
 *
 * This script only ensures mt_admin_user_preferences exists if you still use it elsewhere; it is NOT required
 * for the shared dashboard map merchant filter.
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
  console.log('Ensured mt_admin_user_preferences exists (optional legacy table).');
  console.log('Map filter uses settings key: dashboard_map_merchant_filter_ids');
  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
