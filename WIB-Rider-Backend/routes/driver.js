const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/db');
const { success, error } = require('../lib/response');
const { validateApiKey, resolveDriver, optionalDriver } = require('../middleware/auth');
const {
  fetchTaskProofPhotosWithUrls,
  buildTaskProofImageUrl,
  insertDriverTaskPhotoRow,
} = require('../lib/taskProof');
const { fetchDriverMergedOrderHistory } = require('../lib/driverOrderHistory');
const { enrichOrderDetailsWithSubcategoryAddons } = require('../lib/orderDetailAddons');
const { attachOrderDetailCategories } = require('../lib/orderDetailCategories');
const {
  notifyAllDashboardAdmins,
  foodTaskNotifyFromStatus,
  formatActorFromDriver,
} = require('../lib/dashboardRiderNotify');
const { insertMtOrderHistoryRow } = require('../lib/mtOrderHistoryInsert');

const uploadDir = path.join(__dirname, '..', 'uploads', 'profiles');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif'].some((e) => ext.endsWith(e))) {
      cb(null, true);
    } else {
      cb(new Error('Only images allowed'));
    }
  },
});

const taskProofDir = path.join(__dirname, '..', 'uploads', 'task');
if (!fs.existsSync(taskProofDir)) {
  fs.mkdirSync(taskProofDir, { recursive: true });
}
const taskProofUpload = multer({
  dest: taskProofDir,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif'].some((e) => ext.endsWith(e))) {
      cb(null, true);
    } else {
      cb(new Error('Only images allowed'));
    }
  },
});

/** Remove multer temp file when auth middleware responds with code 2 (invalid key/token). */
function cleanupUploadOnAuthError(req, res, next) {
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (body && body.code === 2) {
      const fromSingle = req.file ? [req.file] : [];
      let fromMulti = [];
      if (req.files && typeof req.files === 'object') {
        fromMulti = Object.values(req.files).flat();
      }
      for (const f of [...fromSingle, ...fromMulti]) {
        if (f?.path) {
          try {
            fs.unlinkSync(f.path);
          } catch (_) {}
        }
      }
    }
    return orig(body);
  };
  next();
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function todayRaw() {
  return Math.floor(Date.now() / 1000).toString();
}

/** mt_order.payment_status may be absent on older DBs; retry without it once. */
let mtOrderPaymentStatusColumn = true;

/**
 * Rider task rows with payment fields from mt_order (same shape for list + detail).
 * @param {string} whereSql SQL after JOIN, starting with WHERE
 * @param {unknown[]} params
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function queryRiderTaskRows(whereSql, params) {
  const payStatusExpr = mtOrderPaymentStatusColumn ? 'o.payment_status AS payment_status' : 'NULL AS payment_status';
  const sql = `SELECT t.task_id, t.order_id, t.task_description, t.trans_type AS trans_type_raw, t.contact_number, t.email_address, t.customer_name, t.delivery_date,
      NULL AS delivery_time, t.delivery_address, t.task_lat, t.task_lng, t.dropoff_merchant,
      COALESCE(NULLIF(TRIM(m.restaurant_name), ''), NULLIF(TRIM(m2.restaurant_name), ''), t.dropoff_merchant) AS merchant_name,
      t.drop_address AS merchant_address,
      t.status, t.status AS status_raw, NULL AS order_status,
      o.payment_type AS payment_type,
      ${payStatusExpr},
      CAST(COALESCE(o.total_w_tax, o.sub_total) AS CHAR) AS order_total_amount,
      t.date_created
    FROM mt_driver_task t
    LEFT JOIN mt_order o ON o.order_id = t.order_id
    LEFT JOIN mt_merchant m ON o.merchant_id = m.merchant_id
    LEFT JOIN mt_merchant m2 ON t.dropoff_merchant REGEXP '^[0-9]+$' AND m2.merchant_id = t.dropoff_merchant
    ${whereSql}`;
  try {
    const [rows] = await pool.query(sql, params);
    return rows || [];
  } catch (e) {
    if (
      mtOrderPaymentStatusColumn &&
      e.code === 'ER_BAD_FIELD_ERROR' &&
      /payment_status/i.test(String(e.sqlMessage || ''))
    ) {
      mtOrderPaymentStatusColumn = false;
      return queryRiderTaskRows(whereSql, params);
    }
    throw e;
  }
}

function pickMoneyStr(v) {
  if (v == null || v === '') return null;
  return String(v);
}

function numOrZero(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True when numeric value is non-zero (used to pick a “real” fee among several DB columns). */
function isNonZeroMoney(v) {
  const n = numOrZero(v);
  return n != null && n !== 0;
}

/** String for JSON only when numeric value is non-zero (avoids treating "0" as a real fee). */
function pickNonZeroMoneyStr(v) {
  return isNonZeroMoney(v) ? pickMoneyStr(v) : null;
}

/**
 * Pull fee-like scalars from mt_order.json_details when columns are 0/null but checkout JSON has amounts.
 * Shallow + common nested objects (cart, totals, order, …).
 * @param {Record<string, unknown>|null|undefined} orderRow
 * @returns {Record<string, unknown>}
 */
function extractStandardOrderJsonFeeHints(orderRow) {
  const out = /** @type {Record<string, unknown>} */ ({});
  if (!orderRow || typeof orderRow !== 'object') return out;
  let raw = orderRow.json_details ?? orderRow.jsonDetails;
  if (raw == null) return out;
  const s = (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)).trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return out;
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (_) {
    return out;
  }
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!root || typeof root !== 'object') return out;

  const feeKeys = [
    'card_fee',
    'cardFee',
    'service_fee',
    'serviceFee',
    'convenience_fee',
    'convenienceFee',
    'platform_fee',
    'platformFee',
    'application_fee',
    'applicationFee',
    'packaging_fee',
    'packagingFee',
    'admin_fee',
    'processing_fee',
  ];
  const takeFrom = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of feeKeys) {
      if (out[k] == null && o[k] != null && String(o[k]).trim() !== '') out[k] = o[k];
    }
  };
  takeFrom(root);
  for (const nest of ['cart', 'totals', 'summary', 'order', 'checkout', 'data', 'payload']) {
    if (root[nest] != null && typeof root[nest] === 'object') takeFrom(root[nest]);
  }
  return out;
}

