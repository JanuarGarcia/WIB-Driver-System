-- ErrandWib: enable separate receipt + delivery proof rows per order/driver.
-- Run manually. If a step fails (duplicate column / unknown index), adjust to match your live schema.

-- 1) Add proof_type (skip if column already exists)
ALTER TABLE st_driver_errand_photo
  ADD COLUMN proof_type VARCHAR(16) NOT NULL DEFAULT 'delivery' AFTER photo_name;

-- 2) Drop the old single-slot unique index (name may be uq_errand_proof_order_driver or uq_st_driver_errand_photo_order_driver)
ALTER TABLE st_driver_errand_photo DROP INDEX uq_st_driver_errand_photo_order_driver;
-- If that fails, try instead:
-- ALTER TABLE st_driver_errand_photo DROP INDEX uq_errand_proof_order_driver;

-- 3) New uniqueness: one row per (order, driver, proof kind)
ALTER TABLE st_driver_errand_photo
  ADD UNIQUE KEY uq_errand_proof_order_driver_type (order_id, driver_id, proof_type);
