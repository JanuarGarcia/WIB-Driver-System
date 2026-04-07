const path = require('path');

const PUBLIC_BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

function proofAssetBaseUrl() {
  const v = process.env.PROOF_ASSET_BASE_URL;
  if (v != null && String(v).trim() !== '') return String(v).trim().replace(/\/$/, '');
  return PUBLIC_BASE_URL;
}

function proofLegacyPlainUsesDriverPath() {
  const v = process.env.PROOF_LEGACY_PLAIN_USES_DRIVER_PATH;
  return v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes';
}

function sanitizeTaskProofFileName(photoName) {
  let s = String(photoName || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^<+/, '').replace(/>+$/, '').trim();
  s = path.basename(s);
  const doubleExt = /\.(jpg|jpeg|png|gif|webp)\.(jpg|jpeg|png|gif|webp)$/i.exec(s);
  if (doubleExt) s = s.slice(0, -(doubleExt[1].length + 1));
  if (!s || s === '.' || s === '..') return '';
  return s;
}

function taskProofDriverBasename(photoName) {
  let s = String(photoName || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^<+/, '').replace(/>+$/, '').trim();
  s = path.basename(s);
  if (!s || s === '.' || s === '..') return '';
  return s;
}

/** Public URL for on-disk proof: legacy /upload/driver/ or /upload/task/ + sanitized name */
function buildTaskProofImageUrl(photoName) {
  const trimmed = String(photoName || '').trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const raw = trimmed.replace(/\\/g, '/');
  const baseUrl = proofAssetBaseUrl();
  const lower = raw.toLowerCase();
  if (lower.includes('/driver/') || lower.includes('upload/driver')) {
    const base = taskProofDriverBasename(photoName);
    if (!base) return null;
    const rel = `/upload/driver/${encodeURIComponent(base)}`;
    return baseUrl ? `${baseUrl}${rel}` : rel;
  }
  if (proofLegacyPlainUsesDriverPath() && raw.length > 0 && !raw.includes('/')) {
    const base = taskProofDriverBasename(photoName);
    if (!base) return null;
    const rel = `/upload/driver/${encodeURIComponent(base)}`;
    return baseUrl ? `${baseUrl}${rel}` : rel;
  }
  const safe = sanitizeTaskProofFileName(photoName);
  if (!safe) return null;
  const rel = `/upload/task/${encodeURIComponent(safe)}`;
  return baseUrl ? `${baseUrl}${rel}` : rel;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} taskId
 * @param {number|null|undefined} [orderId] When set, also loads rows tied to the order but not this task
 *   (e.g. proof-of-receipt saved with order_id and task_id NULL/0 — same pattern as mt_order_history).
 */
async function fetchTaskProofPhotosWithUrls(pool, taskId, orderId) {
  const byId = new Map();
  const mergeRows = (photoRows) => {
    for (const row of photoRows || []) {
      if (!row || row.id == null) continue;
      byId.set(Number(row.id), row);
    }
  };
  try {
    const [photoRows] = await pool.query(
      'SELECT id, task_id, photo_name, date_created, ip_address FROM mt_driver_task_photo WHERE task_id = ?',
      [taskId]
    );
    mergeRows(photoRows);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return { task_photos: [], proof_images: [] };
    }
    throw e;
  }

  const oid =
    orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0'
      ? parseInt(String(orderId), 10)
      : NaN;
  if (Number.isFinite(oid) && oid > 0) {
    try {
      const [orderScoped] = await pool.query(
        `SELECT id, task_id, photo_name, date_created, ip_address FROM mt_driver_task_photo
         WHERE order_id = ? AND (task_id IS NULL OR task_id = 0)`,
        [oid]
      );
      mergeRows(orderScoped);
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
  }

  const rows = Array.from(byId.values()).sort((a, b) => {
    const ta = a.date_created ? new Date(a.date_created).getTime() : 0;
    const tb = b.date_created ? new Date(b.date_created).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return Number(a.id) - Number(b.id);
  });
  const task_photos = rows.map((row) => ({
    ...row,
    proof_url: buildTaskProofImageUrl(row.photo_name),
  }));
  const proof_images = task_photos.map((r) => r.proof_url).filter(Boolean);
  return { task_photos, proof_images };
}

/**
 * Insert one proof row; includes order_id when the column exists and a positive orderId is provided.
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} executor
 * @returns {Promise<number|undefined>} insertId when available
 */
async function insertDriverTaskPhotoRow(executor, taskId, photoName, ip, orderId) {
  const ipVal = ip || null;
  const oid =
    orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0'
      ? parseInt(String(orderId), 10)
      : NaN;
  try {
    if (Number.isFinite(oid) && oid > 0) {
      const [ins] = await executor.query(
        'INSERT INTO mt_driver_task_photo (task_id, order_id, photo_name, date_created, ip_address) VALUES (?, ?, ?, NOW(), ?)',
        [taskId, oid, photoName, ipVal]
      );
      return ins.insertId;
    }
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  try {
    const [ins] = await executor.query(
      'INSERT INTO mt_driver_task_photo (task_id, photo_name, date_created, ip_address) VALUES (?, ?, NOW(), ?)',
      [taskId, photoName, ipVal]
    );
    return ins.insertId;
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      const [ins2] = await executor.query('INSERT INTO mt_driver_task_photo (task_id, photo_name) VALUES (?, ?)', [
        taskId,
        photoName,
      ]);
      return ins2.insertId;
    }
    throw e;
  }
}

module.exports = {
  buildTaskProofImageUrl,
  fetchTaskProofPhotosWithUrls,
  sanitizeTaskProofFileName,
  insertDriverTaskPhotoRow,
};
