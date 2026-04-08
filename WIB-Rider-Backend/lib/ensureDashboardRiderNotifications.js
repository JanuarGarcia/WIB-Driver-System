/**
 * Persists dashboard dispatcher notifications so they survive restarts and work with PM2 cluster / multiple Node workers.
 * Uses the primary pool (same DB as mt_admin_user).
 */

/**
 * @param {import('mysql2/promise').Pool} pool
 */
async function ensureDashboardRiderNotificationTables(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mt_dashboard_rider_notification (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      admin_id BIGINT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NULL,
      type VARCHAR(64) NOT NULL DEFAULT 'info',
      viewed TINYINT(1) NOT NULL DEFAULT 0,
      date_created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_admin_unread (admin_id, viewed, date_created)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mt_dashboard_notification_dedupe (
      dedupe_key VARCHAR(190) NOT NULL,
      date_created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (dedupe_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

module.exports = { ensureDashboardRiderNotificationTables };
