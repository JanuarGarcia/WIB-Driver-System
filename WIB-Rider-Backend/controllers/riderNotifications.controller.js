const riderNotificationService = require('../services/riderNotification.service');
const { pool } = require('../config/db');

function toDto(n) {
  const d = n.createdAt instanceof Date ? n.createdAt : new Date(n.createdAt);
  const createdAtIso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  const rawAct = n.activityAt;
  const a = rawAct instanceof Date ? rawAct : rawAct != null ? new Date(rawAct) : null;
  const activityAtIso =
    a && !Number.isNaN(a.getTime()) ? a.toISOString() : undefined;
  return {
    id: String(n.id),
    riderId: String(n.riderId),
    title: n.title,
    message: n.message,
    type: n.type || 'info',
    createdAt: createdAtIso,
    ...(activityAtIso ? { activityAt: activityAtIso } : {}),
  };
}

async function list(req, res) {
  try {
    const rows = await riderNotificationService.listUnreadForRider(pool, req.riderId);
    res.json({ notifications: rows.map(toDto) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load notifications' });
  }
}

async function markViewed(req, res) {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.notificationIds) ? body.notificationIds.map((x) => String(x)) : [];
    const marked = await riderNotificationService.markViewedForRider(pool, req.riderId, ids);
    res.json({ ok: true, marked });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to update notifications' });
  }
}

async function devCreate(req, res) {
  const allow =
    process.env.NODE_ENV !== 'production' || String(process.env.ALLOW_DEV_NOTIFICATIONS || '').trim() === '1';
  if (!allow) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const row = await riderNotificationService.createForRider(pool, req.riderId, req.body || {});
    res.status(201).json({ notification: toDto(row) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to create notification' });
  }
}

module.exports = { list, markViewed, devCreate, toDto };
