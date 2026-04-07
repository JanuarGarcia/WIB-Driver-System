/**
 * Ensures dashboard admin session exists and sets req.riderId for notification routes.
 * Parent admin router must run adminAuth first (sets req.adminUser).
 */

function attachRiderIdFromAdmin(req, res, next) {
  const u = req.adminUser;
  if (!u || u.admin_id == null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.riderId = String(u.admin_id);
  next();
}

module.exports = { attachRiderIdFromAdmin };
