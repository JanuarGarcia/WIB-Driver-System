-- Office Compliance Gate (drivers/riders)
-- Run on the primary database (same DB that contains `mt_driver`).
--
-- Existing drivers default to allowed (no compliance row required).
-- The backend treats missing rows as: compliance_required=0, compliance_status='reported'.

CREATE TABLE IF NOT EXISTS mt_driver_office_compliance (
  driver_id INT PRIMARY KEY,
  compliance_required TINYINT NOT NULL DEFAULT 0,
  compliance_status ENUM('not_reported', 'reported') NOT NULL DEFAULT 'reported',
  compliance_reason VARCHAR(32) DEFAULT NULL,
  compliance_note TEXT DEFAULT NULL,
  flagged_at DATETIME DEFAULT NULL,
  flagged_by_admin_id INT DEFAULT NULL,
  flagged_by_label VARCHAR(255) DEFAULT NULL,
  cleared_at DATETIME DEFAULT NULL,
  cleared_by_admin_id INT DEFAULT NULL,
  cleared_by_label VARCHAR(255) DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_required_status (compliance_required, compliance_status),
  CONSTRAINT fk_office_compliance_driver FOREIGN KEY (driver_id) REFERENCES mt_driver(driver_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mt_driver_office_compliance_audit (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  driver_id INT NOT NULL,
  action VARCHAR(32) NOT NULL,
  from_required TINYINT DEFAULT NULL,
  to_required TINYINT DEFAULT NULL,
  from_status VARCHAR(32) DEFAULT NULL,
  to_status VARCHAR(32) DEFAULT NULL,
  from_reason VARCHAR(32) DEFAULT NULL,
  to_reason VARCHAR(32) DEFAULT NULL,
  from_note TEXT DEFAULT NULL,
  to_note TEXT DEFAULT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed_by_admin_id INT DEFAULT NULL,
  changed_by_label VARCHAR(255) DEFAULT NULL,
  INDEX idx_driver_changed (driver_id, changed_at),
  CONSTRAINT fk_office_compliance_audit_driver FOREIGN KEY (driver_id) REFERENCES mt_driver(driver_id) ON DELETE CASCADE
);

