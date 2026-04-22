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

function normalizeLimit(limitRaw, fallback = 20) {
  let limit = parseInt(String(limitRaw ?? fallback), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = fallback;
  if (limit > 100) limit = 100;
  return limit;
}

function normalizeAfterPushId(afterPushIdRaw) {
  const n = parseInt(String(afterPushIdRaw ?? 0), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function derivePopupMeta(row) {
  const parsed = parseJsonMaybe(row?.json_response);
  const fallbackTitle = row?.push_title != null ? String(row.push_title) : '';
  const fallbackMessage = row?.push_message != null ? String(row.push_message) : '';
  const fallbackType = row?.push_type != null ? String(row.push_type) : '';

  const sources = [];
  if (parsed && typeof parsed === 'object') {
    sources.push(parsed);
    if (parsed.popup && typeof parsed.popup === 'object') sources.push(parsed.popup);
    if (parsed.data && typeof parsed.data === 'object') sources.push(parsed.data);
    if (parsed.payload && typeof parsed.payload === 'object') sources.push(parsed.payload);
  }

  let enabled = true;
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    if (src.show_popup != null) {
      const v = String(src.show_popup).trim().toLowerCase();
      enabled = v === '1' || v === 'true' || v === 'yes' || v === 'on';
      break;
    }
    if (src.popup_enabled != null) {
      const v = String(src.popup_enabled).trim().toLowerCase();
      enabled = v === '1' || v === 'true' || v === 'yes' || v === 'on';
      break;
    }
  }

  let popupTitleRaw;
  let popupMessageRaw;
  let popupTypeRaw;
  for (const src of sources) {
    if (popupTitleRaw == null) popupTitleRaw = pickField(src, ['popup_title', 'local_notification_title']);
    if (popupMessageRaw == null) popupMessageRaw = pickField(src, ['popup_message', 'local_notification_body']);
    if (popupTypeRaw == null) popupTypeRaw = pickField(src, ['popup_type', 'local_notification_type']);
  }

  const popupTitle =
    popupTitleRaw != null && String(popupTitleRaw).trim() !== ''
      ? String(popupTitleRaw)
      : fallbackTitle;
  const popupMessage =
    popupMessageRaw != null && String(popupMessageRaw).trim() !== ''
      ? String(popupMessageRaw)
      : fallbackMessage;
  const popupType =
    popupTypeRaw != null && String(popupTypeRaw).trim() !== ''
      ? String(popupTypeRaw)
      : fallbackType;

  return {
    show_popup: enabled ? 1 : 0,
    popup_title: popupTitle || fallbackTitle,
    popup_message: popupMessage || fallbackMessage,
    popup_type: popupType || fallbackType,
  };
}

function mapNotificationRow(row) {
  const derived = deriveTaskAndOrderIds(row.json_response);
  const popup = derivePopupMeta(row);
  return {
    push_id: Number(row.push_id),
    push_title: row.push_title,
    push_message: row.push_message,
    push_type: row.push_type,
    date_created: row.date_created ? new Date(row.date_created).toISOString() : null,
    is_read: Number(row.is_read) === 1 ? 1 : 0,
    ...derived,
    ...popup,
  };
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

  return (rows || []).map(mapNotificationRow);
}

async function listNotificationFeed(clientId, paging) {
  const cid = parseInt(String(clientId), 10);
  if (!Number.isFinite(cid) || cid <= 0) {
    throw new Error('Invalid client_id');
  }

  const limit = normalizeLimit(paging?.limit, 20);
  const afterPushId = normalizeAfterPushId(paging?.after_push_id ?? paging?.afterPushId);

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
      AND l.id > ?
    ORDER BY l.id ASC
    LIMIT ?`,
    [cid, afterPushId, limit]
  );

  const items = (rows || []).map(mapNotificationRow);
  const cursor = items.length ? items[items.length - 1].push_id : afterPushId;
  return {
    cursor,
    after_push_id: afterPushId,
    items,
  };
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
  listNotificationFeed,
  markNotificationRead,
  markAllNotificationsRead,
};
