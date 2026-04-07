/**
 * Maps st_ordernew (wheninba_ErrandWib) rows into task-list shapes for the dashboard.
 * task_id is negative (-order_id) so it cannot collide with mt_driver_task.task_id.
 */

const {
  normalizeDriverPaymentType,
  normalizeDriverPaymentStatus,
  mapPaymentRawToEnum,
} = require('./errandPayment');
const {
  deriveErrandDriverTaskStatus,
  mapDeliveryToCanonicalTaskStatus,
} = require('./errandDriverStatus');

function mapDeliveryToTaskStatus(deliveryStatus, orderStatus) {
  return mapDeliveryToCanonicalTaskStatus(deliveryStatus, orderStatus);
}

/**
 * Map latest `st_ordernew_history.status` + row into driver task status (canonical ladder).
 * @param {string|null|undefined} historyStatusRaw
 * @param {unknown} deliveryStatus - st_ordernew.delivery_status
 * @param {unknown} orderStatus - st_ordernew.status
 * @param {number|null|undefined} driverId - assigned rider (mt_driver), if any
 */
function mapErrandHistoryStatusToTaskStatus(historyStatusRaw, deliveryStatus, orderStatus, driverId) {
  return deriveErrandDriverTaskStatus(deliveryStatus, orderStatus, historyStatusRaw, driverId);
}

/**
 * Latest `st_ordernew_history.status` per order (by max id).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number[]} orderIds
 * @returns {Promise<Map<string, string>>}
 */
