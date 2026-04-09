const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { verifyRiderPasswordFields, verifyRiderPasswordResult } = require('./passwordVerify');

/**
 * Write bcrypt only to password_bcrypt — never replaces legacy `password` (keeps old rider app working).
 * @param {import('mysql2/promise').Pool} pool
 * @param {'mt_client' | 'st_client'} table
 * @param {number} clientId
 * @param {string} plainPassword
 */
async function persistPasswordBcryptSidecar(pool, table, clientId, plainPassword) {
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(cid) || cid <= 0 || !plainPassword) return;
  const hash = await bcrypt.hash(plainPassword, 10);
  try {
    await pool.query(`UPDATE ${table} SET password_bcrypt = ? WHERE client_id = ?`, [hash, cid]);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') return;
    throw e;
  }
}

/** Rider accounts live in `mt_driver`: bcrypt sidecar only — does not replace legacy `password`. */
async function persistPasswordBcryptSidecarMtDriver(pool, driverId, plainPassword) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0 || !plainPassword) return;
  const hash = await bcrypt.hash(plainPassword, 10);
  try {
    await pool.query('UPDATE mt_driver SET password_bcrypt = ? WHERE driver_id = ?', [hash, did]);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') return;
    throw e;
  }
}

function md5Hex(plain) {
  return crypto.createHash('md5').update(plain).digest('hex').toLowerCase();
}

/**
 * When a rider sets a new password in the **new** rider app: update both legacy MD5 (typical Yii/restomulti)
 * and bcrypt so old and new rider apps stay aligned.
 * @param {import('mysql2/promise').Pool} pool
 * @param {'mt_client' | 'st_client'} table
 * @param {number} clientId
 * @param {string} newPlainPassword
 * @param {{ legacyMd5?: boolean }} [opts] legacyMd5 default true (set false if the old rider app stored plain text in `password`)
 */
async function persistDualPasswordOnPasswordChange(pool, table, clientId, newPlainPassword, opts = {}) {
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(cid) || cid <= 0 || !newPlainPassword) return;
  const useMd5 = opts.legacyMd5 !== false;
  const bcryptHash = await bcrypt.hash(newPlainPassword, 10);
  const legacyVal = useMd5 ? md5Hex(newPlainPassword) : newPlainPassword;
  try {
    await pool.query(`UPDATE ${table} SET password = ?, password_bcrypt = ? WHERE client_id = ?`, [
      legacyVal,
      bcryptHash,
      cid,
    ]);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        await pool.query(`UPDATE ${table} SET password = ? WHERE client_id = ?`, [legacyVal, cid]);
      } catch (e2) {
        if (e2.code === 'ER_BAD_FIELD_ERROR') throw e;
        throw e2;
      }
    } else throw e;
  }
}

/**
 * Rider password change on `mt_driver`: legacy `password` (default MD5) + `password_bcrypt`.
 * @param {{ legacyMd5?: boolean }} [opts]
 */
async function persistDualPasswordOnPasswordChangeMtDriver(pool, driverId, newPlainPassword, opts = {}) {
  const did = parseInt(String(driverId), 10);
  if (!Number.isFinite(did) || did <= 0 || !newPlainPassword) return;
  const useMd5 = opts.legacyMd5 !== false;
  const bcryptHash = await bcrypt.hash(newPlainPassword, 10);
  const legacyVal = useMd5 ? md5Hex(newPlainPassword) : newPlainPassword;
  try {
    await pool.query('UPDATE mt_driver SET password = ?, password_bcrypt = ? WHERE driver_id = ?', [
      legacyVal,
      bcryptHash,
      did,
    ]);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      await pool.query('UPDATE mt_driver SET password = ? WHERE driver_id = ?', [legacyVal, did]);
    } else throw e;
  }
}

module.exports = {
  verifyRiderPasswordFields,
  verifyRiderPasswordResult,
  persistPasswordBcryptSidecar,
  persistDualPasswordOnPasswordChange,
  persistPasswordBcryptSidecarMtDriver,
  persistDualPasswordOnPasswordChangeMtDriver,
};