/** First non-zero money among candidates (order matters). */
function firstPositiveMoneyScalar(...candidates) {
  for (const c of candidates) {
    if (isNonZeroMoney(c)) return pickMoneyStr(c);
  }
  return null;
}

/**
 * Payment scalars for driver task JSON (root + nested order/mt_order). Matches Flutter normalization keys.
 * @param {Record<string, unknown>|null|undefined} orderRow mt_order
 * @param {Record<string, unknown>|null|undefined} deliveryRow mt_order_delivery_address (optional)
 * @returns {Record<string, string|null>}
 */
function computeMtOrderPaymentFieldsForDriver(orderRow, deliveryRow) {
  const empty = {
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
  if (!orderRow || typeof orderRow !== 'object') return empty;

  const jh = extractStandardOrderJsonFeeHints(orderRow);

  const service_fee =
    pickNonZeroMoneyStr(orderRow.service_fee) ||
    pickNonZeroMoneyStr(orderRow.serviceFee) ||
    (deliveryRow ? pickNonZeroMoneyStr(deliveryRow.service_fee) : null) ||
    firstPositiveMoneyScalar(jh.service_fee, jh.serviceFee);

  const card_fee =
    pickNonZeroMoneyStr(orderRow.card_fee) ||
    pickNonZeroMoneyStr(orderRow.cardFee) ||
    firstPositiveMoneyScalar(jh.card_fee, jh.cardFee);

  let convenience_fee = firstPositiveMoneyScalar(
    orderRow.card_fee,
    jh.card_fee,
    jh.cardFee,
    orderRow.service_fee,
    jh.service_fee,
    jh.serviceFee,
    orderRow.convenience_fee,
    jh.convenience_fee,
    jh.convenienceFee,
    orderRow.platform_fee,
    jh.platform_fee,
    jh.platformFee,
    orderRow.application_fee,
    jh.application_fee,
    jh.applicationFee,
    orderRow.packaging_fee,
    jh.packaging_fee,
    jh.packagingFee,
    jh.admin_fee,
    jh.processing_fee,
    deliveryRow?.service_fee
  );

  if (convenience_fee == null && isNonZeroMoney(service_fee)) convenience_fee = service_fee;

  if (convenience_fee != null && !isNonZeroMoney(convenience_fee)) convenience_fee = null;

  const order_delivery_charge =
    pickMoneyStr(orderRow.delivery_charge) ||
    pickMoneyStr(orderRow.customer_delivery_charge) ||
    pickMoneyStr(orderRow.shipping_fee) ||
    pickMoneyStr(orderRow.delivery_fee);

  const delivery_fee =
    pickMoneyStr(orderRow.task_fee) ||
    pickMoneyStr(orderRow.rider_fee) ||
    pickMoneyStr(orderRow.driver_fee) ||
    pickMoneyStr(orderRow.driver_delivery_fee);

  const tipPct =
    orderRow.cart_tip_percentage != null && String(orderRow.cart_tip_percentage).trim() !== ''
      ? String(orderRow.cart_tip_percentage)
      : null;

  const sub_total = pickMoneyStr(orderRow.sub_total);
  const total_w_tax = pickMoneyStr(orderRow.total_w_tax);
  const delivery_charge =
    pickMoneyStr(orderRow.delivery_charge) || pickMoneyStr(orderRow.customer_delivery_charge) || order_delivery_charge;

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
    customer_delivery_charge: pickMoneyStr(orderRow.customer_delivery_charge),
    customerDeliveryCharge: pickMoneyStr(orderRow.customer_delivery_charge),
    convenience_fee,
    convenienceFee: convenience_fee,
    service_fee,
    serviceFee: service_fee,
    card_fee,
    cardFee: card_fee,
    cart_tip_percentage: tipPct,
    cartTipPercentage: tipPct,
    cart_tip_value: pickMoneyStr(orderRow.cart_tip_value),
    cartTipValue: pickMoneyStr(orderRow.cart_tip_value),
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

function truthyAsap(v) {
  if (v == null || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

/** Normalize DB / Date to YYYY-MM-DD for JSON. */
function formatDateOnlyMysql(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  if (str.includes('T')) return str.slice(0, 10);
  return str || null;
}

/** Map one mt_order_details row for rider app (snake + camelCase aliases, addon string + parsed addons). */
function mapDetailRowForRider(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  const itemName = row.item_name ?? row.itemName ?? row.name ?? null;
  const qty = row.qty ?? row.quantity ?? row.qty_ordered ?? null;
  const size = row.size != null && row.size !== '' ? String(row.size) : null;
  const orderNotes = row.order_notes ?? row.notes ?? row.orderNotes ?? null;
  let addonRaw = row.addon ?? row.addons;
  if (Buffer.isBuffer(addonRaw)) addonRaw = addonRaw.toString('utf8');
  let addonsParsed = null;
  if (addonRaw != null && typeof addonRaw === 'string' && addonRaw.trim() !== '') {
    try {
      addonsParsed = JSON.parse(addonRaw);
    } catch (_) {
      /* keep string in addon */
    }
  } else if (Array.isArray(addonRaw)) {
    addonsParsed = addonRaw;
    addonRaw = JSON.stringify(addonRaw);
  }
  if (itemName != null) {
    out.item_name = itemName;
    out.itemName = itemName;
  }
  if (qty != null) {
    out.qty = qty;
    out.quantity = qty;
  }
  if (size != null) out.size = size;
  if (orderNotes != null) {
    out.order_notes = orderNotes;
    out.orderNotes = orderNotes;
  }
  if (addonRaw != null && addonRaw !== '') {
    out.addon = typeof addonRaw === 'string' ? addonRaw : JSON.stringify(addonRaw);
  } else {
    out.addon = out.addon != null && !Buffer.isBuffer(out.addon) ? String(out.addon) : out.addon;
  }
  if (addonsParsed != null) out.addons = addonsParsed;
  return out;
}

/**
 * Attach scheduled delivery, instructions, line items, and nested order aliases (list + detail same shape).
 * @param {Record<string, unknown>} details task row (mutated)
 * @param {Record<string, unknown>|null} orderRow mt_order row or null
 * @param {unknown[]} rawLineRows mt_order_details rows
 * @param {Record<string, unknown>|null} [deliveryRow] mt_order_delivery_address — improves convenience_fee when fee lives only here
 */
function attachScheduleLinesAndAliases(details, orderRow, rawLineRows, deliveryRow = null) {
  const lines = Array.isArray(rawLineRows) ? rawLineRows.map(mapDetailRowForRider) : [];
  details.order_line_items = lines;
  details.orderLineItems = lines;
  details.mt_order_details = lines;
  details.order_details = lines;
  details.orderDetails = lines;

  const ddFromOrder = orderRow ? formatDateOnlyMysql(orderRow.delivery_date) : null;
  const ddFromTask = formatDateOnlyMysql(details.delivery_date);
  const dd = ddFromOrder || ddFromTask || null;

  const dt =
    orderRow && orderRow.delivery_time != null && String(orderRow.delivery_time).trim() !== ''
      ? String(orderRow.delivery_time).trim()
      : null;

  const di =
    orderRow && orderRow.delivery_instruction != null && String(orderRow.delivery_instruction).trim() !== ''
      ? String(orderRow.delivery_instruction).trim()
      : null;

  const deliveryAsap = orderRow ? truthyAsap(orderRow.delivery_asap) : false;

  if (dd) {
    details.delivery_date = dd;
    details.deliveryDate = dd;
  }
  if (dt != null) {
    details.delivery_time = dt;
    details.deliveryTime = dt;
  }
  details.delivery_asap = deliveryAsap ? 1 : 0;
  details.deliveryAsap = deliveryAsap;
  if (di != null) {
    details.delivery_instruction = di;
    details.deliveryInstruction = di;
  }

  let jsonDetails = null;
  if (orderRow) {
    if (orderRow.json_details != null) {
      jsonDetails = Buffer.isBuffer(orderRow.json_details) ? orderRow.json_details.toString('utf8') : String(orderRow.json_details);
    } else if (orderRow.jsonDetails != null) {
      jsonDetails = String(orderRow.jsonDetails);
    }
  }

  const orderBase = details.order && typeof details.order === 'object' ? { ...details.order } : {};
  orderBase.delivery_date = dd;
  orderBase.deliveryDate = dd;
  orderBase.delivery_time = dt;
  orderBase.deliveryTime = dt;
  orderBase.delivery_asap = deliveryAsap ? 1 : 0;
  orderBase.deliveryAsap = deliveryAsap;
  orderBase.delivery_instruction = di;
  orderBase.deliveryInstruction = di;
  if (jsonDetails) {
    orderBase.json_details = jsonDetails;
    orderBase.jsonDetails = jsonDetails;
  }

  let payForRoot = null;
  if (orderRow) {
    payForRoot = computeMtOrderPaymentFieldsForDriver(orderRow, deliveryRow);
    Object.assign(orderBase, payForRoot);
  }

  details.order = orderBase;
  details.mt_order = { ...orderBase };
  details.order_info = { ...orderBase };
  details.orderInfo = { ...orderBase };

  if (payForRoot) Object.assign(details, payForRoot);

  return details;
}

/** Batch-load mt_order + mt_order_details for many order_ids (driver task list). */
async function batchFetchOrdersAndLines(pool, orderIds) {
  const uniq = [
    ...new Set(
      orderIds
        .map((id) => parseInt(String(id), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  const ordersMap = new Map();
  const linesByOrder = new Map();
  if (uniq.length === 0) return { ordersMap, linesByOrder };
  const ph = uniq.map(() => '?').join(',');
  try {
    const [orows] = await pool.query(`SELECT * FROM mt_order WHERE order_id IN (${ph})`, uniq);
    for (const r of orows || []) {
      if (r.order_id != null) ordersMap.set(Number(r.order_id), r);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  try {
    const [lrows] = await pool.query(
      `SELECT * FROM mt_order_details WHERE order_id IN (${ph}) ORDER BY order_id ASC, id ASC`,
      uniq
    );
    for (const r of lrows || []) {
      const oid = Number(r.order_id);
      if (!linesByOrder.has(oid)) linesByOrder.set(oid, []);
      linesByOrder.get(oid).push(r);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  return { ordersMap, linesByOrder };
}

/**
 * Latest `mt_order_delivery_address` row per order_id (list API uses same fee resolution as GetTaskDetails).
 * @param {import('mysql2/promise').Pool} pool
 * @param {unknown[]} orderIds
 * @returns {Promise<Map<number, Record<string, unknown>>>}
 */
async function batchFetchLatestDeliveryAddressesByOrderIds(pool, orderIds) {
  const map = new Map();
  const uniq = [
    ...new Set(
      orderIds
        .map((id) => parseInt(String(id), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (uniq.length === 0) return map;
  const ph = uniq.map(() => '?').join(',');
  const load = async (withServiceFee) => {
    const sf = withServiceFee ? ', service_fee' : '';
    const [rows] = await pool.query(
      `SELECT order_id, location_name, google_lat, google_lng, street, city, state, zipcode, country, formatted_address${sf}
       FROM mt_order_delivery_address WHERE order_id IN (${ph}) ORDER BY id DESC`,
      uniq
    );
    for (const r of rows || []) {
      const oid = Number(r.order_id);
      if (!map.has(oid)) map.set(oid, r);
    }
  };
  try {
    await load(true);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' && /service_fee/i.test(String(e.sqlMessage || ''))) {
      try {
        await load(false);
      } catch (e2) {
        if (e2.code !== 'ER_NO_SUCH_TABLE' && e2.code !== 'ER_BAD_FIELD_ERROR') throw e2;
      }
    } else if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      throw e;
    }
  }
  return map;
}

/** Single-line pickup address from mt_merchant (rider task details). */
function formatMerchantPickupAddress(m) {
  if (!m || typeof m !== 'object') return '';
  const parts = [m.street, m.city, m.state, m.post_code, m.zipcode, m.country]
    .map((x) => (x != null ? String(x).trim() : ''))
    .filter(Boolean);
  const joined = parts.join(', ');
  if (joined) return joined;
  const fa = m.formatted_address != null ? String(m.formatted_address).trim() : '';
  return fa || '';
}

/**
 * Merge order / delivery / merchant / line items into rider task details.
 * Preserves existing keys from queryRiderTaskRows; adds order_subtotal, convenience_fee, nested order, etc.
 */
async function enrichRiderTaskDetails(pool, taskRow) {
  const details = { ...taskRow };
  const legacyDropMerchantAddr = details.merchant_address;
  details.task_drop_address = legacyDropMerchantAddr != null ? String(legacyDropMerchantAddr) : '';
  details.drop_address = details.task_drop_address;

  const orderId = details.order_id != null ? parseInt(String(details.order_id), 10) : 0;

  let orderRow = null;
  if (orderId) {
    try {
      const [ords] = await pool.query('SELECT * FROM mt_order WHERE order_id = ? LIMIT 1', [orderId]);
      orderRow = ords && ords[0];
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
  }

  let deliveryRow = null;
  if (orderId) {
    try {
      const [dr] = await pool.query(
        `SELECT location_name, google_lat, google_lng, street, city, state, zipcode, country, formatted_address, service_fee
         FROM mt_order_delivery_address WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
        [orderId]
      );
      deliveryRow = dr && dr[0];
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR' && /service_fee/i.test(String(e.sqlMessage || ''))) {
        const [dr] = await pool.query(
          `SELECT location_name, google_lat, google_lng, street, city, state, zipcode, country, formatted_address
           FROM mt_order_delivery_address WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
          [orderId]
        );
        deliveryRow = dr && dr[0];
      } else if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
        throw e;
      }
    }
  }

  const midFromOrder = orderRow?.merchant_id != null && String(orderRow.merchant_id).trim() !== '' ? parseInt(String(orderRow.merchant_id), 10) : null;
  const dropoff = details.dropoff_merchant;
  const midFromTask =
    dropoff != null && String(dropoff).trim() !== '' && /^\d+$/.test(String(dropoff).trim())
      ? parseInt(String(dropoff).trim(), 10)
      : null;
  const merchantId = Number.isFinite(midFromOrder) ? midFromOrder : Number.isFinite(midFromTask) ? midFromTask : null;

  let merchantRow = null;
  if (merchantId) {
    try {
      const [mr] = await pool.query(
        'SELECT merchant_id, restaurant_name, restaurant_phone, street, city, state, post_code FROM mt_merchant WHERE merchant_id = ? LIMIT 1',
        [merchantId]
      );
      merchantRow = mr && mr[0];
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  const pickupFormatted = formatMerchantPickupAddress(merchantRow);
  details.merchant_address = pickupFormatted || details.drop_address || '';

  if (merchantRow) {
    details.merchant = {
      merchant_id: merchantRow.merchant_id,
      restaurant_name: merchantRow.restaurant_name,
      restaurant_phone: merchantRow.restaurant_phone,
      street: merchantRow.street,
      city: merchantRow.city,
      state: merchantRow.state,
      post_code: merchantRow.post_code,
      formatted_address: pickupFormatted || null,
    };
  }

  if (deliveryRow) {
    details.order_delivery_address = { ...deliveryRow };
    details.mt_order_delivery_address = details.order_delivery_address;
    details.orderDeliveryAddress = details.order_delivery_address;
  }

  let rawLines = [];
  if (orderId) {
    try {
      const [lines] = await pool.query('SELECT * FROM mt_order_details WHERE order_id = ? ORDER BY id ASC', [orderId]);
      rawLines = lines || [];
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  if (rawLines.length > 0) {
    try {
      rawLines = await attachOrderDetailCategories(pool, rawLines, merchantId);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
    try {
      rawLines = await enrichOrderDetailsWithSubcategoryAddons(pool, rawLines);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  attachScheduleLinesAndAliases(details, orderRow, rawLines, deliveryRow);

  const tid = details.task_id != null ? parseInt(String(details.task_id), 10) : 0;
  if (Number.isFinite(tid) && tid > 0) {
    const { task_photos, proof_images } = await fetchTaskProofPhotosWithUrls(
      pool,
      tid,
      orderId > 0 ? orderId : null
    );
    details.task_photos = task_photos;
    details.proof_images = proof_images;
  } else {
    details.task_photos = [];
    details.proof_images = [];
  }

  /** Activity timeline for Flutter (order_history + aliases; each row has date_created / created_at / …). */
  let orderHistoryForDriver = [];
  if (Number.isFinite(tid) && tid > 0) {
    try {
      orderHistoryForDriver = await fetchDriverMergedOrderHistory(pool, tid, orderId > 0 ? orderId : null);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }
  details.order_history = orderHistoryForDriver;
  details.orderHistory = orderHistoryForDriver;
  details.mt_order_history = orderHistoryForDriver;
  details.order_status_list = orderHistoryForDriver;
  details.order_status_history = orderHistoryForDriver;

  return details;
}

// ---- Public (api_key only) ----
router.post('/Login', validateApiKey, async (req, res) => {
  const { username, password, device_id, device_platform } = req.body;
  if (!username || !password) {
    return error(res, 'Username and password required');
  }
  const [[driver]] = await pool.query(
    'SELECT driver_id AS id, username, password AS password_hash, on_duty FROM mt_driver WHERE username = ?',
    [username]
  );
  if (!driver) {
    return error(res, 'Invalid credentials');
  }
  const stored = (driver.password_hash || '').trim();
  const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');
  const isMd5 = /^[a-f0-9]{32}$/i.test(stored);
  let passwordOk = false;
  if (isBcrypt) {
    passwordOk = await bcrypt.compare(password, stored);
  } else if (isMd5) {
    passwordOk = crypto.createHash('md5').update(password).digest('hex').toLowerCase() === stored.toLowerCase();
  } else {
    passwordOk = password === stored;
  }
  if (!passwordOk) {
    return error(res, 'Invalid credentials');
  }
  const token = uuidv4();
  const nowUnix = Math.floor(Date.now() / 1000);
  const updates = [token, device_id || null, (device_platform || '').toLowerCase() || null, driver.id];
  try {
    await pool.query(
      'UPDATE mt_driver SET token = ?, device_id = ?, device_platform = ?, last_login = NOW(), last_online = ? WHERE driver_id = ?',
      [updates[0], updates[1], updates[2], nowUnix, driver.id]
    );
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      await pool.query(
        'UPDATE mt_driver SET token = ?, device_id = ?, device_platform = ?, last_login = NOW() WHERE driver_id = ?',
        updates
      );
    } else throw e;
  }
  if (!isBcrypt && stored) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE mt_driver SET password = ? WHERE driver_id = ?', [hash, driver.id]);
  }
  return success(res, {
    token,
    username: driver.username,
    todays_date: todayStr(),
    todays_date_raw: todayRaw(),
    on_duty: driver.on_duty ?? 1,
    duty_status: driver.on_duty,
    location_accuracy: 2,
    enabled_push: 1,
    topic_new_task: null,
    topic_alert: null,
  });
});

async function getDriverSettingsMap() {
  try {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    if (rows && rows.length > 0) return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (e) {
    // settings table may not exist
  }
  try {
    const [rows] = await pool.query('SELECT option_name AS `key`, option_value AS value FROM mt_option');
    return Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  } catch (e) {
    return {};
  }
}

/** Optional COD / payment fields when completing a task (mt_order). */
async function updateOrderPaymentFields(orderId, payment_type, payment_status) {
  if (!orderId || orderId <= 0) return;
  const pt = payment_type != null && String(payment_type).trim() !== '' ? String(payment_type).trim() : null;
  const ps = payment_status != null && String(payment_status).trim() !== '' ? String(payment_status).trim() : null;
  if (pt == null && ps == null) return;
  const pieces = [];
  const vals = [];
  if (pt != null) {
    pieces.push('payment_type = ?');
    vals.push(pt);
  }
  if (ps != null) {
    pieces.push('payment_status = ?');
    vals.push(ps);
  }
  if (!pieces.length) return;
  vals.push(orderId);
  try {
    await pool.query(`UPDATE mt_order SET ${pieces.join(', ')} WHERE order_id = ?`, vals);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' && /payment_status/i.test(String(e.sqlMessage || ''))) {
      if (pt != null) {
        await pool.query('UPDATE mt_order SET payment_type = ? WHERE order_id = ?', [pt, orderId]);
      }
    } else if (e.code !== 'ER_BAD_FIELD_ERROR') {
      throw e;
    }
  }
}

router.post('/GetAppSettings', validateApiKey, optionalDriver, async (req, res) => {
  const settings = await getDriverSettingsMap();
  const driver = req.driver;
  const appName = (settings.app_name != null && String(settings.app_name).trim() !== '') ? String(settings.app_name).trim() : (settings.website_title || 'WIB Driver');
  const configuredApiKey = settings.driver_api_hash_key || settings.api_hash_key || process.env.API_HASH_KEY || '';
  const envMobileApiUrlRaw = (process.env.MOBILE_API_URL || '').trim();
  const envMobileApiUrl = envMobileApiUrlRaw ? envMobileApiUrlRaw.replace(/\/+$/, '') : '';
  const mobileApiUrl = configuredApiKey && String(configuredApiKey).trim() ? envMobileApiUrl : '';
  const details = {
    app_language: settings.app_default_language || 'en',
    app_name: appName,
    allow_task_successful_when: settings.allow_task_successful_when || 'picture_proof',
    mobile_api_url: mobileApiUrl,
    valid_token: !!driver,
    todays_date: todayStr(),
    todays_date_raw: todayRaw(),
    on_duty: driver?.on_duty ?? 0,
    token: driver ? (await getTokenForDriverId(driver.id)) : null,
    duty_status: driver?.on_duty,
    location_accuracy: 2,
    enabled_push: 1,
    topic_new_task: null,
    topic_alert: null,
    notification_sound_url: null,
    track_interval: 15000,
    map_provider: 'google',
    translation: {},
  };
  return success(res, details);
});

async function getTokenForDriverId(driverId) {
  const [[r]] = await pool.query('SELECT token FROM mt_driver WHERE driver_id = ?', [driverId]);
  return r?.token || null;
}

// ---- Protected (api_key + token) ----
router.post('/Logout', validateApiKey, resolveDriver, async (req, res) => {
  const oldUnix = Math.floor(Date.now() / 1000) - 35 * 60;
  try {
    await pool.query('UPDATE mt_driver SET token = NULL, last_online = ? WHERE driver_id = ?', [oldUnix, req.driver.id]);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      await pool.query('UPDATE mt_driver SET token = NULL WHERE driver_id = ?', [req.driver.id]);
    } else throw e;
  }
  return success(res, null);
});

router.post('/reRegisterDevice', validateApiKey, resolveDriver, async (req, res) => {
  const { new_device_id, device_platform } = req.body;
  await pool.query(
    'UPDATE mt_driver SET device_id = ?, device_platform = ? WHERE driver_id = ?',
    [new_device_id || null, (device_platform || '').toLowerCase() || null, req.driver.id]
  );
  return success(res, null);
});

router.post('/ChangeDutyStatus', validateApiKey, resolveDriver, async (req, res) => {
  const onDuty = parseInt(req.body.on_duty, 10);
  const val = onDuty === 1 ? 1 : 0;
  if (val !== 1) {
    const oldUnix = Math.floor(Date.now() / 1000) - 35 * 60;
    try {
      await pool.query('UPDATE mt_driver SET on_duty = ?, last_online = ? WHERE driver_id = ?', [val, oldUnix, req.driver.id]);
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        await pool.query('UPDATE mt_driver SET on_duty = ? WHERE driver_id = ?', [val, req.driver.id]);
      } else throw e;
    }
  } else {
    const nowUnix = Math.floor(Date.now() / 1000);
    try {
      await pool.query(
        'UPDATE mt_driver SET on_duty = ?, last_online = ?, last_login = NOW() WHERE driver_id = ?',
        [val, nowUnix, req.driver.id]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        try {
          await pool.query('UPDATE mt_driver SET on_duty = ?, last_login = NOW() WHERE driver_id = ?', [val, req.driver.id]);
        } catch (e2) {
          if (e2.code === 'ER_BAD_FIELD_ERROR') {
            await pool.query('UPDATE mt_driver SET on_duty = ? WHERE driver_id = ?', [val, req.driver.id]);
          } else throw e2;
        }
      } else throw e;
    }
  }
  return success(res, null);
});

router.post('/UpdateDriverLocation', validateApiKey, resolveDriver, async (req, res) => {
  const { lat, lng, accuracy, altitude, device_id, device_platform, on_duty, driver_id } = req.body;
  const did = driver_id ? parseInt(driver_id, 10) : req.driver.id;
  const numLat = parseFloat(lat);
  const numLng = parseFloat(lng);
  if (Number.isNaN(numLat) || Number.isNaN(numLng)) {
    return error(res, 'Invalid lat/lng');
  }
  // Current position in mt_driver; last_online = now so driver appears online (option 1)
  const nowUnix = Math.floor(Date.now() / 1000);
  try {
    await pool.query(
      'UPDATE mt_driver SET location_lat = ?, location_lng = ?, date_modified = NOW(), last_online = ? WHERE driver_id = ?',
      [numLat, numLng, nowUnix, did]
    );
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      await pool.query(
        'UPDATE mt_driver SET location_lat = ?, location_lng = ?, date_modified = NOW() WHERE driver_id = ?',
        [numLat, numLng, did]
      );
    } else throw e;
  }
  // History in mt_driver_track_location
  await pool.query(
    `INSERT INTO mt_driver_track_location (driver_id, latitude, longitude, altitude, accuracy, date_created, device_platform)
     VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
    [did, numLat, numLng, altitude || null, accuracy || null, (device_platform || '').toLowerCase() || null]
  );
  if (device_id || device_platform != null) {
    await pool.query(
      'UPDATE mt_driver SET device_id = COALESCE(?, device_id), device_platform = COALESCE(?, device_platform), on_duty = COALESCE(?, on_duty) WHERE driver_id = ?',
      [device_id || null, device_platform || null, on_duty != null ? parseInt(on_duty, 10) : null, did]
    );
  }
  return success(res, null, 'Location set');
});

router.post('/GetProfile', validateApiKey, resolveDriver, async (req, res) => {
  const [[d]] = await pool.query(
    `SELECT CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name, d.phone, d.location_address AS address, d.transport_type_id, d.transport_description,
      d.licence_plate, d.color, d.profile_photo, d.team_id, t.team_name, d.email
     FROM mt_driver d LEFT JOIN mt_driver_team t ON d.team_id = t.team_id WHERE d.driver_id = ?`,
    [req.driver.id]
  );
  // Hardcoded to match old backend transportType() – no transport_types table
  const transportList = {
    '': 'Please select',
    truck: 'Truck',
    car: 'Car',
    bike: 'Bike',
    bicycle: 'Bicycle',
    scooter: 'Scooter',
    walk: 'Walk',
  };
  const profilePhoto = d?.profile_photo ? (d.profile_photo.startsWith('http') ? d.profile_photo : `${BASE_URL}${d.profile_photo.startsWith('/') ? '' : '/'}${d.profile_photo}`) : null;
  return success(res, {
    full_name: d?.full_name,
    team_name: d?.team_name,
    email: d?.email,
    phone: d?.phone,
    address: d?.address,
    transport_type_id: d?.transport_type_id,
    transport_type_id2: d?.transport_type_id,
    transport_description: d?.transport_description,
    licence_plate: d?.licence_plate,
    color: d?.color,
    profile_photo: profilePhoto,
    transport_list: transportList,
  });
});

router.post('/UpdateProfile', validateApiKey, resolveDriver, async (req, res) => {
  const { phone, team_name, username, address, driver_address } = req.body;
  const addr = address || driver_address;
  if (username != null) {
    await pool.query('UPDATE mt_driver SET first_name = ?, last_name = ? WHERE driver_id = ?', [username.trim(), '', req.driver.id]);
  }
  if (phone != null) await pool.query('UPDATE mt_driver SET phone = ? WHERE driver_id = ?', [phone, req.driver.id]);
  if (addr != null) await pool.query('UPDATE mt_driver SET location_address = ? WHERE driver_id = ?', [addr, req.driver.id]);
  if (team_name != null) {
    const [[t]] = await pool.query('SELECT team_id FROM mt_driver_team WHERE team_name = ? LIMIT 1', [team_name]);
    await pool.query('UPDATE mt_driver SET team_id = ? WHERE driver_id = ?', [t?.team_id ?? null, req.driver.id]);
  }
  return success(res, null);
});

router.post('/UpdateVehicle', validateApiKey, resolveDriver, async (req, res) => {
  const { transport_type_id, transport_description, licence_plate, color } = req.body;
  await pool.query(
    'UPDATE mt_driver SET transport_type_id = ?, transport_description = ?, licence_plate = ?, color = ? WHERE driver_id = ?',
    [transport_type_id || null, transport_description || null, licence_plate || null, color || null, req.driver.id]
  );
  return success(res, null);
});

router.post('/GetTaskByDate', validateApiKey, resolveDriver, async (req, res) => {
  const date = req.body.date || todayStr();
  const rows = await queryRiderTaskRows(
    'WHERE (t.delivery_date = ? OR DATE(t.delivery_date) = ?) AND (t.driver_id IS NULL OR t.driver_id = ?) ORDER BY t.task_id',
    [date, date, req.driver.id]
  );
  const orderIdsForBatch = rows.map((r) => r.order_id);
  const { ordersMap, linesByOrder } = await batchFetchOrdersAndLines(pool, orderIdsForBatch);
  const deliveryByOrderId = await batchFetchLatestDeliveryAddressesByOrderIds(pool, orderIdsForBatch);
  const data = rows.map((r) => {
    const out = {
      ...r,
      date_created: r.date_created ? new Date(r.date_created).toISOString() : null,
    };
    const oid = out.order_id != null ? parseInt(String(out.order_id), 10) : 0;
    const orderRow = Number.isFinite(oid) && oid > 0 ? ordersMap.get(oid) || null : null;
    const lineRows = Number.isFinite(oid) && oid > 0 ? linesByOrder.get(oid) || [] : [];
    const deliveryRow = Number.isFinite(oid) && oid > 0 ? deliveryByOrderId.get(oid) || null : null;
    attachScheduleLinesAndAliases(out, orderRow, lineRows, deliveryRow);
    return out;
  });
  return success(res, { data });
});

router.post('/GetTaskDetails', validateApiKey, resolveDriver, async (req, res) => {
  const taskId = parseInt(req.body.task_id, 10);
  if (!taskId) return error(res, 'task_id required');
  const rows = await queryRiderTaskRows('WHERE t.task_id = ? LIMIT 1', [taskId]);
  const r = rows[0];
  if (!r) return error(res, 'Task not found');
  r.date_created = r.date_created ? new Date(r.date_created).toISOString() : null;
  try {
    const details = await enrichRiderTaskDetails(pool, r);
    return success(res, details);
  } catch (e) {
    return error(res, e.message || 'Failed to load task details');
  }
});

router.post('/ChangeTaskStatus', validateApiKey, resolveDriver, async (req, res) => {
  const body = req.body || {};
  const {
    task_id,
    status_raw,
    reason,
    payment_type,
    payment_status,
    latitude,
    longitude,
    lat,
    lng,
  } = body;
  const tid = parseInt(task_id ?? body.taskId ?? body.task_id, 10);
  if (!tid) return error(res, 'task_id required');
  const rawForStatus =
    status_raw ??
    body.statusRaw ??
    body.status ??
    body.Status ??
    body.state ??
    body.delivery_status;
  const status = (
    rawForStatus != null && String(rawForStatus).trim() !== '' ? String(rawForStatus) : 'completed'
  )
    .toLowerCase()
    .trim();

  const [[task]] = await pool.query(
    'SELECT task_id, order_id, driver_id, task_description FROM mt_driver_task WHERE task_id = ? LIMIT 1',
    [tid]
  );
  if (!task || task.driver_id !== req.driver.id) {
    return error(res, 'Task not found or not assigned to you');
  }

  const settings = await getDriverSettingsMap();
  const policy = settings.allow_task_successful_when || 'picture_proof';
  const requiresProof = policy === 'picture_proof' && (status === 'successful' || status === 'delivered');
  if (requiresProof) {
    try {
      const [[row]] = await pool.query(
        'SELECT COUNT(*) AS c FROM mt_driver_task_photo WHERE task_id = ?',
        [tid]
      );
      const cnt = Number(row?.c ?? 0);
      if (!cnt) {
        return error(res, 'Picture proof of delivery is required before marking this task successful');
      }
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') {
        return error(res, 'Picture proof of delivery is required before marking this task successful');
      }
      throw e;
    }
  }

  const [updateResult] = await pool.query(
    'UPDATE mt_driver_task SET status = ?, date_modified = NOW() WHERE task_id = ? AND driver_id = ?',
    [status, tid, req.driver.id]
  );
  if (!updateResult.affectedRows) {
    return error(res, 'Task not found or not assigned to you');
  }

  const oid = task.order_id != null ? parseInt(String(task.order_id), 10) : 0;
  if (Number.isFinite(oid) && oid > 0) {
    try {
      await updateOrderPaymentFields(oid, payment_type, payment_status);
    } catch (_) {
      /* optional payment update */
    }
  }

  try {
    const remarks = reason != null && String(reason).trim() ? String(reason).trim() : '';
    const latRaw = latitude ?? lat;
    const lngRaw = longitude ?? lng;
    const geoLat = latRaw != null && String(latRaw).trim() !== '' ? parseFloat(latRaw) : NaN;
    const geoLng = lngRaw != null && String(lngRaw).trim() !== '' ? parseFloat(lngRaw) : NaN;
    const hasGeo = Number.isFinite(geoLat) && Number.isFinite(geoLng);
    await insertMtOrderHistoryRow(pool, {
      orderId: task?.order_id || null,
      taskId: tid,
      status,
      remarks,
      updateByType: 'driver',
      actorId: req.driver.id,
      actorDisplayName: formatActorFromDriver(req.driver),
      latitude: hasGeo ? geoLat : null,
      longitude: hasGeo ? geoLng : null,
    });
  } catch (_) {
    /* mt_order_history optional — do not fail status update */
  }

  try {
    const actor = formatActorFromDriver(req.driver);
    const payload = foodTaskNotifyFromStatus(tid, task.order_id, task.task_description, status, actor);
    if (payload) await notifyAllDashboardAdmins(pool, payload).catch(() => {});
  } catch (_) {}

  return success(res, null);
});

router.post('/GetNotifications', validateApiKey, resolveDriver, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT push_id, push_title, push_message, push_type, date_created, is_read, task_id, order_id FROM mt_driver_pushlog WHERE driver_id = ? ORDER BY date_created DESC LIMIT 100',
    [req.driver.id]
  );
  const data = rows.map((r) => ({
    ...r,
    date_created: r.date_created ? new Date(r.date_created).toISOString() : null,
  }));
  return success(res, data);
});

router.post('/ClearNotifications', validateApiKey, resolveDriver, async (req, res) => {
  await pool.query('UPDATE mt_driver_pushlog SET is_read = 1 WHERE driver_id = ?', [req.driver.id]);
  return success(res, null);
});

router.post('/ForgotPassword', validateApiKey, async (req, res) => {
  const { email } = req.body;
  if (!email) return error(res, 'Email required');
  return success(res, null, 'If the email exists, a reset link has been sent.');
});

router.post('/ChangePassword', validateApiKey, resolveDriver, async (req, res) => {
  const { current_password, new_password } = req.body;
  const [[d]] = await pool.query('SELECT password AS password_hash FROM mt_driver WHERE driver_id = ?', [req.driver.id]);
  if (!d || !(await bcrypt.compare(current_password, d.password_hash))) {
    return error(res, 'Current password is wrong');
  }
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE mt_driver SET password = ? WHERE driver_id = ?', [hash, req.driver.id]);
  return success(res, null);
});

router.post('/joinQueue', validateApiKey, resolveDriver, async (req, res) => {
  const [[existing]] = await pool.query('SELECT id FROM mt_driver_queue WHERE driver_id = ? AND left_at IS NULL LIMIT 1', [req.driver.id]);
  if (!existing) {
    await pool.query(
      'INSERT INTO mt_driver_queue (driver_id, status, joined_at) VALUES (?, ?, NOW())',
      [req.driver.id, 'joined']
    );
  }
  const [order] = await pool.query('SELECT driver_id, joined_at FROM mt_driver_queue WHERE left_at IS NULL ORDER BY joined_at ASC');
  const row = order.find((r) => r.driver_id === req.driver.id);
  const pos = row ? order.findIndex((r) => r.driver_id === req.driver.id) + 1 : 0;
  return success(res, { in_queue: true, position: pos, joined_at: row?.joined_at ? new Date(row.joined_at).toISOString() : new Date().toISOString() });
});

router.post('/leaveQueue', validateApiKey, resolveDriver, async (req, res) => {
  await pool.query('UPDATE mt_driver_queue SET left_at = NOW(), status = ? WHERE driver_id = ? AND left_at IS NULL', ['left', req.driver.id]);
  return success(res, null);
});

router.post('/queuePosition', validateApiKey, resolveDriver, async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT joined_at FROM mt_driver_queue WHERE driver_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1', [req.driver.id]);
    if (!r) {
      return success(res, { in_queue: false, position: null, joined_at: null });
    }
    const [order] = await pool.query('SELECT driver_id FROM mt_driver_queue WHERE left_at IS NULL ORDER BY joined_at ASC');
    const pos = order.findIndex((row) => row.driver_id === req.driver.id) + 1;
    return success(res, { in_queue: true, position: pos, joined_at: r.joined_at ? new Date(r.joined_at).toISOString() : null });
  } catch (e) {
    return success(res, { in_queue: false, position: null, joined_at: null }, 'Queue position unavailable');
  }
});

router.post('/UploadProfilePhoto', validateApiKey, resolveDriver, upload.single('photo'), async (req, res) => {
  if (!req.file) return error(res, 'No file uploaded');
  const ext = path.extname(req.file.originalname || '') || '.jpg';
  const newName = `driver_${req.driver.id}_${Date.now()}${ext}`;
  const newPath = path.join(uploadDir, newName);
  fs.renameSync(req.file.path, newPath);
  const urlPath = `/uploads/profiles/${newName}`;
  await pool.query('UPDATE mt_driver SET profile_photo = ? WHERE driver_id = ?', [urlPath, req.driver.id]);
  return success(res, null);
}, (err, req, res, next) => {
  if (err) return error(res, err.message || 'Upload failed');
  next();
});

/**
 * Proof of receipt / delivery: multipart file field(s) "photo" (legacy), "receipt_photo", "proof_receipt",
 * "proof_of_receipt", "delivery_photo" — multiple files in one request are each stored as separate rows.
 * Body: task_id, optional order_id (stored when mt_driver_task_photo.order_id exists).
 */
router.post(
  '/UploadTaskProof',
  taskProofUpload.fields([
    { name: 'photo', maxCount: 10 },
    { name: 'receipt_photo', maxCount: 10 },
    { name: 'proof_receipt', maxCount: 10 },
    { name: 'proof_of_receipt', maxCount: 10 },
    { name: 'delivery_photo', maxCount: 10 },
  ]),
  cleanupUploadOnAuthError,
  validateApiKey,
  resolveDriver,
  async (req, res) => {
    const groups = req.files && typeof req.files === 'object' ? req.files : {};
    const ordered = [
      ...(groups.photo || []),
      ...(groups.receipt_photo || []),
      ...(groups.proof_receipt || []),
      ...(groups.proof_of_receipt || []),
      ...(groups.delivery_photo || []),
    ];
    if (!ordered.length) return error(res, 'No file uploaded');
    const tid = parseInt(req.body.task_id, 10);
    if (!tid) {
      for (const f of ordered) {
        try {
          if (f?.path) fs.unlinkSync(f.path);
        } catch (_) {}
      }
      return error(res, 'task_id required');
    }
    const [[task]] = await pool.query(
      'SELECT task_id, driver_id, order_id FROM mt_driver_task WHERE task_id = ? LIMIT 1',
      [tid]
    );
    if (!task || task.driver_id !== req.driver.id) {
      for (const f of ordered) {
        try {
          if (f?.path) fs.unlinkSync(f.path);
        } catch (_) {}
      }
      return error(res, 'Task not found or not assigned to you');
    }
    const bodyOid = parseInt(String(req.body.order_id ?? req.body.orderId ?? ''), 10);
    const taskOid = task.order_id != null ? parseInt(String(task.order_id), 10) : NaN;
    const orderIdForRow = Number.isFinite(bodyOid) && bodyOid > 0 ? bodyOid : Number.isFinite(taskOid) && taskOid > 0 ? taskOid : null;
    const ip = req.ip || req.connection?.remoteAddress || null;

    const conn = await pool.getConnection();
    const savedDisk = [];
    try {
      await conn.beginTransaction();
      const proofs = [];
      for (let i = 0; i < ordered.length; i += 1) {
        const file = ordered[i];
        const ext = path.extname(file.originalname || '') || '.jpg';
        const newName = `task_${tid}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        const newPath = path.join(taskProofDir, newName);
        fs.renameSync(file.path, newPath);
        savedDisk.push(newPath);
        const insertId = await insertDriverTaskPhotoRow(conn, tid, newName, ip, orderIdForRow);
        const proof_url = buildTaskProofImageUrl(newName);
        proofs.push({
          id: insertId,
          task_id: tid,
          photo_name: newName,
          proof_url: proof_url || null,
        });
      }
      await conn.commit();
      if (proofs.length === 1) {
        return success(res, proofs[0]);
      }
      return success(res, { proofs });
    } catch (e) {
      try {
        await conn.rollback();
      } catch (_) {}
      for (const p of savedDisk) {
        try {
          fs.unlinkSync(p);
        } catch (_) {}
      }
      if (e.code === 'ER_NO_SUCH_TABLE') {
        return error(res, 'Proof storage is not available');
      }
      return error(res, e.message || 'Failed to save proof');
    } finally {
      conn.release();
    }
  },
  (err, req, res, next) => {
    if (err) {
      const groups = req.files && typeof req.files === 'object' ? req.files : {};
      const ordered = Object.values(groups).flat();
      for (const f of ordered) {
        try {
          if (f?.path) fs.unlinkSync(f.path);
        } catch (_) {}
      }
      return error(res, err.message || 'Upload failed');
    }
    next();
  }
);

// Log map API usage to mt_driver_mapsapicall (map_provider, api_functions, api_response, date_created, date_call, ip_address)
router.post('/LogMapApiCall', validateApiKey, optionalDriver, async (req, res) => {
  const { map_provider, api_functions, api_response } = req.body;
  const ip_address = req.body.ip_address || req.ip || req.connection?.remoteAddress || null;
  try {
    await pool.query(
      `INSERT INTO mt_driver_mapsapicall (map_provider, api_functions, api_response, date_created, date_call, ip_address)
       VALUES (?, ?, ?, NOW(), NOW(), ?)`,
      [map_provider || null, api_functions || null, api_response != null ? String(api_response) : null, ip_address]
    );
    return success(res, null);
  } catch (e) {
    return error(res, e.message || 'Log failed');
  }
});

const driverErrandRoutes = require('./driverErrand');
router.use(driverErrandRoutes);

module.exports = router;