async function fetchErrandLatestHistoryStatusByOrderIds(errandPool, orderIds) {
  const map = new Map();
  const uniq = [...new Set(orderIds.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  try {
    const [rows] = await errandPool.query(
      `SELECT h.order_id, h.status
       FROM st_ordernew_history h
       INNER JOIN (
         SELECT order_id, MAX(id) AS max_id
         FROM st_ordernew_history
         WHERE order_id IN (${ph})
         GROUP BY order_id
       ) lm ON lm.order_id = h.order_id AND lm.max_id = h.id`,
      uniq
    );
    for (const r of rows || []) {
      if (r.order_id != null && r.status != null && String(r.status).trim() !== '') {
        map.set(String(r.order_id), String(r.status).trim());
      }
    }
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return map;
    throw e;
  }
  return map;
}

function driverDisplayName(map, driverId) {
  if (driverId == null || driverId === '') return null;
  const k = String(driverId);
  return map.get(k) || null;
}

/** E.164-style phone from ErrandWib `st_driver` (`phone_prefix` + `phone`). */
function errandDriverPhoneFromRow(d) {
  if (!d || typeof d !== 'object') return null;
  const raw = d.phone != null ? String(d.phone).trim() : '';
  if (!raw) return null;
  const prefix = d.phone_prefix != null ? String(d.phone_prefix).trim().replace(/\D/g, '') : '';
  if (raw.startsWith('+')) {
    let digits = raw.slice(1).replace(/\D/g, '');
    if (prefix === '63' && digits.startsWith('6363')) {
      digits = `63${digits.slice(4)}`;
    }
    return digits ? `+${digits}` : raw;
  }
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (prefix && digits.startsWith(prefix)) {
    return `+${digits}`;
  }
  if (prefix === '63' && digits.startsWith('0') && digits.length >= 10) {
    return `+63${digits.slice(1)}`;
  }
  if (prefix) {
    return `+${prefix}${digits}`;
  }
  if (digits.startsWith('63')) {
    return `+${digits}`;
  }
  return raw;
}

/**
 * Batch-load ErrandWib `st_driver` rows for task list / detail (names, phone, team, verification).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number[]} driverIds
 * @returns {Promise<Map<string, { full_name: string|null, driver_phone: string|null, verification_code: string|null, team_id: number|null, photo: string|null }>>}
 */
async function fetchErrandStDriversByIds(errandPool, driverIds) {
  const map = new Map();
  if (!errandPool) return map;
  const uniq = [
    ...new Set(
      driverIds
        .map((n) => parseInt(String(n), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  const attempts = [
    `SELECT driver_id, first_name, last_name, phone_prefix, phone, photo, team_id, verification_code FROM st_driver WHERE driver_id IN (${ph})`,
    `SELECT driver_id, first_name, last_name, phone_prefix, phone, photo, team_id FROM st_driver WHERE driver_id IN (${ph})`,
    `SELECT driver_id, first_name, last_name, phone FROM st_driver WHERE driver_id IN (${ph})`,
  ];
  for (const sql of attempts) {
    try {
      const [rows] = await errandPool.query(sql, uniq);
      for (const r of rows || []) {
        if (r.driver_id == null) continue;
        const fn = r.first_name != null ? String(r.first_name).trim() : '';
        const ln = r.last_name != null ? String(r.last_name).trim() : '';
        const full = [fn, ln].filter(Boolean).join(' ').trim() || null;
        const tid = r.team_id != null ? parseInt(String(r.team_id), 10) : NaN;
        const team_id = Number.isFinite(tid) && tid > 0 ? tid : null;
        const hasVer = Object.prototype.hasOwnProperty.call(r, 'verification_code');
        map.set(String(r.driver_id), {
          full_name: full,
          driver_phone: errandDriverPhoneFromRow(r),
          verification_code:
            hasVer && r.verification_code != null && String(r.verification_code).trim() !== ''
              ? String(r.verification_code).trim()
              : null,
          team_id,
          photo: r.photo != null && String(r.photo).trim() !== '' ? String(r.photo).trim() : null,
        });
      }
      return map;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return map;
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }
  return map;
}

/**
 * One primary errand driver group per driver (ErrandWib `st_driver_group` + relation table).
 * Picks the relation with latest `date_created`, then lowest `group_id` on tie.
 * Tries `st_driver_group_relations` then `st_driver_group_relation`.
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number[]} driverIds
 * @returns {Promise<Map<string, { group_id: number|null, group_name: string|null, color_hex: string|null }>>}
 */
async function fetchErrandDriverPrimaryGroupByDriverIds(errandPool, driverIds) {
  const out = new Map();
  if (!errandPool) return out;
  const uniq = [
    ...new Set(
      driverIds
        .map((n) => parseInt(String(n), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (!uniq.length) return out;
  const ph = uniq.map(() => '?').join(',');
  const relTables = ['st_driver_group_relations', 'st_driver_group_relation'];

  const reduceRows = (rows) => {
    /** @type {Map<string, Record<string, unknown>>} */
    const best = new Map();
    const rowTime = (r) => {
      const raw = r.rel_date_created ?? r.date_created;
      if (raw == null) return 0;
      const t = new Date(raw).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    const rowGid = (r) => {
      const n = r.group_id != null ? parseInt(String(r.group_id), 10) : NaN;
      return Number.isFinite(n) ? n : 999999;
    };
    for (const r of rows || []) {
      if (r.driver_id == null) continue;
      const did = String(r.driver_id);
      const prev = best.get(did);
      if (!prev) {
        best.set(did, r);
        continue;
      }
      const ta = rowTime(r);
      const tb = rowTime(prev);
      if (ta > tb || (ta === tb && rowGid(r) < rowGid(prev))) {
        best.set(did, r);
      }
    }
    for (const [did, r] of best) {
      const gid = r.group_id != null ? parseInt(String(r.group_id), 10) : NaN;
      const name = r.group_name != null ? String(r.group_name).trim() : '';
      const hex = r.color_hex != null ? String(r.color_hex).trim() : '';
      out.set(did, {
        group_id: Number.isFinite(gid) ? gid : null,
        group_name: name || null,
        color_hex: hex || null,
      });
    }
  };

  for (const relTable of relTables) {
    const attempts = [
      `SELECT r.driver_id, r.group_id, r.date_created AS rel_date_created, g.group_name, g.color_hex
       FROM ${relTable} r
       INNER JOIN st_driver_group g ON g.group_id = r.group_id
       WHERE r.driver_id IN (${ph})`,
      `SELECT r.driver_id, r.group_id, g.group_name, g.color_hex
       FROM ${relTable} r
       INNER JOIN st_driver_group g ON g.group_id = r.group_id
       WHERE r.driver_id IN (${ph})`,
    ];
    for (const sql of attempts) {
      try {
        const [rows] = await errandPool.query(sql, uniq);
        reduceRows(rows);
        return out;
      } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') {
          break;
        }
        if (e.code === 'ER_BAD_FIELD_ERROR') {
          continue;
        }
        throw e;
      }
    }
  }
  return out;
}

/**
 * Mutates values from `fetchErrandStDriversByIds` with `errand_group_id`, `errand_group_name`, `errand_group_color_hex`.
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {Map<string, Record<string, unknown>>} errandDriverById
 */
async function attachErrandDriverGroups(errandPool, errandDriverById) {
  if (!errandPool || !errandDriverById || errandDriverById.size === 0) return;
  const ids = [...errandDriverById.keys()]
    .map((k) => parseInt(String(k), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const gMap = await fetchErrandDriverPrimaryGroupByDriverIds(errandPool, ids);
  for (const [did, row] of errandDriverById) {
    const g = gMap.get(did);
    if (!g) continue;
    row.errand_group_id = g.group_id;
    row.errand_group_name = g.group_name;
    row.errand_group_color_hex = g.color_hex;
  }
}

/**
 * @param {import('mysql2/promise').Pool|null|undefined} mainPool
 * @param {number[]} teamIds
 * @returns {Promise<Map<string, string>>}
 */
async function fetchMtDriverTeamNamesByIds(mainPool, teamIds) {
  const map = new Map();
  if (!mainPool) return map;
  const uniq = [
    ...new Set(teamIds.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n) && n > 0)),
  ];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  try {
    const [rows] = await mainPool.query(
      `SELECT team_id, team_name FROM mt_driver_team WHERE team_id IN (${ph})`,
      uniq
    );
    for (const r of rows || []) {
      if (r.team_id == null) continue;
      const name = r.team_name != null ? String(r.team_name).trim() : '';
      if (name) map.set(String(r.team_id), name);
    }
  } catch (_) {
    /* optional */
  }
  return map;
}

/**
 * Driver block for errand task detail: prefers ErrandWib `st_driver`, falls back to primary `mt_driver` name only.
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {import('mysql2/promise').Pool|null|undefined} mainPool
 * @param {number|null|undefined} driverId
 * @returns {Promise<null|{ driver_name: string|null, driver_phone: string|null, verification_code: string|null, team_id: number|null, team_name: string|null, driver_profile_photo: string|null }>}
 */
async function resolveErrandDriverDetail(errandPool, mainPool, driverId) {
  if (!Number.isFinite(driverId) || driverId <= 0) return null;
  const map = await fetchErrandStDriversByIds(errandPool, [driverId]);
  const st = map.get(String(driverId));
  let driver_name = st?.full_name ?? null;
  const driver_phone = st?.driver_phone ?? null;
  const verification_code = st?.verification_code ?? null;
  const team_id = st?.team_id ?? null;
  const driver_profile_photo = st?.photo ?? null;
  if (!driver_name && mainPool) {
    try {
      const [[d]] = await mainPool.query(
        `SELECT CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name FROM mt_driver WHERE driver_id = ? LIMIT 1`,
        [driverId]
      );
      driver_name = d?.full_name != null ? String(d.full_name).trim() : null;
    } catch (_) {
      /* optional */
    }
  }
  let team_name = null;
  if (team_id != null && mainPool) {
    const tm = await fetchMtDriverTeamNamesByIds(mainPool, [team_id]);
    team_name = tm.get(String(team_id)) || null;
  }
  const gMap = await fetchErrandDriverPrimaryGroupByDriverIds(errandPool, [driverId]);
  const g = gMap.get(String(driverId));
  if (g?.group_name) team_name = g.group_name;
  if (
    !driver_name &&
    !driver_phone &&
    !verification_code &&
    !team_id &&
    !driver_profile_photo &&
    !team_name
  ) {
    return null;
  }
  return {
    driver_name,
    driver_phone,
    verification_code,
    team_id,
    team_name,
    driver_profile_photo,
  };
}

/** Prefer pickup merchant coords; else use coordinates on the order row (ErrandWib `st_ordernew` varies by schema). */
function coordsFromOrderRow(row) {
  if (!row || typeof row !== 'object') return null;
  const pairs = [
    ['latitude', 'longitude'],
    ['google_lat', 'google_lng'],
    ['lat', 'lng'],
    ['delivery_lat', 'delivery_lng'],
    ['map_lat', 'map_lng'],
  ];
  for (const [la, ln] of pairs) {
    if (row[la] == null || row[ln] == null) continue;
    const plat = parseFloat(String(row[la]));
    const plng = parseFloat(String(row[ln]));
    if (Number.isFinite(plat) && Number.isFinite(plng)) {
      return { lat: plat, lng: plng };
    }
  }
  return null;
}

/**
 * Batch-load st_merchant rows (ErrandWib) for task list / detail.
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number[]} merchantIds
 * @returns {Promise<Map<string, Record<string, unknown>>>}
 */
async function fetchErrandMerchantsByIds(errandPool, merchantIds) {
  const map = new Map();
  const uniq = [...new Set(merchantIds.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  const sql = `SELECT merchant_id, restaurant_name, restaurant_phone, contact_name, contact_phone, contact_email,
    address, latitude, lontitude
    FROM st_merchant WHERE merchant_id IN (${ph})`;
  try {
    const [mrows] = await errandPool.query(sql, uniq);
    for (const m of mrows || []) {
      if (m.merchant_id != null) map.set(String(m.merchant_id), m);
    }
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return map;
    }
    if (e.code === 'ER_BAD_FIELD_ERROR' && /lontitude|longitude/i.test(String(e.sqlMessage || ''))) {
      const [mrows2] = await errandPool.query(
        `SELECT merchant_id, restaurant_name, restaurant_phone, contact_name, contact_phone, contact_email, address, latitude
         FROM st_merchant WHERE merchant_id IN (${ph})`,
        uniq
      );
      for (const m of mrows2 || []) {
        if (m.merchant_id != null) map.set(String(m.merchant_id), m);
      }
    } else {
      throw e;
    }
  }
  return map;
}

/**
 * Batch-load st_client rows (ErrandWib) linked from st_ordernew.client_id.
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number[]} clientIds
 * @returns {Promise<Map<string, Record<string, unknown>>>}
 */
async function fetchErrandClientsByIds(errandPool, clientIds) {
  const map = new Map();
  const uniq = [...new Set(clientIds.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  try {
    const [rows] = await errandPool.query(
      `SELECT client_id, first_name, last_name, email_address, phone_prefix, contact_phone
       FROM st_client WHERE client_id IN (${ph})`,
      uniq
    );
    for (const c of rows || []) {
      if (c.client_id != null) map.set(String(c.client_id), c);
    }
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return map;
    throw e;
  }
  return map;
}

/**
 * All saved addresses per client (ErrandWib `st_client_address`).
 * @returns {Promise<Map<string, Record<string, unknown>[]>>} keyed by client_id string
 */
async function fetchErrandClientAddressesByClientIds(errandPool, clientIds) {
  const map = new Map();
  const uniq = [...new Set(clientIds.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  try {
    const [rows] = await errandPool.query(`SELECT * FROM st_client_address WHERE client_id IN (${ph})`, uniq);
    for (const r of rows || []) {
      const k = String(r.client_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return map;
    throw e;
  }
  return map;
}

/** Full formatted string from `st_client_address` (snake_case and camelCase columns). */
function clientAddressFormattedFull(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const a = addr.formatted_address != null ? String(addr.formatted_address).trim() : '';
  const b = addr.formattedAddress != null ? String(addr.formattedAddress).trim() : '';
  const s = a || b;
  return s || null;
}

/** Short maps label from `st_client_address.formatted_address` (dashboard task card). */
function clientAddressShortFormattedLine(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const short = addr.formatted_address != null ? String(addr.formatted_address).trim() : '';
  return short || '';
}

/** Single-line label for map / task list. */
function clientAddressLine(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const fa = clientAddressFormattedFull(addr);
  if (fa) return fa;
  const parts = [addr.address1, addr.address2, addr.city, addr.state, addr.postal_code, addr.country]
    .map((x) => (x != null ? String(x).trim() : ''))
    .filter(Boolean);
  return parts.join(', ').trim();
}

/** Street / area from `st_client_address` (address1, then address2) for transaction / driver line. */
function clientStreetOrAreaLine(addr) {
  if (!addr || typeof addr !== 'object') return '';
  for (const k of ['address1', 'address2', 'street', 'area']) {
    const v = addr[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function coordsFromClientAddressRow(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const pairs = [
    ['latitude', 'longitude'],
    ['google_lat', 'google_lng'],
    ['lat', 'lng'],
    ['map_lat', 'map_lng'],
  ];
  for (const [la, ln] of pairs) {
    if (addr[la] == null || addr[ln] == null) continue;
    const plat = parseFloat(String(addr[la]));
    const plng = parseFloat(String(addr[ln]));
    if (Number.isFinite(plat) && Number.isFinite(plng)) {
      return { lat: plat, lng: plng };
    }
  }
  return null;
}

/**
 * Pick `st_client_address` row for this order: explicit id on order row, else delivery-type, else latest.
 * @param {Record<string, unknown>} orderRow - st_ordernew
 * @param {Record<string, unknown>[]|null|undefined} addressList
 */
function pickClientAddressRow(orderRow, addressList) {
  if (!addressList || !addressList.length) return null;
  const idCandidates = [
    orderRow.client_address_id,
    orderRow.address_id,
    orderRow.delivery_address_id,
    orderRow.client_addressId,
  ];
  for (const id of idCandidates) {
    if (id == null || String(id).trim() === '') continue;
    const want = String(id).trim();
    const hit = addressList.find((a) => String(a.address_id ?? '') === want);
    if (hit) return hit;
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const scoreType = (t) => {
    const n = norm(t);
    if (n.includes('delivery') || n.includes('shipping') || n === 'dropoff') return 0;
    if (n.includes('default') || n.includes('primary')) return 1;
    return 2;
  };
  const sorted = [...addressList].sort((a, b) => {
    const sa = scoreType(a.address_type);
    const sb = scoreType(b.address_type);
    if (sa !== sb) return sa - sb;
    const ta = new Date(a.date_modified || a.date_created || 0).getTime();
    const tb = new Date(b.date_modified || b.date_created || 0).getTime();
    return tb - ta;
  });
  return sorted[0] || null;
}

/** @param {Record<string, unknown>|null|undefined} c */
function clientDisplayName(c) {
  if (!c || typeof c !== 'object') return null;
  const fn = c.first_name != null ? String(c.first_name).trim() : '';
  const ln = c.last_name != null ? String(c.last_name).trim() : '';
  const full = [fn, ln].filter(Boolean).join(' ').trim();
  return full || null;
}

/** @param {Record<string, unknown>|null|undefined} c */
function clientDisplayPhone(c) {
  if (!c || typeof c !== 'object') return null;
  const raw = c.contact_phone != null ? String(c.contact_phone).trim() : '';
  if (!raw) return null;
  const prefix = c.phone_prefix != null ? String(c.phone_prefix).trim().replace(/\D/g, '') : '';

  if (raw.startsWith('+')) {
    let d = raw.slice(1).replace(/\D/g, '');
    // Stored as +6363... (duplicate PH country code)
    if (prefix === '63' && d.startsWith('6363')) {
      d = `63${d.slice(4)}`;
    }
    return d ? `+${d}` : raw;
  }

  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // contact_phone often already includes country code while phone_prefix repeats it (e.g. 639... + prefix 63)
  if (prefix && digits.startsWith(prefix)) {
    return `+${digits}`;
  }
  if (prefix === '63' && digits.startsWith('0') && digits.length >= 10) {
    return `+63${digits.slice(1)}`;
  }
  if (prefix) {
    return `+${prefix}${digits}`;
  }
  if (digits.startsWith('63')) {
    return `+${digits}`;
  }
  return raw;
}

/** Scheduled delivery wall time from `st_ordernew` (advance / task panel + Scheduled Orders). */
function pickErrandOrderDeliveryTime(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.delivery_time != null && String(row.delivery_time).trim() !== '') return row.delivery_time;
  if (row.delivery_time_end != null && String(row.delivery_time_end).trim() !== '') return row.delivery_time_end;
  return null;
}

/**
 * @param {Record<string, unknown>} row - st_ordernew row
 * @param {Map<string, { full_name: string|null, driver_phone: string|null, verification_code: string|null, team_id: number|null, photo: string|null }>} errandDriverById - from st_driver (ErrandWib)
 * @param {Map<string, string|null>} [mtDriverNameById] - legacy fallback from mt_driver (primary DB)
 * @param {Map<string, Record<string, unknown>>} merchantById - from st_merchant (ErrandWib), keyed by merchant_id string
 * @param {Map<string, Record<string, unknown>>} [clientById] - from st_client (ErrandWib), keyed by client_id string
 * @param {Map<string, Record<string, unknown>[]>} [clientAddressesByClientId] - from st_client_address, keyed by client_id string
 * @param {Map<string, string>} [latestHistoryStatusByOrderId] - latest st_ordernew_history.status per order_id
 * @param {Map<string, string>} [teamNameById] - from mt_driver_team (primary DB), keyed by team_id string
 */
function mapStOrderRowToTaskListRow(
  row,
  errandDriverById,
  mtDriverNameById,
  merchantById,
  clientById,
  clientAddressesByClientId,
  latestHistoryStatusByOrderId,
  teamNameById
) {
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const safeId = Number.isFinite(oid) ? oid : 0;
  const driverId = row.driver_id != null ? parseInt(String(row.driver_id), 10) : null;
  const stDriver =
    Number.isFinite(driverId) && driverId > 0 && errandDriverById
      ? errandDriverById.get(String(driverId))
      : null;
  const mtMap = mtDriverNameById && typeof mtDriverNameById.get === 'function' ? mtDriverNameById : new Map();
  const driverName = stDriver?.full_name || (Number.isFinite(driverId) ? driverDisplayName(mtMap, driverId) : null);
  const driverPhone = stDriver?.driver_phone ?? null;
  const verificationCode = stDriver?.verification_code ?? null;
  const driverTeamId = stDriver?.team_id ?? null;
  const errandGroupName =
    stDriver?.errand_group_name != null && String(stDriver.errand_group_name).trim()
      ? String(stDriver.errand_group_name).trim()
      : null;
  const teamName =
    errandGroupName ||
    (driverTeamId != null && teamNameById && typeof teamNameById.get === 'function'
      ? teamNameById.get(String(driverTeamId)) || null
      : null);
  const driverPhoto = stDriver?.photo ?? null;
  const mid = row.merchant_id != null ? parseInt(String(row.merchant_id), 10) : null;
  const merch = Number.isFinite(mid) ? merchantById?.get(String(mid)) : null;
  const restaurantName =
    merch && merch.restaurant_name != null && String(merch.restaurant_name).trim()
      ? String(merch.restaurant_name).trim()
      : mid != null
        ? `Merchant #${mid}`
        : null;
  const merchantAddr =
    merch && merch.address != null && String(merch.address).trim()
      ? String(merch.address).trim()
      : '';
  const dropAddr = row.formatted_address != null ? String(row.formatted_address).trim() : '';

  const cid = row.client_id != null ? parseInt(String(row.client_id), 10) : null;
  const addrList =
    Number.isFinite(cid) && cid > 0 ? clientAddressesByClientId?.get(String(cid)) : null;
  const clientAddrRow = pickClientAddressRow(row, addrList);
  const clientAddrLine = clientAddressLine(clientAddrRow);
  const streetOrArea = clientStreetOrAreaLine(clientAddrRow);
  const shortFormatted = clientAddressShortFormattedLine(clientAddrRow);
  /** Task card / list: `st_client_address.formatted_address`, then street/area, else order/merchant */
  const addressLine = shortFormatted || streetOrArea || dropAddr || merchantAddr;
  let taskLat = null;
  let taskLng = null;
  const clientCoords = coordsFromClientAddressRow(clientAddrRow);
  if (clientCoords) {
    taskLat = clientCoords.lat;
    taskLng = clientCoords.lng;
  }
  if (merch) {
    const plat = merch.latitude != null ? parseFloat(String(merch.latitude)) : NaN;
    const plng =
      merch.lontitude != null
        ? parseFloat(String(merch.lontitude))
        : merch.longitude != null
          ? parseFloat(String(merch.longitude))
          : NaN;
    if (taskLat == null || taskLng == null || !Number.isFinite(taskLat) || !Number.isFinite(taskLng)) {
      if (Number.isFinite(plat) && Number.isFinite(plng)) {
        taskLat = plat;
        taskLng = plng;
      }
    }
  }
  if (taskLat == null || taskLng == null || !Number.isFinite(taskLat) || !Number.isFinite(taskLng)) {
    const oc = coordsFromOrderRow(row);
    if (oc) {
      taskLat = oc.lat;
      taskLng = oc.lng;
    }
  }
  const histStatus = latestHistoryStatusByOrderId?.get(String(safeId));
  const status = mapErrandHistoryStatusToTaskStatus(histStatus, row.delivery_status, row.status, driverId);
  const desc =
    row.order_reference != null && String(row.order_reference).trim()
      ? `Errand ${String(row.order_reference).trim()}`
      : `Errand order #${safeId}`;
  const created = row.date_created || row.created_at || row.date_modified || null;
  const errandDeliveryTime = pickErrandOrderDeliveryTime(row);

  const client = Number.isFinite(cid) && cid > 0 ? clientById?.get(String(cid)) : null;
  const customerName = clientDisplayName(client);
  const customerPhone = clientDisplayPhone(client);
  const customerEmail =
    client && client.email_address != null && String(client.email_address).trim()
      ? String(client.email_address).trim()
      : null;

  const payment_type =
    normalizeDriverPaymentType(row) ??
    (row.payment_code != null && String(row.payment_code).trim() !== ''
      ? mapPaymentRawToEnum(String(row.payment_code))
      : null);
  const payment_status_norm =
    normalizeDriverPaymentStatus(row) ??
    (row.payment_status != null && String(row.payment_status).trim() !== '' ? String(row.payment_status).trim() : null);

  return {
    task_source: 'errand',
    task_id: safeId > 0 ? -safeId : 0,
    st_order_id: safeId,
    order_id: safeId,
    status,
    status_raw: status,
    delivery_status: row.delivery_status != null ? String(row.delivery_status) : null,
    order_status_raw: row.status != null ? String(row.status) : null,
    errand_history_status: histStatus || null,
    task_description: desc,
    delivery_address: addressLine,
    formatted_address: shortFormatted || clientAddressFormattedFull(clientAddrRow) || clientAddrLine || dropAddr || null,
    merchant_address: merchantAddr || null,
    delivery_landmark:
      clientAddrRow && clientAddrRow.location_name != null && String(clientAddrRow.location_name).trim()
        ? String(clientAddrRow.location_name).trim()
        : null,
    delivery_date: row.delivery_date,
    delivery_time: errandDeliveryTime,
    order_delivery_time: errandDeliveryTime,
    order_delivery_date: row.delivery_date,
    task_lat: taskLat,
    task_lng: taskLng,
    date_created: created,
    merchant_id: row.merchant_id,
    restaurant_name: restaurantName,
    merchant_phone: merch?.restaurant_phone != null ? String(merch.restaurant_phone).trim() : null,
    customer_name: customerName,
    contact_number: customerPhone,
    email_address: customerEmail,
    client_id: Number.isFinite(cid) ? cid : null,
    client_address: clientAddrRow
      ? {
          latitude: clientAddrRow.latitude,
          longitude: clientAddrRow.longitude,
          google_lat: clientAddrRow.google_lat,
          google_lng: clientAddrRow.google_lng,
        }
      : null,
    driver_id: Number.isFinite(driverId) ? driverId : null,
    driver_name: driverName,
    driver_phone: driverPhone,
    verification_code: verificationCode,
    team_id: driverTeamId,
    team_name: teamName,
    driver_profile_photo: driverPhoto,
    payment_type,
    payment_status: payment_status_norm,
    order_payment_status: payment_status_norm,
    payment_code: row.payment_code,
    service_code: row.service_code,
    total: row.total,
  };
}

/** First non-empty line, trimmed; optional max length for long descriptions (driver UI). */
function errandLineFirstLine(text, maxLen) {
  if (text == null) return '';
  const t = String(text).trim();
  if (!t) return '';
  const line = t.split(/\r?\n/)[0].trim();
  if (maxLen != null && line.length > maxLen) {
    return `${line.slice(0, maxLen).trim()}…`;
  }
  return line;
}

/** Non-empty trimmed string, first line only (maxLen). */
function errandPickLabel(v, maxLen) {
  return errandLineFirstLine(v, maxLen).trim();
}

/**
 * Human-readable line label for driver app (Flutter: item_name / name / label, else "Item #" + item_id).
 * Uses line-level columns from `st_ordernew_item` (via `oi.*`), then catalog (`st_item`) under `catalog_*` aliases,
 * then common ErrandWib text fields. Omits reliance on item_id 0 when names are missing.
 * @param {Record<string, unknown>} row
 */
function pickErrandLineItemDisplayName(row) {
  const tryLabel = (v) => {
    const t = errandPickLabel(v, 280);
    if (!t || t === '0') return '';
    return t;
  };
  const catalogName = tryLabel(row.catalog_item_name);
  const lineItemName = tryLabel(row.item_name);
  const catShort = tryLabel(row.catalog_short_description);
  const catLong = tryLabel(row.catalog_description);
  const lineShort = tryLabel(row.item_short_description);
  const lineLong = tryLabel(row.item_description);
  const instructions = tryLabel(row.special_instructions);
  const orderedKeys = [
    lineItemName,
    catalogName,
    catShort,
    catLong,
    lineShort,
    lineLong,
    instructions,
  ];
  for (const t of orderedKeys) {
    if (t) return t;
  }
  const extraKeys = [
    'line_item_name',
    'package_name',
    'product_name',
    'service_name',
    'item_label',
    'title',
    'label',
    'name',
    'description',
    'notes',
    'note',
    'line_notes',
    'item_notes',
    'item_remarks',
    'remarks',
    'errand_description',
    'transaction_description',
  ];
  for (const k of extraKeys) {
    const t = tryLabel(row[k]);
    if (t) return t;
  }
  const itemIdNum = row.item_id != null ? parseInt(String(row.item_id), 10) : NaN;
  if (Number.isFinite(itemIdNum) && itemIdNum > 0) return `Item #${itemIdNum}`;
  return 'Errand service';
}

/**
 * Map joined `st_ordernew_item` + `st_item` row into `order_details` shape (TaskDetailsModal ordered items).
 * @param {Record<string, unknown>} row
 */
function mapErrandOrderLineToOrderDetail(row) {
  const lineId = row.line_id != null ? row.line_id : row.id;
  const qty = row.qty != null ? Number(row.qty) : 0;
  let unit = row.price != null ? Number(row.price) : null;
  if (unit != null && Number.isNaN(unit)) unit = null;
  const name = pickErrandLineItemDisplayName(row);
  const notes =
    row.special_instructions != null && String(row.special_instructions).trim() !== ''
      ? String(row.special_instructions).trim()
      : null;
  const itemIdNum = row.item_id != null ? parseInt(String(row.item_id), 10) : NaN;
  const photoRaw =
    row.catalog_item_photo != null && String(row.catalog_item_photo).trim() !== ''
      ? String(row.catalog_item_photo).trim()
      : row.photo != null && String(row.photo).trim() !== ''
        ? String(row.photo).trim()
        : null;
  const pathRaw =
    row.catalog_item_path != null && String(row.catalog_item_path).trim() !== ''
      ? String(row.catalog_item_path).trim()
      : row.path != null && String(row.path).trim() !== ''
        ? String(row.path).trim()
        : null;
  /** Omit item_id when not a real catalog id — Flutter may use `item_id ?? 0` and show "Item #0". */
  const out = {
    id: lineId,
    qty,
    quantity: qty,
    item_name: name,
    itemName: name,
    name,
    label: name,
    item_name_display: name,
    normal_price: unit,
    discounted_price: unit,
    order_notes: notes,
    orderNotes: notes,
    item_source: 'errand',
    photo: photoRaw,
    path: pathRaw,
  };
  if (Number.isFinite(itemIdNum) && itemIdNum > 0) {
    out.item_id = itemIdNum;
    out.itemId = itemIdNum;
  }
  return out;
}

/**
 * Load line items for an errand order (`st_ordernew_item` JOIN `st_item`).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 * @returns {Promise<Record<string, unknown>[]>}
 */
function filterNonVoidedErrandLines(rows) {
  return (rows || []).filter((r) => {
    const v = r.voided_at;
    if (v == null) return true;
    const s = String(v).trim();
    if (s === '' || s.startsWith('0000-00-00')) return true;
    return false;
  });
}

async function fetchErrandOrderLineItems(errandPool, orderId) {
  const mapRows = (rows) => filterNonVoidedErrandLines(rows).map(mapErrandOrderLineToOrderDetail);
  const sqlFull = `SELECT oi.*,
              i.item_name AS catalog_item_name,
              i.item_short_description AS catalog_short_description,
              i.item_description AS catalog_description,
              i.photo AS catalog_item_photo,
              i.path AS catalog_item_path
       FROM st_ordernew_item oi
       LEFT JOIN st_item i ON i.item_id = oi.item_id
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC`;
  try {
    const [rows] = await errandPool.query(sqlFull, [orderId]);
    return mapRows(rows);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        const [rows2] = await errandPool.query(
          `SELECT oi.*,
                  i.item_name AS catalog_item_name,
                  i.photo AS catalog_item_photo,
                  i.path AS catalog_item_path
           FROM st_ordernew_item oi
           LEFT JOIN st_item i ON i.item_id = oi.item_id
           WHERE oi.order_id = ?
           ORDER BY oi.id ASC`,
          [orderId]
        );
        return mapRows(rows2);
      } catch (e2) {
        if (e2.code === 'ER_NO_SUCH_TABLE') return [];
        throw e2;
      }
    }
    throw e;
  }
}

/**
 * Replace `{{placeholders}}` in `remarks` using JSON from `ramarks_trans` / `remarks_trans`.
 * @param {unknown} remarks
 * @param {unknown} transRaw
 */
function resolveErrandHistoryRemarks(remarks, transRaw) {
  let t = remarks != null ? String(remarks) : '';
  if (!t.trim()) return '';
  let map = /** @type {Record<string, string>} */ ({});
  if (transRaw != null && String(transRaw).trim() !== '') {
    try {
      const parsed = JSON.parse(String(transRaw));
      if (parsed && typeof parsed === 'object') map = /** @type {Record<string, string>} */ (parsed);
    } catch (_) {
      /* keep t */
    }
  }
  if (map && typeof map === 'object') {
    for (const [k, v] of Object.entries(map)) {
      if (k) t = t.split(k).join(v != null ? String(v) : '');
    }
  }
  return t.trim();
}

/**
 * Best timestamp for timeline (ErrandWib schemas differ: `date_created`, `date_added`, `created_at`, etc.).
 * @param {Record<string, unknown>} row
 * @returns {string|null} ISO string when possible (stable JSON for dashboard)
 */
function pickErrandHistoryDateCreated(row) {
  if (!row || typeof row !== 'object') return null;
  const keys = [
    'date_created',
    'created_at',
    'date_added',
    'updated_at',
    'time_stamp',
    'timestamp',
    'dt_created',
    'date_modified',
  ];
  for (const k of keys) {
    const v = row[k];
    if (v == null) continue;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return null;
}

/**
 * When a history row was inserted as `(order_id, status)` only, all event times are NULL.
 * Use `st_ordernew` driver-milestone times so the dashboard still shows a reasonable clock time.
 * @param {Record<string, unknown>|null|undefined} orderRow
 * @param {unknown} statusRaw
 */
function pickStOrdernewFallbackTimeForHistory(orderRow, statusRaw) {
  if (!orderRow || typeof orderRow !== 'object') return null;
  const norm = String(statusRaw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
  const milestones = new Set([
    'acknowledged',
    'assigned',
    'started',
    'inprogress',
    'successful',
    'delivered',
    'completed',
    'cancelled',
    'pickedup',
    'pickup',
    'ontheway',
    'enroute',
  ]);
  if (!milestones.has(norm)) return null;
  const keys = ['assigned_at', 'date_modified', 'updated_at', 'date_updated', 'date_created', 'created_at'];
  for (const k of keys) {
    const v = orderRow[k];
    if (v == null) continue;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    const s = String(v).trim();
    if (s !== '' && !s.startsWith('0000-00-00')) return s;
  }
  return null;
}

/**
 * One `st_ordernew_history` row → `order_history` entry for the dashboard timeline.
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>|null|undefined} [stOrderRow] `st_ordernew` for fallback times
 */
function mapErrandHistoryRowForTimeline(row, stOrderRow = null) {
  const trans = row.ramarks_trans ?? row.remarks_trans;
  const resolved = resolveErrandHistoryRemarks(row.remarks, trans);
  const lat = row.latitude != null ? parseFloat(String(row.latitude)) : NaN;
  const lng = row.longitude != null ? parseFloat(String(row.longitude)) : NaN;
  let dateCreated = pickErrandHistoryDateCreated(row);
  if (!dateCreated && stOrderRow) {
    dateCreated = pickStOrdernewFallbackTimeForHistory(stOrderRow, row.status);
  }
  const statusStr = row.status != null ? String(row.status).trim() : '';
  /** Flutter TaskOrderHistoryEntry: first non-empty of date_created | dateCreated | created_at | date_updated | updated_at */
  const out = {
    id: row.id,
    order_id: row.order_id,
    status: statusStr,
    status_raw: statusStr,
    remarks: resolved || null,
    date_created: dateCreated,
    dateCreated,
    created_at: dateCreated,
    date_updated: dateCreated,
    updated_at: dateCreated,
    update_by_name: row.change_by != null ? String(row.change_by).trim() : null,
    update_by_type: row.change_by != null ? String(row.change_by).trim() : null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    ip_address: row.ip_address != null ? String(row.ip_address).trim() : null,
    errand_history: true,
  };
  return out;
}

/**
 * Activity timeline rows from `st_ordernew_history` (ErrandWib).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 * @param {Record<string, unknown>|null|undefined} [stOrderRow] optional `st_ordernew` row for fallback timestamps on legacy history rows
 */
async function fetchErrandOrderHistory(errandPool, orderId, stOrderRow = null) {
  try {
    /** Prefer SELECT * so every timestamp column (`date_created`, `date_added`, `created_at`, …) is present for coalescing. */
    const [rows] = await errandPool.query(
      `SELECT * FROM st_ordernew_history WHERE order_id = ? ORDER BY id ASC`,
      [orderId]
    );
    return (rows || []).map((r) => mapErrandHistoryRowForTimeline(r, stOrderRow));
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

function pickErrandMoneyStr(v) {
  if (v == null || v === '') return null;
  return String(v);
}

function errandNonZeroMoney(v) {
  if (v == null || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0;
}

/**
 * Payment scalars for errand driver detail — same key names / nesting as GetTaskDetails (order / mt_order / task root).
 * @param {Record<string, unknown>|null|undefined} row - st_ordernew
 * @param {Record<string, unknown>|null|undefined} clientAddressRow - st_client_address (optional; service_fee fallback)
 */
function computeStOrdernewPaymentFieldsForDriver(row, clientAddressRow) {
  const z = {
    order_subtotal: null,
    sub_total: null,
    subtotal: null,
    subTotal: null,
    total_w_tax: null,
    totalWTax: null,
    totalWithTax: null,
    order_total_amount: null,
    order_delivery_charge: null,
    delivery_charge: null,
    deliveryCharge: null,
    customer_delivery_charge: null,
    customerDeliveryCharge: null,
    convenience_fee: null,
    convenienceFee: null,
    service_fee: null,
    serviceFee: null,
    card_fee: null,
    cardFee: null,
    cart_tip_percentage: null,
    cartTipPercentage: null,
    cart_tip_value: null,
    cartTipValue: null,
    delivery_fee: null,
    deliveryFee: null,
    rider_fee: null,
    riderFee: null,
    driver_fee: null,
    driverFee: null,
    driver_delivery_fee: null,
    driverDeliveryFee: null,
  };
  if (!row || typeof row !== 'object') return z;

  let convenience_fee = null;
  if (errandNonZeroMoney(row.card_fee)) convenience_fee = pickErrandMoneyStr(row.card_fee);
  else if (errandNonZeroMoney(row.service_fee)) convenience_fee = pickErrandMoneyStr(row.service_fee);
  else if (errandNonZeroMoney(row.convenience_fee)) convenience_fee = pickErrandMoneyStr(row.convenience_fee);
  else if (errandNonZeroMoney(row.platform_fee)) convenience_fee = pickErrandMoneyStr(row.platform_fee);
  else if (errandNonZeroMoney(row.application_fee)) convenience_fee = pickErrandMoneyStr(row.application_fee);
  else if (errandNonZeroMoney(row.packaging_fee)) convenience_fee = pickErrandMoneyStr(row.packaging_fee);
  else if (clientAddressRow && errandNonZeroMoney(clientAddressRow.service_fee)) {
    convenience_fee = pickErrandMoneyStr(clientAddressRow.service_fee);
  }

  /** ErrandWib `st_ordernew`: `packaging_fee` is the customer “convenience” line (dashboard + driver app). */
  const service_fee =
    pickErrandMoneyStr(row.service_fee) ||
    pickErrandMoneyStr(row.packaging_fee) ||
    (clientAddressRow ? pickErrandMoneyStr(clientAddressRow.service_fee) : null);

  const order_delivery_charge =
    pickErrandMoneyStr(row.delivery_charge) ||
    pickErrandMoneyStr(row.customer_delivery_charge) ||
    pickErrandMoneyStr(row.shipping_fee) ||
    pickErrandMoneyStr(row.delivery_fee);

  const delivery_fee =
    pickErrandMoneyStr(row.task_fee) ||
    pickErrandMoneyStr(row.rider_fee) ||
    pickErrandMoneyStr(row.driver_fee) ||
    pickErrandMoneyStr(row.driver_delivery_fee);

  const tipPct =
    row.cart_tip_percentage != null && String(row.cart_tip_percentage).trim() !== ''
      ? String(row.cart_tip_percentage)
      : row.tip_percentage != null && String(row.tip_percentage).trim() !== ''
        ? String(row.tip_percentage)
        : row.tip_percent != null && String(row.tip_percent).trim() !== ''
          ? String(row.tip_percent)
          : null;

  const tipVal =
    pickErrandMoneyStr(row.cart_tip_value) ||
    pickErrandMoneyStr(row.courier_tip) ||
    pickErrandMoneyStr(row.courirer_tip) ||
    pickErrandMoneyStr(row.tip_amount) ||
    pickErrandMoneyStr(row.tip_value) ||
    pickErrandMoneyStr(row.tip);

  const sub_total = pickErrandMoneyStr(row.sub_total);
  const totalRaw = row.total_w_tax != null && String(row.total_w_tax).trim() !== '' ? row.total_w_tax : row.total;
  const total_w_tax = pickErrandMoneyStr(totalRaw);
  const delivery_charge =
    pickErrandMoneyStr(row.delivery_charge) ||
    pickErrandMoneyStr(row.customer_delivery_charge) ||
    order_delivery_charge;

  const packagingStr = pickErrandMoneyStr(row.packaging_fee);
  const courierTipStr = pickErrandMoneyStr(row.courier_tip) || pickErrandMoneyStr(row.courirer_tip);

  return {
    order_subtotal: sub_total,
    sub_total,
    subtotal: sub_total,
    subTotal: sub_total,
    total_w_tax,
    totalWTax: total_w_tax,
    totalWithTax: total_w_tax,
    order_total_amount: total_w_tax != null ? total_w_tax : sub_total,
    order_delivery_charge,
    delivery_charge,
    deliveryCharge: delivery_charge,
    customer_delivery_charge: pickErrandMoneyStr(row.customer_delivery_charge),
    customerDeliveryCharge: pickErrandMoneyStr(row.customer_delivery_charge),
    /** Dashboard order summary checks `order.packaging` before `convenience_fee`. */
    packaging: packagingStr,
    packaging_fee: packagingStr,
    convenience_fee,
    convenienceFee: convenience_fee,
    service_fee,
    serviceFee: service_fee,
    courier_tip: courierTipStr,
    card_fee: pickErrandMoneyStr(row.card_fee),
    cardFee: pickErrandMoneyStr(row.card_fee),
    cart_tip_percentage: tipPct,
    cartTipPercentage: tipPct,
    cart_tip_value: tipVal,
    cartTipValue: tipVal,
    delivery_fee,
    deliveryFee: delivery_fee,
    rider_fee: delivery_fee,
    riderFee: delivery_fee,
    driver_fee: delivery_fee,
    driverFee: delivery_fee,
    driver_delivery_fee: delivery_fee,
    driverDeliveryFee: delivery_fee,
  };
}

/**
 * Build GET /errand-orders/:id detail payload (mirrors task modal shape partially).
 * @param {Record<string, unknown>} row - st_ordernew
 * @param {null|{ driver_name: string|null, driver_phone: string|null, verification_code: string|null, team_id: number|null, team_name: string|null, driver_profile_photo: string|null }} driverDetail - from st_driver (+ team name)
 * @param {Record<string, unknown>|null} merchantRow - st_merchant row or null
 * @param {Record<string, unknown>|null} clientRow - st_client row or null
 * @param {Record<string, unknown>|null} [clientAddressRow] - chosen st_client_address row or null
 * @param {string|null} [latestHistoryStatus] - latest st_ordernew_history.status for this order
 * @param {Record<string, unknown>[]} [orderDetails] - from fetchErrandOrderLineItems
 * @param {Record<string, unknown>[]} [orderHistoryRows] - from fetchErrandOrderHistory (activity timeline)
 * @param {{ forRiderApp?: boolean }} [options] - when `forRiderApp`, strip raw `json_details` from `errand_order` so the app uses normalized `order_details` lines with `item_name`
 */
function buildErrandTaskDetailPayload(
  row,
  driverDetail,
  merchantRow,
  clientRow,
  clientAddressRow,
  latestHistoryStatus,
  orderDetails = [],
  orderHistoryRows = [],
  options = {}
) {
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const safeId = Number.isFinite(oid) ? oid : 0;
  const driverId = row.driver_id != null ? parseInt(String(row.driver_id), 10) : null;
  const status = mapErrandHistoryStatusToTaskStatus(
    latestHistoryStatus,
    row.delivery_status,
    row.status,
    Number.isFinite(driverId) ? driverId : null
  );
  const status_raw = status;
  const desc =
    row.order_reference != null && String(row.order_reference).trim()
      ? `Errand ${String(row.order_reference).trim()}`
      : `Errand order #${safeId}`;

  const cl = clientRow && typeof clientRow === 'object' ? clientRow : null;
  const custName = clientDisplayName(cl);
  const custPhone = clientDisplayPhone(cl);
  const custEmail = cl && cl.email_address != null && String(cl.email_address).trim() ? String(cl.email_address).trim() : null;

  const m = merchantRow && typeof merchantRow === 'object' ? merchantRow : null;
  const restaurantName =
    m && m.restaurant_name != null && String(m.restaurant_name).trim()
      ? String(m.restaurant_name).trim()
      : row.merchant_id != null
        ? `Merchant #${row.merchant_id}`
        : null;
  const merchantAddr = m && m.address != null ? String(m.address).trim() : '';
  const dropAddr = row.formatted_address != null ? String(row.formatted_address).trim() : '';
  const addr = clientAddressRow && typeof clientAddressRow === 'object' ? clientAddressRow : null;
  const clientAddrLine = clientAddressLine(addr);
  const streetOrArea = clientStreetOrAreaLine(addr);
  const shortFormatted = clientAddressShortFormattedLine(addr);
  const addressLine = shortFormatted || streetOrArea || dropAddr || merchantAddr;
  let taskLat = null;
  let taskLng = null;
  const clientCoords = coordsFromClientAddressRow(addr);
  if (clientCoords) {
    taskLat = clientCoords.lat;
    taskLng = clientCoords.lng;
  }
  if (m) {
    const plat = m.latitude != null ? parseFloat(String(m.latitude)) : NaN;
    const plng =
      m.lontitude != null
        ? parseFloat(String(m.lontitude))
        : m.longitude != null
          ? parseFloat(String(m.longitude))
          : NaN;
    if (taskLat == null || taskLng == null || !Number.isFinite(taskLat) || !Number.isFinite(taskLng)) {
      if (Number.isFinite(plat) && Number.isFinite(plng)) {
        taskLat = plat;
        taskLng = plng;
      }
    }
  }
  if (taskLat == null || taskLng == null || !Number.isFinite(taskLat) || !Number.isFinite(taskLng)) {
    const oc = coordsFromOrderRow(row);
    if (oc) {
      taskLat = oc.lat;
      taskLng = oc.lng;
    }
  }

  const orderDeliveryTime = pickErrandOrderDeliveryTime(row);

  const payment_type =
    normalizeDriverPaymentType(row) ??
    (row.payment_code != null && String(row.payment_code).trim() !== ''
      ? mapPaymentRawToEnum(String(row.payment_code))
      : null);
  const payment_status_norm =
    normalizeDriverPaymentStatus(row) ??
    (row.payment_status != null && String(row.payment_status).trim() !== '' ? String(row.payment_status).trim() : null);

  const pay = computeStOrdernewPaymentFieldsForDriver(row, clientAddressRow);

  const task = {
    task_source: 'errand',
    task_id: safeId > 0 ? -safeId : 0,
    st_order_id: safeId,
    order_id: safeId,
    order_uuid: row.order_uuid,
    status,
    status_raw,
    delivery_status: row.delivery_status,
    errand_history_status: latestHistoryStatus != null && String(latestHistoryStatus).trim() !== '' ? String(latestHistoryStatus).trim() : null,
    task_description: desc,
    delivery_address: addressLine,
    formatted_address: shortFormatted || clientAddressFormattedFull(addr) || clientAddrLine || dropAddr || null,
    merchant_address: merchantAddr || null,
    delivery_landmark:
      addr && addr.location_name != null && String(addr.location_name).trim()
        ? String(addr.location_name).trim()
        : null,
    delivery_date: row.delivery_date,
    delivery_time: orderDeliveryTime,
    order_delivery_time: orderDeliveryTime,
    order_delivery_date: row.delivery_date,
    customer_name: custName,
    contact_number: custPhone,
    email_address: custEmail,
    trans_type: row.service_code != null ? String(row.service_code) : 'delivery',
    payment_type,
    payment_status: payment_status_norm,
    order_payment_status: payment_status_norm,
    restaurant_name: restaurantName,
    driver_id: Number.isFinite(driverId) ? driverId : null,
    driver_name: driverDetail?.driver_name ?? null,
    driver_phone: driverDetail?.driver_phone ?? null,
    verification_code: driverDetail?.verification_code ?? null,
    team_id: driverDetail?.team_id ?? null,
    team_name: driverDetail?.team_name ?? null,
    driver_profile_photo: driverDetail?.driver_profile_photo ?? null,
    task_lat: taskLat,
    task_lng: taskLng,
    date_created: row.date_created || row.created_at || null,
    advance_order_note: null,
    ...pay,
  };

  const order = {
    order_id: safeId,
    trans_type: row.service_code,
    payment_type,
    payment_status: payment_status_norm,
    order_payment_status: payment_status_norm,
    delivery_date: row.delivery_date,
    delivery_time: orderDeliveryTime,
    order_delivery_time: orderDeliveryTime,
    order_delivery_date: row.delivery_date,
    date_created: row.date_created || row.created_at,
    contact_number: custPhone,
    order_change: pickErrandMoneyStr(row.amount_due),
    ...pay,
  };

  const mt_order = { ...order };
  const order_info = { ...order };
  const orderInfo = { ...order };

  const merchant = m
    ? {
        merchant_id: m.merchant_id,
        restaurant_name: m.restaurant_name,
        restaurant_phone: m.restaurant_phone,
        contact_name: m.contact_name,
        contact_phone: m.contact_phone,
        contact_email: m.contact_email,
        street: m.address,
        formatted_address: m.address,
      }
    : null;

  const lines = Array.isArray(orderDetails) ? orderDetails : [];

  const historyList = Array.isArray(orderHistoryRows) ? orderHistoryRows : [];

  let errandOrderPayload = row;
  if (options && options.forRiderApp === true && row && typeof row === 'object') {
    errandOrderPayload = { ...row };
    for (const k of [
      'json_details',
      'jsonDetails',
      'cart_details',
      'cartDetails',
      'order_json',
      'orderJson',
    ]) {
      if (Object.prototype.hasOwnProperty.call(errandOrderPayload, k)) {
        delete errandOrderPayload[k];
      }
    }
  }

  const clientAddressPayload = addr
    ? {
        address_id: addr.address_id,
        address_type: addr.address_type,
        address1: addr.address1 != null ? String(addr.address1).trim() : null,
        address2: addr.address2 != null ? String(addr.address2).trim() : null,
        formatted_address: shortFormatted || null,
        formatted_address_full: clientAddressFormattedFull(addr),
        location_name: addr.location_name != null ? String(addr.location_name).trim() : null,
        address_label: addr.address_label != null ? String(addr.address_label).trim() : null,
        delivery_instructions: addr.delivery_instructions != null ? String(addr.delivery_instructions).trim() : null,
        formatted_address_summary: clientAddrLine || null,
        latitude: addr.latitude ?? addr.google_lat ?? null,
        longitude: addr.longitude ?? addr.google_lng ?? null,
        service_fee: pickErrandMoneyStr(addr.service_fee),
        serviceFee: pickErrandMoneyStr(addr.service_fee),
      }
    : null;

  return {
    task_source: 'errand',
    status,
    status_raw,
    payment_type,
    payment_status: payment_status_norm,
    order_payment_status: payment_status_norm,
    ...pay,
    task,
    order,
    mt_order,
    order_info,
    orderInfo,
    merchant,
    order_details: lines,
    order_line_items: lines,
    orderLineItems: lines,
    mt_order_details: lines,
    orderDetails: lines,
    task_photos: [],
    proof_images: [],
    order_history: historyList,
    orderHistory: historyList,
    mt_order_history: historyList,
    order_status_list: historyList,
    order_status_history: historyList,
    errand_order: errandOrderPayload,
    client: cl
      ? {
          client_id: cl.client_id,
          first_name: cl.first_name,
          last_name: cl.last_name,
          email_address: cl.email_address,
          contact_phone: cl.contact_phone,
          phone_prefix: cl.phone_prefix,
        }
      : null,
    client_address: clientAddressPayload,
    mt_order_delivery_address: clientAddressPayload,
    orderDeliveryAddress: clientAddressPayload,
  };
}

/**
 * @param {Record<string, unknown>} r - st_driver row
 * @param {{ group_id: number|null, group_name: string|null }|null|undefined} groupInfo
 * @returns {Record<string, unknown>} shape consumed by `mapDriverRowToAgentDriver` (admin.js)
 */
function stDriverRowToAgentDashboardInput(r, groupInfo) {
  const lat = r.latitude != null ? parseFloat(String(r.latitude)) : NaN;
  let lng = NaN;
  if (r.lontitude != null) lng = parseFloat(String(r.lontitude));
  else if (r.longitude != null) lng = parseFloat(String(r.longitude));
  const lastTs = r.last_seen || r.date_modified || r.date_created || null;
  const lastLogin = lastTs;
  const lastOnlineSec = lastTs ? Math.floor(new Date(lastTs).getTime() / 1000) : 0;
  let onDuty = 1;
  if (Object.prototype.hasOwnProperty.call(r, 'is_online')) {
    const io = r.is_online;
    onDuty = io === 1 || io === true || String(io) === '1' ? 1 : 0;
  }
  const tid = r.team_id != null ? parseInt(String(r.team_id), 10) : NaN;
  const team_id_mt = Number.isFinite(tid) && tid > 0 ? tid : groupInfo?.group_id != null ? groupInfo.group_id : null;
  return {
    driver_id: r.driver_id,
    username: r.email != null && String(r.email).trim() ? String(r.email).trim() : null,
    first_name: r.first_name,
    last_name: r.last_name,
    phone: r.phone,
    on_duty: onDuty,
    team_id: team_id_mt,
    team_name: groupInfo?.group_name ?? null,
    email: r.email ?? null,
    vehicle: null,
    status: r.status != null && String(r.status).trim() ? String(r.status).trim() : 'active',
    status_updated_at: lastTs,
    last_login: lastLogin,
    last_online: lastOnlineSec,
    location_lat: Number.isFinite(lat) ? lat : null,
    location_lng: Number.isFinite(lng) ? lng : null,
    user_type: null,
    user_id: null,
    device_platform: 'android',
    device_type: null,
    driver_source: 'errand',
  };
}

/**
 * Active ErrandWib `st_driver` rows for agent panel when team filter is "all".
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {{ driver_name?: string|null }} filters
 */
async function fetchErrandStDriversRawForAgentPanel(errandPool, filters) {
  if (!errandPool) return [];
  const driverName = filters?.driver_name != null && String(filters.driver_name).trim() !== '' ? String(filters.driver_name).trim() : null;
  const nameClause = driverName
    ? " AND (CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) LIKE ? OR first_name LIKE ? OR last_name LIKE ?)"
    : '';
  const nameParams = driverName ? [`%${driverName}%`, `%${driverName}%`, `%${driverName}%`] : [];
  const statusClause =
    " AND (LOWER(TRIM(COALESCE(NULLIF(TRIM(COALESCE(status,'')), ''), 'active'))) = 'active')";
  const attempts = [
    `SELECT driver_id, first_name, last_name, email, phone, phone_prefix, status, is_online, last_seen, date_modified, date_created,
            latitude, lontitude, longitude, team_id
     FROM st_driver WHERE 1=1${statusClause}${nameClause} ORDER BY first_name, last_name`,
    `SELECT driver_id, first_name, last_name, email, phone, status, is_online, last_seen, date_modified, date_created,
            latitude, lontitude, team_id
     FROM st_driver WHERE 1=1${statusClause}${nameClause} ORDER BY first_name, last_name`,
    `SELECT driver_id, first_name, last_name, email, phone, last_seen, date_modified, latitude, lontitude, team_id
     FROM st_driver WHERE 1=1${nameClause} ORDER BY first_name, last_name`,
  ];
  for (const sql of attempts) {
    try {
      const [rows] = await errandPool.query(sql, nameParams);
      return rows || [];
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return [];
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }
  return [];
}

/**
 * Pseudo–`mt_driver` rows for agent dashboard / map (drivers not in `mt_driver`).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {{ driver_name?: string|null }} filters
 */
async function buildErrandPseudoRowsForAgentDashboard(errandPool, filters) {
  const raw = await fetchErrandStDriversRawForAgentPanel(errandPool, filters);
  if (!raw.length) return [];
  const ids = raw.map((r) => parseInt(String(r.driver_id), 10)).filter((n) => Number.isFinite(n) && n > 0);
  const gMap = await fetchErrandDriverPrimaryGroupByDriverIds(errandPool, ids);
  return raw.map((r) => {
    const g = gMap.get(String(r.driver_id));
    return stDriverRowToAgentDashboardInput(r, g);
  });
}

/**
 * Errand order counts per driver for agent panel "tasks today".
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number[]} driverIds
 * @param {string} dateOnly YYYY-MM-DD
 * @returns {Promise<Record<number, number>>}
 */
async function fetchErrandOrderTaskCountsByDriver(errandPool, driverIds, dateOnly) {
  /** @type {Record<number, number>} */
  const counts = {};
  if (!errandPool || !driverIds.length) return counts;
  const uniq = [...new Set(driverIds.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return counts;
  const ph = uniq.map(() => '?').join(',');
  const d = String(dateOnly || '').slice(0, 10);
  try {
    const [rows] = await errandPool.query(
      `SELECT driver_id, COUNT(*) AS cnt FROM st_ordernew
       WHERE driver_id IN (${ph})
         AND DATE(COALESCE(delivery_date, created_at, date_created, date_modified)) = ?
       GROUP BY driver_id`,
      [...uniq, d]
    );
    for (const r of rows || []) {
      if (r.driver_id != null) counts[r.driver_id] = Number(r.cnt) || 0;
    }
  } catch (_) {
    /* optional */
  }
  return counts;
}

/**
 * GPS pins for ErrandWib riders (`st_driver.latitude` / `lontitude`), same shape as `GET /drivers/locations` rows.
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {boolean} includeOffline
 */
async function fetchErrandDriverLocationsForMap(errandPool, includeOffline) {
  const out = [];
  if (!errandPool) return out;
  const recency = includeOffline
    ? ''
    : ' AND COALESCE(last_seen, date_modified) > DATE_SUB(NOW(), INTERVAL 30 MINUTE)';
  const bases = [
    `SELECT driver_id, first_name, last_name, is_online, team_id, latitude, lontitude AS lng_col, longitude,
            COALESCE(last_seen, date_modified) AS updated_at
     FROM st_driver
     WHERE latitude IS NOT NULL AND (lontitude IS NOT NULL OR longitude IS NOT NULL)
       AND (ABS(latitude) > 0.0001 OR ABS(COALESCE(lontitude, longitude, 0)) > 0.0001)${recency}`,
    `SELECT driver_id, first_name, last_name, is_online, team_id, latitude, lontitude AS lng_col,
            COALESCE(last_seen, date_modified) AS updated_at
     FROM st_driver
     WHERE latitude IS NOT NULL AND lontitude IS NOT NULL
       AND (ABS(latitude) > 0.0001 OR ABS(lontitude) > 0.0001)${recency}`,
    `SELECT driver_id, first_name, last_name, team_id, latitude, lontitude AS lng_col,
            date_modified AS updated_at
     FROM st_driver
     WHERE latitude IS NOT NULL AND lontitude IS NOT NULL`,
  ];
  /** @type {Record<string, unknown>[]|null} */
  let rows = null;
  for (const sql of bases) {
    try {
      const [r] = await errandPool.query(sql);
      rows = r || [];
      break;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return out;
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }
  if (!rows || !rows.length) return out;
  const ids = rows.map((r) => parseInt(String(r.driver_id), 10)).filter((n) => Number.isFinite(n) && n > 0);
  const gMap = await fetchErrandDriverPrimaryGroupByDriverIds(errandPool, ids);
  for (const r of rows) {
    const lat = r.latitude != null ? parseFloat(String(r.latitude)) : NaN;
    let lng = NaN;
    if (r.lng_col != null) lng = parseFloat(String(r.lng_col));
    else if (r.longitude != null) lng = parseFloat(String(r.longitude));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const fn = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
    const g = gMap.get(String(r.driver_id));
    const tid = r.team_id != null ? parseInt(String(r.team_id), 10) : NaN;
    const team_id = Number.isFinite(tid) && tid > 0 ? tid : g?.group_id ?? null;
    let onDuty = 1;
    if (Object.prototype.hasOwnProperty.call(r, 'is_online')) {
      const io = r.is_online;
      onDuty = io === 1 || io === true || String(io) === '1' ? 1 : 0;
    }
    out.push({
      driver_id: r.driver_id,
      team_id,
      full_name: fn || null,
      on_duty: onDuty,
      lat,
      lng,
      updated_at: r.updated_at ?? null,
      active_merchant_id: null,
      driver_source: 'errand',
    });
  }
  return out;
}

module.exports = {
  mapStOrderRowToTaskListRow,
  buildErrandTaskDetailPayload,
  fetchErrandOrderLineItems,
  fetchErrandOrderHistory,
  mapDeliveryToTaskStatus,
  mapErrandHistoryStatusToTaskStatus,
  fetchErrandMerchantsByIds,
  fetchErrandClientsByIds,
  fetchErrandClientAddressesByClientIds,
  fetchErrandLatestHistoryStatusByOrderIds,
  pickClientAddressRow,
  fetchErrandStDriversByIds,
  fetchErrandDriverPrimaryGroupByDriverIds,
  attachErrandDriverGroups,
  fetchMtDriverTeamNamesByIds,
  resolveErrandDriverDetail,
  buildErrandPseudoRowsForAgentDashboard,
  fetchErrandOrderTaskCountsByDriver,
  fetchErrandDriverLocationsForMap,
};
