-- Run against the ErrandWib database (same as DB_ERRANDWIB_NAME / errandWibPool).
-- Stores proof-of-delivery filenames; files live under uploads/errand/ and are served at /upload/errand/<name>.
--
-- WIB-Rider-Backend tries, in order: wib_errand_driver_proof, then mt_errand_driver_proof (photo_name or photo).
-- Run at least ONE of the CREATE statements below.

CREATE TABLE IF NOT EXISTS wib_errand_driver_proof (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  driver_id INT NOT NULL,
  photo_name VARCHAR(512) NOT NULL,
  date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order_id (order_id),
  KEY idx_driver_order (driver_id, order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Legacy / PHP-style name (optional — Node will use photo_name column if present)
CREATE TABLE IF NOT EXISTS mt_errand_driver_proof (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  driver_id INT NOT NULL,
  photo_name VARCHAR(512) NOT NULL,
  date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order_id (order_id),
  KEY idx_driver_order (driver_id, order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
