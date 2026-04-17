const path = require('path');

const PUBLIC_BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

/** @typedef {'receipt'|'delivery'} TaskProofKind */

/**
 * Normalize task / order status for proof + terminal checks (matches driver.js legacy helper).
 * @param {unknown} s
 * @returns {string}
 */
function normalizeTaskStatusKeyForProof(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

/** Receipt / delivery uploads blocked once delivery is done or the job is closed negatively. */
const PROOF_UPLOAD_BLOCKED_STATUS_KEYS = new Set([
  'successful',
  'completed',
  'delivered',
  'cancelled',
  'canceled',
  'failed',
  'declined',
]);

/**
 * @param {unknown} statusRaw
 * @returns {boolean}
 */
function taskStatusAllowsProofReceipt(statusRaw) {
  const k = normalizeTaskStatusKeyForProof(statusRaw);
  return !PROOF_UPLOAD_BLOCKED_STATUS_KEYS.has(k);
}

/** Delivery proof: same gate as receipt (rider may replace either until terminal). */
function taskStatusAllowsProofDelivery(statusRaw) {
  return taskStatusAllowsProofReceipt(statusRaw);
}

const VALID_PROOF_TYPES = new Set(['receipt', 'delivery']);

/**
 * Normalize multipart/body proof_type. Unknown values return null.
 * @param {unknown} raw
 * @returns {TaskProofKind|null}
 */
function parseProofTypeParam(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'receipt' || s === 'proof_receipt' || s === 'proof_of_receipt') return 'receipt';
  if (s === 'delivery' || s === 'proof_delivery' || s === 'proof_of_delivery') return 'delivery';
  return null;
}

/**
 * Default `delivery` when omitted (legacy clients). Call after parseProofTypeParam === null.
 * @returns {TaskProofKind}
 */
function defaultProofTypeWhenOmitted() {
  return 'delivery';
}

/**
 * DB NULL or missing → usually delivery. For legacy/ambiguous rows, detect receipt from filename hints.
 * @param {unknown} stored
 * @param {unknown} photoName
 * @returns {TaskProofKind}
 */
function normalizeStoredProofType(stored, photoName) {
  if (stored == null || String(stored).trim() === '') {
    const hint = String(photoName || '').trim().toLowerCase();
    if (hint && /(receipt|proof[_-]?receipt)/i.test(hint)) return 'receipt';
    return 'delivery';
  }
  const s = String(stored).trim().toLowerCase();
  if (s === 'receipt' || s === 'proof_receipt' || s === 'proof_of_receipt') return 'receipt';
  return 'delivery';
}

/**
 * Infer proof kind from multipart field names when `proof_type` body field is absent.
 * @param {{ photo?: unknown[], receipt_photo?: unknown[], proof_receipt?: unknown[], proof_of_receipt?: unknown[], delivery_photo?: unknown[] }} groups
 * @returns {TaskProofKind|null} null → caller should use default delivery
 */
function inferProofTypeFromFileGroups(groups) {
  const g = groups && typeof groups === 'object' ? groups : {};
  const nPhoto = (g.photo || []).length;
  const nDel = (g.delivery_photo || []).length;
  const nRec =
    (g.receipt_photo || []).length + (g.proof_receipt || []).length + (g.proof_of_receipt || []).length;
  const onlyReceipt = nRec > 0 && nPhoto === 0 && nDel === 0;
  if (onlyReceipt) return 'receipt';
  return null;
}

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

  const selectColsExtended =
    'SELECT id, task_id, order_id, photo_name, proof_type, driver_id, date_created, ip_address FROM mt_driver_task_photo';
  const selectColsBasic = 'SELECT id, task_id, photo_name, date_created, ip_address FROM mt_driver_task_photo';

  let useExtendedCols = true;
  try {
    const [photoRows] = await pool.query(`${selectColsExtended} WHERE task_id = ?`, [taskId]);
    mergeRows(photoRows);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      useExtendedCols = false;
      try {
        const [photoRows] = await pool.query(`${selectColsBasic} WHERE task_id = ?`, [taskId]);
        mergeRows(photoRows);
      } catch (e2) {
        if (e2.code === 'ER_NO_SUCH_TABLE' || e2.code === 'ER_BAD_FIELD_ERROR') {
          return {
            task_photos: [],
            proof_images: [],
            proof_receipt_url: null,
            proof_delivery_url: null,
          };
        }
        throw e2;
      }
    } else if (e.code === 'ER_NO_SUCH_TABLE') {
      return { task_photos: [], proof_images: [], proof_receipt_url: null, proof_delivery_url: null };
    } else {
      throw e;
    }
  }

  const oid =
    orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0'
      ? parseInt(String(orderId), 10)
      : NaN;
  if (Number.isFinite(oid) && oid > 0) {
    try {
      const q = useExtendedCols
        ? `${selectColsExtended} WHERE order_id = ? AND (task_id IS NULL OR task_id = 0)`
        : `${selectColsBasic} WHERE order_id = ? AND (task_id IS NULL OR task_id = 0)`;
      const [orderScoped] = await pool.query(q, [oid]);
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
  const task_photos = rows.map((row) => {
    const kind = normalizeStoredProofType(row.proof_type, row.photo_name);
    return {
      ...row,
      proof_type: kind,
      proof_url: buildTaskProofImageUrl(row.photo_name),
    };
  });
  const proof_images = task_photos.map((r) => r.proof_url).filter(Boolean);

  let proof_receipt_url = null;
  let proof_delivery_url = null;
  const receiptRows = task_photos.filter((r) => r.proof_type === 'receipt');
  const deliveryRows = task_photos.filter((r) => r.proof_type === 'delivery');
  if (receiptRows.length) {
    const last = receiptRows[receiptRows.length - 1];
    proof_receipt_url = last.proof_url || null;
  }
  if (deliveryRows.length) {
    const last = deliveryRows[deliveryRows.length - 1];
    proof_delivery_url = last.proof_url || null;
  }

  return { task_photos, proof_images, proof_receipt_url, proof_delivery_url };
}

/**
 * Remove existing rows for this task + proof slot so a new upload replaces the same kind (receipt vs delivery).
 * Keep ambiguous legacy NULL rows (could include old receipt uploads) to avoid deleting valid proof history.
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} executor
 * @param {number} taskId
 * @param {TaskProofKind} proofKind
 */
async function deleteDriverTaskProofSlot(executor, taskId, proofKind) {
  const kind = proofKind === 'receipt' ? 'receipt' : 'delivery';
  try {
    if (kind === 'receipt') {
      await executor.query('DELETE FROM mt_driver_task_photo WHERE task_id = ? AND proof_type = ?', [taskId, 'receipt']);
    } else {
      await executor.query(
        'DELETE FROM mt_driver_task_photo WHERE task_id = ? AND (proof_type = ? OR proof_type IS NULL)',
        [taskId, 'delivery']
      );
    }
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      /* Column proof_type missing — legacy DB keeps multiple rows; do not delete. */
      return;
    }
    throw e;
  }
}

