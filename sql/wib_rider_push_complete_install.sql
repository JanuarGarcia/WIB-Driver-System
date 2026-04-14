-- =============================================================================
-- WIB rider push — full install (tables + mt_option notification templates)
-- Run in phpMyAdmin / MySQL CLI against the SAME database as WIB-Rider-Backend.
--
-- If mt_option has NO merchant_id column, remove "merchant_id, " from INSERT
-- column lists and remove the "0, " prefix from each SELECT row.
-- =============================================================================

-- ----- A) Tables (idempotent) -----

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

-- ----- B) mt_option templates (skip if option_name already exists) -----
-- Placeholders: {order_id} {driver_id}

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_ORDER_ASSIGNED',
'{"enable_push":1,"push":{"title":"New delivery","body":"You have been assigned order #{order_id}."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_ORDER_ASSIGNED' LIMIT 1);

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_REASSIGNED',
'{"enable_push":1,"push":{"title":"Delivery reassigned","body":"You have been assigned order #{order_id}. The assignment was changed."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_REASSIGNED' LIMIT 1);

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_READY_FOR_PICKUP',
'{"enable_push":1,"push":{"title":"Ready for pickup","body":"Order #{order_id} is ready for pickup at the merchant."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_READY_FOR_PICKUP' LIMIT 1);

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_ORDER_CANCELLED',
'{"enable_push":1,"push":{"title":"Order cancelled","body":"Order #{order_id} is no longer assigned to you (cancelled or unassigned)."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_ORDER_CANCELLED' LIMIT 1);

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_DELIVERY_UPDATED',
'{"enable_push":1,"push":{"title":"Delivery update","body":"Order #{order_id} status was updated. Open the app for details."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_DELIVERY_UPDATED' LIMIT 1);
