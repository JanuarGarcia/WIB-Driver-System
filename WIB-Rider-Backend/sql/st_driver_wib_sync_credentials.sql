-- Mangan DB migration (order.wheninbaguioeat.com): store per-driver login used by WIB backend
-- to call the legacy /driver/* endpoints (DriverController.php).
--
-- Run this on the database that contains:
--   - st_driver (drivers)
--   - st_ordernew (orders)
--
-- If you see "Duplicate column" errors, the columns already exist — you can ignore this migration.

ALTER TABLE st_driver
  ADD COLUMN wib_sync_username VARCHAR(190) NULL DEFAULT NULL COMMENT 'Mangan rider app username/email for WIB sync',
  ADD COLUMN wib_sync_password VARCHAR(255) NULL DEFAULT NULL COMMENT 'Mangan rider app password for WIB sync (plain; restrict DB access)';

