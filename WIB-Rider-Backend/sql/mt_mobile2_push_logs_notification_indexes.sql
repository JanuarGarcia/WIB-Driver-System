-- Notification inbox indexes for mt_mobile2_push_logs.
-- Idempotent migration: creates only missing indexes.

SET @db_name := DATABASE();

SET @has_idx_client_id_id := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db_name
    AND table_name = 'mt_mobile2_push_logs'
    AND index_name = 'idx_mobile2_push_logs_client_id_id'
);

SET @has_idx_client_id_is_read := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db_name
    AND table_name = 'mt_mobile2_push_logs'
    AND index_name = 'idx_mobile2_push_logs_client_id_is_read'
);

SET @sql := IF(
  @has_idx_client_id_id = 0,
  'ALTER TABLE mt_mobile2_push_logs ADD INDEX idx_mobile2_push_logs_client_id_id (client_id, id)',
  'SELECT ''idx_mobile2_push_logs_client_id_id exists'' AS info'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  @has_idx_client_id_is_read = 0,
  'ALTER TABLE mt_mobile2_push_logs ADD INDEX idx_mobile2_push_logs_client_id_is_read (client_id, is_read)',
  'SELECT ''idx_mobile2_push_logs_client_id_is_read exists'' AS info'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
