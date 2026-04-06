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

/** Single-line label for map / task list. */
function clientAddressLine(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const fa = addr.formatted_address ?? addr.formattedAddress;
  if (fa != null && String(fa).trim()) return String(fa).trim();
  const parts = [addr.address1, addr.address2, addr.city, addr.state, addr.postal_code, addr.country]
    .map((x) => (x != null ? String(x).trim() : ''))
    .filter(Boolean);
  return parts.join(', ').trim();
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
 */
function mapStOrderRowToTaskListRow(row, driverNameById, merchantById, clientById, clientAddressesByClientId) {
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
  /** Primary line: client saved address (st_client_address), else order drop-off text, else merchant pickup */
  const addressLine = clientAddrLine || dropAddr || merchantAddr;
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
  const status = mapDeliveryToTaskStatus(row.delivery_status, row.status);
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
    task_description: desc,
    delivery_address: addressLine,
    formatted_address: clientAddrLine || dropAddr || null,
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
 * Build GET /errand-orders/:id detail payload (mirrors task modal shape partially).
 * @param {Record<string, unknown>|null} merchantRow - st_merchant row or null
 * @param {Record<string, unknown>|null} clientRow - st_client row or null
 * @param {Record<string, unknown>|null} [clientAddressRow] - chosen st_client_address row or null
 */
function buildErrandTaskDetailPayload(row, driverName, merchantRow, clientRow, clientAddressRow) {
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const safeId = Number.isFinite(oid) ? oid : 0;
  const driverId = row.driver_id != null ? parseInt(String(row.driver_id), 10) : null;
  const status = mapDeliveryToTaskStatus(row.delivery_status, row.status);
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
  const addressLine = clientAddrLine || dropAddr || merchantAddr;
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
    task_description: desc,
    delivery_address: addressLine,
    formatted_address: clientAddrLine || dropAddr || null,
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
    order_details: [],
    task_photos: [],
    proof_images: [],
    order_history: [],
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
          formatted_address: clientAddrLine || null,
          location_name: addr.location_name,
          delivery_instructions: addr.delivery_instructions,
          latitude: addr.latitude,
          longitude: addr.longitude,
        }
      : null,
  };
}

module.exports = {
  mapStOrderRowToTaskListRow,
  buildErrandTaskDetailPayload,
  mapDeliveryToTaskStatus,
  fetchErrandMerchantsByIds,
  fetchErrandClientsByIds,
  fetchErrandClientAddressesByClientIds,
  pickClientAddressRow,
};
