'use strict';

const { error } = require('../lib/response');
const notificationService = require('../services/mobile2NotificationService');

function authClientId(req) {
  const raw = req.customer && req.customer.client_id != null ? req.customer.client_id : null;
  const cid = parseInt(String(raw), 10);
  return Number.isFinite(cid) && cid > 0 ? cid : null;
}

async function list(req, res) {
  try {
    const clientId = authClientId(req);
    if (!clientId) return error(res, 'Invalid token', 2);

    const details = await notificationService.listNotifications(clientId, {
      limit: req.body?.limit ?? req.query?.limit,
      offset: req.body?.offset ?? req.query?.offset,
    });

    return res.json({ code: 1, msg: 'ok', details });
  } catch (e) {
    console.error('[mobile2.notifications.list] failed', e);
    return error(res, 'Failed to fetch notifications');
  }
}

async function markRead(req, res) {
  try {
    const clientId = authClientId(req);
    if (!clientId) return error(res, 'Invalid token', 2);

    const pushId = parseInt(String(req.body?.push_id ?? ''), 10);
    if (!Number.isFinite(pushId) || pushId <= 0) return error(res, 'push_id is required');

    await notificationService.markNotificationRead(clientId, pushId);
    return res.json({ code: 1, msg: 'ok', details: null });
  } catch (e) {
    console.error('[mobile2.notifications.read] failed', e);
    return error(res, 'Failed to mark notification read');
  }
}

async function markReadAll(req, res) {
  try {
    const clientId = authClientId(req);
    if (!clientId) return error(res, 'Invalid token', 2);

    const details = await notificationService.markAllNotificationsRead(clientId);
    return res.json({ code: 1, msg: 'ok', details });
  } catch (e) {
    console.error('[mobile2.notifications.readAll] failed', e);
    return error(res, 'Failed to mark notifications read');
  }
}

module.exports = { list, markRead, markReadAll };
