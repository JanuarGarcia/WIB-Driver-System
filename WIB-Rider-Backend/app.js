require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { databaseNames } = require('./config/db');
const driverRoutes = require('./routes/driver');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsRoot = path.join(__dirname, 'uploads');
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

// Admin API
app.use('/admin/api', adminRoutes);

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    /** Resolved at process start from DB_NAME (primary pool used by driver login). */
    primary_database: databaseNames.primary,
  });
});

module.exports = app;
