const riderNotificationService = require('../services/riderNotification.service');

function toDto(n) {
  const d = n.createdAt instanceof Date ? n.createdAt : new Date(n.createdAt);
  return {
    id: String(n.id),
    riderId: String(n.riderId),
    title: n.title,
    message: n.message,
    type: n.type || 'info',
    createdAt: Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(),
  };
}

function list(req, res) {
  try {
    const rows = riderNotificationService.listUnreadForRider(req.riderId);
    res.json({ notifications: rows.map(toDto) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load notifications' });
  }
}

function markViewed(req, res) {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.notificationIds) ? body.notificationIds.map((x) => String(x)) : [];
    const marked = riderNotificationService.markViewedForRider(req.riderId, ids);
    res.json({ ok: true, marked });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to update notifications' });
  }
}

function devCreate(req, res) {
  const allow =
    process.env.NODE_ENV !== 'production' || String(process.env.ALLOW_DEV_NOTIFICATIONS || '').trim() === '1';
  if (!allow) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const row = riderNotificationService.createForRider(req.riderId, req.body || {});
    res.status(201).json({ notification: toDto(row) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to create notification' });
  }
}

module.exports = { list, markViewed, devCreate, toDto };
