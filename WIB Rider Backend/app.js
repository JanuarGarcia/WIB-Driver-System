require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const driverRoutes = require('./routes/driver');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static uploads for profile photos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Driver API (Flutter app) - base path /driver/api
app.use('/driver/api', driverRoutes);

// Admin API
app.use('/admin/api', adminRoutes);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

module.exports = app;
