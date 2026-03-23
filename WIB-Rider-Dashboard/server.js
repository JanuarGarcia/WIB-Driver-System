/**
 * WIB Rider Dashboard - Node.js
 * Separate app that talks to WIB Rider Backend for task assignment.
 * Run: npm install && npm start  (default port 3001)
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3002;
const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function backendHeaders(req = null) {
  const h = { 'Content-Type': 'application/json' };
  if (ADMIN_SECRET) h['x-admin-key'] = ADMIN_SECRET;
  const token = req && req.headers && req.headers['x-dashboard-token'];
  if (token) h['x-dashboard-token'] = token;
  return h;
}

function setNoCache(res) {
  // Avoid LiteSpeed / intermediary caching for API proxy responses.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
}

// Proxy: GET /uploads/* -> BACKEND_URL/uploads/* (for merchant logos, profile photos, etc.)
app.get('/uploads/*', async (req, res) => {
  const subPath = (req.path || '').replace(/^\/uploads\/?/, '') || '';
  const url = `${BACKEND_URL}/uploads/${subPath}`;
  try {
    const response = await axios.get(url, { responseType: 'stream', timeout: 10000 });
    res.set(response.headers);
    response.data.pipe(res);
  } catch (err) {
    res.status(err.response?.status || 502).end();
  }
});

// Proxy: GET /api/task-photos/:id/image -> backend returns image binary (stream, not JSON)
app.get('/api/task-photos/:id/image', async (req, res) => {
  const id = req.params.id;
  const url = `${BACKEND_URL}/admin/api/task-photos/${id}/image`;
  try {
    const response = await axios.get(url, {
      headers: backendHeaders(),
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Cache-Control', response.headers['cache-control'] || 'private, max-age=3600');
    res.type(contentType).send(Buffer.from(response.data));
  } catch (err) {
    res.status(err.response?.status || 502).end();
  }
});

// Proxy: POST /api/auth/login (no auth required)
app.post('/api/auth/login', express.json(), async (req, res) => {
  setNoCache(res);
  try {
    const response = await axios.post(`${BACKEND_URL}/admin/api/auth/login`, req.body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// Proxy: GET /api/auth/me (requires x-dashboard-token from client)
app.get('/api/auth/me', async (req, res) => {
  setNoCache(res);
  const url = `${BACKEND_URL}/admin/api/auth/me`;
  try {
    const response = await axios.get(url, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// Proxy: GET /api/* -> BACKEND_URL/admin/api/*
app.get('/api/*', async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const subPath = (req.path || '').replace(/^\/api\/?/, '') || '';
  const url = `${BACKEND_URL}/admin/api/${subPath}`;
  try {
    const response = await axios.get(url, {
      headers: backendHeaders(req),
      params: req.query,
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// Proxy: PUT /api/driver-queue/:driverId/remove
app.put('/api/driver-queue/:driverId/remove', express.json(), async (req, res) => {
  setNoCache(res);
  const driverId = req.params.driverId;
  const url = `${BACKEND_URL}/admin/api/driver-queue/${encodeURIComponent(driverId)}/remove`;
  try {
    const response = await axios.put(url, req.body || {}, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// Proxy: PUT /api/tasks/:id/assign
app.put('/api/tasks/:id/assign', express.json(), async (req, res) => {
  setNoCache(res);
  const id = req.params.id;
  const url = `${BACKEND_URL}/admin/api/tasks/${id}/assign`;
  try {
    const response = await axios.put(url, req.body, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// Proxy: POST /api/tasks (create task)
app.post('/api/tasks', express.json(), async (req, res) => {
  setNoCache(res);
  try {
    const response = await axios.post(`${BACKEND_URL}/admin/api/tasks`, req.body, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// Proxy: DELETE /api/tasks/:id (task details delete — was missing; otherwise SPA/HTML broke JSON parse)
app.delete('/api/tasks/:id', async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const id = req.params.id;
  const url = `${BACKEND_URL}/admin/api/tasks/${encodeURIComponent(id)}`;
  try {
    const response = await axios.delete(url, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    if (response.data !== undefined && response.data !== '') {
      res.status(response.status || 200).json(response.data);
    } else {
      res.status(response.status || 200).json({ ok: true });
    }
  } catch (err) {
    const status = err.response?.status || 500;
    let data = err.response?.data;
    if (data != null && typeof data === 'string' && data.trimStart().startsWith('<')) {
      data = { error: 'Backend returned an error page. Check server logs and BACKEND_URL.' };
    }
    if (data == null || typeof data !== 'object') data = { error: err.message || 'Delete failed' };
    res.status(status).json(data);
  }
});

// Proxy: DELETE /api/drivers/:id
app.delete('/api/drivers/:id', async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const id = req.params.id;
  const url = `${BACKEND_URL}/admin/api/drivers/${encodeURIComponent(id)}`;
  try {
    const response = await axios.delete(url, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    if (response.data !== undefined && response.data !== '') {
      res.status(response.status || 200).json(response.data);
    } else {
      res.status(response.status || 200).json({ ok: true });
    }
  } catch (err) {
    const status = err.response?.status || 500;
    let data = err.response?.data;
    if (data != null && typeof data === 'string' && data.trimStart().startsWith('<')) {
      data = { error: 'Backend returned an error page.' };
    }
    if (data == null || typeof data !== 'object') data = { error: err.message || 'Delete failed' };
    res.status(status).json(data);
  }
});

// Proxy: DELETE /api/teams/:id
app.delete('/api/teams/:id', async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const id = req.params.id;
  const url = `${BACKEND_URL}/admin/api/teams/${encodeURIComponent(id)}`;
  try {
    const response = await axios.delete(url, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    if (response.data !== undefined && response.data !== '') {
      res.status(response.status || 200).json(response.data);
    } else {
      res.status(response.status || 200).json({ ok: true });
    }
  } catch (err) {
    const status = err.response?.status || 500;
    let data = err.response?.data;
    if (data != null && typeof data === 'string' && data.trimStart().startsWith('<')) {
      data = { error: 'Backend returned an error page.' };
    }
    if (data == null || typeof data !== 'object') data = { error: err.message || 'Delete failed' };
    res.status(status).json(data);
  }
});

// Proxy: PUT /api/settings
app.put('/api/settings', express.json(), async (req, res) => {
  setNoCache(res);
  try {
    const response = await axios.put(`${BACKEND_URL}/admin/api/settings`, req.body, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// Serve React build only (run "npm run build" from repo root first)
const clientBuild = path.join(__dirname, 'client', 'dist');
const fs = require('fs');
if (fs.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return;
    res.sendFile(path.join(clientBuild, 'index.html'));
  });
} else {
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return;
    res.type('html').send(`
      <!DOCTYPE html><html><head><title>WIB Rider Dashboard</title></head><body>
      <h1>React app not built</h1>
      <p>Run from repo root: <code>npm run build</code> then <code>npm start</code>.</p>
      <p>Or for development: <code>npm run dev:client</code> and open <a href="http://localhost:5173">http://localhost:5173</a>.</p>
      </body></html>
    `);
  });
}

app.listen(PORT, () => {
  console.log(`WIB Rider Dashboard: http://localhost:${PORT}`);
  console.log(`  Backend: ${BACKEND_URL}`);
});
