require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, databaseNames } = require('./config/db');
const { getUploadsRoot } = require('./lib/uploadsRoot');
const driverRoutes = require('./routes/driver');
const adminRoutes = require('./routes/admin');
const riderDevicesRoutes = require('./routes/riderDevicesRoutes');
const mobile2NotificationsRoutes = require('./routes/mobile2Notifications');

const app = express();

app.use(cors());

// Correlation / request id (helps trace 5xx across proxy + app logs).
app.use((req, res, next) => {
  const incoming =
    (req.headers['x-request-id'] || req.headers['x-correlation-id'] || req.headers['cf-ray'] || '').toString().trim() || null;
  const requestId = incoming || (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsRoot = getUploadsRoot();
// Proof-of-delivery: files referenced by mt_driver_task_photo.photo_name (old rider app + dashboard).
// Newer rows often use uploads/task/; legacy filenames may live in uploads/task_photos/.
const uploadsTaskDir = path.join(uploadsRoot, 'task');
const uploadsTaskPhotosDir = path.join(uploadsRoot, 'task_photos');
// Legacy rider PHP: /upload/driver/<file> — copy old files into uploads/driver/
const uploadsDriverDir = path.join(uploadsRoot, 'driver');
const uploadsErrandDir = path.join(uploadsRoot, 'errand');
[uploadsRoot, uploadsTaskDir, uploadsTaskPhotosDir, uploadsDriverDir, uploadsErrandDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Static uploads for profile photos, certs, etc.
app.use('/uploads', express.static(uploadsRoot));
app.use('/upload/task', express.static(uploadsTaskDir));
app.use('/upload/task', express.static(uploadsTaskPhotosDir));
app.use('/upload/driver', express.static(uploadsDriverDir));
app.use('/upload/errand', express.static(uploadsErrandDir));

// Driver API (Flutter app) - base path /driver/api
app.use('/driver/api', driverRoutes);

// Rider FCM device registry (Flutter → same auth as /driver/api)
app.use('/api/riders', riderDevicesRoutes);
app.use('/api/mobile2', mobile2NotificationsRoutes);

// Admin API
app.use('/admin/api', adminRoutes);

app.get('/health', (req, res) => {
  const deep = String(req.query?.deep || '').trim() === '1';
  if (!deep) {
    return res.json({
      ok: true,
      /** Resolved at process start from DB_NAME (primary pool used by driver login). */
      primary_database: databaseNames.primary,
      request_id: req.requestId,
    });
  }
  pool
    .query('SELECT 1 AS ok')
    .then(() =>
      res.json({
        ok: true,
        primary_database: databaseNames.primary,
        db_ok: true,
        request_id: req.requestId,
      })
    )
    .catch((e) => {
      console.error('[health deep] db error', { requestId: req.requestId, code: e.code, message: e.message || String(e) });
      res.status(503).json({
        ok: false,
        primary_database: databaseNames.primary,
        db_ok: false,
        msg: 'Service unavailable (database)',
        request_id: req.requestId,
      });
    });
});

// Always return JSON for uncaught errors (avoid proxy HTML bodies reaching Flutter app).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const requestId = req?.requestId || null;
  console.error('[unhandled express error]', { requestId, path: req?.path, message: err?.message || String(err) });
  if (res.headersSent) return;
  res
    .status(500)
    .json({ code: 2, msg: 'Server error', details: null, request_id: requestId });
});

module.exports = app;
