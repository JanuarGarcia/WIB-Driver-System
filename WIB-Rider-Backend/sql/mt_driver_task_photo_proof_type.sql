-- Main rider DB (mt_driver_task_photo). Run once for typed proofs.
-- Skip any statement that errors with ER_DUP_FIELDNAME if the column already exists.

ALTER TABLE mt_driver_task_photo
  ADD COLUMN proof_type VARCHAR(16) NULL DEFAULT NULL COMMENT 'receipt | delivery; NULL = legacy delivery' AFTER photo_name;

ALTER TABLE mt_driver_task_photo
  ADD COLUMN driver_id INT NULL DEFAULT NULL COMMENT 'uploader (mt_driver.driver_id)' AFTER proof_type;
