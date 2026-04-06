/**
 * Maps st_ordernew (wheninba_ErrandWib) rows into task-list shapes for the dashboard.
 * task_id is negative (-order_id) so it cannot collide with mt_driver_task.task_id.
 */

function mapDeliveryToTaskStatus(deliveryStatus, orderStatus) {
  const ds = String(deliveryStatus || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
  if (ds === 'unassigned') return 'unassigned';
  if (ds === 'assigned') return 'assigned';
  if (ds === 'delivered') return 'delivered';
  if (ds === 'cancelled' || ds === 'canceled') return 'cancelled';
  if (ds === 'pickedup' || ds === 'picked_up' || ds === 'ontheway' || ds === 'in_transit') return 'inprogress';
  const os = String(orderStatus || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
  if (os === 'rejected' || os === 'cancelled' || os === 'canceled') return 'cancelled';
  if (os === 'delivered') return 'delivered';
  return 'unassigned';
}

/**
 * Map latest `st_ordernew_history.status` into dashboard task statuses (TaskPanel / map).
 * Errand often appends history while `st_ordernew.delivery_status` lags.
 * @param {string|null|undefined} historyStatusRaw
 * @param {unknown} deliveryStatus - st_ordernew.delivery_status
 * @param {unknown} orderStatus - st_ordernew.status
 * @param {number|null|undefined} driverId - assigned rider (mt_driver), if any
 */
function mapErrandHistoryStatusToTaskStatus(historyStatusRaw, deliveryStatus, orderStatus, driverId) {
  const fromDelivery = mapDeliveryToTaskStatus(deliveryStatus, orderStatus);
  if (historyStatusRaw == null || String(historyStatusRaw).trim() === '') {
    return fromDelivery;
  }
  const hasDriver = driverId != null && Number.isFinite(Number(driverId)) && Number(driverId) > 0;
  const h = String(historyStatusRaw).toLowerCase().replace(/\s+/g, ' ').trim();
  const c = h.replace(/\s+/g, '').replace(/_/g, '');

  if (/\bdelivered\b|complete|successful/i.test(h) || c === 'delivered' || c.endsWith('delivered')) {
    return 'delivered';
  }
  if (c.includes('cancel') || c.includes('reject') || c.includes('declin')) {
    return 'cancelled';
  }

  if (hasDriver) {
    if (c.includes('way') || c.includes('transit') || c.includes('ontheway') || h.includes('on its way')) {
      return 'inprogress';
    }
    if (c.includes('pick') || c.includes('prepar') || c.includes('cooking')) {
      return 'inprogress';
    }
    if (c.includes('accept')) {
      return 'assigned';
    }
    if (c === 'new' && fromDelivery !== 'unassigned') {
      return fromDelivery;
    }
  } else {
    if (c === 'new' || c.includes('advanceorder') || h.includes('advance order')) {
      return 'unassigned';
    }
    if (c.includes('accept') || c.includes('prepar') || c.includes('way') || c.includes('pick')) {
      return 'unassigned';
    }
  }

  if (c.includes('way') || h.includes('on its way') || c.includes('transit')) {
    return 'inprogress';
  }
  if (c.includes('pick') || c.includes('prepar')) {
    return 'inprogress';
  }
  if (c.includes('accept')) {
    return hasDriver ? 'assigned' : 'unassigned';
  }

  return fromDelivery;
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

/**
 * @param {Record<string, unknown>} row - st_ordernew row
 * @param {Map<string, string>} driverNameById - from mt_driver (primary pool)
 * @param {Map<string, Record<string, unknown>>} merchantById - from st_merchant (ErrandWib), keyed by merchant_id string
 * @param {Map<string, Record<string, unknown>>} [clientById] - from st_client (ErrandWib), keyed by client_id string
 * @param {Map<string, Record<string, unknown>[]>} [clientAddressesByClientId] - from st_client_address, keyed by client_id string
 * @param {Map<string, string>} [latestHistoryStatusByOrderId] - latest st_ordernew_history.status per order_id
 */
function mapStOrderRowToTaskListRow(
  row,
  driverNameById,
  merchantById,
  clientById,
  clientAddressesByClientId,
  latestHistoryStatusByOrderId
) {
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const safeId = Number.isFinite(oid) ? oid : 0;
  const driverId = row.driver_id != null ? parseInt(String(row.driver_id), 10) : null;
  const driverName = Number.isFinite(driverId)
    ? driverDisplayName(driverNameById, driverId)
    : null;
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

  const client = Number.isFinite(cid) && cid > 0 ? clientById?.get(String(cid)) : null;
  const customerName = clientDisplayName(client);
  const customerPhone = clientDisplayPhone(client);
  const customerEmail =
    client && client.email_address != null && String(client.email_address).trim()
      ? String(client.email_address).trim()
      : null;

  return {
    task_source: 'errand',
    task_id: safeId > 0 ? -safeId : 0,
    st_order_id: safeId,
    order_id: safeId,
    status,
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
    driver_profile_photo: null,
    payment_status: row.payment_status,
    payment_code: row.payment_code,
    service_code: row.service_code,
    total: row.total,
  };
}

/**
 * Map joined `st_ordernew_item` + `st_item` row into `order_details` shape (TaskDetailsModal ordered items).
 * @param {Record<string, unknown>} row
 */
function mapErrandOrderLineToOrderDetail(row) {
  const qty = row.qty != null ? Number(row.qty) : 0;
  let unit = row.price != null ? Number(row.price) : null;
  if (unit != null && Number.isNaN(unit)) unit = null;
  const name =
    row.item_name != null && String(row.item_name).trim() !== ''
      ? String(row.item_name).trim()
      : row.item_id != null
        ? `Item #${row.item_id}`
        : 'Item';
  const notes =
    row.special_instructions != null && String(row.special_instructions).trim() !== ''
      ? String(row.special_instructions).trim()
      : null;
  return {
    id: row.line_id,
    item_id: row.item_id,
    qty,
    item_name: name,
    item_name_display: name,
    normal_price: unit,
    discounted_price: unit,
    order_notes: notes,
    item_source: 'errand',
    photo: row.photo != null ? String(row.photo).trim() : null,
    path: row.path != null ? String(row.path).trim() : null,
  };
}

/**
 * Load line items for an errand order (`st_ordernew_item` JOIN `st_item`).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function fetchErrandOrderLineItems(errandPool, orderId) {
  const mapRows = (rows) => (rows || []).map(mapErrandOrderLineToOrderDetail);
  try {
    const [rows] = await errandPool.query(
      `SELECT oi.id AS line_id, oi.order_id, oi.item_id, oi.qty, oi.price, oi.discount, oi.discount_type,
              oi.special_instructions, oi.item_size_id, oi.cat_id,
              i.item_name, i.photo, i.path, i.item_description, i.item_short_description
       FROM st_ordernew_item oi
       LEFT JOIN st_item i ON i.item_id = oi.item_id
       WHERE oi.order_id = ? AND oi.voided_at IS NULL
       ORDER BY oi.id ASC`,
      [orderId]
    );
    return mapRows(rows);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        const [rows2] = await errandPool.query(
          `SELECT oi.id AS line_id, oi.order_id, oi.item_id, oi.qty, oi.price, oi.special_instructions,
                  i.item_name, i.photo, i.path
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
 * One `st_ordernew_history` row → `order_history` entry for the dashboard timeline.
 * @param {Record<string, unknown>} row
 */
function mapErrandHistoryRowForTimeline(row) {
  const trans = row.ramarks_trans ?? row.remarks_trans;
  const resolved = resolveErrandHistoryRemarks(row.remarks, trans);
  const lat = row.latitude != null ? parseFloat(String(row.latitude)) : NaN;
  const lng = row.longitude != null ? parseFloat(String(row.longitude)) : NaN;
  return {
    id: row.id,
    order_id: row.order_id,
    status: row.status != null ? String(row.status).trim() : '',
    remarks: resolved || null,
    date_created: row.created_at ?? row.date_created ?? null,
    update_by_name: row.change_by != null ? String(row.change_by).trim() : null,
    update_by_type: row.change_by != null ? String(row.change_by).trim() : null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    ip_address: row.ip_address != null ? String(row.ip_address).trim() : null,
    errand_history: true,
  };
}

/**
 * Activity timeline rows from `st_ordernew_history` (ErrandWib).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 */
async function fetchErrandOrderHistory(errandPool, orderId) {
  const mapRows = (rows) => (rows || []).map(mapErrandHistoryRowForTimeline);
  try {
    const [rows] = await errandPool.query(
      `SELECT id, order_id, status, remarks, ramarks_trans, change_by, latitude, longitude, ip_address, created_at
       FROM st_ordernew_history
       WHERE order_id = ?
       ORDER BY id ASC`,
      [orderId]
    );
    return mapRows(rows);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        const [rows2] = await errandPool.query(
          `SELECT id, order_id, status, remarks, remarks_trans, change_by, latitude, longitude, ip_address, created_at
           FROM st_ordernew_history
           WHERE order_id = ?
           ORDER BY id ASC`,
          [orderId]
        );
        return (rows2 || []).map((r) => mapErrandHistoryRowForTimeline({ ...r, ramarks_trans: r.remarks_trans }));
      } catch (e2) {
        if (e2.code === 'ER_BAD_FIELD_ERROR') {
          try {
            const [rows3] = await errandPool.query(
              `SELECT id, order_id, status, remarks, change_by, created_at
               FROM st_ordernew_history
               WHERE order_id = ?
               ORDER BY id ASC`,
              [orderId]
            );
            return (rows3 || []).map((r) =>
              mapErrandHistoryRowForTimeline({ ...r, ramarks_trans: null, latitude: null, longitude: null, ip_address: null })
            );
          } catch (e3) {
            if (e3.code === 'ER_NO_SUCH_TABLE') return [];
            throw e3;
          }
        }
        if (e2.code === 'ER_NO_SUCH_TABLE') return [];
        throw e2;
      }
    }
    throw e;
  }
}

/**
 * Build GET /errand-orders/:id detail payload (mirrors task modal shape partially).
 * @param {Record<string, unknown>|null} merchantRow - st_merchant row or null
 * @param {Record<string, unknown>|null} clientRow - st_client row or null
 * @param {Record<string, unknown>|null} [clientAddressRow] - chosen st_client_address row or null
 * @param {string|null} [latestHistoryStatus] - latest st_ordernew_history.status for this order
 * @param {Record<string, unknown>[]} [orderDetails] - from fetchErrandOrderLineItems
 * @param {Record<string, unknown>[]} [orderHistoryRows] - from fetchErrandOrderHistory (activity timeline)
 */
function buildErrandTaskDetailPayload(
  row,
  driverName,
  merchantRow,
  clientRow,
  clientAddressRow,
  latestHistoryStatus,
  orderDetails = [],
  orderHistoryRows = []
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

  const task = {
    task_source: 'errand',
    task_id: safeId > 0 ? -safeId : 0,
    st_order_id: safeId,
    order_id: safeId,
    order_uuid: row.order_uuid,
    status,
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
    customer_name: custName,
    contact_number: custPhone,
    email_address: custEmail,
    trans_type: row.service_code != null ? String(row.service_code) : 'delivery',
    payment_type: row.payment_code != null ? String(row.payment_code) : null,
    restaurant_name: restaurantName,
    driver_id: Number.isFinite(driverId) ? driverId : null,
    driver_name: driverName || null,
    driver_phone: null,
    task_lat: taskLat,
    task_lng: taskLng,
    date_created: row.date_created || row.created_at || null,
    advance_order_note: null,
  };

  const order = {
    order_id: safeId,
    trans_type: row.service_code,
    payment_type: row.payment_code,
    sub_total: row.sub_total,
    total_w_tax: row.total,
    delivery_date: row.delivery_date,
    delivery_time: row.delivery_time != null ? row.delivery_time : row.delivery_time_end,
    date_created: row.date_created || row.created_at,
    contact_number: custPhone,
    order_change: row.amount_due,
  };

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

  return {
    task_source: 'errand',
    task,
    order,
    merchant,
    order_details: Array.isArray(orderDetails) ? orderDetails : [],
    task_photos: [],
    proof_images: [],
    order_history: Array.isArray(orderHistoryRows) ? orderHistoryRows : [],
    errand_order: row,
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
    client_address: addr
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
          /** Short line for lists / summaries (merged from saved address fields). */
          formatted_address_summary: clientAddrLine || null,
          latitude: addr.latitude ?? addr.google_lat ?? null,
          longitude: addr.longitude ?? addr.google_lng ?? null,
        }
      : null,
  };
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
};
