const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/**
 * Match stored password formats used across mt_driver, mt_client, mt_admin_user:
 * bcrypt ($2a/$2b/$2y), 32-char MD5 hex, or legacy plain text.
 * @param {string} plain
 * @param {string|null|undefined} stored
 * @returns {Promise<boolean>}
 */
async function verifyStoredPassword(plain, stored) {
  const s = (stored || '').trim();
  if (!s) return false;
  if (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$')) {
    return bcrypt.compare(plain, s);
  }
  if (/^[a-f0-9]{32}$/i.test(s)) {
    return crypto.createHash('md5').update(plain).digest('hex').toLowerCase() === s.toLowerCase();
  }
  return plain === s;
}

/**
 * Rider row on **`mt_driver`** (or optional `mt_client` / `st_client` in fallback flows): legacy `password` (MD5 / plain / bcrypt)
 * plus optional **`password_bcrypt`** so the old rider app keeps working while the new app prefers bcrypt without overwriting `password`.
 * @param {string} plain
 * @param {{ password?: unknown, password_hash?: unknown, password_bcrypt?: unknown }} row
 * @returns {Promise<{ ok: boolean, matched: 'bcrypt' | 'legacy' | null }>}
 */
async function verifyRiderPasswordResult(plain, row) {
  const bcryptCol = String(row.password_bcrypt || '').trim();
  if (
    bcryptCol &&
    (bcryptCol.startsWith('$2a$') || bcryptCol.startsWith('$2b$') || bcryptCol.startsWith('$2y$'))
  ) {
    if (await bcrypt.compare(plain, bcryptCol)) return { ok: true, matched: 'bcrypt' };
  }
  const legacy = String(row.password ?? row.password_hash ?? '').trim();
  if (await verifyStoredPassword(plain, legacy)) return { ok: true, matched: 'legacy' };
  return { ok: false, matched: null };
}

/** @returns {Promise<boolean>} */
async function verifyRiderPasswordFields(plain, row) {
  const r = await verifyRiderPasswordResult(plain, row);
  return r.ok;
}

module.exports = { verifyStoredPassword, verifyRiderPasswordFields, verifyRiderPasswordResult };
