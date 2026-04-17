const path = require('path');
const fs = require('fs');
const { normalizeStoredProofType } = require('./taskProof');

/** Canonical ErrandWib proof table; created automatically on boot if missing (see ensureErrandProofTable). */
const CANONICAL_ERRAND_PROOF_TABLE = 'st_driver_errand_photo';

function buildErrandProofImageUrl(photoName) {
  const trimmed = String(photoName || '').trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const safe = path.basename(trimmed.replace(/\\/g, '/'));
  if (!safe || safe === '.' || safe === '..') return null;
  const rel = `/upload/errand/${encodeURIComponent(safe)}`;
  return baseUrl ? `${baseUrl}${rel}` : rel;
}

/**
 * Whitelisted proof table layouts (ErrandWib). First successful SELECT wins and caches for the process.
 * @type {{ table: string, photoCol: string, hasProofType: boolean } | null}
 */
let proofSchemaCache = null;

const PROOF_SCHEMA_CANDIDATES = [
  { table: 'st_driver_errand_photo', photoCol: 'photo_name' },
  { table: 'wib_errand_driver_proof', photoCol: 'photo_name' },
  { table: 'mt_errand_driver_proof', photoCol: 'photo_name' },
  { table: 'mt_errand_driver_proof', photoCol: 'photo' },
];

function quoteIdent(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('Invalid SQL identifier');
  return `\`${name}\``;
}

/**
 * Ensures st_driver_errand_photo exists on ErrandWib (idempotent). New installs: receipt + delivery per order/driver.
 * @param {import('mysql2/promise').Pool} errandPool
 */
