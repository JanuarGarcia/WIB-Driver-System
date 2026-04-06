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
 * Proof rows for an errand order (ErrandWib `wib_errand_driver_proof`).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 */
async function fetchErrandProofsForOrder(errandPool, orderId) {
  try {
    const [rows] = await errandPool.query(
      'SELECT id, order_id, driver_id, photo_name, date_created FROM wib_errand_driver_proof WHERE order_id = ? ORDER BY date_created ASC',
      [orderId]
    );
    return (rows || []).map((r) => ({
      ...r,
      proof_url: buildErrandProofImageUrl(r.photo_name),
    }));
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

async function countErrandProofForOrder(errandPool, orderId) {
  try {
    const [[r]] = await errandPool.query(
      'SELECT COUNT(*) AS c FROM wib_errand_driver_proof WHERE order_id = ?',
      [orderId]
    );
    return Number(r?.c ?? 0);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return 0;
    throw e;
  }
}

async function insertErrandProofRow(errandPool, orderId, driverId, photoName) {
  const [result] = await errandPool.query(
    'INSERT INTO wib_errand_driver_proof (order_id, driver_id, photo_name, date_created) VALUES (?, ?, ?, NOW())',
    [orderId, driverId, photoName]
  );
  return result.insertId;
}

module.exports = {
  buildErrandProofImageUrl,
  fetchErrandProofsForOrder,
  countErrandProofForOrder,
  insertErrandProofRow,
};
