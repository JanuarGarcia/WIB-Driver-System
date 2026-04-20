-- Migration script to add reassignment fields to mt_driver_task table

ALTER TABLE mt_driver_task
  ADD COLUMN reassigned_to INT NULL DEFAULT NULL COMMENT 'New rider assigned to the task',
  ADD COLUMN reassigned_by INT NULL DEFAULT NULL COMMENT 'Admin or user who reassigned the task',
  ADD COLUMN reassign_reason VARCHAR(255) NULL DEFAULT NULL COMMENT 'Reason for reassignment';