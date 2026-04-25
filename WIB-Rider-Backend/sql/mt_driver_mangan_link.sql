-- Link one primary WIB rider account (mt_driver) to one legacy ErrandWib / Mangan rider account (st_driver).
-- Run on the primary WIB database.

ALTER TABLE mt_driver
  ADD COLUMN mangan_driver_id INT NULL DEFAULT NULL COMMENT 'Linked legacy ErrandWib st_driver.driver_id for errand/mangan sync';
