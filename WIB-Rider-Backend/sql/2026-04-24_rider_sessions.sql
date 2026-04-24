-- Single-device rider sessions + active device push routing.
-- Run on the primary rider database used by mt_driver / driver API.

CREATE TABLE IF NOT EXISTS mt_rider_session (
  id INT NOT NULL AUTO_INCREMENT,
  driver_id INT NOT NULL,
  auth_token VARCHAR(191) NOT NULL,
  token_jti VARCHAR(64) NULL,
  device_id VARCHAR(191) NULL,
  device_uuid VARCHAR(191) NULL,
  device_name VARCHAR(255) NULL,
  device_platform VARCHAR(32) NULL,
  push_token VARCHAR(512) NULL,
  app_version VARCHAR(64) NULL,
  ip_address VARCHAR(64) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  revoked_at DATETIME NULL,
  revoked_reason VARCHAR(64) NULL,
  last_seen_at DATETIME NULL,
  date_created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_modified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mt_rider_session_auth_token (auth_token),
  KEY idx_mt_rider_session_driver_active (driver_id, is_active, id),
  KEY idx_mt_rider_session_driver_device (driver_id, device_id, device_uuid),
  CONSTRAINT fk_mt_rider_session_driver
    FOREIGN KEY (driver_id) REFERENCES mt_driver(driver_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mt_rider_device_reg (
  id INT NOT NULL AUTO_INCREMENT,
  driver_id INT NOT NULL,
  device_id VARCHAR(512) NOT NULL,
  device_platform VARCHAR(32) NULL,
  device_uuid VARCHAR(191) NULL,
  device_name VARCHAR(255) NULL,
  push_enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  auth_token VARCHAR(191) NULL,
  session_id INT NULL,
  revoked_at DATETIME NULL,
  revoked_reason VARCHAR(64) NULL,
  last_seen_at DATETIME NULL,
  date_created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_modified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mt_rider_device_reg_driver_device (driver_id, device_id),
  KEY idx_mt_rider_device_reg_driver_active (driver_id, is_active, push_enabled, id),
  KEY idx_mt_rider_device_reg_session (session_id),
  CONSTRAINT fk_mt_rider_device_reg_driver
    FOREIGN KEY (driver_id) REFERENCES mt_driver(driver_id) ON DELETE CASCADE
);

SET @db_name = DATABASE();

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'mt_rider_device_reg' AND COLUMN_NAME = 'device_name'
  ),
  'SELECT ''mt_rider_device_reg.device_name exists'' AS info',
  'ALTER TABLE mt_rider_device_reg ADD COLUMN device_name VARCHAR(255) NULL AFTER device_uuid'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'mt_rider_device_reg' AND COLUMN_NAME = 'is_active'
  ),
  'SELECT ''mt_rider_device_reg.is_active exists'' AS info',
  'ALTER TABLE mt_rider_device_reg ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER push_enabled'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'mt_rider_device_reg' AND COLUMN_NAME = 'auth_token'
  ),
  'SELECT ''mt_rider_device_reg.auth_token exists'' AS info',
  'ALTER TABLE mt_rider_device_reg ADD COLUMN auth_token VARCHAR(191) NULL AFTER is_active'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'mt_rider_device_reg' AND COLUMN_NAME = 'session_id'
  ),
  'SELECT ''mt_rider_device_reg.session_id exists'' AS info',
  'ALTER TABLE mt_rider_device_reg ADD COLUMN session_id INT NULL AFTER auth_token'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'mt_rider_device_reg' AND COLUMN_NAME = 'revoked_at'
  ),
  'SELECT ''mt_rider_device_reg.revoked_at exists'' AS info',
  'ALTER TABLE mt_rider_device_reg ADD COLUMN revoked_at DATETIME NULL AFTER session_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'mt_rider_device_reg' AND COLUMN_NAME = 'revoked_reason'
  ),
  'SELECT ''mt_rider_device_reg.revoked_reason exists'' AS info',
  'ALTER TABLE mt_rider_device_reg ADD COLUMN revoked_reason VARCHAR(64) NULL AFTER revoked_at'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'mt_rider_device_reg' AND COLUMN_NAME = 'last_seen_at'
  ),
  'SELECT ''mt_rider_device_reg.last_seen_at exists'' AS info',
  'ALTER TABLE mt_rider_device_reg ADD COLUMN last_seen_at DATETIME NULL AFTER revoked_reason'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'mt_rider_device_reg' AND INDEX_NAME = 'idx_mt_rider_device_reg_driver_active'
  ),
  'SELECT ''idx_mt_rider_device_reg_driver_active exists'' AS info',
  'ALTER TABLE mt_rider_device_reg ADD INDEX idx_mt_rider_device_reg_driver_active (driver_id, is_active, push_enabled, id)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