async function ensureErrandProofTable(errandPool) {
  if (!errandPool) return;
  const tbl = quoteIdent(CANONICAL_ERRAND_PROOF_TABLE);
  await errandPool.query(`
    CREATE TABLE IF NOT EXISTS ${tbl} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      driver_id INT NOT NULL,
      photo_name VARCHAR(512) NOT NULL,
      proof_type VARCHAR(16) NOT NULL DEFAULT 'delivery',
      file_name VARCHAR(255) NULL,
      mime_type VARCHAR(128) NULL,
      status VARCHAR(32) NULL DEFAULT 'active',
      date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
      date_modified DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_errand_proof_order_driver_type (order_id, driver_id, proof_type),
      KEY idx_order_id (order_id),
      KEY idx_driver_order (driver_id, order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/**
 * @param {import('mysql2/promise').Pool} errandPool
 * @returns {Promise<{ table: string, photoCol: string, hasProofType: boolean } | null>}
 */
async function detectProofSchema(errandPool) {
  if (proofSchemaCache) return proofSchemaCache;
  for (const s of PROOF_SCHEMA_CANDIDATES) {
    try {
      await errandPool.query(`SELECT 1 FROM ${quoteIdent(s.table)} LIMIT 1`);
      let hasProofType = false;
      try {
        await errandPool.query(`SELECT proof_type FROM ${quoteIdent(s.table)} WHERE 1=0`);
        hasProofType = true;
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
      proofSchemaCache = { ...s, hasProofType };
      return proofSchemaCache;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') continue;
      throw e;
    }
  }
  return null;
}

/**
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 */
async function fetchErrandProofsForOrder(errandPool, orderId) {
  const schema = await detectProofSchema(errandPool);
  if (!schema) return [];
  const photoSel = quoteIdent(schema.photoCol);
  const tbl = quoteIdent(schema.table);
  try {
    let rows;
    if (schema.hasProofType) {
      const [r] = await errandPool.query(
        `SELECT id, order_id, driver_id, proof_type, ${photoSel} AS photo_name, date_created FROM ${tbl} WHERE order_id = ? ORDER BY date_created ASC`,
        [orderId]
      );
      rows = r;
    } else {
      const [r] = await errandPool.query(
        `SELECT id, order_id, driver_id, ${photoSel} AS photo_name, date_created FROM ${tbl} WHERE order_id = ? ORDER BY date_created ASC`,
        [orderId]
      );
      rows = r;
    }
    return (rows || []).map((row) => {
      const kind = schema.hasProofType ? normalizeStoredProofType(row.proof_type) : 'delivery';
      return {
        ...row,
        proof_type: kind,
        proof_url: buildErrandProofImageUrl(row.photo_name),
      };
    });
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      proofSchemaCache = null;
      return fetchErrandProofsForOrder(errandPool, orderId);
    }
    throw e;
  }
}

async function countErrandProofForOrder(errandPool, orderId) {
  const schema = await detectProofSchema(errandPool);
  if (!schema) return 0;
  const tbl = quoteIdent(schema.table);
  try {
    let sql = `SELECT COUNT(*) AS c FROM ${tbl} WHERE order_id = ?`;
    const params = [orderId];
    if (schema.hasProofType) {
      sql += ` AND (proof_type = 'delivery' OR proof_type IS NULL)`;
    }
    const [[r]] = await errandPool.query(sql, params);
    return Number(r?.c ?? 0);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      proofSchemaCache = null;
      return countErrandProofForOrder(errandPool, orderId);
    }
    if (e.code === 'ER_NO_SUCH_TABLE') return 0;
    throw e;
  }
}

/**
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 * @param {number} driverId
 * @param {string} photoName
 * @param {'receipt'|'delivery'} [proofKind]
 * @returns {Promise<number>} insert id
 */
async function insertErrandProofRow(errandPool, orderId, driverId, photoName, proofKind) {
  const pt = proofKind === 'receipt' ? 'receipt' : 'delivery';

  const resolveInsertId = async (s, result) => {
    if (result.insertId) return result.insertId;
    const tbl = quoteIdent(s.table);
    if (s.hasProofType) {
      const [[row]] = await errandPool.query(
        `SELECT id FROM ${tbl} WHERE order_id = ? AND driver_id = ? AND proof_type = ? LIMIT 1`,
        [orderId, driverId, pt]
      );
      return row?.id != null ? Number(row.id) : 0;
    }
    const [[row]] = await errandPool.query(
      `SELECT id FROM ${tbl} WHERE order_id = ? AND driver_id = ? LIMIT 1`,
      [orderId, driverId]
    );
    return row?.id != null ? Number(row.id) : 0;
  };

  const runUpsertTyped = async (s) => {
    const tbl = quoteIdent(s.table);
    const col = quoteIdent(s.photoCol);
    const [result] = await errandPool.query(
      `INSERT INTO ${tbl} (order_id, driver_id, ${col}, proof_type, date_created) VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE ${col} = VALUES(${col})`,
      [orderId, driverId, photoName, pt]
    );
    proofSchemaCache = s;
    return resolveInsertId(s, result);
  };

  const runUpsertLegacy = async (s) => {
    const tbl = quoteIdent(s.table);
    const col = quoteIdent(s.photoCol);
    const [result] = await errandPool.query(
      `INSERT INTO ${tbl} (order_id, driver_id, ${col}, date_created) VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE ${col} = VALUES(${col})`,
      [orderId, driverId, photoName]
    );
    proofSchemaCache = s;
    return resolveInsertId(s, result);
  };

  const tryAll = async () => {
    if (proofSchemaCache) {
      try {
        if (proofSchemaCache.hasProofType) {
          return await runUpsertTyped(proofSchemaCache);
        }
        if (pt === 'receipt') {
          const err = new Error(
            'proof_type=receipt requires DB migration — run WIB-Rider-Backend/sql/migrate_st_driver_errand_photo_proof_type.sql on ErrandWib'
          );
          err.code = 'ERR_RECEIPT_SCHEMA';
          throw err;
        }
        return await runUpsertLegacy(proofSchemaCache);
      } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') {
          proofSchemaCache = null;
        } else {
          throw e;
        }
      }
    }

    let lastErr = null;
    for (const s of PROOF_SCHEMA_CANDIDATES) {
      let hasProofType = false;
      try {
        await errandPool.query(`SELECT 1 FROM ${quoteIdent(s.table)} LIMIT 1`);
        try {
          await errandPool.query(`SELECT proof_type FROM ${quoteIdent(s.table)} WHERE 1=0`);
          hasProofType = true;
        } catch (e) {
          if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
        }
      } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') continue;
        lastErr = e;
        continue;
      }
      const full = { ...s, hasProofType };
      try {
        if (hasProofType) {
          const [result] = await errandPool.query(
            `INSERT INTO ${quoteIdent(s.table)} (order_id, driver_id, ${quoteIdent(s.photoCol)}, proof_type, date_created) VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE ${quoteIdent(s.photoCol)} = VALUES(${quoteIdent(s.photoCol)})`,
            [orderId, driverId, photoName, pt]
          );
          proofSchemaCache = full;
          return resolveInsertId(full, result);
        }
        if (pt === 'receipt') {
          const err = new Error(
            'proof_type=receipt requires DB migration — run WIB-Rider-Backend/sql/migrate_st_driver_errand_photo_proof_type.sql on ErrandWib'
          );
          err.code = 'ERR_RECEIPT_SCHEMA';
          throw err;
        }
        const [result] = await errandPool.query(
          `INSERT INTO ${quoteIdent(s.table)} (order_id, driver_id, ${quoteIdent(s.photoCol)}, date_created) VALUES (?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE ${quoteIdent(s.photoCol)} = VALUES(${quoteIdent(s.photoCol)})`,
          [orderId, driverId, photoName]
        );
        proofSchemaCache = full;
        return resolveInsertId(full, result);
      } catch (e) {
        lastErr = e;
        if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
          proofSchemaCache = null;
          continue;
        }
        throw e;
      }
    }
    const err = lastErr || new Error('No errand proof table available');
    err.code = err.code || 'ER_NO_SUCH_TABLE';
    throw err;
  };

  try {
    return await tryAll();
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      await ensureErrandProofTable(errandPool);
      proofSchemaCache = null;
      return tryAll();
    }
    throw e;
  }
}

/**
 * Remove one proof slot for an order (rider app "clear photo"). Returns removed disk filename when known.
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 * @param {number} driverId
 * @param {'receipt'|'delivery'} proofKind
 * @returns {Promise<string[]>} basenames that were removed (for unlink)
 */
async function deleteErrandProofSlot(errandPool, orderId, driverId, proofKind) {
  const pt = proofKind === 'receipt' ? 'receipt' : 'delivery';
  const schema = await detectProofSchema(errandPool);
  if (!schema) return [];
  const tbl = quoteIdent(schema.table);
  const photoCol = quoteIdent(schema.photoCol);
  try {
    if (schema.hasProofType) {
      const [[row]] = await errandPool.query(
        `SELECT ${photoCol} AS photo_name FROM ${tbl} WHERE order_id = ? AND driver_id = ? AND proof_type = ? LIMIT 1`,
        [orderId, driverId, pt]
      );
      const name = row?.photo_name != null ? String(row.photo_name).trim() : '';
      await errandPool.query(`DELETE FROM ${tbl} WHERE order_id = ? AND driver_id = ? AND proof_type = ?`, [
        orderId,
        driverId,
        pt,
      ]);
      return name ? [name] : [];
    }
    if (pt === 'receipt') return [];
    const [[row]] = await errandPool.query(
      `SELECT ${photoCol} AS photo_name FROM ${tbl} WHERE order_id = ? AND driver_id = ? LIMIT 1`,
      [orderId, driverId]
    );
    const name = row?.photo_name != null ? String(row.photo_name).trim() : '';
    await errandPool.query(`DELETE FROM ${tbl} WHERE order_id = ? AND driver_id = ?`, [orderId, driverId]);
    return name ? [name] : [];
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      proofSchemaCache = null;
      return deleteErrandProofSlot(errandPool, orderId, driverId, proofKind);
    }
    throw e;
  }
}

/**
 * @param {string} uploadsErrandDir Absolute path to errand upload directory (same as multer dest).
 * @param {string[]} basenames
 */
function unlinkErrandProofFiles(uploadsErrandDir, basenames) {
  for (const base of basenames || []) {
    const safe = path.basename(String(base || '').replace(/\\/g, '/'));
    if (!safe || safe === '.' || safe === '..') continue;
    const full = path.join(uploadsErrandDir, safe);
    try {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch (_) {}
  }
}

module.exports = {
  buildErrandProofImageUrl,
  fetchErrandProofsForOrder,
  countErrandProofForOrder,
  insertErrandProofRow,
  deleteErrandProofSlot,
  unlinkErrandProofFiles,
  detectProofSchema,
  ensureErrandProofTable,
  CANONICAL_ERRAND_PROOF_TABLE,
};
