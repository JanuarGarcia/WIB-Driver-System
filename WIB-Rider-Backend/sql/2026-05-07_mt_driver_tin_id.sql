-- Add optional TIN ID for riders/drivers (dashboard + mobile profile)
-- Safe for existing rows (nullable column).

ALTER TABLE mt_driver ADD COLUMN mt_tin_id VARCHAR(50) NULL AFTER phone;
