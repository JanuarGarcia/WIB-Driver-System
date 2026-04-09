-- Rider → customer chat messages during active delivery (driver app → customer push).
-- Run on the same database as mt_driver_task / mt_order (primary pool / DB_NAME).

CREATE TABLE IF NOT EXISTS mt_driver_customer_message (
  message_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  driver_id INT NOT NULL,
  client_id INT NOT NULL COMMENT 'Customer (mt_client or st_client) id in the DB where token was resolved',
  task_id INT NULL COMMENT 'App task_id (may be negative for errand synthetic id)',
  order_id INT NULL COMMENT 'Standard order (mt_order.order_id) when applicable',
  errand_order_id INT NULL COMMENT 'st_ordernew.order_id when applicable',
  message_text VARCHAR(600) NOT NULL,
  push_title VARCHAR(255) NULL,
  push_type VARCHAR(64) NULL,
  date_created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id),
  KEY idx_mdcm_driver_task_time (driver_id, task_id, date_created),
  KEY idx_mdcm_client_time (client_id, date_created)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
