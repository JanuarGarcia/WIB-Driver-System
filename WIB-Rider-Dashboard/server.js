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
/** Must be ≥ browser client timeout (see VITE_API_FETCH_TIMEOUT_MS); 15s was cutting off slow /settings, /tasks, etc. */
const API_PROXY_GET_TIMEOUT_MS = Math.max(
  5000,
  parseInt(String(process.env.DASHBOARD_API_PROXY_TIMEOUT_MS || '90000'), 10) || 90000
);

function backendHeaders(req = null) {
  const h = { 'Content-Type': 'application/json' };
  if (ADMIN_SECRET) h['x-admin-key'] = ADMIN_SECRET;
  const token = req && req.headers && req.headers['x-dashboard-token'];
  if (token) h['x-dashboard-token'] = token;
  return h;
}

/** Avoid forwarding cPanel / nginx HTML bodies as JSON `error` (breaks dashboard UI). */
function sanitizeAxiosError(err, fallbackMessage = 'Request failed') {
  const status = err.response?.status || 500;
  let data = err.response?.data;

  const htmlDetected = (str) =>
    typeof str === 'string' &&
    (str.trimStart().startsWith('<') ||
      /<!DOCTYPE\s+html/i.test(str) ||
      (str.length > 200 && /<\s*html\b[\s>]/i.test(str) && /<\/html>/i.test(str)) ||
      (str.length > 200 && /cPanel\s+Login/i.test(str)));

  if (typeof data === 'string' && htmlDetected(data)) {
    data = {
      error:
        status === 401 || status === 403
          ? 'Session expired or not authorized. Please log in again.'
          : 'The API backend returned a web page instead of JSON. Set BACKEND_URL to the Node rider API (not cPanel or the wrong port).',
    };
  } else if (data && typeof data === 'object' && typeof data.error === 'string' && htmlDetected(data.error)) {
    data = {
      ...data,
      error:
        status === 401 || status === 403
          ? 'Session expired or not authorized. Please log in again.'
          : 'Backend returned an HTML error page. Check BACKEND_URL and server logs.',
    };
  }

  if (data == null || typeof data !== 'object') {
    data = { error: err.message || fallbackMessage };
  }
  return { status, data };
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

// Proxy: /upload/* -> BACKEND_URL/upload/* (Express 4: use mount, not * in path)
app.use('/upload', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const subPath = (req.url || '').split('?')[0].replace(/^\//, '') || '';
  if (!subPath) return next();
  const url = `${BACKEND_URL}/upload/${subPath}`;
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

// Proxy: merchant map logos — must not use JSON /api/* handler (<img> has no auth; route is public on backend).
app.get('/api/merchants/public-logo/:filename', async (req, res) => {
  const raw = req.params.filename != null ? String(req.params.filename) : '';
  const safe = encodeURIComponent(raw.split('/').pop() || raw);
  const url = `${BACKEND_URL}/admin/api/merchants/public-logo/${safe}`;
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      return res.status(response.status).end();
    }
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Cache-Control', response.headers['cache-control'] || 'public, max-age=86400');
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
    const { status, data } = sanitizeAxiosError(err, 'Login request failed');
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
    const { status, data } = sanitizeAxiosError(err, 'Auth check failed');
    res.status(status).json(data);
  }
});

/**
 * SSE — must not use the JSON proxy below (axios would buffer until the stream closes = hang / timeout).
 * EventSource uses query ?token=…; forward query + optional session header.
 */
app.get('/api/realtime/stream', async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const url = `${BACKEND_URL}/admin/api/realtime/stream`;
  const headers = { ...backendHeaders(req) };
  delete headers['Content-Type'];
  headers.Accept = 'text/event-stream';
  try {
    const response = await axios.get(url, {
      headers,
      params: req.query,
      responseType: 'stream',
      timeout: 0,
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        response.data.on('data', (c) => chunks.push(c));
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });
      const raw = Buffer.concat(chunks).toString('utf8');
      let data;
      try {
        data = raw ? JSON.parse(raw) : { error: 'Unauthorized' };
      } catch {
        data = { error: raw.slice(0, 200) || 'Upstream error' };
      }
      return res.status(response.status).json(typeof data === 'object' ? data : { error: String(data) });
    }
    const hopByHop = new Set([
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailers',
      'transfer-encoding',
      'upgrade',
    ]);
    for (const [k, v] of Object.entries(response.headers)) {
      if (v == null || v === '') continue;
      const key = String(k).toLowerCase();
      if (hopByHop.has(key)) continue;
      try {
        res.set(k, v);
      } catch (_) {}
    }
    res.status(200);
    response.data.pipe(res);
    const cleanup = () => {
      try {
        response.data.destroy();
      } catch (_) {}
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    response.data.on('error', cleanup);
  } catch (err) {
    const { status, data } = sanitizeAxiosError(err, 'SSE proxy failed');
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
      timeout: API_PROXY_GET_TIMEOUT_MS,
    });
    res.json(response.data);
  } catch (err) {
    const { status, data } = sanitizeAxiosError(err, 'Request failed');
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
    const { status, data } = sanitizeAxiosError(err, 'Request failed');
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
    const { status, data } = sanitizeAxiosError(err, 'Request failed');
    res.status(status).json(data);
  }
});

