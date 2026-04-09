/**
 * Resolve customer FCM token (and optional device ref for logging) from mt_client / st_client.
 * Uses INFORMATION_SCHEMA so legacy column names can coexist.
 */

/** @type {Map<string, Set<string>>} */
const columnCache = new Map();

/**
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {string} tableName
 * @returns {Promise<Set<string>>}
 */
async function loadColumnSet(dbPool, tableName) {
  const cacheKey = `${tableName}`;
  const hit = columnCache.get(cacheKey);
  if (hit) return hit;
  const [rows] = await dbPool.query(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  const set = new Set((rows || []).map((r) => String(r.c)));
  columnCache.set(cacheKey, set);
  return set;
}

const TOKEN_PRIORITY = [
  'device_id',
  'fcm_token',
  'gcm_token',
  'ios_device_id',
  'android_device_id',
  'registration_id',
  'device_token',
  'push_notification_token',
];

const DEVICE_REF_PRIORITY = ['device_uiid', 'device_uuid', 'mobile_uuid', 'uuid'];

/**
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {'mt_client' | 'st_client'} tableName
 * @param {number} clientId
 * @returns {Promise<{ token: string | null, deviceRef: string | null }>}
 */
async function fetchClientFcmTokenAndDeviceRef(dbPool, tableName, clientId) {
  if (!Number.isFinite(clientId) || clientId <= 0) return { token: null, deviceRef: null };
  let cols;
  try {
    cols = await loadColumnSet(dbPool, tableName);
  } catch (_) {
    return { token: null, deviceRef: null };
  }
  const tokenCol = TOKEN_PRIORITY.find((c) => cols.has(c));
  if (!tokenCol) return { token: null, deviceRef: null };
  const refCols = DEVICE_REF_PRIORITY.filter((c) => cols.has(c));
  const parts = [`\`${tokenCol}\` AS _fcm_tok`];
  for (const c of refCols) {
    parts.push(`\`${c}\` AS _ref_${c}`);
  }
  let row;
  try {
    const [r] = await dbPool.query(`SELECT ${parts.join(', ')} FROM \`${tableName}\` WHERE client_id = ? LIMIT 1`, [
      clientId,
    ]);
    row = r && r[0];
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return { token: null, deviceRef: null };
    throw e;
  }
  if (!row) return { token: null, deviceRef: null };
  const raw = row._fcm_tok;
  const token = raw != null && String(raw).trim() ? String(raw).trim() : null;
  let deviceRef = null;
  for (const c of refCols) {
    const v = row[`_ref_${c}`];
    if (v != null && String(v).trim()) {
      deviceRef = String(v).trim();
      break;
    }
  }
  return { token, deviceRef };
}

module.exports = { fetchClientFcmTokenAndDeviceRef };
