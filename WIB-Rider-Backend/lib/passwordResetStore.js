const RESET_CODE_TTL_MINUTES = 15;

let ensured = false;

async function ensurePasswordResetTable(pool) {
  if (ensured) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS mt_password_reset_request (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      account_type VARCHAR(16) NOT NULL,
      account_id INT NOT NULL,
      login_key VARCHAR(190) DEFAULT NULL,
      reset_code VARCHAR(16) NOT NULL,
      requested_ip VARCHAR(64) DEFAULT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_account_open (account_type, account_id, used_at, expires_at),
      INDEX idx_code_lookup (account_type, account_id, reset_code, used_at, expires_at)
    )`
  );
  ensured = true;
}

function sixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function issueResetCode(pool, accountType, accountId, loginKey, requestIp) {
  await ensurePasswordResetTable(pool);
  const code = sixDigitCode();
  await pool.query(
    `INSERT INTO mt_password_reset_request
      (account_type, account_id, login_key, reset_code, requested_ip, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [accountType, accountId, loginKey || null, code, requestIp || null, RESET_CODE_TTL_MINUTES]
  );
  return { code, expires_in_minutes: RESET_CODE_TTL_MINUTES };
}

async function consumeResetCode(pool, accountType, accountId, resetCode) {
  await ensurePasswordResetTable(pool);
  const code = String(resetCode || '').trim();
  if (!code) return { ok: false, reason: 'missing_code' };

  const [[row]] = await pool.query(
    `SELECT id FROM mt_password_reset_request
     WHERE account_type = ? AND account_id = ? AND reset_code = ?
       AND used_at IS NULL AND expires_at > NOW()
     ORDER BY id DESC
     LIMIT 1`,
    [accountType, accountId, code]
  );
  if (!row) return { ok: false, reason: 'invalid_or_expired' };

  await pool.query('UPDATE mt_password_reset_request SET used_at = NOW() WHERE id = ?', [row.id]);
  return { ok: true };
}

module.exports = {
  issueResetCode,
  consumeResetCode,
};