/**
 * Photo basenames to unlink before `deleteDriverTaskProofSlot` (delivery includes legacy NULL proof_type).
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} executor
 * @param {number} taskId
 * @param {'receipt'|'delivery'} proofKind
 * @returns {Promise<string[]>}
 */
async function selectDriverTaskProofFileNames(executor, taskId, proofKind) {
  const kind = proofKind === 'receipt' ? 'receipt' : 'delivery';
  try {
    if (kind === 'receipt') {
      const [rows] = await executor.query(
        'SELECT photo_name FROM mt_driver_task_photo WHERE task_id = ? AND proof_type = ?',
        [taskId, 'receipt']
      );
      return (rows || []).map((r) => String(r.photo_name || '').trim()).filter(Boolean);
    }
    const [rows] = await executor.query(
      'SELECT photo_name FROM mt_driver_task_photo WHERE task_id = ? AND (proof_type = ? OR proof_type IS NULL)',
      [taskId, 'delivery']
    );
    return (rows || []).map((r) => String(r.photo_name || '').trim()).filter(Boolean);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      if (kind === 'receipt') return [];
      const [rows] = await executor.query('SELECT photo_name FROM mt_driver_task_photo WHERE task_id = ?', [taskId]);
      return (rows || []).map((r) => String(r.photo_name || '').trim()).filter(Boolean);
    }
    throw e;
  }
}

/**
 * Insert one proof row; includes order_id when the column exists and a positive orderId is provided.
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} executor
 * @param {TaskProofKind} [proofKind]
 * @param {number|null} [driverId]
 * @returns {Promise<number|undefined>} insertId when available
 */
async function insertDriverTaskPhotoRow(executor, taskId, photoName, ip, orderId, proofKind, driverId) {
  const ipVal = ip || null;
  const oid =
    orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0'
      ? parseInt(String(orderId), 10)
      : NaN;
  const pType = proofKind === 'receipt' ? 'receipt' : 'delivery';
  const did = driverId != null && Number.isFinite(Number(driverId)) && Number(driverId) > 0 ? Number(driverId) : null;

  const tryWithProofMeta = async () => {
    if (Number.isFinite(oid) && oid > 0 && did != null) {
      const [ins] = await executor.query(
        'INSERT INTO mt_driver_task_photo (task_id, order_id, photo_name, proof_type, driver_id, date_created, ip_address) VALUES (?, ?, ?, ?, ?, NOW(), ?)',
        [taskId, oid, photoName, pType, did, ipVal]
      );
      return ins.insertId;
    }
    if (Number.isFinite(oid) && oid > 0) {
      const [ins] = await executor.query(
        'INSERT INTO mt_driver_task_photo (task_id, order_id, photo_name, proof_type, date_created, ip_address) VALUES (?, ?, ?, ?, NOW(), ?)',
        [taskId, oid, photoName, pType, ipVal]
      );
      return ins.insertId;
    }
    if (did != null) {
      const [ins] = await executor.query(
        'INSERT INTO mt_driver_task_photo (task_id, photo_name, proof_type, driver_id, date_created, ip_address) VALUES (?, ?, ?, ?, NOW(), ?)',
        [taskId, photoName, pType, did, ipVal]
      );
      return ins.insertId;
    }
    const [ins] = await executor.query(
      'INSERT INTO mt_driver_task_photo (task_id, photo_name, proof_type, date_created, ip_address) VALUES (?, ?, ?, NOW(), ?)',
      [taskId, photoName, pType, ipVal]
    );
    return ins.insertId;
  };

  try {
    return await tryWithProofMeta();
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

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
  deleteDriverTaskProofSlot,
  selectDriverTaskProofFileNames,
  parseProofTypeParam,
  defaultProofTypeWhenOmitted,
  normalizeStoredProofType,
  inferProofTypeFromFileGroups,
  normalizeTaskStatusKeyForProof,
  taskStatusAllowsProofReceipt,
  taskStatusAllowsProofDelivery,
};
