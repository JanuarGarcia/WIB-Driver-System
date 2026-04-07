-- Run against the ErrandWib database (DB_ERRANDWIB_NAME / errandWibPool).
-- Proof-of-delivery filenames; files live under uploads/errand/ and are served at /upload/errand/<name>.
-- WIB-Rider-Backend uses this table first when present (column photo_name).

CREATE TABLE IF NOT EXISTS st_driver_errand_photo (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  driver_id INT NOT NULL,
  photo_name VARCHAR(512) NOT NULL,
  file_name VARCHAR(255) NULL,
  mime_type VARCHAR(128) NULL,
  status VARCHAR(32) NULL DEFAULT 'active',
  date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
  date_modified DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_st_driver_errand_photo_order_driver (order_id, driver_id),
  KEY idx_order_id (order_id),
  KEY idx_driver_order (driver_id, order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
