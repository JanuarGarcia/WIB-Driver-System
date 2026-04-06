const path = require('path');

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
 * Whitelisted proof table layouts (ErrandWib). First successful INSERT wins and caches for the process.
 * @type {{ table: string, photoCol: string } | null}
 */
let proofSchemaCache = null;

const PROOF_SCHEMA_CANDIDATES = [
  { table: 'wib_errand_driver_proof', photoCol: 'photo_name' },
  { table: 'mt_errand_driver_proof', photoCol: 'photo_name' },
  { table: 'mt_errand_driver_proof', photoCol: 'photo' },
];

function quoteIdent(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('Invalid SQL identifier');
  return `\`${name}\``;
}

/**
 * @param {import('mysql2/promise').Pool} errandPool
 * @returns {Promise<{ table: string, photoCol: string } | null>}
 */
async function detectProofSchema(errandPool) {
  if (proofSchemaCache) return proofSchemaCache;
  for (const s of PROOF_SCHEMA_CANDIDATES) {
    try {
      await errandPool.query(`SELECT 1 FROM ${quoteIdent(s.table)} LIMIT 1`);
      proofSchemaCache = s;
      return s;
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
    const [rows] = await errandPool.query(
      `SELECT id, order_id, driver_id, ${photoSel} AS photo_name, date_created FROM ${tbl} WHERE order_id = ? ORDER BY date_created ASC`,
      [orderId]
    );
    return (rows || []).map((r) => ({
      ...r,
      proof_url: buildErrandProofImageUrl(r.photo_name),
    }));
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
    const [[r]] = await errandPool.query(`SELECT COUNT(*) AS c FROM ${tbl} WHERE order_id = ?`, [orderId]);
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
 * @returns {Promise<number>} insert id
 */
async function insertErrandProofRow(errandPool, orderId, driverId, photoName) {
  const runInsert = async (s) => {
    const tbl = quoteIdent(s.table);
    const col = quoteIdent(s.photoCol);
    const [result] = await errandPool.query(
      `INSERT INTO ${tbl} (order_id, driver_id, ${col}, date_created) VALUES (?, ?, ?, NOW())`,
      [orderId, driverId, photoName]
    );
    proofSchemaCache = s;
    return result.insertId;
  };

  if (proofSchemaCache) {
    try {
      return await runInsert(proofSchemaCache);
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
    try {
      return await runInsert(s);
    } catch (e) {
      lastErr = e;
      if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') continue;
      throw e;
    }
  }
  const err = lastErr || new Error('No errand proof table available');
  err.code = err.code || 'ER_NO_SUCH_TABLE';
  throw err;
}

module.exports = {
  buildErrandProofImageUrl,
  fetchErrandProofsForOrder,
  countErrandProofForOrder,
  insertErrandProofRow,
  detectProofSchema,
};
