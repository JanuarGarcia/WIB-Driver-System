'use strict';

function toPositiveInt(value) {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function uniqPositiveInts(values) {
  return [...new Set((values || []).map((value) => toPositiveInt(value)).filter((value) => value != null))];
}

function normalizeLookupValue(value) {
  return value != null ? String(value).trim() : '';
}

async function fetchMtDriverRow(mainPool, wibDriverId) {
  if (!mainPool) return null;
  const did = toPositiveInt(wibDriverId);
  if (!did) return null;
  try {
    const [[row]] = await mainPool.query('SELECT * FROM mt_driver WHERE driver_id = ? LIMIT 1', [did]);
    return row || null;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

async function fetchStDriverById(errandPool, manganDriverId) {
  if (!errandPool) return null;
  const did = toPositiveInt(manganDriverId);
  if (!did) return null;
  try {
    const [[row]] = await errandPool.query('SELECT * FROM st_driver WHERE driver_id = ? LIMIT 1', [did]);
    return row || null;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

async function fetchUniqueStDriverByField(errandPool, column, value) {
  if (!errandPool) return null;
  const normalized = normalizeLookupValue(value);
  if (!normalized) return null;
  try {
    const [rows] = await errandPool.query(
      `SELECT * FROM st_driver
       WHERE LOWER(TRIM(COALESCE(\`${column}\`, ''))) = LOWER(TRIM(?))
       ORDER BY driver_id ASC
       LIMIT 2`,
      [normalized]
    );
    return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

async function fetchUniqueStDriverByName(errandPool, firstName, lastName) {
  if (!errandPool) return null;
  const first = normalizeLookupValue(firstName);
  const last = normalizeLookupValue(lastName);
  if (!first || !last) return null;
  try {
    const [rows] = await errandPool.query(
      `SELECT * FROM st_driver
       WHERE LOWER(TRIM(COALESCE(first_name, ''))) = LOWER(TRIM(?))
         AND LOWER(TRIM(COALESCE(last_name, ''))) = LOWER(TRIM(?))
       ORDER BY driver_id ASC
       LIMIT 2`,
      [first, last]
    );
    return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

/**
 * Resolve which legacy ErrandWib `st_driver.driver_id` belongs to one primary `mt_driver.driver_id`.
 *
 * `candidateDriverIds` always includes the WIB driver id as a transitional read fallback so
 * old rows that were written with the wrong id do not disappear immediately.
 *
 * @param {import('mysql2/promise').Pool|null|undefined} mainPool
 * @param {import('mysql2/promise').Pool|null|undefined} errandPool
 * @param {number|string|null|undefined} wibDriverId
 */
async function resolveErrandDriverLink(mainPool, errandPool, wibDriverId) {
  const wibId = toPositiveInt(wibDriverId);
  const unresolved = {
    wibDriverId: wibId,
    manganDriverId: null,
    candidateDriverIds: uniqPositiveInts([wibId]),
    source: 'unlinked',
  };
  if (!wibId) return unresolved;

  const mtRow = await fetchMtDriverRow(mainPool, wibId);

  const explicitManganId = toPositiveInt(mtRow?.mangan_driver_id);
  if (explicitManganId) {
    const explicitRow = await fetchStDriverById(errandPool, explicitManganId);
    if (explicitRow) {
      return {
        wibDriverId: wibId,
        manganDriverId: explicitManganId,
        candidateDriverIds: uniqPositiveInts([explicitManganId, wibId]),
        source: 'mt_driver.mangan_driver_id',
      };
    }
  }

  const sameIdRow = await fetchStDriverById(errandPool, wibId);
  if (sameIdRow) {
    return {
      wibDriverId: wibId,
      manganDriverId: wibId,
      candidateDriverIds: [wibId],
      source: 'same_driver_id',
    };
  }

  const candidateKeys = [];
  const pushKey = (field, value) => {
    const normalized = normalizeLookupValue(value);
    if (!normalized) return;
    if (!candidateKeys.some((entry) => entry.field === field && entry.value.toLowerCase() === normalized.toLowerCase())) {
      candidateKeys.push({ field, value: normalized });
    }
  };

  pushKey('wib_sync_username', mtRow?.mangan_api_username);
  pushKey('email', mtRow?.mangan_api_username);
  pushKey('email', mtRow?.email);
  pushKey('wib_sync_username', mtRow?.username);
  pushKey('email', mtRow?.username);

  for (const candidate of candidateKeys) {
    const stRow = await fetchUniqueStDriverByField(errandPool, candidate.field, candidate.value);
    const manganDriverId = toPositiveInt(stRow?.driver_id);
    if (manganDriverId) {
      return {
        wibDriverId: wibId,
        manganDriverId,
        candidateDriverIds: uniqPositiveInts([manganDriverId, wibId]),
        source: `${candidate.field}:${candidate.value}`,
      };
    }
  }

  const nameMatch = await fetchUniqueStDriverByName(errandPool, mtRow?.first_name, mtRow?.last_name);
  const nameDriverId = toPositiveInt(nameMatch?.driver_id);
  if (nameDriverId) {
    return {
      wibDriverId: wibId,
      manganDriverId: nameDriverId,
      candidateDriverIds: uniqPositiveInts([nameDriverId, wibId]),
      source: 'full_name',
    };
  }

  return unresolved;
}

/**
 * @param {import('mysql2/promise').Pool|null|undefined} mainPool
 * @param {import('mysql2/promise').Pool|null|undefined} errandPool
 * @param {(number|string|null|undefined)[]} wibDriverIds
 */
async function resolveErrandDriverLinks(mainPool, errandPool, wibDriverIds) {
  const uniq = uniqPositiveInts(wibDriverIds);
  const entries = await Promise.all(uniq.map(async (driverId) => [driverId, await resolveErrandDriverLink(mainPool, errandPool, driverId)]));
  return new Map(entries);
}

function orderAssignedDriverId(row) {
  return toPositiveInt(row?.driver_id);
}

function orderAssignedToDriverCandidates(row, candidateDriverIds) {
  const assigned = orderAssignedDriverId(row);
  if (!assigned) return false;
  return uniqPositiveInts(candidateDriverIds).includes(assigned);
}

module.exports = {
  toPositiveInt,
  uniqPositiveInts,
  resolveErrandDriverLink,
  resolveErrandDriverLinks,
  orderAssignedDriverId,
  orderAssignedToDriverCandidates,
};
