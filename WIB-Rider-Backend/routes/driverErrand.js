const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool, errandWibPool } = require('../config/db');
const { success, error } = require('../lib/response');
const { validateApiKey, resolveDriver } = require('../middleware/auth');
const {
  mapStOrderRowToTaskListRow,
  buildErrandTaskDetailPayload,
  fetchErrandOrderLineItems,
  fetchErrandOrderHistory,
  fetchErrandMerchantsByIds,
  fetchErrandClientsByIds,
  fetchErrandClientAddressesByClientIds,
  fetchErrandLatestHistoryStatusByOrderIds,
  pickClientAddressRow,
  fetchErrandStDriversByIds,
  attachErrandDriverGroups,
  fetchMtDriverTeamNamesByIds,
  resolveErrandDriverDetail,
} = require('../lib/errandOrders');
const { normalizeIncomingStatusRaw } = require('../lib/errandDriverStatus');
const { notifyAllDashboardAdminsFireAndForget, errandNotifyFromCanonical } = require('../lib/dashboardRiderNotify');

async function errandOrderNotifyLabel(errandPool, orderId) {
  try {
    const [[er]] = await errandPool.query('SELECT order_reference FROM st_ordernew WHERE order_id = ? LIMIT 1', [orderId]);
    if (er?.order_reference != null && String(er.order_reference).trim()) {
      return `Errand ${String(er.order_reference).trim()}`;
    }
  } catch (_) {
    /* ignore */
  }
  return `Errand order #${orderId}`;
}

const {
  buildErrandProofImageUrl,
  fetchErrandProofsForOrder,
  countErrandProofForOrder,
  insertErrandProofRow,
} = require('../lib/errandProof');
const { insertStOrdernewHistoryRow } = require('../lib/errandHistoryInsert');

const router = express.Router();

const errandProofDir = path.join(__dirname, '..', 'uploads', 'errand');
if (!fs.existsSync(errandProofDir)) {
  fs.mkdirSync(errandProofDir, { recursive: true });
}

