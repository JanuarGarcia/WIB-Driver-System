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

async function fetchTaskProofPhotosWithUrls(pool, taskId) {
  try {
    const [photoRows] = await pool.query(
      'SELECT id, task_id, photo_name, date_created, ip_address FROM mt_driver_task_photo WHERE task_id = ? ORDER BY date_created ASC',
      [taskId]
    );
    const rows = photoRows || [];
    const task_photos = rows.map((row) => ({
      ...row,
      proof_url: buildTaskProofImageUrl(row.photo_name),
    }));
    const proof_images = task_photos.map((r) => r.proof_url).filter(Boolean);
    return { task_photos, proof_images };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return { task_photos: [], proof_images: [] };
    }
    throw e;
  }
}

module.exports = {
  buildTaskProofImageUrl,
  fetchTaskProofPhotosWithUrls,
  sanitizeTaskProofFileName,
};
