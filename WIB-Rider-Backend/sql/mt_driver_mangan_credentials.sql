-- Optional: per-rider Mangan (order.wheninbaguioeat.com) driver-app login used only for
-- server-to-server status sync → Mangan customer push. Run on the same DB as `mt_driver`.
-- The Mangan account must be the driver assigned to that order on Mangan (DriverController checks driver_id).
-- If "Duplicate column" errors appear, columns already exist — skip this file.

ALTER TABLE mt_driver
  ADD COLUMN mangan_api_username VARCHAR(190) NULL DEFAULT NULL COMMENT 'Mangan rider app username/email',
  ADD COLUMN mangan_api_password VARCHAR(255) NULL DEFAULT NULL COMMENT 'Mangan rider app password (plain; restrict DB access)';
