'use strict';

const { pool } = require('../config/db');

function parseJsonMaybe(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch (_) {
      return null;
    }
  }
  const s = String(raw).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function pickField(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== '') return obj[k];
  }
  return undefined;
}

function deriveTaskAndOrderIds(jsonResponse) {
  const parsed = parseJsonMaybe(jsonResponse);
  if (!parsed || typeof parsed !== 'object') return {};

  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!root || typeof root !== 'object') return {};

  const payload = root.payload && typeof root.payload === 'object' ? root.payload : null;
  const data = root.data && typeof root.data === 'object' ? root.data : null;
  const sources = [root, payload, data];

  let orderRaw;
  let taskRaw;
  const orderKeys = ['order_id', 'orderId', 'order_no', 'orderNo'];
  const taskKeys = ['task_id', 'taskId', 'mt_driver_task_id'];

  for (const src of sources) {
    if (!src) continue;
    if (orderRaw == null) orderRaw = pickField(src, orderKeys);
    if (taskRaw == null) taskRaw = pickField(src, taskKeys);
  }

  const out = {};
  const orderId = orderRaw != null ? parseInt(String(orderRaw), 10) : NaN;
  const taskId = taskRaw != null ? parseInt(String(taskRaw), 10) : NaN;
  if (Number.isFinite(orderId) && orderId > 0) out.order_id = orderId;
  if (Number.isFinite(taskId) && taskId > 0) out.task_id = taskId;
  return out;
}

function normalizeLimitOffset(limitRaw, offsetRaw) {
  let limit = parseInt(String(limitRaw ?? 20), 10);
  let offset = parseInt(String(offsetRaw ?? 0), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 20;
  if (limit > 100) limit = 100;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

async function listNotifications(clientId, paging) {
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(cid) || cid <= 0) {
    throw new Error('Invalid client_id');
  }

  const { limit, offset } = normalizeLimitOffset(paging?.limit, paging?.offset);

  const [rows] = await pool.query(
    `SELECT
      l.id AS push_id,
      l.push_title,
      l.push_message,
      l.push_type,
      l.date_created,
      COALESCE(l.is_read, 0) AS is_read,
      l.json_response
    FROM mt_mobile2_push_logs l
    WHERE l.client_id = ?
    ORDER BY l.id DESC
    LIMIT ? OFFSET ?`,
    [cid, limit, offset]
  );

  return (rows || []).map((r) => {
    const derived = deriveTaskAndOrderIds(r.json_response);
    return {
      push_id: Number(r.push_id),
      push_title: r.push_title,
      push_message: r.push_message,
      push_type: r.push_type,
      date_created: r.date_created ? new Date(r.date_created).toISOString() : null,
      is_read: Number(r.is_read) === 1 ? 1 : 0,
      ...derived,
    };
  });
}

async function markNotificationRead(clientId, pushId) {
  const cid = parseInt(String(clientId), 10);
  const pid = parseInt(String(pushId), 10);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Invalid client_id');
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('push_id must be numeric');

  await pool.query(
    `UPDATE mt_mobile2_push_logs
     SET is_read = 1, date_modified = NOW()
     WHERE id = ? AND client_id = ?`,
    [pid, cid]
  );
}

async function markAllNotificationsRead(clientId) {
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Invalid client_id');

  const [result] = await pool.query(
    `UPDATE mt_mobile2_push_logs
     SET is_read = 1, date_modified = NOW()
     WHERE client_id = ? AND COALESCE(is_read, 0) <> 1`,
    [cid]
  );

  return { affected_rows: Number(result?.affectedRows || 0) };
}

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
