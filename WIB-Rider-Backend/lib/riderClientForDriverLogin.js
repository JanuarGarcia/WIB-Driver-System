/**
 * Resolve rider/customer rows for driver app login (Option A2: linked mt_driver.client_id).
 * Primary source: mt_client on the same DB as mt_driver (restomulti-style).
 * Optional: st_client on errand pool when DRIVER_LOGIN_CHECK_ERRAND_ST_CLIENT=1 (only if client_id values match your mt_driver.client_id usage).
 */

const MSG_NOT_DRIVER =
  'This account is not a driver account. Contact admin to enable driver access or use driver credentials.';

/**
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function trySelect(dbPool, sql, params) {
  try {
    const [rows] = await dbPool.query(sql, params);
    return rows && rows[0] ? rows[0] : null;
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

/**
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {'mt_client' | 'st_client'} table
 * @param {Record<string, unknown>} row
 */
async function enrichClientRowWithBcrypt(dbPool, table, row) {
  if (!row || row.client_id == null) return row;
  const bc = await trySelect(
    dbPool,
    `SELECT password_bcrypt FROM ${table} WHERE client_id = ? LIMIT 1`,
    [row.client_id]
  );
  return {
    client_id: row.client_id,
    password: String(row.password || ''),
    password_bcrypt: bc && bc.password_bcrypt != null ? String(bc.password_bcrypt).trim() : '',
  };
}

/**
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {'mt_client' | 'st_client'} table
 * @param {string} identifier login field from app (usually email)
 * @returns {Promise<{ client_id: number, password: string, password_bcrypt: string } | null>}
 */
async function fetchClientByIdentifier(dbPool, table, identifier) {
  const key = (identifier || '').trim().toLowerCase();
  if (!key) return null;

  const queries = [
    [
      `SELECT client_id, password FROM ${table} WHERE LOWER(TRIM(COALESCE(email_address,''))) = ? LIMIT 1`,
      [key],
    ],
    [
      `SELECT client_id, password_hash AS password FROM ${table} WHERE LOWER(TRIM(COALESCE(email_address,''))) = ? LIMIT 1`,
      [key],
    ],
    [
      `SELECT client_id, password FROM ${table} WHERE LOWER(TRIM(COALESCE(username,''))) = ? LIMIT 1`,
      [key],
    ],
    [
      `SELECT client_id, password_hash AS password FROM ${table} WHERE LOWER(TRIM(COALESCE(username,''))) = ? LIMIT 1`,
      [key],
    ],
    [`SELECT client_id, password FROM ${table} WHERE LOWER(TRIM(email_address)) = ? LIMIT 1`, [key]],
    [`SELECT client_id, password_hash AS password FROM ${table} WHERE LOWER(TRIM(email_address)) = ? LIMIT 1`, [key]],
  ];

  for (const [sql, params] of queries) {
    const row = await trySelect(dbPool, sql, params);
    if (row && row.client_id != null) return enrichClientRowWithBcrypt(dbPool, table, row);
  }
  return null;
}

/**
 * @param {string} identifier
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('mysql2/promise').Pool | null} errandWibPool
 * @param {{ checkErrandStClient?: boolean }} [opts]
 * @returns {Promise<{ client_id: number, password: string, password_bcrypt: string, source: string } | null>}
 */
async function findRiderClientAcrossDatabases(identifier, pool, errandWibPool, opts = {}) {
  const checkErrand = opts.checkErrandStClient === true;
  let row = await fetchClientByIdentifier(pool, 'mt_client', identifier);
  if (row) {
    return {
      client_id: row.client_id,
      password: row.password,
      password_bcrypt: row.password_bcrypt,
      source: 'mt_client',
    };
  }
  if (checkErrand && errandWibPool) {
    row = await fetchClientByIdentifier(errandWibPool, 'st_client', identifier);
    if (row) {
      return {
        client_id: row.client_id,
        password: row.password,
        password_bcrypt: row.password_bcrypt,
        source: 'st_client',
      };
    }
  }
  return null;
}

/**
 * Auth fields for mt_client on primary pool (driver login sync / dual password).
 * @param {import('mysql2/promise').Pool} pool
 * @param {number|string} clientId
 * @returns {Promise<{ password: string, password_bcrypt: string } | null>}
 */
async function loadPrimaryClientAuthRow(pool, clientId) {
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  const attempts = [
    'SELECT password, password_bcrypt FROM mt_client WHERE client_id = ? LIMIT 1',
    'SELECT password_hash AS password, password_bcrypt FROM mt_client WHERE client_id = ? LIMIT 1',
    'SELECT password FROM mt_client WHERE client_id = ? LIMIT 1',
    'SELECT password_hash AS password FROM mt_client WHERE client_id = ? LIMIT 1',
  ];
  for (const sql of attempts) {
    const row = await trySelect(pool, sql, [cid]);
    if (row) {
      return {
        password: String(row.password || '').trim(),
        password_bcrypt: String(row.password_bcrypt || '').trim(),
      };
    }
  }
  return null;
}

module.exports = {
  findRiderClientAcrossDatabases,
  loadPrimaryClientAuthRow,
  MSG_NOT_DRIVER,
};