const errandProofUpload = multer({
  dest: errandProofDir,
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

function cleanupUploadOnAuthError(req, res, next) {
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (req.file?.path && body && body.code === 2) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }
    return orig(body);
  };
  next();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function truthyIncludeUnassigned(v) {
  if (v == null || v === '') return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

/** Positive order_id, or |task_id| only when task_id < 0 (errand synthetic id; positive task_id is mt_driver_task). */
function parseErrandOrderId(body) {
  const b = body || {};
  if (b.order_id != null && String(b.order_id).trim() !== '') {
    const n = parseInt(String(b.order_id), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (b.task_id != null && String(b.task_id).trim() !== '') {
    const t = parseInt(String(b.task_id), 10);
    if (Number.isFinite(t) && t < 0) return Math.abs(t);
  }
  return null;
}

function orderDriverId(row) {
  if (row.driver_id == null || String(row.driver_id).trim() === '') return null;
  const n = parseInt(String(row.driver_id), 10);
  return Number.isFinite(n) ? n : null;
}

function isUnassignedOrder(row) {
  const d = orderDriverId(row);
  return d == null || d === 0;
}

async function getDriverSettingsMap() {
  try {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    if (rows && rows.length > 0) return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (_) {
    /* optional */
  }
  try {
    const [rows] = await pool.query('SELECT option_name AS `key`, option_value AS value FROM mt_option');
    return Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  } catch (_) {
    return {};
  }
}

async function fetchDriverNameMap(driverIds) {
  const uniq = [...new Set(driverIds.filter((n) => Number.isFinite(n) && n > 0))];
  const map = new Map();
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  const [drows] = await pool.query(
    `SELECT driver_id, CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name
     FROM mt_driver WHERE driver_id IN (${ph})`,
    uniq
  );
  for (const d of drows || []) {
    map.set(String(d.driver_id), String(d.full_name || '').trim() || null);
  }
  return map;
}

async function loadErrandOrderRow(orderId) {
  const [[row]] = await errandWibPool.query('SELECT * FROM st_ordernew WHERE order_id = ? LIMIT 1', [orderId]);
  return row || null;
}

async function buildDetailPayloadForOrder(orderId) {
  const row = await loadErrandOrderRow(orderId);
  if (!row) return null;
  const did = orderDriverId(row);
  const driverDetail =
    did != null && did > 0 ? await resolveErrandDriverDetail(errandWibPool, pool, did) : null;
  let merchantRow = null;
  if (row.merchant_id != null && String(row.merchant_id).trim() !== '') {
    const mid = parseInt(String(row.merchant_id), 10);
    if (Number.isFinite(mid)) {
      const mmap = await fetchErrandMerchantsByIds(errandWibPool, [mid]);
      merchantRow = mmap.get(String(mid)) || null;
    }
  }
  let clientRow = null;
  let clientAddressRow = null;
  if (row.client_id != null && String(row.client_id).trim() !== '') {
    const cid = parseInt(String(row.client_id), 10);
    if (Number.isFinite(cid) && cid > 0) {
      const cmap = await fetchErrandClientsByIds(errandWibPool, [cid]);
      clientRow = cmap.get(String(cid)) || null;
      const addrMap = await fetchErrandClientAddressesByClientIds(errandWibPool, [cid]);
      const addrList = addrMap.get(String(cid)) || [];
      clientAddressRow = pickClientAddressRow(row, addrList);
    }
  }
  let latestHistoryStatus = null;
  try {
    const [[hr]] = await errandWibPool.query(
      'SELECT status FROM st_ordernew_history WHERE order_id = ? ORDER BY id DESC LIMIT 1',
      [orderId]
    );
    latestHistoryStatus = hr?.status != null ? String(hr.status).trim() : null;
  } catch (_) {
    latestHistoryStatus = null;
  }
  const [orderDetails, orderHistoryRows] = await Promise.all([
    fetchErrandOrderLineItems(errandWibPool, orderId),
    fetchErrandOrderHistory(errandWibPool, orderId, row),
  ]);
  const payload = buildErrandTaskDetailPayload(
    row,
    driverDetail,
    merchantRow,
    clientRow,
    clientAddressRow,
    latestHistoryStatus,
    orderDetails,
    orderHistoryRows,
    { forRiderApp: true }
  );
  const proofs = await fetchErrandProofsForOrder(errandWibPool, orderId);
  const taskPhotos = proofs.map((p) => ({
    id: p.id,
    task_id: null,
    errand_order_id: orderId,
    photo_name: p.photo_name,
    date_created: p.date_created,
    proof_url: p.proof_url,
  }));
  payload.task_photos = taskPhotos;
  payload.proof_images = proofs.map((p) => p.proof_url).filter(Boolean);
  return payload;
}

async function appendErrandHistory(orderId, statusText) {
  await appendErrandDriverHistory(errandWibPool, orderId, String(statusText || '').trim() || 'updated', '', null, null);
}

/**
 * Append driver timeline row (canonical `status` + optional remarks / geo). Tries common st_ordernew_history layouts.
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 * @param {string} statusCanonical
 * @param {string} [remarks]
 * @param {unknown} [latitude]
 * @param {unknown} [longitude]
 */
async function appendErrandDriverHistory(errandPool, orderId, statusCanonical, remarks, latitude, longitude) {
  const st = String(statusCanonical || '').trim().toLowerCase() || 'updated';
  const rem = remarks != null && String(remarks).trim() ? String(remarks).trim() : '';
  const latRaw = latitude != null && String(latitude).trim() !== '' ? parseFloat(latitude) : NaN;
  const lngRaw = longitude != null && String(longitude).trim() !== '' ? parseFloat(longitude) : NaN;
  const hasGeo = Number.isFinite(latRaw) && Number.isFinite(lngRaw);
  await insertStOrdernewHistoryRow(errandPool, {
    orderId,
    status: st,
    remarks: rem || undefined,
    latitude: hasGeo ? latRaw : undefined,
    longitude: hasGeo ? lngRaw : undefined,
  });
}

/** Optional payment fields on ErrandWib `st_ordernew` (mirrors mt_order update on ChangeTaskStatus). */
async function updateErrandOrderPaymentFields(errandPool, orderId, payment_type, payment_status) {
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
    await errandPool.query(`UPDATE st_ordernew SET ${pieces.join(', ')} WHERE order_id = ?`, vals);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' && /payment_status/i.test(String(e.sqlMessage || ''))) {
      if (pt != null) {
        try {
          await errandPool.query('UPDATE st_ordernew SET payment_type = ? WHERE order_id = ?', [pt, orderId]);
        } catch (_) {
          /* optional */
        }
      }
    } else if (e.code !== 'ER_BAD_FIELD_ERROR') {
      throw e;
    }
  }
  if (ps != null) {
    try {
      await errandPool.query('UPDATE st_ordernew SET order_payment_status = ? WHERE order_id = ?', [ps, orderId]);
    } catch (_) {
      /* column may not exist */
    }
  }
}

router.post('/GetErrandOrders', validateApiKey, resolveDriver, async (req, res) => {
  const date = req.body.date || todayStr();
  const includeUnassigned = truthyIncludeUnassigned(req.body.include_unassigned);
  const driverId = req.driver.id;
  try {
    const flag = includeUnassigned ? 1 : 0;
    const [eRows] = await errandWibPool.query(
      `SELECT * FROM st_ordernew
       WHERE DATE(COALESCE(delivery_date, created_at, date_created)) = ?
         AND (
           driver_id = ?
           OR (? = 1 AND (driver_id IS NULL OR driver_id = 0))
         )
       ORDER BY order_id DESC
       LIMIT 200`,
      [date, driverId, flag]
    );
    const list = eRows || [];
    const driverIds = [
      ...new Set(list.map((r) => r.driver_id).filter((id) => id != null && String(id).trim() !== '')),
    ]
      .map((id) => parseInt(String(id), 10))
      .filter((n) => Number.isFinite(n));
    const errandDriverById = await fetchErrandStDriversByIds(errandWibPool, driverIds);
    await attachErrandDriverGroups(errandWibPool, errandDriverById);
    const needMtNames = driverIds.filter(
      (id) => !errandDriverById.has(String(id)) || !errandDriverById.get(String(id))?.full_name
    );
    const mtDriverNameById = await fetchDriverNameMap(needMtNames);
    const teamIdsForErrand = [
      ...new Set(
        [...errandDriverById.values()]
          .map((v) => v.team_id)
          .filter((tid) => tid != null && Number.isFinite(tid) && tid > 0)
      ),
    ];
    const teamNameById = await fetchMtDriverTeamNamesByIds(pool, teamIdsForErrand);
    const merchantIds = list
      .map((r) => r.merchant_id)
      .filter((id) => id != null && String(id).trim() !== '')
      .map((id) => parseInt(String(id), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const merchantById = await fetchErrandMerchantsByIds(errandWibPool, merchantIds);
    const clientIds = list
      .map((r) => r.client_id)
      .filter((id) => id != null && String(id).trim() !== '')
      .map((id) => parseInt(String(id), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const clientById = await fetchErrandClientsByIds(errandWibPool, clientIds);
    const clientAddressesByClientId = await fetchErrandClientAddressesByClientIds(errandWibPool, clientIds);
    const orderIds = list
      .map((r) => r.order_id)
      .filter((id) => id != null && String(id).trim() !== '')
      .map((id) => parseInt(String(id), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const latestHistoryStatusByOrderId = await fetchErrandLatestHistoryStatusByOrderIds(errandWibPool, orderIds);
    const data = list.map((r) =>
      mapStOrderRowToTaskListRow(
        r,
        errandDriverById,
        mtDriverNameById,
        merchantById,
        clientById,
        clientAddressesByClientId,
        latestHistoryStatusByOrderId,
        teamNameById
      )
    );
    for (const row of data) {
      if (row.order_id != null) {
        const oid = parseInt(String(row.order_id), 10);
        if (Number.isFinite(oid)) {
          try {
            const c = await countErrandProofForOrder(errandWibPool, oid);
            row.proof_photo_count = c;
          } catch (_) {
            row.proof_photo_count = 0;
          }
        }
      }
    }
    return success(res, { data });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return success(res, { data: [] });
    }
    return error(res, e.message || 'Failed to load errand orders');
  }
});

router.post('/GetErrandOrderDetails', validateApiKey, resolveDriver, async (req, res) => {
  const orderId = parseErrandOrderId(req.body);
  if (!orderId) return error(res, 'order_id required (or negative task_id for errand)');
  const driverId = req.driver.id;
  try {
    const row = await loadErrandOrderRow(orderId);
    if (!row) return error(res, 'Order not found');
    const assigned = orderDriverId(row);
    const unassigned = isUnassignedOrder(row);
    if (!unassigned && assigned !== driverId) {
      return error(res, 'Order not available');
    }
    const details = await buildDetailPayloadForOrder(orderId);
    if (!details) return error(res, 'Order not found');
    return success(res, details);
  } catch (e) {
    return error(res, e.message || 'Failed to load order');
  }
});

router.post('/AcceptErrandOrder', validateApiKey, resolveDriver, async (req, res) => {
  const orderId = parseErrandOrderId(req.body);
  if (!orderId) return error(res, 'order_id required');
  const driverId = req.driver.id;
  try {
    let result;
    try {
      [result] = await errandWibPool.query(
        `UPDATE st_ordernew SET driver_id = ?, delivery_status = 'assigned', assigned_at = NOW(), date_modified = NOW()
         WHERE order_id = ? AND (driver_id IS NULL OR driver_id = 0)`,
        [driverId, orderId]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [result] = await errandWibPool.query(
          `UPDATE st_ordernew SET driver_id = ?, delivery_status = 'assigned', date_modified = NOW()
           WHERE order_id = ? AND (driver_id IS NULL OR driver_id = 0)`,
          [driverId, orderId]
        );
      } else {
        throw e;
      }
    }
    if (!result.affectedRows) {
      return error(res, 'Order not available to accept (already assigned or not found)');
    }
    await appendErrandDriverHistory(errandWibPool, orderId, 'assigned', '', null, null);
    const details = await buildDetailPayloadForOrder(orderId);
    try {
      const lbl = await errandOrderNotifyLabel(errandWibPool, orderId);
      const p = errandNotifyFromCanonical(orderId, lbl, 'assigned');
      if (p) notifyAllDashboardAdminsFireAndForget(pool, p);
    } catch (_) {}
    return success(res, details || null);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return error(res, 'Errand orders unavailable');
    }
    return error(res, e.message || 'Accept failed');
  }
});

router.post('/ChangeErrandOrderStatus', validateApiKey, resolveDriver, async (req, res) => {
  const orderId = parseErrandOrderId(req.body);
  if (!orderId) return error(res, 'order_id required');
  const {
    status_raw: bodyStatusRaw,
    reason,
    payment_type,
    payment_status,
    latitude,
    longitude,
    lat,
    lng,
  } = req.body;
  const rawIn = bodyStatusRaw != null ? String(bodyStatusRaw) : '';
  const effectiveRaw = rawIn.trim() !== '' ? rawIn : 'completed';
  const canonical = normalizeIncomingStatusRaw(effectiveRaw);
  if (!canonical) {
    return error(res, 'Invalid status');
  }
  const sNorm = effectiveRaw.trim().toLowerCase();
  const driverId = req.driver.id;
  const latRaw = latitude ?? lat;
  const lngRaw = longitude ?? lng;
  try {
    const row = await loadErrandOrderRow(orderId);
    if (!row) return error(res, 'Order not found');

    if (canonical === 'unassigned') {
      if (orderDriverId(row) !== driverId) {
        return error(res, 'Order not assigned to you');
      }
      let result;
      try {
        [result] = await errandWibPool.query(
          `UPDATE st_ordernew SET driver_id = NULL, delivery_status = ?, date_modified = NOW() WHERE order_id = ? AND driver_id = ?`,
          [canonical, orderId, driverId]
        );
      } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
          [result] = await errandWibPool.query(
            `UPDATE st_ordernew SET driver_id = 0, delivery_status = ? WHERE order_id = ? AND driver_id = ?`,
            [canonical, orderId, driverId]
          );
        } else {
          throw e;
        }
      }
      if (!result.affectedRows) {
        return error(res, 'Update failed');
      }
      await appendErrandDriverHistory(errandWibPool, orderId, canonical, reason, latRaw, lngRaw);
      await updateErrandOrderPaymentFields(errandWibPool, orderId, payment_type, payment_status);
      try {
        const lbl = await errandOrderNotifyLabel(errandWibPool, orderId);
        const p = errandNotifyFromCanonical(orderId, lbl, canonical);
        if (p) notifyAllDashboardAdminsFireAndForget(pool, p);
      } catch (_) {}
      return success(res, null);
    }

    if (orderDriverId(row) !== driverId) {
      return error(res, 'Order not assigned to you');
    }

    const settings = await getDriverSettingsMap();
    const policy = settings.allow_task_successful_when || 'picture_proof';
    const requiresProof = policy === 'picture_proof' && (sNorm === 'successful' || sNorm === 'delivered');
    if (requiresProof) {
      const cnt = await countErrandProofForOrder(errandWibPool, orderId);
      if (!cnt) {
        return error(res, 'Picture proof of delivery is required before marking this order successful');
      }
    }

    let result;
    try {
      [result] = await errandWibPool.query(
        `UPDATE st_ordernew SET delivery_status = ?, date_modified = NOW() WHERE order_id = ? AND driver_id = ?`,
        [canonical, orderId, driverId]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [result] = await errandWibPool.query(
          `UPDATE st_ordernew SET delivery_status = ? WHERE order_id = ? AND driver_id = ?`,
          [canonical, orderId, driverId]
        );
      } else {
        throw e;
      }
    }
    if (!result.affectedRows) {
      return error(res, 'Update failed');
    }
    await appendErrandDriverHistory(errandWibPool, orderId, canonical, reason, latRaw, lngRaw);
    await updateErrandOrderPaymentFields(errandWibPool, orderId, payment_type, payment_status);
    try {
      const lbl = await errandOrderNotifyLabel(errandWibPool, orderId);
      const p = errandNotifyFromCanonical(orderId, lbl, canonical);
      if (p) notifyAllDashboardAdminsFireAndForget(pool, p);
    } catch (_) {}
    return success(res, null);
  } catch (e) {
    return error(res, e.message || 'Status update failed');
  }
});

router.post(
  '/UploadErrandOrderProof',
  errandProofUpload.single('photo'),
  cleanupUploadOnAuthError,
  validateApiKey,
  resolveDriver,
  async (req, res) => {
    if (!req.file) return error(res, 'No file uploaded');
    const orderId = parseErrandOrderId(req.body);
    if (!orderId) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
      return error(res, 'order_id required (or negative errand task_id)');
    }
    const driverId = req.driver.id;
    try {
      const row = await loadErrandOrderRow(orderId);
      if (!row) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (_) {}
        return error(res, 'Order not found');
      }
      if (orderDriverId(row) !== driverId) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (_) {}
        return error(res, 'Order not assigned to you');
      }
      const ext = path.extname(req.file.originalname || '') || '.jpg';
      const newName = `errand_${orderId}_${Date.now()}${ext}`;
      const newPath = path.join(errandProofDir, newName);
      fs.renameSync(req.file.path, newPath);
      let insertId;
      try {
        insertId = await insertErrandProofRow(errandWibPool, orderId, driverId, newName);
      } catch (e) {
        try {
          fs.unlinkSync(newPath);
        } catch (_) {}
        if (e.code === 'ER_NO_SUCH_TABLE') {
          return error(
            res,
            'Proof storage not configured — run WIB-Rider-Backend/sql/st_driver_errand_photo.sql on the ErrandWib database (or legacy sql/wib_errand_driver_proof.sql)'
          );
        }
        return error(res, e.message || 'Failed to save proof');
      }
      const proof_url = buildErrandProofImageUrl(newName);
      return success(res, {
        id: insertId,
        order_id: orderId,
        errand_order_id: orderId,
        photo_name: newName,
        proof_url: proof_url || null,
      });
    } catch (e) {
      if (req.file?.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (_) {}
      }
      return error(res, e.message || 'Upload failed');
    }
  },
  (err, req, res, next) => {
    if (err) {
      if (req.file?.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (_) {}
      }
      return error(res, err.message || 'Upload failed');
    }
    next();
  }
);

module.exports = router;
