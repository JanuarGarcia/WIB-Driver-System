-- Rider FCM device registry, push logs, order triggers (Node + MySQL/MariaDB).
-- Matches WIB-Rider-Backend: mt_rider_device_reg, mt_rider_push_logs, mt_rider_order_trigger.

CREATE TABLE IF NOT EXISTS mt_rider_device_reg (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  driver_id INT NOT NULL,
  device_id VARCHAR(512) NOT NULL,
  device_platform VARCHAR(32) NOT NULL DEFAULT '',
  device_uuid VARCHAR(64) NULL,
  push_enabled TINYINT(1) NOT NULL DEFAULT 1,
  date_created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_modified DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rider_device (driver_id, device_id(255)),
  KEY idx_driver_push (driver_id, push_enabled),
  KEY idx_device_uuid (driver_id, device_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mt_rider_push_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  driver_id INT NOT NULL,
  order_id INT NULL,
  trigger_id BIGINT UNSIGNED NULL,
  push_type VARCHAR(96) NOT NULL DEFAULT '',
  push_title VARCHAR(512) NOT NULL DEFAULT '',
  push_body TEXT NULL,
  device_id VARCHAR(512) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  provider_response TEXT NULL,
  error_message TEXT NULL,
  date_created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_modified DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_driver_created (driver_id, date_created),
  KEY idx_order (order_id),
  KEY idx_status_created (status, date_created)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mt_rider_order_trigger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  driver_id INT NOT NULL,
  event_key VARCHAR(96) NOT NULL,
  remarks TEXT NULL,
  date_created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_order (order_id),
  KEY idx_driver (driver_id),
  KEY idx_event (event_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