// Proxy: PUT /api/tasks/:id/status (change status — was missing; otherwise HTML 404 broke JSON parse)
app.put('/api/tasks/:id/status', express.json(), async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const id = req.params.id;
  const url = `${BACKEND_URL}/admin/api/tasks/${encodeURIComponent(id)}/status`;
  try {
    const response = await axios.put(url, req.body, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const { status, data } = sanitizeAxiosError(err, 'Status update failed');
    res.status(status).json(data);
  }
});

// Proxy: PUT /api/tasks/:id (edit task body)
app.put('/api/tasks/:id', express.json(), async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const id = req.params.id;
  const url = `${BACKEND_URL}/admin/api/tasks/${encodeURIComponent(id)}`;
  try {
    const response = await axios.put(url, req.body, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const { status, data } = sanitizeAxiosError(err, 'Update failed');
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
    const { status, data } = sanitizeAxiosError(err, 'Request failed');
    res.status(status).json(data);
  }
});

// Proxy: POST /api/* -> BACKEND_URL/admin/api/* (send-push, teams, task actions, etc.)
app.post('/api/*', express.json({ limit: '2mb' }), async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const subPath = (req.path || '').replace(/^\/api\/?/, '') || '';
  const url = `${BACKEND_URL}/admin/api/${subPath}`;
  try {
    const response = await axios.post(url, req.body !== undefined ? req.body : {}, {
      headers: backendHeaders(req),
      params: req.query,
      timeout: 60000,
    });
    res.status(response.status || 200).json(response.data);
  } catch (err) {
    const { status, data } = sanitizeAxiosError(err, 'Request failed');
    res.status(status).json(data);
  }
});

// Proxy: DELETE /api/* -> BACKEND_URL/admin/api/* (tasks, drivers, teams, errand-orders, …)
// Errand “Delete task” uses DELETE /api/errand-orders/:orderId — without this, requests miss the proxy
// and static/nginx may return index.html (HTML instead of JSON).
app.delete('/api/*', async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const subPath = (req.path || '').replace(/^\/api\/?/, '') || '';
  const url = `${BACKEND_URL}/admin/api/${subPath}`;
  try {
    const response = await axios.delete(url, {
      headers: backendHeaders(req),
      params: req.query,
      timeout: 15000,
    });
    if (response.data !== undefined && response.data !== '') {
      res.status(response.status || 200).json(response.data);
    } else {
      res.status(response.status || 200).json({ ok: true });
    }
  } catch (err) {
    const { status, data } = sanitizeAxiosError(err, 'Delete failed');
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
    const { status, data } = sanitizeAxiosError(err, 'Request failed');
    res.status(status).json(data);
  }
});

// Proxy: PUT /api/* -> BACKEND_URL/admin/api/* (map-merchant-filter, user-preferences, future PUTs)
app.put('/api/*', express.json(), async (req, res) => {
  setNoCache(res);
  res.set('X-Dashboard-Proxy', '1');
  const subPath = (req.path || '').replace(/^\/api\/?/, '') || '';
  const url = `${BACKEND_URL}/admin/api/${subPath}`;
  try {
    const response = await axios.put(url, req.body || {}, {
      headers: backendHeaders(req),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    const { status, data } = sanitizeAxiosError(err, 'Request failed');
    res.status(status).json(data);
  }
});

// Serve React build only (run "npm run build" from repo root first)
const clientBuild = path.join(__dirname, 'client', 'dist');
const fs = require('fs');
if (fs.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/upload')) {
      return res.status(404).type('text').send('Not found');
    }
    res.sendFile(path.join(clientBuild, 'index.html'));
  });
} else {
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/upload')) {
      return res.status(404).type('text').send('Not found');
    }
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
