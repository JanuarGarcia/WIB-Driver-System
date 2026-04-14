const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { pool, errandWibPool } = require('../config/db');
const { getUploadsRoot } = require('../lib/uploadsRoot');
const {
  mapStOrderRowToTaskListRow,
  buildErrandTaskDetailPayload,
  fetchErrandOrderLineItems,
  fetchErrandOrderHistory,
  fetchErrandMerchantsByIds,
  fetchErrandClientsByIds,
  fetchErrandClientAddressesByClientIds,
  fetchErrandLatestHistoryStatusByOrderIds,
  pickClientAddressRow,
  fetchErrandStDriversByIds,
  attachErrandDriverGroups,
  fetchMtDriverTeamNamesByIds,
  resolveErrandDriverDetail,
  buildErrandPseudoRowsForAgentDashboard,
  fetchErrandOrderTaskCountsByDriver,
  fetchErrandDriverLocationsForMap,
  resolveErrandHistoryRemarks,
  ST_ORDERNEW_EXCLUDE_ADMIN_DELETED_SQL,
} = require('../lib/errandOrders');
const { normalizeIncomingStatusRaw, CANONICAL: ERRAND_CANONICAL_STATUSES } = require('../lib/errandDriverStatus');
const { success, error } = require('../lib/response');
const { sendPushToDriver, sendPushToAllDrivers, sendPushToDevice, resetFirebase, initFirebase } = require('../services/fcm');
const { fetchTaskProofPhotosWithUrls, buildTaskProofImageUrl, normalizeStoredProofType } = require('../lib/taskProof');
const { fetchErrandProofsForOrder } = require('../lib/errandProof');
const riderNotificationService = require('../services/riderNotification.service');
const { insertStOrdernewHistoryRow } = require('../lib/errandHistoryInsert');
const { enrichOrderDetailsWithSubcategoryAddons } = require('../lib/orderDetailAddons');
const { attachOrderDetailCategories } = require('../lib/orderDetailCategories');
const {
  notifyAllDashboardAdmins,
  notifyAllDashboardAdminsFireAndForget,
  foodTaskNotifyFromStatus,
  errandNotifyFromCanonical,
  formatActorFromAdminUser,
  formatActorFromDriver,
  attachActorToPayload,
} = require('../lib/dashboardRiderNotify');
const { insertMtOrderHistoryRow } = require('../lib/mtOrderHistoryInsert');
const { notifyDashboardAfterMtTaskHistoryRow } = require('../lib/mtTaskStatusDashboardNotify');
const {
  normalizeTimelineNotifyKey,
  milestoneDedupeKeyForTask,
  milestoneDedupeKeyForErrand,
  errandCanonicalToMilestoneCategory,
  classifyTimelineHistoryForDashboardNotify,
} = require('../lib/dashboardTimelineNotifyClassify');
const {
  notifyCustomerRiderAssignedForFoodTaskFireAndForget,
  notifyCustomerFoodTaskStatusPushFireAndForget,
} = require('../lib/customerOrderPushDispatch');
const {
  notifyRiderOrderPushAfterAdminAssignFireAndForget,
  notifyRiderOrderPushAfterTaskStatusFireAndForget,
} = require('../lib/riderOrderPushDispatch');
const { updateMtOrderStatusIfDeliveryComplete } = require('../lib/mtOrderStatusSync');
const { sendCustomerTaskNotify } = require('../lib/sendCustomerTaskMessage');
const { resolveMerchantLogoForApi, merchantLogoSearchDirs } = require('../lib/merchantUploadsLogo');

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// Upload dirs for admin (certificate, profile photo, FCM JSON). UPLOADS_DIR must match app.js static /uploads root.
const uploadsBase = getUploadsRoot();
const certDir = path.join(uploadsBase, 'certificates');
const fcmDir = path.join(uploadsBase, 'fcm');
[uploadsBase, certDir, fcmDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
const storageCert = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, certDir),
  filename: (_req, file, cb) => cb(null, `ios_cert_${Date.now()}${path.extname(file.originalname || '') || '.p12'}`),
});
const storageFcm = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, fcmDir),
  filename: (_req, _file, cb) => cb(null, `service_account_${Date.now()}.json`),
});
const profileDir = path.join(uploadsBase, 'profiles');
const merchantLogoDir = process.env.MERCHANT_LOGOS_DIR
  ? path.resolve(process.env.MERCHANT_LOGOS_DIR)
  : path.join(uploadsBase, 'merchants');
if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
if (!fs.existsSync(merchantLogoDir)) fs.mkdirSync(merchantLogoDir, { recursive: true });

(function warnIfNoMerchantLogoFiles() {
  try {
    const dirs = merchantLogoSearchDirs(merchantLogoDir);
    let n = 0;
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      for (const name of fs.readdirSync(d)) {
        if (/\.(jpe?g|png|gif|webp)$/i.test(name)) n += 1;
      }
    }
    if (n === 0) {
      console.warn(
        `[WIB] Merchant map logos: no image files under ${dirs.join(' | ')}. ` +
          'The repo gitignores uploads/ — copy uploads/merchants to the API server, or set UPLOADS_DIR / MERCHANT_LOGOS_DIR in .env.'
      );
    }
  } catch (e) {
    console.warn('[WIB] Merchant map logos: could not scan logo directories:', e.message || e);
  }
})();
const storageProfile = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, profileDir),
  filename: (_req, file, cb) => cb(null, `driver_${Date.now()}${path.extname(file.originalname || '') || '.jpg'}`),
});
const uploadCert = multer({ storage: storageCert, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadFcm = multer({ storage: storageFcm, limits: { fileSize: 2 * 1024 * 1024 } });
const uploadProfile = multer({
  storage: storageProfile,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif'].some((e) => ext.endsWith(e))) cb(null, true);
    else cb(new Error('Only images allowed'));
  },
});

/** Validate password against stored hash (bcrypt, md5, or plain). */
async function checkPassword(password, stored) {
  const s = (stored || '').trim();
  if (!s) return false;
  if (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$')) {
    return bcrypt.compare(password, s);
  }
  if (/^[a-f0-9]{32}$/i.test(s)) {
    return crypto.createHash('md5').update(password).digest('hex').toLowerCase() === s.toLowerCase();
  }
  return password === s;
}

/** Middleware: require valid x-dashboard-token from mt_admin_user. Sets req.adminUser. */
async function requireDashboardToken(req, res, next) {
  const token = (req.headers['x-dashboard-token'] || '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [[user]] = await pool.query(
      'SELECT admin_id, username, email_address, first_name, last_name, role FROM mt_admin_user WHERE session_token = ? AND (status IS NULL OR status = 1 OR status = ?) LIMIT 1',
      [token, 'active']
    );
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.adminUser = user;
    next();
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.status(401).json({ error: 'Unauthorized' });
    next(e);
  }
}

/**
 * Allow ADMIN_SECRET (x-admin-key) or dashboard session token (mt_admin_user).
 * Prefer validating x-dashboard-token first when present so req.adminUser is set even if the
 * dashboard proxy also forwards x-admin-key (rider notifications and other per-admin routes need it).
 *
 * If a non-empty token is sent but does not match any row, respond 401 — do not fall through to
 * x-admin-key only. Otherwise stale browser tokens + proxy admin key look "logged in" for most
 * routes but break anything that requires req.adminUser (e.g. GET /rider/notifications).
 */
async function adminAuth(req, res, next) {
  const token = (req.headers['x-dashboard-token'] || '').trim();
  if (token) {
    try {
      const [[user]] = await pool.query(
        'SELECT admin_id, username, email_address, first_name, last_name, role FROM mt_admin_user WHERE session_token = ? AND (status IS NULL OR status = 1 OR status = ?) LIMIT 1',
        [token, 'active']
      );
      if (user) {
        req.adminUser = user;
        return next();
      }
      return res.status(401).json({ error: 'Unauthorized' });
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') { /* fall through */ }
      else return next(e);
    }
  }

  const key = req.headers['x-admin-key'] || req.query.admin_key || req.body?.admin_key;
  if (ADMIN_SECRET && key === ADMIN_SECRET) return next();

  return res.status(401).json({ error: 'Unauthorized' });
}

// ---- Auth (no adminAuth): login and me ----
router.post('/auth/login', express.json(), async (req, res) => {
  const { email_or_username, password, remember_me } = req.body || {};
  const login = (email_or_username || '').toString().trim();
  const pwd = (password || '').toString();
  if (!login || !pwd) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT admin_id, username, email_address, password, first_name, last_name, role FROM mt_admin_user
       WHERE (username = ? OR email_address = ?)
       AND (status IS NULL OR status = '' OR status = 0 OR status = 1 OR status = '1' OR status = ?)
       LIMIT 1`,
      [login, login, 'active']
    );
    const user = rows && rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const stored = (user.password || '').trim();
    const ok = await checkPassword(pwd, stored);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const sessionToken = uuidv4();
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || null;
    await pool.query(
      'UPDATE mt_admin_user SET session_token = ?, last_login = NOW(), ip_address = ? WHERE admin_id = ?',
      [sessionToken, ip, user.admin_id]
    );
    return res.json({
      token: sessionToken,
      user: {
        admin_id: user.admin_id,
        username: user.username,
        email_address: user.email_address,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ error: 'mt_admin_user table not found. Set DB_NAME to the database that contains mt_admin_user (e.g. wibdb).' });
    }
    return res.status(500).json({ error: e.message || 'Login failed' });
  }
});

router.get('/auth/me', requireDashboardToken, (req, res) => {
  res.json(req.adminUser);
});

/** EventSource cannot set custom headers in browsers; allow token from query for SSE only. */
async function requireDashboardTokenForSse(req, res, next) {
  const token = (req.headers['x-dashboard-token'] || req.query.token || '').toString().trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [[user]] = await pool.query(
      'SELECT admin_id, username, email_address, first_name, last_name, role FROM mt_admin_user WHERE session_token = ? AND (status IS NULL OR status = 1 OR status = ?) LIMIT 1',
      [token, 'active']
    );
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.adminUser = user;
    return next();
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.status(401).json({ error: 'Unauthorized' });
    return next(e);
  }
}

/**
 * Real-time dashboard stream (SSE): emits lightweight update pings when task-related cursors move.
 * Client keeps existing polling as fallback; this route only accelerates refresh-to-screen latency.
 */
router.get('/realtime/stream', requireDashboardTokenForSse, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const safeWrite = (chunk) => {
    try {
      res.write(chunk);
    } catch (_) {}
  };
  safeWrite(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);

  const dateStr =
    req.query.date != null && String(req.query.date).trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date).trim())
      ? String(req.query.date).trim()
      : null;

  let closed = false;
  let cursorHistory = 0;
  let cursorPhoto = 0;
  let cursorErrand = 0;
  let cursorTask = 0;

  const poll = async () => {
    if (closed) return;
    let nextHistory = cursorHistory;
    let nextPhoto = cursorPhoto;
    let nextErrand = cursorErrand;
    let nextTask = cursorTask;

    try {
      const [[h]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM mt_order_history');
      nextHistory = Number(h?.m) || 0;
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
    try {
      const [[p]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM mt_driver_task_photo');
      nextPhoto = Number(p?.m) || 0;
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
    try {
      if (dateStr) {
        const [[t]] = await pool.query(
          'SELECT COALESCE(MAX(task_id), 0) AS m FROM mt_driver_task WHERE (delivery_date = ? OR DATE(delivery_date) = ?)',
          [dateStr, dateStr]
        );
        nextTask = Number(t?.m) || 0;
      } else {
        const [[t]] = await pool.query('SELECT COALESCE(MAX(task_id), 0) AS m FROM mt_driver_task');
        nextTask = Number(t?.m) || 0;
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
    if (errandWibPool) {
      try {
        const [[eh]] = await errandWibPool.query('SELECT COALESCE(MAX(id), 0) AS m FROM st_ordernew_history');
        nextErrand = Number(eh?.m) || 0;
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }

    const changed =
      nextHistory > cursorHistory ||
      nextPhoto > cursorPhoto ||
      nextErrand > cursorErrand ||
      nextTask > cursorTask;

    if (changed) {
      cursorHistory = nextHistory;
      cursorPhoto = nextPhoto;
      cursorErrand = nextErrand;
      cursorTask = nextTask;
      safeWrite(
        `event: dashboard_update\ndata: ${JSON.stringify({
          ts: Date.now(),
          historyCursor: cursorHistory,
          photoCursor: cursorPhoto,
          errandCursor: cursorErrand,
          taskCursor: cursorTask,
          hasUpdate: true,
        })}\n\n`
      );
    }
  };

  const beatId = setInterval(() => {
    if (!closed) {
      // Comment line keeps some mobile proxies from treating the stream as idle (EventSource ignores it).
      safeWrite(': ping\n\n');
      safeWrite(`event: heartbeat\ndata: ${Date.now()}\n\n`);
    }
  }, 12000);
  const pollId = setInterval(() => {
    poll().catch((e) => {
      safeWrite(`event: error\ndata: ${JSON.stringify({ error: e.message || 'stream error' })}\n\n`);
    });
  }, 2000);

  poll().catch(() => {});

  req.on('close', () => {
    closed = true;
    clearInterval(beatId);
    clearInterval(pollId);
  });
});

/** Same as app GET /health — under /admin/api for load balancers that only probe the API prefix. */
router.get('/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * Merchant map / table logos: <img> cannot send x-dashboard-token, and the dashboard may be on another
 * host than /uploads static. Serve files from uploads/merchants by basename only (no path traversal).
 */
const MERCHANT_PUBLIC_LOGO_EXT = /\.(jpe?g|png|gif|webp)$/i;
router.get('/merchants/public-logo/:filename', (req, res) => {
  try {
    let raw = req.params.filename != null ? String(req.params.filename) : '';
    try {
      raw = decodeURIComponent(raw);
    } catch (_) {
      /* use raw */
    }
    const base = path.basename(String(raw).replace(/\\/g, '/').split('?')[0].split('#')[0]);
    if (!base || !MERCHANT_PUBLIC_LOGO_EXT.test(base)) return res.status(400).end();
    const ext = path.extname(base).toLowerCase();
    const ct =
      ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    for (const dir of merchantLogoSearchDirs(merchantLogoDir)) {
      const fp = path.join(dir, base);
      const root = path.resolve(dir);
      const resolved = path.resolve(fp);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) continue;
      if (!fs.existsSync(resolved)) continue;
      res.set('Cache-Control', 'public, max-age=86400');
      return res.type(ct).sendFile(resolved);
    }
    return res.status(404).end();
  } catch (_) {
    res.status(500).end();
  }
});

router.use(adminAuth);

/**
 * Server-to-server: legacy Yii/PHP (or any backend) after it updates driver_task / order_history.
 * Auth: same as other admin-key routes — header `x-admin-key: <ADMIN_SECRET>`.
 * Body JSON: { task_id, status_raw | status, actor_display_name? , driver_id? }
 * If actor_display_name is omitted, driver_id loads name from mt_driver; else task's assigned driver_id.
 */
router.post('/internal/notify-task-status', express.json(), async (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'ADMIN_SECRET is not configured on this server' });
  }
  const body = req.body || {};
  const taskId = parseInt(body.task_id ?? body.taskId, 10);
  const rawStatus = body.status_raw ?? body.status ?? body.Status;
  const actorFromBody =
    body.actor_display_name != null
      ? String(body.actor_display_name).trim()
      : body.actorDisplayName != null
        ? String(body.actorDisplayName).trim()
        : '';
  const driverIdFromBody = parseInt(String(body.driver_id ?? body.driverId ?? ''), 10);

  if (!Number.isFinite(taskId) || taskId <= 0) {
    return res.status(400).json({ error: 'task_id required' });
  }
  if (rawStatus == null || String(rawStatus).trim() === '') {
    return res.status(400).json({ error: 'status_raw or status required' });
  }

  try {
    const [[trow]] = await pool.query(
      'SELECT task_id, order_id, task_description, driver_id FROM mt_driver_task WHERE task_id = ? LIMIT 1',
      [taskId]
    );
    if (!trow) {
      return res.status(404).json({ error: 'Task not found' });
    }

    let actor = actorFromBody;
    const did = Number.isFinite(driverIdFromBody) && driverIdFromBody > 0 ? driverIdFromBody : trow.driver_id;
    if (!actor && did != null && String(did).trim() !== '' && Number(did) > 0) {
      try {
        const [[drow]] = await pool.query(
          `SELECT driver_id AS id, username,
            CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name
           FROM mt_driver WHERE driver_id = ? LIMIT 1`,
          [did]
        );
        if (drow) actor = formatActorFromDriver(drow);
      } catch (_) {
        /* optional */
      }
    }

    const payload = foodTaskNotifyFromStatus(
      taskId,
      trow.order_id,
      trow.task_description,
      String(rawStatus).trim(),
      actor || undefined
    );
    if (!payload) {
      return res.json({ ok: true, notified: false, reason: 'status_does_not_map_to_notification' });
    }
    const rawNorm = normalizeTimelineNotifyKey(rawStatus);
    const cat =
      payload.type === 'task_accepted'
        ? 'accepted'
        : payload.type === 'ready_pickup'
          ? 'ready_for_pickup'
          : payload.type === 'task_done'
            ? 'successful'
            : rawNorm === 'started'
              ? 'started'
              : rawNorm === 'inprogress'
                ? 'inprogress'
                : '';
    const dedupeKey = milestoneDedupeKeyForTask(taskId, cat || payload.type);
    if (dedupeKey && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, dedupeKey))) {
      return res.json({ ok: true, notified: false, reason: 'deduped', dedupeKey });
    }
    await notifyAllDashboardAdmins(pool, payload);
    return res.json({ ok: true, notified: true });
  } catch (e) {
    console.error('[internal/notify-task-status]', e.message || e);
    return res.status(500).json({ error: e.message || 'Failed to notify' });
  }
});

/** Legacy global key (pre–per-admin prefs). Still read for lazy migration and for admin-key-only API access. */
const DASHBOARD_MAP_MERCHANT_FILTER_KEY = 'dashboard_map_merchant_filter_ids';

let adminUserPreferencesTableEnsured = false;

async function ensureAdminUserPreferencesTable() {
  if (adminUserPreferencesTableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mt_admin_user_preferences (
      admin_id INT NOT NULL PRIMARY KEY,
      map_merchant_filter_ids TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  adminUserPreferencesTableEnsured = true;
}

/** Normalize stored filter to string IDs; drops null/undefined/empty and literal "null"/"undefined". */
function normalizeDashboardMapMerchantIdsInput(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    if (x == null) continue;
    const s = String(x).trim();
    if (!s || s === 'null' || s === 'undefined') continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Parse DB value: string JSON, or driver may return object/array for JSON columns. */
function parseDashboardMapMerchantIdsStored(raw) {
  if (raw == null || raw === '') return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try {
      parsed = JSON.parse(t);
    } catch (_) {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return normalizeDashboardMapMerchantIdsInput(parsed);
}

async function upsertGlobalSettingKey(strValue, key) {
  const v = strValue === null || strValue === undefined ? '' : String(strValue);
  try {
    const [existing] = await pool.query('SELECT 1 FROM settings WHERE `key` = ? LIMIT 1', [key]);
    if (existing.length) {
      await pool.query('UPDATE settings SET value = ? WHERE `key` = ?', [v, key]);
    } else {
      await pool.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', [key, v]);
    }
  } catch (tableErr) {
    if (tableErr.code === 'ER_NO_SUCH_TABLE' || String(tableErr.message || '').includes('settings')) {
      const [existing] = await pool.query('SELECT 1 FROM mt_option WHERE option_name = ? LIMIT 1', [key]);
      if (existing.length) {
        await pool.query('UPDATE mt_option SET option_value = ? WHERE option_name = ?', [v, key]);
      } else {
        await pool.query('INSERT INTO mt_option (merchant_id, option_name, option_value) VALUES (0, ?, ?)', [key, v]);
      }
    } else throw tableErr;
  }
}

/** Filename-style label for the Firebase service account JSON (matches typical downloaded key names). */
function deriveFcmServiceAccountDisplay(jsonStr) {
  try {
    const o = JSON.parse(jsonStr);
    const pid = o.project_id;
    const pkid = o.private_key_id;
    const email = o.client_email || '';
    const m = email.match(/firebase-adminsdk-([^@]+)/);
    const mid = m ? m[1] : '';
    if (pid && pkid && mid) {
      const name = `${pid}-firebase-adminsdk-${mid}-${pkid}.json`;
      return name.length > 80 ? `${name.slice(0, 77)}...` : name;
    }
    if (email) {
      const local = email.split('@')[0];
      const n = `${local}.json`;
      return n.length > 80 ? `${n.slice(0, 77)}...` : n;
    }
    return pid ? `${pid}-service-account.json` : '';
  } catch {
    return '';
  }
}

// ---- Settings (General) - merge `settings` + `mt_option` (`settings` wins on duplicate keys) ----
async function getSettingsMap() {
  let fromOption = {};
  try {
    const [rows] = await pool.query('SELECT option_name AS `key`, option_value AS value FROM mt_option');
    if (rows && rows.length > 0) {
      fromOption = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    }
  } catch (_) {}
  try {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    if (rows && rows.length > 0) {
      const fromSettings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      return { ...fromOption, ...fromSettings };
    }
  } catch (_) {}
  return fromOption;
}

async function handleGetDashboardMapMerchantFilter(req, res) {
  try {
    const adminId = req.adminUser?.admin_id;
    if (adminId != null && adminId !== '') {
      await ensureAdminUserPreferencesTable();
      const [rows] = await pool.query(
        'SELECT map_merchant_filter_ids FROM mt_admin_user_preferences WHERE admin_id = ? LIMIT 1',
        [adminId]
      );
      const row = rows && rows[0];
      if (row && row.map_merchant_filter_ids != null && String(row.map_merchant_filter_ids).trim() !== '') {
        const out = parseDashboardMapMerchantIdsStored(row.map_merchant_filter_ids);
        if (out != null) {
          if (out.length === 0) return res.json({ merchant_ids: [] });
          return res.json({ merchant_ids: out });
        }
      }
      const map = await getSettingsMap();
      const legacyRaw = map[DASHBOARD_MAP_MERCHANT_FILTER_KEY];
      if (legacyRaw != null && String(legacyRaw).trim() !== '') {
        const migrated = parseDashboardMapMerchantIdsStored(legacyRaw);
        if (migrated != null && migrated.length > 0) {
          await pool.query(
            `INSERT INTO mt_admin_user_preferences (admin_id, map_merchant_filter_ids) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE map_merchant_filter_ids = VALUES(map_merchant_filter_ids)`,
            [adminId, JSON.stringify(migrated)]
          );
          return res.json({ merchant_ids: migrated });
        }
      }
      return res.json({ merchant_ids: null });
    }
    const map = await getSettingsMap();
    const raw = map[DASHBOARD_MAP_MERCHANT_FILTER_KEY];
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      return res.json({ merchant_ids: null });
    }
    const out = parseDashboardMapMerchantIdsStored(raw);
    if (out == null) {
      return res.json({ merchant_ids: null });
    }
    if (out.length === 0) {
      return res.json({ merchant_ids: [] });
    }
    return res.json({ merchant_ids: out });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to load map merchant filter' });
  }
}

async function handlePutDashboardMapMerchantFilter(req, res) {
  const raw = req.body?.merchant_ids;
  if (!Array.isArray(raw)) {
    return res.status(400).json({ error: 'merchant_ids must be an array' });
  }
  const normalized = normalizeDashboardMapMerchantIdsInput(raw);
  const jsonStr = JSON.stringify(normalized);
  try {
    const adminId = req.adminUser?.admin_id;
    if (adminId != null && adminId !== '') {
      await ensureAdminUserPreferencesTable();
      await pool.query(
        `INSERT INTO mt_admin_user_preferences (admin_id, map_merchant_filter_ids) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE map_merchant_filter_ids = VALUES(map_merchant_filter_ids)`,
        [adminId, jsonStr]
      );
      return res.json({ ok: true, merchant_ids: normalized });
    }
    await upsertGlobalSettingKey(jsonStr, DASHBOARD_MAP_MERCHANT_FILTER_KEY);
    return res.json({ ok: true, merchant_ids: normalized });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to save map merchant filter' });
  }
}

// ---- Per-dashboard-admin map merchant filter (syncs across devices for that account) ----
router.get('/settings/map-merchant-filter', handleGetDashboardMapMerchantFilter);
router.put('/settings/map-merchant-filter', handlePutDashboardMapMerchantFilter);
/** Same handler — older dashboard bundles may call this path. */
router.get('/user-preferences/map-merchant-filter', handleGetDashboardMapMerchantFilter);
router.put('/user-preferences/map-merchant-filter', handlePutDashboardMapMerchantFilter);

router.get('/settings', async (req, res) => {
  try {
    const map = await getSettingsMap();
    let admin_team_merchant_ids = [];
    let merchant_task_owner_admin_ids = [];
    try {
      if (map.admin_team_merchant_ids && String(map.admin_team_merchant_ids).trim()) {
        admin_team_merchant_ids = JSON.parse(map.admin_team_merchant_ids);
      }
    } catch (_) {}
    try {
      if (map.merchant_task_owner_admin_ids && String(map.merchant_task_owner_admin_ids).trim()) {
        merchant_task_owner_admin_ids = JSON.parse(map.merchant_task_owner_admin_ids);
      }
    } catch (_) {}
    let block_merchant_ids = [];
    try {
      if (map.block_merchant_ids && String(map.block_merchant_ids).trim()) {
        block_merchant_ids = JSON.parse(map.block_merchant_ids);
      }
    } catch (_) {}
    let order_status_accepted = [];
    try {
      if (map.order_status_accepted && String(map.order_status_accepted).trim()) {
        order_status_accepted = JSON.parse(map.order_status_accepted);
      }
    } catch (_) {}
    const apiHashKey = map.driver_api_hash_key || map.api_hash_key || '';
    const envMobileApiUrlRaw = (process.env.MOBILE_API_URL || '').trim();
    const envMobileApiUrl = envMobileApiUrlRaw ? envMobileApiUrlRaw.replace(/\/+$/, '') : '';
    const mobileApiUrl = apiHashKey && String(apiHashKey).trim() ? envMobileApiUrl : '';
    let fcm_service_account_display = '';
    const storedFcmName = map.fcm_service_account_filename != null ? String(map.fcm_service_account_filename).trim() : '';
    if (storedFcmName) {
      fcm_service_account_display = storedFcmName.length > 80 ? `${storedFcmName.slice(0, 77)}...` : storedFcmName;
    } else if (map.fcm_service_account_path && String(map.fcm_service_account_path).trim()) {
      fcm_service_account_display = path.basename(String(map.fcm_service_account_path).trim());
    } else if (map.fcm_service_account_json && String(map.fcm_service_account_json).trim()) {
      fcm_service_account_display = deriveFcmServiceAccountDisplay(map.fcm_service_account_json);
    }
    return res.json({
      website_title: map.website_title || '',
      mobile_api_url: mobileApiUrl,
      api_hash_key: apiHashKey,
      app_default_language: map.app_default_language || 'en',
      language: map.language != null && map.language !== '' ? String(map.language) : (map.app_default_language || 'en'),
      force_default_language: map.force_default_language === '1' ? '1' : '0',
      google_api_key: map.google_api_key || '',
      mapbox_access_token: map.mapbox_access_token || '',
      map_provider: (map.map_provider || 'leaflet').toLowerCase() === 'mapbox' ? 'mapbox' : (map.map_provider || '').toLowerCase() === 'google' ? 'google' : 'leaflet',
      fcm_server_key: map.fcm_server_key || '',
      fcm_service_account_configured: !!(map.fcm_service_account_json && String(map.fcm_service_account_json).trim()),
      fcm_service_account_display,
      allow_all_admin_team_by_merchant: map.allow_all_admin_team_by_merchant || '0',
      set_certain_merchant_admin_team: map.set_certain_merchant_admin_team || '0',
      admin_team_merchant_ids: Array.isArray(admin_team_merchant_ids) ? admin_team_merchant_ids : [],
      task_owner: map.task_owner || 'admin',
      merchant_task_owner_admin_ids: Array.isArray(merchant_task_owner_admin_ids) ? merchant_task_owner_admin_ids : [],
      admin_show_only_admin_task: map.admin_show_only_admin_task || '0',
      do_not_allow_merchant_delete_task: map.do_not_allow_merchant_delete_task || '1',
      merchant_delete_task_days: map.merchant_delete_task_days != null && map.merchant_delete_task_days !== '' ? String(map.merchant_delete_task_days) : '',
      block_merchant_ids: Array.isArray(block_merchant_ids) ? block_merchant_ids : [],
      allow_task_successful_when: map.allow_task_successful_when || 'picture_proof',
      order_status_accepted: Array.isArray(order_status_accepted) ? order_status_accepted : [],
      order_status_cancel: map.order_status_cancel || 'Cancel',
      delivery_time: map.delivery_time != null && map.delivery_time !== '' ? String(map.delivery_time) : '',
      hide_total_order_amount: map.hide_total_order_amount || '0',
      app_name: map.app_name != null && map.app_name !== '' ? String(map.app_name) : (map.website_title || 'WIB Rider'),
      send_push_only_online_driver: map.send_push_only_online_driver || '0',
      enabled_notes: map.enabled_notes || '1',
      enabled_signature: map.enabled_signature || '0',
      mandatory_signature: map.mandatory_signature || '0',
      enabled_signup: map.enabled_signup || '0',
      enabled_add_photo_take_picture: map.enabled_add_photo_take_picture || '1',
      enabled_resize_picture: map.enabled_resize_picture || '1',
      resize_picture_width: map.resize_picture_width != null && map.resize_picture_width !== '' ? String(map.resize_picture_width) : '500',
      resize_picture_height: map.resize_picture_height != null && map.resize_picture_height !== '' ? String(map.resize_picture_height) : '600',
      device_vibration: map.device_vibration != null && map.device_vibration !== '' ? String(map.device_vibration) : '3000',
      signup_status: map.signup_status || 'active',
      signup_notification_emails: map.signup_notification_emails != null ? String(map.signup_notification_emails) : '',
      localize_calendar_language: map.localize_calendar_language || 'en',
      driver_tracking_option: map.driver_tracking_option || '1',
      records_driver_location: map.records_driver_location || '0',
      disabled_tracking: map.disabled_tracking || '0',
      track_interval: map.track_interval != null && map.track_interval !== '' ? String(map.track_interval) : '10',
      task_critical_options_enabled: map.task_critical_options_enabled || '0',
      task_critical_options_minutes: map.task_critical_options_minutes != null && map.task_critical_options_minutes !== '' ? String(map.task_critical_options_minutes) : '5',
      privacy_policy_link: map.privacy_policy_link != null ? String(map.privacy_policy_link) : '',
      default_map_country: map.default_map_country != null ? String(map.default_map_country) : 'ph',
      disable_activity_tracking: map.disable_activity_tracking || '0',
      activity_refresh_interval: map.activity_refresh_interval != null && map.activity_refresh_interval !== '' ? String(map.activity_refresh_interval) : '60',
      driver_activity_refresh: map.driver_activity_refresh || '1',
      auto_geocode_address: map.auto_geocode_address || '0',
      include_offline_drivers_on_map: map.include_offline_drivers_on_map !== '0' ? '1' : '0',
      hide_pickup_tasks: map.hide_pickup_tasks || '0',
      hide_delivery_tasks: map.hide_delivery_tasks || '0',
      hide_successful_tasks: map.hide_successful_tasks || '0',
      google_map_style: map.google_map_style != null ? String(map.google_map_style) : '',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to load settings' });
  }
});

router.put('/settings', async (req, res) => {
  const body = req.body || {};
  const {
    website_title, mobile_api_url, api_hash_key, app_default_language, language, force_default_language,
    google_api_key, mapbox_access_token, map_provider, fcm_server_key, fcm_service_account_json, fcm_service_account_filename,
    allow_all_admin_team_by_merchant, set_certain_merchant_admin_team, admin_team_merchant_ids,
    task_owner, merchant_task_owner_admin_ids, admin_show_only_admin_task,
    do_not_allow_merchant_delete_task, merchant_delete_task_days,
    block_merchant_ids, allow_task_successful_when,
    order_status_accepted, order_status_cancel, delivery_time, hide_total_order_amount,
    app_name, send_push_only_online_driver, enabled_notes, enabled_signature, mandatory_signature,
    enabled_signup, enabled_add_photo_take_picture, enabled_resize_picture,
    resize_picture_width, resize_picture_height, device_vibration,
    signup_status, signup_notification_emails, localize_calendar_language,
    driver_tracking_option, records_driver_location, disabled_tracking, track_interval,
    task_critical_options_enabled, task_critical_options_minutes, privacy_policy_link,
    default_map_country, disable_activity_tracking, activity_refresh_interval, driver_activity_refresh,
    auto_geocode_address, include_offline_drivers_on_map, hide_pickup_tasks, hide_delivery_tasks, hide_successful_tasks, google_map_style,
  } = body;
  const raw = typeof map_provider === 'string' ? map_provider.trim().toLowerCase() : '';
  const normalizedMapProvider = raw === 'mapbox' ? 'mapbox' : raw === 'google' ? 'google' : 'leaflet';
  const jsonOr = (val, def) => (val !== undefined && val !== null ? (Array.isArray(val) ? JSON.stringify(val) : String(val)) : def);
  const updates = [
    [website_title, 'website_title'],
    // mobile_api_url is read-only; derive from env (MOBILE_API_URL) instead of DB
    [api_hash_key, 'driver_api_hash_key'],
    [app_default_language, 'app_default_language'],
    [language !== undefined && language !== null ? String(language) : undefined, 'language'],
    [force_default_language === true || force_default_language === '1' ? '1' : (force_default_language === false || force_default_language === '0' ? '0' : undefined), 'force_default_language'],
    [google_api_key, 'google_api_key'],
    [mapbox_access_token, 'mapbox_access_token'],
    [normalizedMapProvider, 'map_provider'],
    [fcm_server_key, 'fcm_server_key'],
    [fcm_service_account_json, 'fcm_service_account_json'],
    [
      fcm_service_account_json !== undefined && fcm_service_account_json !== null && String(fcm_service_account_json).trim() !== ''
        ? (fcm_service_account_filename !== undefined && fcm_service_account_filename !== null ? String(fcm_service_account_filename).trim() : '')
        : undefined,
      'fcm_service_account_filename',
    ],
    [allow_all_admin_team_by_merchant === true || allow_all_admin_team_by_merchant === '1' ? '1' : (allow_all_admin_team_by_merchant === false || allow_all_admin_team_by_merchant === '0' ? '0' : undefined), 'allow_all_admin_team_by_merchant'],
    [set_certain_merchant_admin_team === true || set_certain_merchant_admin_team === '1' ? '1' : (set_certain_merchant_admin_team === false || set_certain_merchant_admin_team === '0' ? '0' : undefined), 'set_certain_merchant_admin_team'],
    [jsonOr(admin_team_merchant_ids, null), 'admin_team_merchant_ids'],
    [task_owner, 'task_owner'],
    [jsonOr(merchant_task_owner_admin_ids, null), 'merchant_task_owner_admin_ids'],
    [admin_show_only_admin_task === true || admin_show_only_admin_task === '1' ? '1' : (admin_show_only_admin_task === false || admin_show_only_admin_task === '0' ? '0' : undefined), 'admin_show_only_admin_task'],
    [do_not_allow_merchant_delete_task === true || do_not_allow_merchant_delete_task === '1' ? '1' : (do_not_allow_merchant_delete_task === false || do_not_allow_merchant_delete_task === '0' ? '0' : undefined), 'do_not_allow_merchant_delete_task'],
    [merchant_delete_task_days !== undefined && merchant_delete_task_days !== null ? String(merchant_delete_task_days) : undefined, 'merchant_delete_task_days'],
    [jsonOr(block_merchant_ids, null), 'block_merchant_ids'],
    [allow_task_successful_when, 'allow_task_successful_when'],
    [jsonOr(order_status_accepted, null), 'order_status_accepted'],
    [order_status_cancel, 'order_status_cancel'],
    [delivery_time !== undefined && delivery_time !== null ? String(delivery_time) : undefined, 'delivery_time'],
    [hide_total_order_amount === true || hide_total_order_amount === '1' ? '1' : (hide_total_order_amount === false || hide_total_order_amount === '0' ? '0' : undefined), 'hide_total_order_amount'],
    [app_name, 'app_name'],
    [send_push_only_online_driver === true || send_push_only_online_driver === '1' ? '1' : (send_push_only_online_driver === false || send_push_only_online_driver === '0' ? '0' : undefined), 'send_push_only_online_driver'],
    [enabled_notes === true || enabled_notes === '1' ? '1' : (enabled_notes === false || enabled_notes === '0' ? '0' : undefined), 'enabled_notes'],
    [enabled_signature === true || enabled_signature === '1' ? '1' : (enabled_signature === false || enabled_signature === '0' ? '0' : undefined), 'enabled_signature'],
    [mandatory_signature === true || mandatory_signature === '1' ? '1' : (mandatory_signature === false || mandatory_signature === '0' ? '0' : undefined), 'mandatory_signature'],
    [enabled_signup === true || enabled_signup === '1' ? '1' : (enabled_signup === false || enabled_signup === '0' ? '0' : undefined), 'enabled_signup'],
    [enabled_add_photo_take_picture === true || enabled_add_photo_take_picture === '1' ? '1' : (enabled_add_photo_take_picture === false || enabled_add_photo_take_picture === '0' ? '0' : undefined), 'enabled_add_photo_take_picture'],
    [enabled_resize_picture === true || enabled_resize_picture === '1' ? '1' : (enabled_resize_picture === false || enabled_resize_picture === '0' ? '0' : undefined), 'enabled_resize_picture'],
    [resize_picture_width !== undefined && resize_picture_width !== null ? String(resize_picture_width) : undefined, 'resize_picture_width'],
    [resize_picture_height !== undefined && resize_picture_height !== null ? String(resize_picture_height) : undefined, 'resize_picture_height'],
    [device_vibration !== undefined && device_vibration !== null ? String(device_vibration) : undefined, 'device_vibration'],
    [signup_status, 'signup_status'],
    [signup_notification_emails !== undefined && signup_notification_emails !== null ? String(signup_notification_emails) : undefined, 'signup_notification_emails'],
    [localize_calendar_language, 'localize_calendar_language'],
    [driver_tracking_option === '2' ? '2' : '1', 'driver_tracking_option'],
    [records_driver_location === true || records_driver_location === '1' ? '1' : (records_driver_location === false || records_driver_location === '0' ? '0' : undefined), 'records_driver_location'],
    [disabled_tracking === true || disabled_tracking === '1' ? '1' : (disabled_tracking === false || disabled_tracking === '0' ? '0' : undefined), 'disabled_tracking'],
    [track_interval !== undefined && track_interval !== null ? String(track_interval) : undefined, 'track_interval'],
    [task_critical_options_enabled === true || task_critical_options_enabled === '1' ? '1' : (task_critical_options_enabled === false || task_critical_options_enabled === '0' ? '0' : undefined), 'task_critical_options_enabled'],
    [task_critical_options_minutes !== undefined && task_critical_options_minutes !== null ? String(task_critical_options_minutes) : undefined, 'task_critical_options_minutes'],
    [privacy_policy_link !== undefined && privacy_policy_link !== null ? String(privacy_policy_link) : undefined, 'privacy_policy_link'],
    [default_map_country !== undefined && default_map_country !== null ? String(default_map_country) : undefined, 'default_map_country'],
    [disable_activity_tracking === true || disable_activity_tracking === '1' ? '1' : (disable_activity_tracking === false || disable_activity_tracking === '0' ? '0' : undefined), 'disable_activity_tracking'],
    [activity_refresh_interval !== undefined && activity_refresh_interval !== null ? String(activity_refresh_interval) : undefined, 'activity_refresh_interval'],
    [driver_activity_refresh === true || driver_activity_refresh === '1' ? '1' : (driver_activity_refresh === false || driver_activity_refresh === '0' ? '0' : undefined), 'driver_activity_refresh'],
    [auto_geocode_address === true || auto_geocode_address === '1' ? '1' : (auto_geocode_address === false || auto_geocode_address === '0' ? '0' : undefined), 'auto_geocode_address'],
    [include_offline_drivers_on_map === true || include_offline_drivers_on_map === '1' ? '1' : (include_offline_drivers_on_map === false || include_offline_drivers_on_map === '0' ? '0' : undefined), 'include_offline_drivers_on_map'],
    [hide_pickup_tasks === true || hide_pickup_tasks === '1' ? '1' : (hide_pickup_tasks === false || hide_pickup_tasks === '0' ? '0' : undefined), 'hide_pickup_tasks'],
    [hide_delivery_tasks === true || hide_delivery_tasks === '1' ? '1' : (hide_delivery_tasks === false || hide_delivery_tasks === '0' ? '0' : undefined), 'hide_delivery_tasks'],
    [hide_successful_tasks === true || hide_successful_tasks === '1' ? '1' : (hide_successful_tasks === false || hide_successful_tasks === '0' ? '0' : undefined), 'hide_successful_tasks'],
    [google_map_style !== undefined && google_map_style !== null ? String(google_map_style) : undefined, 'google_map_style'],
  ].filter(([v]) => v !== undefined && v !== null);
  try {
    for (const [value, key] of updates) {
      const strValue = value === null || value === undefined ? '' : String(value);
      try {
        const [existing] = await pool.query('SELECT 1 FROM settings WHERE `key` = ? LIMIT 1', [key]);
        if (existing.length) {
          await pool.query('UPDATE settings SET value = ? WHERE `key` = ?', [strValue, key]);
        } else {
          await pool.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', [key, strValue]);
        }
      } catch (tableErr) {
        if (tableErr.code === 'ER_NO_SUCH_TABLE' || String(tableErr.message || '').includes('settings')) {
          const [existing] = await pool.query('SELECT 1 FROM mt_option WHERE option_name = ? LIMIT 1', [key]);
          if (existing.length) {
            await pool.query('UPDATE mt_option SET option_value = ? WHERE option_name = ?', [strValue, key]);
          } else {
            await pool.query('INSERT INTO mt_option (merchant_id, option_name, option_value) VALUES (0, ?, ?)', [key, strValue]);
          }
        } else throw tableErr;
      }
    }
    if (updates.some(([, key]) => key === 'fcm_service_account_json')) {
      await resetFirebase();
      await initFirebase();
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to save settings' });
  }
});

// ---- Driver active/offline by stats (driver_tracking_options 1 or 2) ----
const ONLINE_MIN_OPT1 = 10;
const OFFLINE_MIN_OPT1 = 11;
const ONLINE_MIN_OPT2 = 30;
const OFFLINE_MIN_OPT2 = 31;
const LOST_CONNECTION_MIN_OPT1 = 6;
const LOST_CONNECTION_MIN_OPT2 = 60;

function lastSeenText(dateVal) {
  if (!dateVal) return '—';
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return '—';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)} day(s) ago`;
  return d.toLocaleDateString();
}

function buildAgentDashboardFilterClause(filters) {
  const { team_id, driver_name } = filters;
  const statusClause =
    " AND (LOWER(TRIM(COALESCE(NULLIF(TRIM(d.status), ''), 'active'))) = 'active')";
  let filterClause = statusClause;
  const params = [];
  if (team_id != null && team_id !== '' && Number.isFinite(Number(team_id))) {
    filterClause += ' AND d.team_id = ?';
    params.push(team_id);
  }
  if (driver_name != null && String(driver_name).trim() !== '') {
    filterClause += " AND (CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) LIKE ? OR d.first_name LIKE ? OR d.last_name LIKE ?)";
    const like = `%${String(driver_name).trim()}%`;
    params.push(like, like, like);
  }
  return { filterClause, params };
}

/**
 * Same driver universe as `/drivers` (join team, profile fields), scoped by active status + optional team/name.
 * Connection + duty are derived in mapDriverRowToAgentDriver (not via separate SQL buckets).
 */
async function fetchDriverRowsForAgentDashboard(filters) {
  const { filterClause, params } = buildAgentDashboardFilterClause(filters);
  const orderClause = ' ORDER BY d.first_name, d.last_name';
  const fromJoin = 'FROM mt_driver d LEFT JOIN mt_driver_team t ON d.team_id = t.team_id';

  const queries = [
    () =>
      pool.query(
        `SELECT 
          d.driver_id,
          d.username,
          d.first_name,
          d.last_name,
          CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
          d.phone,
          d.on_duty,
          d.team_id,
          t.team_name,
          d.email,
          COALESCE(d.transport_description, d.licence_plate, '') AS vehicle,
          COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
          COALESCE(d.last_login, d.date_modified) AS status_updated_at,
          d.last_login,
          d.last_online,
          d.location_lat,
          d.location_lng,
          d.user_type,
          d.user_id,
          d.device_platform,
          d.device_type
        ${fromJoin}
        WHERE 1=1${filterClause}${orderClause}`,
        params
      ),
    () =>
      pool.query(
        `SELECT 
          d.driver_id,
          d.username,
          d.first_name,
          d.last_name,
          CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
          d.phone,
          d.on_duty,
          d.team_id,
          t.team_name,
          d.email,
          COALESCE(d.transport_description, d.licence_plate, '') AS vehicle,
          COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
          d.last_login AS status_updated_at,
          d.last_login,
          d.location_lat,
          d.location_lng,
          d.user_type,
          d.user_id,
          d.device_platform,
          d.device_type
        ${fromJoin}
        WHERE 1=1${filterClause}${orderClause}`,
        params
      ),
    () =>
      pool.query(
        `SELECT 
          d.driver_id,
          d.username,
          d.first_name,
          d.last_name,
          CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
          d.phone,
          d.on_duty,
          d.team_id,
          t.team_name,
          d.email,
          COALESCE(d.transport_description, d.licence_plate, '') AS vehicle,
          COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
          d.date_modified AS status_updated_at,
          d.last_login,
          d.location_lat,
          d.location_lng,
          d.user_type,
          d.user_id,
          d.device_platform,
          d.device_type
        ${fromJoin}
        WHERE 1=1${filterClause}${orderClause}`,
        params
      ),
    () =>
      pool.query(
        `SELECT 
          d.driver_id,
          d.username,
          d.first_name,
          d.last_name,
          CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
          d.phone,
          d.on_duty,
          d.team_id,
          t.team_name,
          COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
          d.last_login,
          d.location_lat,
          d.location_lng,
          d.device_platform,
          d.device_type
        ${fromJoin}
        WHERE 1=1${filterClause}${orderClause}`,
        params
      ),
    () =>
      pool.query(
        `SELECT 
          d.driver_id,
          d.username,
          d.first_name,
          d.last_name,
          CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
          d.phone,
          d.on_duty,
          d.team_id,
          COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
          d.last_login,
          d.device_platform,
          d.device_type
        FROM mt_driver d
        LEFT JOIN mt_driver_team t ON d.team_id = t.team_id
        WHERE 1=1${filterClause}${orderClause}`,
        params
      ),
  ];

  for (const run of queries) {
    try {
      const [r] = await run();
      const rows = r || [];
      return rows.map((row) => ({
        ...row,
        last_online:
          row.last_online != null
            ? row.last_online
            : row.last_login
              ? Math.floor(new Date(row.last_login).getTime() / 1000)
              : null,
      }));
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  const { team_id, driver_name } = filters;
  const statusClause =
    " AND (LOWER(TRIM(COALESCE(NULLIF(TRIM(d.status), ''), 'active'))) = 'active')";
  const totalParams = [];
  let where = ` WHERE 1=1${statusClause}`;
  if (team_id != null && team_id !== '' && Number.isFinite(Number(team_id))) {
    where += ' AND d.team_id = ?';
    totalParams.push(team_id);
  }
  if (driver_name != null && String(driver_name).trim() !== '') {
    where +=
      " AND (CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) LIKE ? OR d.first_name LIKE ? OR d.last_name LIKE ?)";
    const like = `%${String(driver_name).trim()}%`;
    totalParams.push(like, like, like);
  }
  const orderFallback = ' ORDER BY d.first_name, d.last_name';
  try {
    const [r] = await pool.query(
      `SELECT d.driver_id, d.username, d.first_name, d.last_name, d.phone, d.on_duty, d.last_login, d.team_id,
        COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status
      FROM mt_driver d${where}${orderFallback}`,
      totalParams
    );
    return (r || []).map((row) => ({
      ...row,
      full_name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null,
      team_name: null,
      email: null,
      vehicle: null,
      status_updated_at: row.last_login,
      location_lat: null,
      location_lng: null,
      user_type: null,
      user_id: null,
      device_platform: null,
      device_type: null,
      last_online: row.last_login ? Math.floor(new Date(row.last_login).getTime() / 1000) : null,
    }));
  } catch (eLast) {
    if (eLast.code === 'ER_BAD_FIELD_ERROR') {
      const [r2] = await pool.query(
        `SELECT d.driver_id, d.first_name, d.last_name, d.phone, d.on_duty, d.team_id,
          COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status
        FROM mt_driver d${where}${orderFallback}`,
        totalParams
      );
      return (r2 || []).map((row) => ({
        ...row,
        username: null,
        full_name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null,
        team_name: null,
        email: null,
        vehicle: null,
        status_updated_at: null,
        last_login: null,
        location_lat: null,
        location_lng: null,
        user_type: null,
        user_id: null,
        device_platform: null,
        device_type: null,
        last_online: null,
      }));
    }
    throw eLast;
  }
}

function mapDriverRowToAgentDriver(r, dateOnly, trackingType, taskCountByDriver, nowSec) {
  const type = parseInt(trackingType, 10) === 2 ? 2 : 1;
  const lostThresholdSec1 = LOST_CONNECTION_MIN_OPT1 * 60;
  const lostThresholdSec2 = LOST_CONNECTION_MIN_OPT2 * 60;

  const lastLogin = r.last_login;
  const lastLoginSec = lastLogin ? Math.floor(new Date(lastLogin).getTime() / 1000) : 0;
  const lastOnlineVal = r.last_online != null ? parseInt(r.last_online, 10) : lastLoginSec;
  const onDuty = Number(r.on_duty) === 1;
  const isOnlineLegacy =
    type === 1
      ? onDuty &&
        lastLogin &&
        new Date(lastLogin).toISOString().slice(0, 10) === dateOnly &&
        lastOnlineVal >= nowSec - ONLINE_MIN_OPT1 * 60
      : onDuty;
  const isOnlineNum = isOnlineLegacy ? 1 : 2;
  const lastActivitySec = type === 1 ? lastOnlineVal : lastLoginSec;
  const lostThreshold = type === 1 ? lostThresholdSec1 : lostThresholdSec2;
  const onlineStatus = lastActivitySec >= nowSec - lostThreshold ? 'online' : 'lost_connection';
  const connectionStatus = onlineStatus === 'online' ? 'Online' : 'Connection Lost';

  const fullName =
    (r.full_name && String(r.full_name).trim()) ||
    [r.first_name, r.last_name].filter(Boolean).join(' ').trim() ||
    null;

  const out = {
    driver_id: r.driver_id,
    id: r.driver_id,
    username: r.username ?? null,
    first_name: r.first_name,
    last_name: r.last_name,
    full_name: fullName,
    phone: r.phone,
    on_duty: r.on_duty,
    status: r.status ?? 'active',
    status_updated_at: r.status_updated_at ?? null,
    team_id: r.team_id,
    team_name: r.team_name ?? null,
    email: r.email ?? null,
    vehicle: r.vehicle ?? null,
    last_login: r.last_login,
    last_online: r.last_online,
    location_lat: r.location_lat,
    location_lng: r.location_lng,
    user_type: r.user_type,
    user_id: r.user_id,
    is_online: isOnlineNum,
    online_status: onlineStatus,
    connection_status: connectionStatus,
    last_seen: lastSeenText(lastLogin),
    total_task: taskCountByDriver[r.driver_id] ?? 0,
    device: r.device_platform || r.device_type || null,
    platform: (r.device_platform || r.device_type || 'android').toString().toLowerCase(),
  };
  if (r.driver_source === 'errand') out.driver_source = 'errand';
  return out;
}

/**
 * Unified agent panel payload: one driver list (like `/drivers` + telemetry), split for counts.
 * - total: all active-account drivers for filters
 * - active: on duty + live connection (online_status === 'online')
 * - offline: all others (includes on duty + lost connection)
 */
async function buildAgentDashboardDetails(transactionDate, trackingType, filters) {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const dateOnly = (transactionDate || now.toISOString().slice(0, 10)).slice(0, 10);

  let rows = await fetchDriverRowsForAgentDashboard(filters);
  const noTeamFilter = filters.team_id == null || filters.team_id === '';
  if (noTeamFilter && errandWibPool) {
    try {
      const errPseudo = await buildErrandPseudoRowsForAgentDashboard(errandWibPool, filters);
      const mtIdSet = new Set((rows || []).map((r) => String(r.driver_id)));
      const extra = errPseudo.filter((r) => !mtIdSet.has(String(r.driver_id)));
      rows = [...(rows || []), ...extra];
    } catch (_) {
      /* optional */
    }
  }

  const mtDriverIds = (rows || []).filter((r) => r.driver_source !== 'errand').map((r) => r.driver_id).filter(Boolean);
  const errDriverIds = (rows || []).filter((r) => r.driver_source === 'errand').map((r) => r.driver_id).filter(Boolean);
  const taskCountByDriver = {};
  if (mtDriverIds.length > 0) {
    try {
      const placeholders = mtDriverIds.map(() => '?').join(',');
      const [taskRows] = await pool.query(
        `SELECT driver_id, COUNT(*) AS cnt FROM mt_driver_task WHERE driver_id IN (${placeholders}) AND (delivery_date = ? OR DATE(delivery_date) = ?) GROUP BY driver_id`,
        [...mtDriverIds, dateOnly, dateOnly]
      );
      for (const tr of taskRows || []) taskCountByDriver[tr.driver_id] = tr.cnt;
    } catch (_) {}
  }
  if (errandWibPool && errDriverIds.length > 0) {
    try {
      const ec = await fetchErrandOrderTaskCountsByDriver(errandWibPool, errDriverIds, dateOnly);
      for (const [k, v] of Object.entries(ec)) {
        taskCountByDriver[Number(k)] = v;
      }
    } catch (_) {}
  }

  const enriched = (rows || []).map((r) =>
    mapDriverRowToAgentDriver(r, dateOnly, trackingType, taskCountByDriver, nowSec)
  );

  const isPanelOnline = (d) => Number(d.on_duty) === 1 && d.online_status === 'online';
  const active = enriched.filter(isPanelOnline);
  const offline = enriched.filter((d) => !isPanelOnline(d));

  return { active, offline, total: enriched };
}

router.get('/driver/agent-dashboard', async (req, res) => {
  try {
    const map = await getSettingsMap();
    const trackingType = map.driver_tracking_option === '2' ? '2' : '1';
    const date = (req.query.date || req.body?.date || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
    const team_id = req.query.team_id != null && req.query.team_id !== '' ? req.query.team_id : (req.body?.team_id ?? null);
    const agent_name = (req.query.agent_name || req.body?.agent_name || '').toString().trim();

    const filters = { team_id: team_id != null && team_id !== '' ? team_id : null, driver_name: agent_name || null };

    const { active, offline, total } = await buildAgentDashboardDetails(date, trackingType, filters);

    return res.json({
      details: { active, offline, total },
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ details: { active: [], offline: [], total: [] } });
    }
    return res.status(500).json({ error: e.message || 'Failed to load agent dashboard' });
  }
});

router.post('/driver/agent-dashboard', express.json(), async (req, res) => {
  try {
    const map = await getSettingsMap();
    const trackingType = map.driver_tracking_option === '2' ? '2' : '1';
    const date = (req.body?.date || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
    const team_id = req.body?.team_id != null && req.body?.team_id !== '' ? req.body?.team_id : null;
    const agent_name = (req.body?.agent_name || '').toString().trim();

    const filters = { team_id, driver_name: agent_name || null };

    const { active, offline, total } = await buildAgentDashboardDetails(date, trackingType, filters);

    return res.json({
      details: { active, offline, total },
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ details: { active: [], offline: [], total: [] } });
    }
    return res.status(500).json({ error: e.message || 'Failed to load agent dashboard' });
  }
});

// ---- Driver queue (mt_driver_queue: active rows only, FIFO by joined_at) ----
router.get('/driver-queue', async (req, res) => {
  try {
    const map = await getSettingsMap();
    const trackingType = map.driver_tracking_option === '2' ? '2' : '1';
    const dateOnly = new Date().toISOString().slice(0, 10);
    const nowSec = Math.floor(Date.now() / 1000);

    const [rows] = await pool.query(
      `SELECT q.id AS queue_entry_id,
              q.driver_id,
              q.joined_at,
              q.status AS queue_row_status,
              d.username,
              d.first_name,
              d.last_name,
              CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
              d.phone,
              d.on_duty,
              d.team_id,
              t.team_name,
              d.email,
              COALESCE(d.transport_description, d.licence_plate, '') AS vehicle,
              COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
              COALESCE(d.last_login, d.date_modified) AS status_updated_at,
              d.last_login,
              d.last_online,
              d.location_lat,
              d.location_lng,
              d.user_type,
              d.user_id,
              d.device_platform
       FROM mt_driver_queue q
       INNER JOIN mt_driver d ON d.driver_id = q.driver_id
       LEFT JOIN mt_driver_team t ON d.team_id = t.team_id
       WHERE q.left_at IS NULL
       ORDER BY q.joined_at ASC`
    );

    const driverIds = (rows || []).map((r) => r.driver_id).filter(Boolean);
    const taskCountByDriver = {};
    if (driverIds.length > 0) {
      try {
        const placeholders = driverIds.map(() => '?').join(',');
        const [taskRows] = await pool.query(
          `SELECT driver_id, COUNT(*) AS cnt FROM mt_driver_task WHERE driver_id IN (${placeholders}) AND (delivery_date = ? OR DATE(delivery_date) = ?) GROUP BY driver_id`,
          [...driverIds, dateOnly, dateOnly]
        );
        for (const tr of taskRows || []) taskCountByDriver[tr.driver_id] = tr.cnt;
      } catch (_) {}
    }

    const queue = (rows || []).map((r, index) => {
      const rowForMap = {
        ...r,
        last_online:
          r.last_online != null
            ? r.last_online
            : r.last_login
              ? Math.floor(new Date(r.last_login).getTime() / 1000)
              : null,
      };
      const mapped = mapDriverRowToAgentDriver(rowForMap, dateOnly, trackingType, taskCountByDriver, nowSec);
      return {
        position: index + 1,
        queue_entry_id: r.queue_entry_id,
        driver_id: r.driver_id,
        joined_at: r.joined_at,
        joined_at_iso: r.joined_at ? new Date(r.joined_at).toISOString() : null,
        full_name: mapped.full_name,
        team_name: mapped.team_name,
        team_id: mapped.team_id,
        online_status: mapped.online_status,
        connection_status: mapped.connection_status,
        on_duty: mapped.on_duty,
        total_task: mapped.total_task,
        is_next: index === 0,
      };
    });

    return res.json({
      queue,
      total_queued: queue.length,
      next_in_line: queue[0] || null,
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Driver queue is not available (mt_driver_queue).' });
    }
    return res.status(500).json({ error: e.message || 'Failed to load driver queue' });
  }
});

router.put('/driver-queue/:driverId/remove', express.json(), async (req, res) => {
  const driverId = parseInt(req.params.driverId, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  try {
    const [result] = await pool.query(
      `UPDATE mt_driver_queue SET left_at = NOW(), status = ? WHERE driver_id = ? AND left_at IS NULL`,
      ['left', driverId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Driver is not in the queue' });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Driver queue is not available.' });
    }
    return res.status(500).json({ error: e.message || 'Failed to remove driver from queue' });
  }
});

// ---- Driver stats (Active / Offline / Total) ----
router.get('/stats/drivers', async (req, res) => {
  try {
    const [all] = await pool.query('SELECT driver_id AS id, on_duty FROM mt_driver');
    const [recent] = await pool.query(
      'SELECT driver_id FROM mt_driver WHERE date_modified > DATE_SUB(NOW(), INTERVAL 5 MINUTE) AND location_lat IS NOT NULL AND location_lng IS NOT NULL'
    );
    const recentIds = new Set((recent || []).map((r) => r.driver_id));
    let active = 0;
    let offline = 0;
    for (const d of all || []) {
      if (d.on_duty === 1 && recentIds.has(d.id)) active++;
      else offline++;
    }
    return res.json({ total: (all || []).length, active, offline });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ total: 0, active: 0, offline: 0 });
    }
    throw e;
  }
});

// ---- Driver locations for map (current position from mt_driver; optional ?team_id= for filter; ?include_offline=1 to include drivers without recent location) ----
router.get('/drivers/locations', async (req, res) => {
  const teamId = req.query.team_id != null && req.query.team_id !== '' ? parseInt(req.query.team_id, 10) : null;
  let includeOffline = req.query.include_offline === '1' || req.query.include_offline === 'true';
  if (!includeOffline) {
    try {
      const map = await getSettingsMap();
      includeOffline = map.include_offline_drivers_on_map === '1';
    } catch (_) {}
  }
  const byTeam = Number.isFinite(teamId) ? ' AND d.team_id = ?' : '';
  const params = Number.isFinite(teamId) ? [teamId] : [];
  const recencyClause = includeOffline ? '' : ' AND d.date_modified > DATE_SUB(NOW(), INTERVAL 30 MINUTE)';
  try {
    const [rows] = await pool.query(
      `SELECT d.driver_id, d.team_id, d.location_lat AS lat, d.location_lng AS lng, d.date_modified AS updated_at,
        CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name, d.on_duty,
        (SELECT o.merchant_id FROM mt_driver_task t
         LEFT JOIN mt_order o ON o.order_id = t.order_id
         WHERE t.driver_id = d.driver_id
         AND LOWER(REPLACE(REPLACE(TRIM(COALESCE(t.status,'')), ' ', ''), '_', '')) IN ('assigned', 'acknowledged', 'started', 'inprogress')
         ORDER BY t.task_id DESC LIMIT 1) AS active_merchant_id
       FROM mt_driver d
       WHERE d.location_lat IS NOT NULL AND d.location_lng IS NOT NULL${recencyClause}${byTeam}
       ORDER BY d.driver_id`,
      params
    );
    const byDriver = {};
    for (const r of rows || []) {
      if (!byDriver[r.driver_id]) {
        byDriver[r.driver_id] = {
          driver_id: r.driver_id,
          team_id: r.team_id,
          full_name: r.full_name,
          on_duty: r.on_duty,
          lat: r.lat,
          lng: r.lng,
          updated_at: r.updated_at,
          active_merchant_id: r.active_merchant_id != null ? r.active_merchant_id : null,
        };
      }
    }
    if (!Number.isFinite(teamId) && errandWibPool) {
      try {
        const errLocs = await fetchErrandDriverLocationsForMap(errandWibPool, includeOffline);
        for (const loc of errLocs || []) {
          if (loc.driver_id == null) continue;
          const k = String(loc.driver_id);
          if (byDriver[k]) continue;
          byDriver[k] = {
            driver_id: loc.driver_id,
            team_id: loc.team_id,
            full_name: loc.full_name,
            on_duty: loc.on_duty,
            lat: loc.lat,
            lng: loc.lng,
            updated_at: loc.updated_at,
            active_merchant_id: loc.active_merchant_id ?? null,
            driver_source: loc.driver_source ?? 'errand',
          };
        }
      } catch (_) {
        /* optional */
      }
    }
    return res.json(Object.values(byDriver));
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json([]);
    }
    throw e;
  }
});

// ---- List merchants (mt_merchant) with logo for table display ----
router.get('/merchants', async (req, res) => {
  const attachResolvedLogos = (rows) =>
    (rows || []).map((r) => ({
      ...r,
      logo: resolveMerchantLogoForApi(r, merchantLogoDir),
    }));
  const run = async (sql) => {
    try {
      const [rows] = await pool.query(sql);
      res.json(attachResolvedLogos(rows));
      return true;
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE') return false;
      throw err;
    }
  };
  if (await run('SELECT merchant_id, restaurant_name, logo FROM mt_merchant ORDER BY merchant_id')) return;
  if (await run('SELECT merchant_id, restaurant_name FROM mt_merchant ORDER BY merchant_id')) return;
  return res.json([]);
});

// ---- Merchant locations for map (mt_merchant: latitude, lontitude or longitude; optional logo for marker image) ----
router.get('/merchants/locations', async (req, res) => {
  const shape = (rows) =>
    (rows || []).map((r) => ({
      merchant_id: r.merchant_id,
      restaurant_name: r.restaurant_name || null,
      lat: Number(r.lat),
      lng: Number(r.lng),
      logo_url: resolveMerchantLogoForApi(
        { logo: r.logo, logo_url: r.logo_url, image_url: r.image_url, restaurant_name: r.restaurant_name },
        merchantLogoDir
      ),
    }));
  const queryWithLogo = (latCol, lngCol) =>
    `SELECT merchant_id, restaurant_name, ${latCol} AS lat, ${lngCol} AS lng, logo FROM mt_merchant WHERE ${latCol} IS NOT NULL AND ${lngCol} IS NOT NULL AND (${latCol} != 0 OR ${lngCol} != 0) ORDER BY merchant_id`;
  const queryNoLogo = (latCol, lngCol) =>
    `SELECT merchant_id, restaurant_name, ${latCol} AS lat, ${lngCol} AS lng FROM mt_merchant WHERE ${latCol} IS NOT NULL AND ${lngCol} IS NOT NULL AND (${latCol} != 0 OR ${lngCol} != 0) ORDER BY merchant_id`;
  const run = async (sql) => {
    try {
      const [rows] = await pool.query(sql);
      res.json(shape(rows));
      return true;
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') return false;
      throw err;
    }
  };
  try {
    if (await run(queryWithLogo('latitude', 'lontitude'))) return;
    if (await run(queryNoLogo('latitude', 'lontitude'))) return;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        if (await run(queryWithLogo('latitude', 'longitude'))) return;
        if (await run(queryNoLogo('latitude', 'longitude'))) return;
      } catch (_) {}
    } else {
      throw e;
    }
  }
  return res.json([]);
});

// ---- getMerchantAdddress (merchant address by id) ----
router.get('/merchants/:id/address', async (req, res) => {
  const merchantId = parseInt(req.params.id, 10);
  if (!Number.isFinite(merchantId)) return res.status(400).json({ error: 'Invalid merchant id' });
  const baseCols = 'SELECT merchant_id, restaurant_name, restaurant_phone, contact_name, contact_phone, contact_email, street, city, state, post_code, latitude';
  const queries = [
    baseCols + ', longitude FROM mt_merchant WHERE merchant_id = ? LIMIT 1',
    baseCols + ', lontitude AS longitude FROM mt_merchant WHERE merchant_id = ? LIMIT 1',
  ];
  for (const sql of queries) {
    try {
      const [rows] = await pool.query(sql, [merchantId]);
      if (!rows || !rows.length) continue;
      const m = rows[0];
      const parts = [m.street, m.city, m.state, m.post_code].filter(Boolean);
      return res.json({
        merchant_id: m.merchant_id,
        restaurant_name: m.restaurant_name,
        restaurant_phone: m.restaurant_phone,
        address: parts.join(', ') || null,
        street: m.street,
        city: m.city,
        state: m.state,
        post_code: m.post_code,
        latitude: m.latitude,
        longitude: m.longitude,
        contact_name: m.contact_name,
        contact_phone: m.contact_phone,
        contact_email: m.contact_email,
      });
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
        if (e.code === 'ER_NO_SUCH_TABLE') return res.status(404).json({ error: 'Merchant not found' });
        continue;
      }
      throw e;
    }
  }
  return res.status(404).json({ error: 'Merchant not found' });
});

const ORDER_HISTORY_SELECT_COLS =
  'id, order_id, status, remarks, date_created, ip_address, task_id, reason, driver_id, remarks2, notes, update_by_type, update_by_id, update_by_name';

/** Cached SELECT list: includes latitude/longitude when those columns exist on mt_order_history. */
let orderHistorySelectColsResolved = null;

async function resolveOrderHistorySelectCols(pool) {
  if (orderHistorySelectColsResolved != null) return orderHistorySelectColsResolved;
  const extended = `${ORDER_HISTORY_SELECT_COLS}, latitude, longitude`;
  try {
    await pool.query(`SELECT ${extended} FROM mt_order_history WHERE 1=0`);
    orderHistorySelectColsResolved = extended;
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') {
      orderHistorySelectColsResolved = ORDER_HISTORY_SELECT_COLS;
    } else {
      throw e;
    }
  }
  return orderHistorySelectColsResolved;
}

/**
 * Activity timeline: rows for this task_id plus order-level rows (same order_id, task_id NULL/0).
 * Deduplicates by id, sorts oldest-first like the classic driver app.
 */
async function fetchMergedTaskOrderHistory(pool, taskId, orderId) {
  try {
    const cols = await resolveOrderHistorySelectCols(pool);
    const [taskRows] = await pool.query(`SELECT ${cols} FROM mt_order_history WHERE task_id = ?`, [taskId]);
    const byId = new Map();
    for (const row of taskRows || []) {
      if (row && row.id != null) byId.set(Number(row.id), row);
    }
    const oid = orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0' ? orderId : null;
    if (oid != null) {
      const [orderOnlyRows] = await pool.query(
        `SELECT ${cols} FROM mt_order_history WHERE order_id = ? AND (task_id IS NULL OR task_id = 0)`,
        [oid]
      );
      for (const row of orderOnlyRows || []) {
        if (row && row.id != null) byId.set(Number(row.id), row);
      }
    }
    const merged = Array.from(byId.values());
    merged.sort((a, b) => {
      const ta = a.date_created ? new Date(a.date_created).getTime() : 0;
      const tb = b.date_created ? new Date(b.date_created).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return Number(a.id) - Number(b.id);
    });
    return merged;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return [];
    }
    throw e;
  }
}

/** Normalize timeline / history status for comparison (matches rider dashboard TaskDetailsModal). */
function normalizeDashboardHistoryStatusKey(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

function historyRowEffectiveStatusKey(row) {
  if (!row || typeof row !== 'object') return '';
  const st = row.status != null ? String(row.status).trim() : '';
  if (st) return normalizeDashboardHistoryStatusKey(st);
  const desc = row.description != null ? String(row.description).trim() : '';
  if (desc) return normalizeDashboardHistoryStatusKey(desc);
  return '';
}

/**
 * Guardrail for task cards: Ready-for-pickup badge is only valid before pickup/delivery progresses.
 * Even if older timeline rows contain an RFP milestone, hide it once task status moved forward.
 */
function allowReadyForPickupByCurrentTaskStatus(statusRaw) {
  const s = normalizeDashboardHistoryStatusKey(statusRaw);
  if (!s) return true;
  if (s === 'unassigned' || s === 'assigned' || s === 'acknowledged' || s === 'readyforpickup') return true;
  if (s === 'new' || s === 'queued' || s === 'pending') return true;
  // Started/in-progress/completed/cancelled etc. should clear RFP badge on cards.
  return false;
}

/**
 * Oldest-first history: RFP is "active" if the last Ready-for-pickup milestone has no later milestone
 * (same rules as dashboard notifications / timeline classifier: status, remarks, notes, etc.).
 */
function isTimelineReadyForPickupActiveFromSortedHistory(sortedOldestFirst) {
  if (!Array.isArray(sortedOldestFirst) || sortedOldestFirst.length === 0) return false;
  let lastRfpIndex = -1;
  for (let i = 0; i < sortedOldestFirst.length; i++) {
    if (classifyTimelineHistoryForDashboardNotify(sortedOldestFirst[i]) === 'ready_for_pickup') lastRfpIndex = i;
  }
  if (lastRfpIndex < 0) return false;
  for (let j = lastRfpIndex + 1; j < sortedOldestFirst.length; j++) {
    const cat = classifyTimelineHistoryForDashboardNotify(sortedOldestFirst[j]);
    if (cat && cat !== 'ready_for_pickup') return false;
  }
  return true;
}

/** Same linking rules as fetchMergedTaskOrderHistory; filters a pre-fetched history array per task. */
function mergeOrderHistoryRowsForTaskFromPool(allRows, taskId, orderId) {
  const tid = Number(taskId);
  const oidRaw = orderId != null ? String(orderId).trim() : '';
  const oid =
    oidRaw !== '' && oidRaw !== '0' && Number.isFinite(parseInt(oidRaw, 10))
      ? parseInt(oidRaw, 10)
      : null;
  const byId = new Map();
  for (const row of allRows || []) {
    if (!row || row.id == null) continue;
    const rid = Number(row.id);
    const rtRaw = row.task_id;
    const rt =
      rtRaw != null && String(rtRaw).trim() !== '' ? Number(rtRaw) : NaN;
    const taskMatch = Number.isFinite(tid) && tid > 0 && Number.isFinite(rt) && rt === tid;
    let orderOnlyMatch = false;
    if (oid != null && row.order_id != null) {
      const ro = parseInt(String(row.order_id), 10);
      if (Number.isFinite(ro) && ro === oid) {
        orderOnlyMatch = !Number.isFinite(rt) || rt === 0;
      }
    }
    if (taskMatch || orderOnlyMatch) byId.set(rid, row);
  }
  const merged = Array.from(byId.values());
  merged.sort((a, b) => {
    const ta = a.date_created ? new Date(a.date_created).getTime() : 0;
    const tb = b.date_created ? new Date(b.date_created).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return Number(a.id) - Number(b.id);
  });
  return merged;
}

/**
 * Sets task.timeline_ready_for_pickup (boolean) on each row for the rider dashboard task cards.
 */
async function attachTimelineReadyForPickupFlags(pool, errandPool, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const mtRows = rows.filter((r) => r.task_source !== 'errand');
  const taskIds = [
    ...new Set(
      mtRows.map((r) => Number(r.task_id)).filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  const orderIds = [
    ...new Set(
      mtRows
        .map((r) => r.order_id)
        .map((x) => (x != null ? parseInt(String(x), 10) : NaN))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];

  let allMtHistory = [];
  if (taskIds.length > 0 || orderIds.length > 0) {
    try {
      const cols = await resolveOrderHistorySelectCols(pool);
      const parts = [];
      const params = [];
      if (taskIds.length > 0) {
        parts.push(`task_id IN (${taskIds.map(() => '?').join(',')})`);
        params.push(...taskIds);
      }
      if (orderIds.length > 0) {
        parts.push(
          `(order_id IN (${orderIds.map(() => '?').join(',')}) AND (task_id IS NULL OR task_id = 0 OR CAST(task_id AS UNSIGNED) = 0))`
        );
        params.push(...orderIds);
      }
      const sql = `SELECT ${cols} FROM mt_order_history WHERE ${parts.join(' OR ')}`;
      const [h] = await pool.query(sql, params);
      allMtHistory = h || [];
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      allMtHistory = [];
    }
  }

  const errandRows = rows.filter((r) => r.task_source === 'errand');
  const errandOrderIds = [
    ...new Set(
      errandRows
        .map((r) => Number(r.order_id ?? r.st_order_id))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];

  const errandHistoryByOrder = new Map();
  if (errandOrderIds.length > 0 && errandPool) {
    try {
      const ph = errandOrderIds.map(() => '?').join(',');
      const [eh] = await errandPool.query(
        `SELECT * FROM st_ordernew_history WHERE order_id IN (${ph}) ORDER BY order_id ASC, id ASC`,
        errandOrderIds
      );
      for (const r of eh || []) {
        const oid = r.order_id;
        if (!errandHistoryByOrder.has(oid)) errandHistoryByOrder.set(oid, []);
        errandHistoryByOrder.get(oid).push(r);
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
  }

  for (const r of rows) {
    let active = false;
    if (r.task_source === 'errand') {
      const oid = Number(r.order_id ?? r.st_order_id);
      const list = errandHistoryByOrder.get(oid) || [];
      active = isTimelineReadyForPickupActiveFromSortedHistory(list);
    } else {
      const tid = Number(r.task_id);
      const oid = r.order_id != null ? parseInt(String(r.order_id), 10) : null;
      const merged = mergeOrderHistoryRowsForTaskFromPool(allMtHistory, tid, oid);
      active = isTimelineReadyForPickupActiveFromSortedHistory(merged);
    }
    r.timeline_ready_for_pickup = Boolean(active) && allowReadyForPickupByCurrentTaskStatus(r.status);
  }
}

/**
 * Latest remarks/notes from mt_order_history where status is "Advance Order" (admin timeline note).
 * Same task/order linking as fetchMergedTaskOrderHistory.
 */
async function fetchLatestAdvanceOrderNoteForTask(pool, taskId, orderId) {
  try {
    const oid = orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0' ? orderId : null;
    const [rows] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(h.remarks), ''), NULLIF(TRIM(h.notes), ''), NULLIF(TRIM(h.remarks2), '')) AS note
       FROM mt_order_history h
       WHERE (
         (h.task_id IS NOT NULL AND CAST(h.task_id AS UNSIGNED) > 0 AND h.task_id = ?)
         OR (
           ? IS NOT NULL
           AND (h.task_id IS NULL OR CAST(h.task_id AS UNSIGNED) = 0)
           AND h.order_id = ?
         )
       )
       AND LOWER(REPLACE(REPLACE(TRIM(COALESCE(h.status,'')), ' ', ''), '_', '')) = 'advanceorder'
       ORDER BY h.date_created DESC, h.id DESC
       LIMIT 1`,
      [taskId, oid, oid]
    );
    const n = rows && rows[0] && rows[0].note != null ? String(rows[0].note).trim() : '';
    return n || null;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return null;
    throw e;
  }
}

/** Prefer timeline / feed `update_by_name`; else parse "Name accepted the task" from remarks. */
function timelineNotifyActorFromHistoryRow(row) {
  if (!row || typeof row !== 'object') return '';
  const n = row.update_by_name != null ? String(row.update_by_name).trim() : '';
  if (n) return n;
  const tryParseAccept = (text) => {
    const t = String(text || '').trim();
    if (!t) return '';
    const m = t.match(/^(.+?)\s+accepted the task\b/i);
    if (m) return m[1].trim();
    return '';
  };
  const fromRem = tryParseAccept(row.remarks);
  if (fromRem) return fromRem;
  const fromDesc = tryParseAccept(row.description);
  if (fromDesc) return fromDesc;
  return '';
}

function timelineNotifyActorFromFeedEvent(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const n = ev.update_by_name != null ? String(ev.update_by_name).trim() : '';
  if (n) return n;
  return timelineNotifyActorFromHistoryRow(ev);
}

function ensureTaskIdMarkerInMessage(message, taskId) {
  const tid = Number(taskId);
  if (!Number.isFinite(tid) || tid <= 0) return String(message || '').trim();
  const s = String(message || '').trim();
  if (new RegExp(`task\\s*#\\s*${tid}\\b`, 'i').test(s)) return s;
  return s ? `${s} · Task #${tid}` : `Task #${tid}`;
}

/**
 * @param {number|null|undefined} taskId — food task id; omit when errandOpts set
 * @param {string|null|undefined} taskDescription — label line (merchant / description)
 * @param {string|number|null|undefined} orderId — order number admins recognize (preferred in message)
 * @param {string} category
 * @param {string} [actorLabel] — rider or updater (appended via attachActorToPayload)
 * @param {{ errandOrderId?: number }} [errandOpts] — Mangan: include order id in message for dashboard deep-link
 */
function timelineNotifyPayloadFromCategory(taskId, taskDescription, orderId, category, actorLabel, errandOpts) {
  let messageBase = '';
  if (errandOpts != null && errandOpts.errandOrderId != null) {
    const oid = Number(errandOpts.errandOrderId);
    const label = (taskDescription && String(taskDescription).trim()) || `Mangan order #${oid}`;
    const hasRef = new RegExp(`#\\s*${oid}\\b`).test(label) || /mangan\s+order/i.test(label);
    messageBase = hasRef ? label : `${label} · Mangan order #${oid}`;
  } else {
    const tid = Number(taskId);
    const ord = orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0' ? String(orderId).trim() : '';
    const base = ord ? `Order #${ord}` : (taskDescription && String(taskDescription).trim()) || `Task #${tid}`;
    messageBase = ensureTaskIdMarkerInMessage(base, tid);
  }

  let payload = null;
  if (category === 'accepted') {
    payload = {
      title: errandOpts != null ? 'Mangan accepted' : 'Task accepted',
      message: messageBase,
      type: 'task_accepted',
    };
  } else if (category === 'successful') {
    payload = {
      title: errandOpts != null ? 'Mangan completed' : 'Successful delivery',
      message: messageBase,
      type: 'task_done',
    };
  } else if (category === 'ready_for_pickup') {
    // Ensure dispatcher bell/inbox receives ready-for-pickup every time.
    payload = { title: 'Ready for pickup', message: messageBase, type: 'ready_pickup' };
  } else if (category === 'preparing') {
    payload = {
      title: errandOpts != null ? 'Mangan preparing' : 'Order preparing',
      message: messageBase,
      type: 'new_task',
    };
  } else if (category === 'created') {
    payload = {
      title: errandOpts != null ? 'New Mangan order' : 'New task order',
      message: messageBase,
      type: 'new_task',
    };
  }
  else if (category === 'started') payload = { title: 'Rider started', message: messageBase, type: 'new_task' };
  else if (category === 'inprogress') payload = { title: 'Task in progress', message: messageBase, type: 'new_task' };
  return attachActorToPayload(payload, actorLabel);
}

function driverActorFromTaskDriverJoinRow(row) {
  if (!row || typeof row !== 'object') return '';
  const fn = row.first_name != null ? String(row.first_name).trim() : '';
  const ln = row.last_name != null ? String(row.last_name).trim() : '';
  const full = [fn, ln].filter(Boolean).join(' ').trim();
  const did = row.driver_id != null ? Number(row.driver_id) : NaN;
  return formatActorFromDriver({
    id: Number.isFinite(did) && did > 0 ? did : undefined,
    full_name: full || null,
    username: row.username != null ? String(row.username).trim() : null,
  });
}

/**
 * One notification per mt_driver_task_photo row; dedupe `mt-p-<id>` (timeline modal + global poller share keys).
 */
async function notifyAdminsForSingleTaskPhoto(pool, photoId, taskId, orderId, taskDescription, actorLabel, activityAt, proofTypeRaw) {
  const pid = photoId != null ? Number(photoId) : NaN;
  const tid = taskId != null ? Number(taskId) : NaN;
  if (!Number.isFinite(pid) || !Number.isFinite(tid) || tid <= 0) return;
  const dedupeKey = `mt-p-${pid}`;
  if (!(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, dedupeKey))) return;
  const ord = orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0' ? String(orderId).trim() : '';
  const label = ord ? `Order #${ord}` : `Task #${tid}`;
  const kind = normalizeStoredProofType(proofTypeRaw);
  const title = kind === 'receipt' ? 'Proof of receipt' : 'Proof of delivery';
  const detail = kind === 'receipt' ? 'Rider added proof of receipt' : 'Rider added proof of delivery';
  const ntype = kind === 'receipt' ? 'task_photo_receipt' : 'task_photo_delivery';
  notifyAllDashboardAdminsFireAndForget(
    pool,
    attachActorToPayload(
      {
        title,
        message: ensureTaskIdMarkerInMessage(`${label} · ${detail}`, tid),
        type: ntype,
        activityAt,
      },
      actorLabel
    )
  );
}

async function fanOutGlobalTaskPhotoNotifySinceRows(pool, rows) {
  for (const r of rows || []) {
    const actor = driverActorFromTaskDriverJoinRow(r);
    await notifyAdminsForSingleTaskPhoto(
      pool,
      r.id,
      r.task_id,
      r.order_id ?? null,
      r.task_description,
      actor,
      r.date_created,
      r.proof_type
    );
  }
}

async function fanOutTimelineMilestonesToRiderNotifications(pool, taskId, taskDescription, newHistoryRows, photoRows) {
  for (const row of newHistoryRows || []) {
    const hid = row && row.id != null ? Number(row.id) : NaN;
    if (!Number.isFinite(hid)) continue;
    const cat = classifyTimelineHistoryForDashboardNotify(row);
    if (!cat) continue;
    const dedupeKey = `mt-h-${hid}`;
    if (!(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, dedupeKey))) continue;
    const milestoneKey = milestoneDedupeKeyForTask(taskId, cat);
    if (milestoneKey && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, milestoneKey))) continue;
    const ordCross = row.order_id != null ? Number(row.order_id) : NaN;
    if (Number.isFinite(ordCross) && ordCross > 0) {
      const eMk = milestoneDedupeKeyForErrand(ordCross, cat);
      if (eMk && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, eMk))) continue;
    }
    const actor = timelineNotifyActorFromHistoryRow(row);
    const payload = timelineNotifyPayloadFromCategory(taskId, taskDescription, row.order_id ?? null, cat, actor);
    if (payload) notifyAllDashboardAdminsFireAndForget(pool, { ...payload, activityAt: row.date_created });
  }
  let photoActor = '';
  let photoOrderId = null;
  if ((photoRows || []).length > 0 && Number.isFinite(Number(taskId)) && Number(taskId) > 0) {
    try {
      const [[dr]] = await pool.query(
        `SELECT t.order_id, t.driver_id, d.first_name, d.last_name, d.username
         FROM mt_driver_task t
         LEFT JOIN mt_driver d ON d.driver_id = t.driver_id
         WHERE t.task_id = ? LIMIT 1`,
        [taskId]
      );
      photoActor = driverActorFromTaskDriverJoinRow(dr);
      photoOrderId = dr?.order_id ?? null;
    } catch (_) {
      /* optional */
    }
  }
  for (const ph of photoRows || []) {
    await notifyAdminsForSingleTaskPhoto(
      pool,
      ph && ph.id,
      taskId,
      photoOrderId,
      taskDescription,
      photoActor,
      ph?.date_created,
      ph?.proof_type
    );
  }
}

/** Map `order-history/feed` event → row shape for `classifyTimelineHistoryForDashboardNotify`. */
function orderHistoryFeedEventToClassifierRow(ev) {
  if (!ev || typeof ev !== 'object') return {};
  return {
    status: ev.status,
    description: ev.description != null ? ev.description : null,
    remarks: ev.remarks,
    reason: ev.reason != null ? ev.reason : null,
    notes: ev.notes != null ? ev.notes : null,
    update_by_type: ev.update_by_type,
  };
}

/**
 * Fan-out bell + inbox notifications from dashboard home feed (mt_order_history), same milestones as task timeline.
 * Dedupe keys match per-history `mt-h-<id>` so modal timeline poll does not double-notify.
 */
async function fanOutOrderHistoryFeedEventsToRiderNotifications(pool, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const taskIds = [
    ...new Set(
      events.map((e) => Number(e.resolved_task_id)).filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  const descByTask = new Map();
  const driverByTask = new Map();
  if (taskIds.length > 0) {
    try {
      const ph = taskIds.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT t.task_id, t.task_description, t.driver_id,
          d.username, CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name
         FROM mt_driver_task t
         LEFT JOIN mt_driver d ON d.driver_id = t.driver_id
         WHERE t.task_id IN (${ph})`,
        taskIds
      );
      for (const r of rows || []) {
        const tid = Number(r.task_id);
        if (Number.isFinite(tid) && tid > 0) {
          descByTask.set(tid, r.task_description);
          driverByTask.set(tid, formatActorFromDriver({ id: r.driver_id, username: r.username, full_name: r.full_name }));
        }
      }
    } catch (_) {
      /* optional */
    }
  }
  for (const ev of events) {
    const hid = ev && ev.id != null ? Number(ev.id) : NaN;
    if (!Number.isFinite(hid)) continue;
    const tid = ev.resolved_task_id != null ? Number(ev.resolved_task_id) : NaN;
    if (!Number.isFinite(tid) || tid <= 0) continue;
    const cat = classifyTimelineHistoryForDashboardNotify(orderHistoryFeedEventToClassifierRow(ev));
    if (!cat) continue;
    const dedupeKey = `mt-h-${hid}`;
    if (!(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, dedupeKey))) continue;
    const milestoneKey = milestoneDedupeKeyForTask(tid, cat);
    if (milestoneKey && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, milestoneKey))) continue;
    const ordCross = ev.order_id != null ? Number(ev.order_id) : NaN;
    if (Number.isFinite(ordCross) && ordCross > 0) {
      const eMk = milestoneDedupeKeyForErrand(ordCross, cat);
      if (eMk && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, eMk))) continue;
    }
    const td = descByTask.get(tid);
    const fromFeed = timelineNotifyActorFromFeedEvent(ev) || '';
    /* Ready-for-pickup is a merchant / order milestone — do not attribute the task's assigned driver (often none yet). */
    const actor =
      cat === 'ready_for_pickup' ? fromFeed : fromFeed || driverByTask.get(tid) || '';
    const payload = timelineNotifyPayloadFromCategory(tid, td, ev.order_id ?? null, cat, actor);
    if (payload) notifyAllDashboardAdminsFireAndForget(pool, { ...payload, activityAt: ev.date_created });
  }
}

function inferUpdateByTypeFromErrandChangeBy(changeBy) {
  const s = String(changeBy || '').toLowerCase();
  if (!s) return null;
  if (s.includes('driver') || s.includes('rider')) return 'driver';
  if (s.includes('admin') || s.includes('merchant') || s.includes('dispatcher')) return 'admin';
  return null;
}

function mapStOrdernewHistoryRowToFeedEvent(h, orderReference) {
  const trans = h.ramarks_trans ?? h.remarks_trans;
  const remarks = resolveErrandHistoryRemarks(h.remarks, trans);
  return {
    id: h.id,
    resolved_errand_order_id: h.order_id != null ? Number(h.order_id) : NaN,
    order_reference: orderReference != null ? String(orderReference).trim() : '',
    status: h.status != null ? String(h.status).trim() : '',
    remarks: remarks || null,
    reason: h.reason != null ? String(h.reason) : null,
    notes: h.notes != null ? String(h.notes) : null,
    update_by_type: inferUpdateByTypeFromErrandChangeBy(h.change_by),
    date_created: h.date_created ?? h.date_added ?? h.created_at ?? null,
    update_by_name: h.change_by != null ? String(h.change_by).trim() : null,
  };
}

/** Mangan (ErrandWib) history feed → same milestone notifications; dedupe `soh-<history_id>`. */
async function fanOutErrandHistoryFeedEventsToRiderNotifications(pool, errandPool, events) {
  if (!Array.isArray(events) || events.length === 0 || !errandPool) return;
  for (const ev of events) {
    const hid = ev && ev.id != null ? Number(ev.id) : NaN;
    if (!Number.isFinite(hid)) continue;
    const oid = ev.resolved_errand_order_id != null ? Number(ev.resolved_errand_order_id) : NaN;
    if (!Number.isFinite(oid) || oid <= 0) continue;
    const cat = classifyTimelineHistoryForDashboardNotify(orderHistoryFeedEventToClassifierRow(ev));
    if (!cat) continue;
    const dedupeKey = `soh-${hid}`;
    if (!(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, dedupeKey))) continue;
    const milestoneKey = milestoneDedupeKeyForErrand(oid, cat);
    if (milestoneKey && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, milestoneKey))) continue;
    const ref = (ev.order_reference || '').trim();
    const label = ref ? `Mangan ${ref}` : `Mangan order #${oid}`;
    const actor = timelineNotifyActorFromFeedEvent(ev);
    const payload = timelineNotifyPayloadFromCategory(null, label, null, cat, actor, { errandOrderId: oid });
    if (payload) notifyAllDashboardAdminsFireAndForget(pool, { ...payload, activityAt: ev.date_created });
  }
}

// ---- Task order history (for activity timeline; client may call when details omit it) ----
router.get('/tasks/:id/order-history', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid task id' });
  try {
    let orderId = null;
    try {
      const [[t]] = await pool.query('SELECT order_id FROM mt_driver_task WHERE task_id = ? LIMIT 1', [id]);
      orderId = t?.order_id ?? null;
    } catch (_) {}
    const merged = await fetchMergedTaskOrderHistory(pool, id, orderId);
    return res.json(merged);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json([]);
    }
    throw e;
  }
});

/**
 * Poll new activity for one task (merged order history + proof photos). Task Details modal toasts + rider notification inbox.
 * Query: ?after_history_id=0&after_photo_id=0 — first call returns max cursors only (no events). Later calls use last cursors.
 */
router.get('/tasks/:id/timeline-updates', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid task id' });
  }
  const afterHRaw = req.query.after_history_id != null ? parseInt(String(req.query.after_history_id), 10) : 0;
  const afterPRaw = req.query.after_photo_id != null ? parseInt(String(req.query.after_photo_id), 10) : 0;
  const afterH = Number.isFinite(afterHRaw) && afterHRaw >= 0 ? afterHRaw : 0;
  const afterP = Number.isFinite(afterPRaw) && afterPRaw >= 0 ? afterPRaw : 0;

  let orderId = null;
  let taskDescriptionCached = '';
  try {
    const [[t]] = await pool.query('SELECT order_id, task_description FROM mt_driver_task WHERE task_id = ? LIMIT 1', [id]);
    orderId = t?.order_id ?? null;
    taskDescriptionCached = t?.task_description != null ? String(t.task_description) : '';
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      throw e;
    }
  }

  try {
    if (afterH === 0 && afterP === 0) {
      let maxH = 0;
      const [[tmax]] = await pool.query(
        'SELECT COALESCE(MAX(id), 0) AS m FROM mt_order_history WHERE task_id = ?',
        [id]
      );
      maxH = Math.max(maxH, Number(tmax?.m) || 0);
      const oid =
        orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0'
          ? orderId
          : null;
      if (oid != null) {
        const [[omax]] = await pool.query(
          `SELECT COALESCE(MAX(id), 0) AS m FROM mt_order_history WHERE order_id = ? AND (task_id IS NULL OR task_id = 0 OR CAST(task_id AS UNSIGNED) = 0)`,
          [oid]
        );
        maxH = Math.max(maxH, Number(omax?.m) || 0);
      }
      let maxP = 0;
      try {
        const [[pmax]] = await pool.query(
          'SELECT COALESCE(MAX(id), 0) AS m FROM mt_driver_task_photo WHERE task_id = ?',
          [id]
        );
        maxP = Number(pmax?.m) || 0;
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
      /*
       * First poll (after_* = 0): client only records cursors; incremental polls use id > max so they
       * would never see existing rows. Fan-out merged history here so milestones (accepted, RFP, etc.)
       * still create inbox notifications — DB dedupe (mt-h-*) prevents duplicates if already notified.
       * Photos omitted on bootstrap to avoid re-firing old proof alerts on every modal open.
       */
      try {
        const mergedBoot = await fetchMergedTaskOrderHistory(pool, id, orderId);
        await fanOutTimelineMilestonesToRiderNotifications(
          pool,
          id,
          taskDescriptionCached,
          mergedBoot || [],
          []
        );
      } catch (fanErr) {
        console.warn('[tasks/:id/timeline-updates] bootstrap notify fan-out', fanErr.message || fanErr);
      }
      return res.json({
        cursor_history: maxH,
        cursor_photo: maxP,
        history_events: [],
        photo_events: [],
      });
    }

    const taskDescription = taskDescriptionCached;

    const merged = await fetchMergedTaskOrderHistory(pool, id, orderId);
    const newHistory = (merged || []).filter((r) => r && r.id != null && Number(r.id) > afterH);
    let nextH = afterH;
    for (const r of newHistory) {
      const n = Number(r.id);
      if (Number.isFinite(n) && n > nextH) nextH = n;
    }

    let photo_events = [];
    let nextP = afterP;
    try {
      /** @type {Record<number, any>} */
      const photoById = {};
      try {
        const [r] = await pool.query(
          'SELECT id, task_id, photo_name, proof_type, date_created, ip_address FROM mt_driver_task_photo WHERE task_id = ? AND id > ? ORDER BY id ASC',
          [id, afterP]
        );
        for (const row of r || []) {
          if (row && row.id != null) photoById[Number(row.id)] = row;
        }
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
        const [r] = await pool.query(
          'SELECT id, task_id, photo_name, date_created, ip_address FROM mt_driver_task_photo WHERE task_id = ? AND id > ? ORDER BY id ASC',
          [id, afterP]
        );
        for (const row of r || []) {
          if (row && row.id != null) photoById[Number(row.id)] = row;
        }
      }

      const oid =
        orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0'
          ? parseInt(String(orderId), 10)
          : NaN;
      if (Number.isFinite(oid) && oid > 0) {
        try {
          const [r2] = await pool.query(
            'SELECT id, task_id, order_id, photo_name, proof_type, driver_id, date_created, ip_address FROM mt_driver_task_photo WHERE order_id = ? AND (task_id IS NULL OR task_id = 0) AND id > ? ORDER BY id ASC',
            [oid, afterP]
          );
          for (const row of r2 || []) {
            if (row && row.id != null) photoById[Number(row.id)] = row;
          }
        } catch (e) {
          if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
        }
      }

      photo_events = Object.values(photoById)
        .sort((a, b) => {
          const ta = a.date_created ? new Date(a.date_created).getTime() : 0;
          const tb = b.date_created ? new Date(b.date_created).getTime() : 0;
          if (ta !== tb) return ta - tb;
          return Number(a.id) - Number(b.id);
        })
        .map((row) => {
          const proofType = normalizeStoredProofType(row.proof_type, row.photo_name);
          const proofUrl = buildTaskProofImageUrl(row.photo_name);
          if (!proofUrl) {
            console.warn('[tasks/:id/timeline-updates] proof URL missing', {
              task_id: id,
              photo_id: row.id,
              proof_type: proofType,
              photo_name: row.photo_name || null,
            });
          }
          return {
            ...row,
            task_id: row.task_id || id,
            proof_type: proofType,
            proof_url: proofUrl,
            eventType: proofType === 'receipt' ? 'proof_of_receipt' : 'proof_of_delivery',
            timestamp: row.date_created || null,
            taskId: row.task_id || id,
            driverId: row.driver_id != null ? Number(row.driver_id) : null,
            attachmentUrl: proofUrl || null,
            attachmentMeta: proofUrl
              ? null
              : {
                  reason: 'missing_url_mapping',
                  photo_name: row.photo_name || null,
                },
          };
        });
      if (photo_events.length > 0) {
        console.info('[tasks/:id/timeline-updates] proof events added', {
          task_id: id,
          count: photo_events.length,
          after_photo_id: afterP,
        });
      }
      for (const r of photo_events) {
        const n = Number(r.id);
        if (Number.isFinite(n) && n > nextP) nextP = n;
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }

    await fanOutTimelineMilestonesToRiderNotifications(pool, id, taskDescription, newHistory, photo_events);

    return res.json({
      cursor_history: nextH,
      cursor_photo: nextP,
      history_events: newHistory,
      photo_events,
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({
        cursor_history: afterH,
        cursor_photo: afterP,
        history_events: [],
        photo_events: [],
      });
    }
    console.error('[tasks/:id/timeline-updates]', e.message || e, e.code);
    return res.status(500).json({ error: e.message || 'Failed to load timeline updates' });
  }
});

/**
 * Dashboard: poll new mt_order_history rows for tasks visible on the task list (same date / hide rules as GET /tasks).
 * Query: ?date=YYYY-MM-DD&after_id=<last seen id>&team_id=<optional>
 */
router.get('/order-history/feed', async (req, res) => {
  const dateStr = req.query.date != null && String(req.query.date).trim() ? String(req.query.date).trim() : null;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'date query (YYYY-MM-DD) is required' });
  }
  const afterRaw = req.query.after_id != null ? parseInt(String(req.query.after_id), 10) : 0;
  const afterId = Number.isFinite(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
  const teamRaw = req.query.team_id != null && String(req.query.team_id).trim() !== '' ? parseInt(String(req.query.team_id), 10) : null;
  const teamId = Number.isFinite(teamRaw) ? teamRaw : null;

  let map = {};
  try {
    map = await getSettingsMap();
  } catch (_) {}

  const taskCondParts = ['(t.delivery_date = ? OR DATE(t.delivery_date) = ?)'];
  const taskParams = [dateStr, dateStr];
  if (teamId != null) {
    taskCondParts.push('t.team_id = ?');
    taskParams.push(teamId);
  }
  if (map.hide_pickup === '1') {
    taskCondParts.push("(t.trans_type IS NULL OR LOWER(TRIM(t.trans_type)) != 'pickup')");
  }
  if (map.hide_delivery === '1') {
    taskCondParts.push("(t.trans_type IS NULL OR LOWER(TRIM(t.trans_type)) != 'delivery')");
  }
  if (map.hide_successful === '1') {
    taskCondParts.push("(t.status IS NULL OR LOWER(TRIM(t.status)) NOT IN ('completed', 'successful', 'delivered'))");
  }
  const taskCondsSql = taskCondParts.join(' AND ');

  const historyLinkSql = `(
    (h.task_id IS NOT NULL AND CAST(h.task_id AS UNSIGNED) > 0 AND h.task_id = t.task_id)
    OR (
      (h.task_id IS NULL OR CAST(h.task_id AS UNSIGNED) = 0)
      AND h.order_id IS NOT NULL AND CAST(h.order_id AS UNSIGNED) > 0
      AND h.order_id = t.order_id
    )
  )`;

  try {
    if (afterId === 0) {
      // INNER JOIN avoids scanning mt_order_history with a per-row EXISTS (very slow on large history tables).
      const cursorSql = `
        SELECT COALESCE(MAX(h.id), 0) AS max_history_id
        FROM mt_order_history h
        INNER JOIN mt_driver_task t ON ${historyLinkSql}
        WHERE ${taskCondsSql}`;
      const [rows] = await pool.query(cursorSql, [...taskParams]);
      const cursor = rows && rows[0] ? Number(rows[0].max_history_id) || 0 : 0;
      /* Same as timeline bootstrap: incremental feed uses id > cursor, so existing rows never arrive — fan-out up to cursor once (dedupe prevents duplicates). */
      if (cursor > 0) {
        const fanSql = `
      SELECT h.id, h.order_id, h.status, h.remarks, h.date_created, h.update_by_type,
        COALESCE(
          NULLIF(TRIM(h.update_by_name), ''),
          NULLIF(TRIM(CONCAT(COALESCE(d.first_name, ''), ' ', COALESCE(d.last_name, ''))), ''),
          NULLIF(TRIM(d.username), '')
        ) AS update_by_name,
        h.reason, h.notes,
        t.task_id AS resolved_task_id
      FROM mt_order_history h
      INNER JOIN mt_driver_task t ON ${historyLinkSql}
      LEFT JOIN mt_driver d ON LOWER(TRIM(h.update_by_type)) = 'driver'
        AND h.update_by_id IS NOT NULL AND CAST(h.update_by_id AS UNSIGNED) = d.driver_id
      WHERE ${taskCondsSql}
      AND h.id <= ?
      ORDER BY h.id ASC
      LIMIT 5000`;
        try {
          const [fanRows] = await pool.query(fanSql, [...taskParams, cursor]);
          const fanList = (fanRows || []).map((row) => ({
            id: row.id,
            order_id: row.order_id,
            status: row.status,
            remarks: row.remarks,
            date_created: row.date_created,
            update_by_type: row.update_by_type,
            update_by_name: row.update_by_name,
            reason: row.reason,
            notes: row.notes,
            resolved_task_id: row.resolved_task_id,
          }));
          fanOutOrderHistoryFeedEventsToRiderNotifications(pool, fanList).catch((err) => {
            console.warn('[order-history/feed] bootstrap notify fan-out', err && err.message ? err.message : err);
          });
        } catch (fanErr) {
          console.warn('[order-history/feed] bootstrap fan-out query', fanErr.message || fanErr);
        }
      }
      return res.json({ cursor, events: [] });
    }

    const listSql = `
      SELECT h.id, h.order_id, h.status, h.remarks, h.date_created, h.update_by_type,
        COALESCE(
          NULLIF(TRIM(h.update_by_name), ''),
          NULLIF(TRIM(CONCAT(COALESCE(d.first_name, ''), ' ', COALESCE(d.last_name, ''))), ''),
          NULLIF(TRIM(d.username), '')
        ) AS update_by_name,
        h.reason, h.notes,
        t.task_id AS resolved_task_id
      FROM mt_order_history h
      INNER JOIN mt_driver_task t ON ${historyLinkSql}
      LEFT JOIN mt_driver d ON LOWER(TRIM(h.update_by_type)) = 'driver'
        AND h.update_by_id IS NOT NULL AND CAST(h.update_by_id AS UNSIGNED) = d.driver_id
      WHERE ${taskCondsSql}
      AND h.id > ?
      ORDER BY h.id ASC
      LIMIT 40`;
    const [events] = await pool.query(listSql, [...taskParams, afterId]);
    const list = (events || []).map((row) => ({
      id: row.id,
      order_id: row.order_id,
      status: row.status,
      remarks: row.remarks,
      date_created: row.date_created,
      update_by_type: row.update_by_type,
      update_by_name: row.update_by_name,
      reason: row.reason,
      notes: row.notes,
      resolved_task_id: row.resolved_task_id,
    }));
    let nextCursor = afterId;
    for (const ev of list) {
      const n = Number(ev.id);
      if (Number.isFinite(n) && n > nextCursor) nextCursor = n;
    }
    if (list.length > 0) {
      fanOutOrderHistoryFeedEventsToRiderNotifications(pool, list).catch((err) => {
        console.warn('[order-history/feed] notify fan-out', err && err.message ? err.message : err);
      });
    }
    return res.json({ cursor: nextCursor, events: list });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ cursor: afterId, events: [] });
    }
    console.error('[order-history/feed]', e.message || e, e.code);
    return res.status(200).json({ cursor: afterId, events: [] });
  }
});

/**
 * Dashboard home: new `st_ordernew_history` rows for Mangan orders on the given delivery date (same date rule as GET /tasks errand rows).
 */
router.get('/order-history/errand-feed', async (req, res) => {
  const dateStr = req.query.date != null && String(req.query.date).trim() ? String(req.query.date).trim() : null;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'date query (YYYY-MM-DD) is required' });
  }
  const afterRaw = req.query.after_id != null ? parseInt(String(req.query.after_id), 10) : 0;
  const afterId = Number.isFinite(afterRaw) && afterRaw >= 0 ? afterRaw : 0;

  if (!errandWibPool) {
    return res.json({ cursor: 0, events: [] });
  }

  const dateExpr = `DATE(COALESCE(o.delivery_date, o.created_at, o.date_created))`;

  try {
    if (afterId === 0) {
      const [[row]] = await errandWibPool.query(
        `SELECT COALESCE(MAX(h.id), 0) AS max_history_id
         FROM st_ordernew_history h
         INNER JOIN st_ordernew o ON o.order_id = h.order_id
         WHERE ${dateExpr} = ?`,
        [dateStr]
      );
      const cursor = row && row.max_history_id != null ? Number(row.max_history_id) || 0 : 0;
      if (cursor > 0) {
        try {
          const [rawFan] = await errandWibPool.query(
            `SELECT h.*
             FROM st_ordernew_history h
             INNER JOIN st_ordernew o ON o.order_id = h.order_id
             WHERE ${dateExpr} = ?
             AND h.id <= ?
             ORDER BY h.id ASC
             LIMIT 5000`,
            [dateStr, cursor]
          );
          const fanList = (rawFan || []).map((h) =>
            mapStOrdernewHistoryRowToFeedEvent(h, h.order_reference ?? h.order_ref ?? null)
          );
          fanOutErrandHistoryFeedEventsToRiderNotifications(pool, errandWibPool, fanList).catch((err) => {
            console.warn('[order-history/errand-feed] bootstrap notify fan-out', err && err.message ? err.message : err);
          });
        } catch (fanErr) {
          console.warn('[order-history/errand-feed] bootstrap fan-out', fanErr.message || fanErr);
        }
      }
      return res.json({ cursor, events: [] });
    }

    const [rawRows] = await errandWibPool.query(
      `SELECT h.*
       FROM st_ordernew_history h
       INNER JOIN st_ordernew o ON o.order_id = h.order_id
       WHERE ${dateExpr} = ?
       AND h.id > ?
       ORDER BY h.id ASC
       LIMIT 40`,
      [dateStr, afterId]
    );

    const list = (rawRows || []).map((h) =>
      mapStOrdernewHistoryRowToFeedEvent(h, h.order_reference ?? h.order_ref ?? null)
    );
    let nextCursor = afterId;
    for (const ev of list) {
      const n = Number(ev.id);
      if (Number.isFinite(n) && n > nextCursor) nextCursor = n;
    }
    if (list.length > 0) {
      fanOutErrandHistoryFeedEventsToRiderNotifications(pool, errandWibPool, list).catch((err) => {
        console.warn('[order-history/errand-feed] notify fan-out', err && err.message ? err.message : err);
      });
    }
    return res.json({ cursor: nextCursor, events: list });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ cursor: afterId, events: [] });
    }
    console.error('[order-history/errand-feed]', e.message || e, e.code);
    return res.status(200).json({ cursor: afterId, events: [] });
  }
});

/**
 * Global cursor for mt_order_history — no delivery_date filter. Mounted from MainHeader on every page so
 * milestone notifications fan-out in near–real time without opening the task timeline or staying on /.
 * ?after_history_id=0 → { cursor: MAX(id) } only (client stores cursor). ?after_history_id=N → rows id>N, fan-out, advance cursor.
 */
router.get('/order-history/notify-since', async (req, res) => {
  const afterRaw = req.query.after_history_id != null ? parseInt(String(req.query.after_history_id), 10) : 0;
  const afterId = Number.isFinite(afterRaw) && afterRaw >= 0 ? afterRaw : 0;

  try {
    if (afterId === 0) {
      const [[row]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM mt_order_history');
      const cursor = row && row.m != null ? Number(row.m) || 0 : 0;
      return res.json({ cursor, processed: 0 });
    }

    const listSql = `
      SELECT h.id, h.order_id, h.status, h.remarks, h.date_created, h.update_by_type,
        COALESCE(
          NULLIF(TRIM(h.update_by_name), ''),
          NULLIF(TRIM(CONCAT(COALESCE(d.first_name, ''), ' ', COALESCE(d.last_name, ''))), ''),
          NULLIF(TRIM(d.username), '')
        ) AS update_by_name,
        h.reason, h.notes,
        (CASE
          WHEN h.task_id IS NOT NULL AND TRIM(CAST(h.task_id AS CHAR)) REGEXP '^[0-9]+$' AND CAST(h.task_id AS UNSIGNED) > 0
          THEN CAST(h.task_id AS UNSIGNED)
          ELSE (
            SELECT MIN(t2.task_id) FROM mt_driver_task t2
            WHERE t2.order_id = h.order_id AND h.order_id IS NOT NULL AND CAST(h.order_id AS UNSIGNED) > 0
            LIMIT 1
          )
        END) AS resolved_task_id
      FROM mt_order_history h
      LEFT JOIN mt_driver d ON LOWER(TRIM(h.update_by_type)) = 'driver'
        AND h.update_by_id IS NOT NULL AND CAST(h.update_by_id AS UNSIGNED) = d.driver_id
      WHERE h.id > ?
      ORDER BY h.id ASC
      LIMIT 40`;

    const [events] = await pool.query(listSql, [afterId]);
    const list = (events || []).map((row) => ({
      id: row.id,
      order_id: row.order_id,
      status: row.status,
      remarks: row.remarks,
      date_created: row.date_created,
      update_by_type: row.update_by_type,
      update_by_name: row.update_by_name,
      reason: row.reason,
      notes: row.notes,
      resolved_task_id: row.resolved_task_id,
    }));

    let nextCursor = afterId;
    for (const ev of list) {
      const n = Number(ev.id);
      if (Number.isFinite(n) && n > nextCursor) nextCursor = n;
    }
    if (list.length > 0) {
      fanOutOrderHistoryFeedEventsToRiderNotifications(pool, list).catch((err) => {
        console.warn('[order-history/notify-since]', err && err.message ? err.message : err);
      });
    }
    return res.json({ cursor: nextCursor, processed: list.length });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ cursor: afterId, processed: 0 });
    }
    console.error('[order-history/notify-since]', e.message || e, e.code);
    return res.status(200).json({ cursor: afterId, processed: 0 });
  }
});

/** Global st_ordernew_history cursor (Mangan) — same pattern as notify-since. */
router.get('/order-history/errand-notify-since', async (req, res) => {
  const afterRaw = req.query.after_history_id != null ? parseInt(String(req.query.after_history_id), 10) : 0;
  const afterId = Number.isFinite(afterRaw) && afterRaw >= 0 ? afterRaw : 0;

  if (!errandWibPool) {
    return res.json({ cursor: 0, processed: 0 });
  }

  try {
    if (afterId === 0) {
      const [[row]] = await errandWibPool.query('SELECT COALESCE(MAX(id), 0) AS m FROM st_ordernew_history');
      const cursor = row && row.m != null ? Number(row.m) || 0 : 0;
      return res.json({ cursor, processed: 0 });
    }

    const [rawRows] = await errandWibPool.query(
      'SELECT h.* FROM st_ordernew_history h WHERE h.id > ? ORDER BY h.id ASC LIMIT 40',
      [afterId]
    );
    const list = (rawRows || []).map((h) =>
      mapStOrdernewHistoryRowToFeedEvent(h, h.order_reference ?? h.order_ref ?? null)
    );
    let nextCursor = afterId;
    for (const ev of list) {
      const n = Number(ev.id);
      if (Number.isFinite(n) && n > nextCursor) nextCursor = n;
    }
    if (list.length > 0) {
      fanOutErrandHistoryFeedEventsToRiderNotifications(pool, errandWibPool, list).catch((err) => {
        console.warn('[order-history/errand-notify-since]', err && err.message ? err.message : err);
      });
    }
    return res.json({ cursor: nextCursor, processed: list.length });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ cursor: afterId, processed: 0 });
    }
    console.error('[order-history/errand-notify-since]', e.message || e, e.code);
    return res.status(200).json({ cursor: afterId, processed: 0 });
  }
});

/**
 * Global cursor for mt_driver_task_photo (rider proof / delivery photos). Same pattern as notify-since so
 * admins get bell + sound without opening the task timeline.
 * ?after_photo_id=0 → { cursor: MAX(id) } only. ?after_photo_id=N → rows id>N, fan-out, new cursor.
 */
router.get('/order-history/task-photo-notify-since', async (req, res) => {
  const afterRaw = req.query.after_photo_id != null ? parseInt(String(req.query.after_photo_id), 10) : 0;
  const afterId = Number.isFinite(afterRaw) && afterRaw >= 0 ? afterRaw : 0;

  try {
    if (afterId === 0) {
      const [[row]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM mt_driver_task_photo');
      const cursor = row && row.m != null ? Number(row.m) || 0 : 0;
      return res.json({ cursor, processed: 0 });
    }

    const listSqlExtended = `
      SELECT p.id, p.task_id, p.photo_name, p.proof_type, p.date_created,
        t.order_id,
        t.task_description,
        t.driver_id,
        d.first_name, d.last_name, d.username
      FROM mt_driver_task_photo p
      INNER JOIN mt_driver_task t ON t.task_id = p.task_id
      LEFT JOIN mt_driver d ON d.driver_id = t.driver_id
      WHERE p.id > ?
      ORDER BY p.id ASC
      LIMIT 40`;
    const listSqlBasic = `
      SELECT p.id, p.task_id, p.photo_name, p.date_created,
        t.order_id,
        t.task_description,
        t.driver_id,
        d.first_name, d.last_name, d.username
      FROM mt_driver_task_photo p
      INNER JOIN mt_driver_task t ON t.task_id = p.task_id
      LEFT JOIN mt_driver d ON d.driver_id = t.driver_id
      WHERE p.id > ?
      ORDER BY p.id ASC
      LIMIT 40`;

    let rows;
    try {
      const [r] = await pool.query(listSqlExtended, [afterId]);
      rows = r;
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      const [r] = await pool.query(listSqlBasic, [afterId]);
      rows = r;
    }
    const list = rows || [];
    let nextCursor = afterId;
    for (const r of list) {
      const n = Number(r.id);
      if (Number.isFinite(n) && n > nextCursor) nextCursor = n;
    }
    if (list.length > 0) {
      fanOutGlobalTaskPhotoNotifySinceRows(pool, list).catch((err) => {
        console.warn('[order-history/task-photo-notify-since]', err && err.message ? err.message : err);
      });
    }
    return res.json({ cursor: nextCursor, processed: list.length });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ cursor: afterId, processed: 0 });
    }
    console.error('[order-history/task-photo-notify-since]', e.message || e, e.code);
    return res.status(200).json({ cursor: afterId, processed: 0 });
  }
});

/** Prefer explicit *_id columns before generic names that may be varchar (e.g. payment_type-style). */
const MT_ORDER_PAYMENT_PROVIDER_FK_CANDIDATES = [
  'payment_provider_id',
  'pyr_payment_provider_id',
  'pyr_provider_id',
  'payment_id',
  'card_id',
  'payment_provider',
];

let mtOrderPaymentProviderFkColumn;

async function resolveMtOrderPaymentProviderFkColumn() {
  if (mtOrderPaymentProviderFkColumn !== undefined) return mtOrderPaymentProviderFkColumn;
  try {
    const ph = MT_ORDER_PAYMENT_PROVIDER_FK_CANDIDATES.map(() => '?').join(',');
    const fieldArgs = MT_ORDER_PAYMENT_PROVIDER_FK_CANDIDATES.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mt_order'
       AND COLUMN_NAME IN (${ph})
       ORDER BY FIELD(COLUMN_NAME, ${fieldArgs})
       LIMIT 1`,
      [...MT_ORDER_PAYMENT_PROVIDER_FK_CANDIDATES, ...MT_ORDER_PAYMENT_PROVIDER_FK_CANDIDATES]
    );
    mtOrderPaymentProviderFkColumn = rows[0]?.COLUMN_NAME || null;
  } catch {
    mtOrderPaymentProviderFkColumn = null;
  }
  return mtOrderPaymentProviderFkColumn;
}

/** mt_order row plus payment_card_label from mt_payment_provider.payment_name (legacy UI "Card#"). */
async function selectOrderRowWithPaymentProvider(orderId) {
  const fk = await resolveMtOrderPaymentProviderFkColumn();
  if (!fk) {
    const [orderRows] = await pool.query('SELECT * FROM mt_order WHERE order_id = ? LIMIT 1', [orderId]);
    return orderRows[0] || null;
  }
  const fkEsc = `\`${String(fk).replace(/`/g, '')}\``;
  try {
    const [orderRows] = await pool.query(
      `SELECT o.*, pp.payment_name AS payment_card_label
       FROM mt_order o
       LEFT JOIN mt_payment_provider pp ON pp.id = o.${fkEsc}
       WHERE o.order_id = ? LIMIT 1`,
      [orderId]
    );
    return orderRows[0] || null;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' && /mt_payment_provider/i.test(String(e.sqlMessage || ''))) {
      const [orderRows] = await pool.query('SELECT * FROM mt_order WHERE order_id = ? LIMIT 1', [orderId]);
      return orderRows[0] || null;
    }
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      mtOrderPaymentProviderFkColumn = null;
      const [orderRows] = await pool.query('SELECT * FROM mt_order WHERE order_id = ? LIMIT 1', [orderId]);
      return orderRows[0] || null;
    }
    throw e;
  }
}

// ---- Single task (for task details) ----
router.get('/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  let rows;
  try {
    [rows] = await pool.query(
      `SELECT t.*, CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS driver_name,
        d.phone AS driver_phone, d.team_id, tt.team_name
       FROM mt_driver_task t
       LEFT JOIN mt_driver d ON t.driver_id = d.driver_id
       LEFT JOIN mt_driver_team tt ON d.team_id = tt.team_id
       WHERE t.task_id = ?`,
      [id]
    );
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(404).json({ error: 'Task not found' });
    }
    throw e;
  }
  if (!rows || !rows.length) return res.status(404).json({ error: 'Task not found' });
  const task = rows[0];
  const result = { task };

  const orderId = task.order_id;
  const orderIdForProofsEarly =
    task.order_id != null && String(task.order_id).trim() !== ''
      ? parseInt(String(task.order_id), 10)
      : NaN;
  const historyPromise = (async () => {
    try {
      return await fetchMergedTaskOrderHistory(pool, id, task.order_id);
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return [];
      throw e;
    }
  })();
  const proofsPromise = fetchTaskProofPhotosWithUrls(
    pool,
    id,
    Number.isFinite(orderIdForProofsEarly) && orderIdForProofsEarly > 0 ? orderIdForProofsEarly : null
  );

  if (orderId) {
    try {
      result.order = await selectOrderRowWithPaymentProvider(orderId);
      if (result.order) {
        const [detailRows] = await pool.query('SELECT * FROM mt_order_details WHERE order_id = ? ORDER BY id', [orderId]);
        const merchantId = result.order.merchant_id;
        let withCats = await attachOrderDetailCategories(pool, detailRows || [], merchantId);
        try {
          withCats = await enrichOrderDetailsWithSubcategoryAddons(pool, withCats);
        } catch (e) {
          if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
        }
        result.order_details = withCats;
        if (merchantId) {
          const [merchantRows] = await pool.query('SELECT merchant_id, restaurant_name, restaurant_phone, contact_name, contact_phone, contact_email, street, city, state, post_code FROM mt_merchant WHERE merchant_id = ? LIMIT 1', [merchantId]);
          result.merchant = merchantRows.length ? merchantRows[0] : null;
        } else result.merchant = null;
        const statsId = result.order.stats_id;
        if (statsId) {
          const [statusRows] = await pool.query('SELECT stats_id, description, date_created FROM mt_order_status WHERE stats_id = ? ORDER BY date_created DESC LIMIT 1', [statsId]);
          result.order_status = statusRows.length ? statusRows[0] : null;
        }
        const [statusTimelineRows] = await pool.query(
          'SELECT stats_id, description, date_created FROM mt_order_status WHERE merchant_id = ? ORDER BY date_created DESC LIMIT 20',
          [result.order.merchant_id]
        );
        result.order_status_timeline = statusTimelineRows || [];
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      result.order = null;
      result.order_details = [];
      result.merchant = null;
      result.order_status = null;
      result.order_status_timeline = [];
    }
  } else {
    result.order = null;
    result.order_details = [];
    result.merchant = null;
    result.order_status = null;
    result.order_status_timeline = [];
  }

  result.order_delivery_address = null;
  if (orderId) {
    try {
      const [addrRows] = await pool.query(
        'SELECT location_name, google_lat, google_lng, street, city, state, zipcode, country, formatted_address FROM mt_order_delivery_address WHERE order_id = ? ORDER BY id DESC LIMIT 1',
        [orderId]
      );
      if (addrRows && addrRows.length) {
        result.order_delivery_address = addrRows[0];
        const la = parseFloat(addrRows[0].google_lat);
        const ln = parseFloat(addrRows[0].google_lng);
        if (Number.isFinite(la) && Number.isFinite(ln)) {
          result.task.task_lat = la;
          result.task.task_lng = ln;
        }
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }

  // Resolve merchant from task.dropoff_merchant when numeric (same as task list JOIN m2)
  if (!result.merchant && task.dropoff_merchant != null && String(task.dropoff_merchant).trim() !== '' && /^\d+$/.test(String(task.dropoff_merchant).trim())) {
    try {
      const dropoffId = parseInt(String(task.dropoff_merchant).trim(), 10);
      const [mRows] = await pool.query('SELECT merchant_id, restaurant_name, restaurant_phone, contact_name, contact_phone, contact_email, street, city, state, post_code FROM mt_merchant WHERE merchant_id = ? LIMIT 1', [dropoffId]);
      if (mRows && mRows.length) result.merchant = mRows[0];
    } catch (_) {}
  }

  // Attach restaurant_name to task for UI (matches /tasks list behavior)
  if (result.merchant?.restaurant_name && (!result.task.restaurant_name || !String(result.task.restaurant_name).trim())) {
    result.task.restaurant_name = result.merchant.restaurant_name;
  }
  if (!result.task.restaurant_name || !String(result.task.restaurant_name).trim()) {
    try {
      const [nameRows] = await pool.query(
        `SELECT COALESCE(m.restaurant_name, m2.restaurant_name) AS restaurant_name
         FROM mt_driver_task t
         LEFT JOIN mt_order o ON t.order_id = o.order_id
         LEFT JOIN mt_merchant m ON o.merchant_id = m.merchant_id
         LEFT JOIN mt_merchant m2 ON t.dropoff_merchant REGEXP '^[0-9]+$' AND m2.merchant_id = t.dropoff_merchant
         WHERE t.task_id = ?
         LIMIT 1`,
        [id]
      );
      const rn = nameRows && nameRows.length ? String(nameRows[0].restaurant_name || '').trim() : '';
      if (rn) result.task.restaurant_name = rn;
    } catch (_) {}
  }

  const [orderHistoryRows, proofPack] = await Promise.all([historyPromise, proofsPromise]);
  result.order_history = orderHistoryRows;

  try {
    const advNote = await fetchLatestAdvanceOrderNoteForTask(pool, id, task.order_id);
    if (advNote) result.task.advance_order_note = advNote;
  } catch (_) {}

  result.task_photos = proofPack.task_photos;
  result.proof_images = proofPack.proof_images;
  result.proof_receipt_url = proofPack.proof_receipt_url;
  result.proof_delivery_url = proofPack.proof_delivery_url;

  return res.json(result);
});

// ---- Task photo image (served from DB: BLOB or base64) ----
router.get('/task-photos/:id/image', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send('Invalid photo id');
  try {
    const [rows] = await pool.query(
      'SELECT photo_data, image_data, photo, image, photo_base64, image_base64 FROM mt_driver_task_photo WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows || !rows.length) return res.status(404).send('Photo not found');
    const row = rows[0];
    let buffer = null;
    let contentType = 'image/jpeg';
    if (row.photo_data && Buffer.isBuffer(row.photo_data)) {
      buffer = row.photo_data;
    } else if (row.image_data && Buffer.isBuffer(row.image_data)) {
      buffer = row.image_data;
    } else if (row.photo && Buffer.isBuffer(row.photo)) {
      buffer = row.photo;
    } else if (row.image && Buffer.isBuffer(row.image)) {
      buffer = row.image;
    } else if (row.photo_base64 && typeof row.photo_base64 === 'string') {
      buffer = Buffer.from(row.photo_base64, 'base64');
    } else if (row.image_base64 && typeof row.image_base64 === 'string') {
      buffer = Buffer.from(row.image_base64, 'base64');
    }
    if (!buffer || buffer.length === 0) return res.status(404).send('No image data');
    res.set('Cache-Control', 'private, max-age=3600');
    res.type(contentType).send(buffer);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        const [rows2] = await pool.query('SELECT * FROM mt_driver_task_photo WHERE id = ? LIMIT 1', [id]);
        if (!rows2 || !rows2.length) return res.status(404).send('Photo not found');
        const row = rows2[0];
        for (const key of Object.keys(row)) {
          if (Buffer.isBuffer(row[key])) {
            res.set('Cache-Control', 'private, max-age=3600');
            return res.type('image/jpeg').send(row[key]);
          }
          if (typeof row[key] === 'string' && /^[A-Za-z0-9+/=]+$/.test(row[key]) && row[key].length > 100) {
            const buf = Buffer.from(row[key], 'base64');
            if (buf.length > 0) {
              res.set('Cache-Control', 'private, max-age=3600');
              return res.type('image/jpeg').send(buf);
            }
          }
        }
      } catch (_) {}
      return res.status(404).send('No image column found');
    }
    throw e;
  }
});

/** Bearing in degrees (0-360) from point A to B. North = 0, East = 90. */
function getBearing(fromLat, fromLng, toLat, toLng) {
  const lat1 = (fromLat * Math.PI) / 180;
  const lat2 = (toLat * Math.PI) / 180;
  const dLng = ((toLng - fromLng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  let br = (Math.atan2(y, x) * 180) / Math.PI;
  return (br + 360) % 360;
}

/** Compass label for turn-by-turn (e.g. "North west") from bearing 0-360. */
function bearingToCompass(bearing) {
  if (bearing == null || Number.isNaN(bearing)) return null;
  const b = ((Number(bearing) % 360) + 360) % 360;
  const labels = [
    { max: 22.5, label: 'North' },
    { max: 67.5, label: 'North east' },
    { max: 112.5, label: 'East' },
    { max: 157.5, label: 'South east' },
    { max: 202.5, label: 'South' },
    { max: 247.5, label: 'South west' },
    { max: 292.5, label: 'West' },
    { max: 337.5, label: 'North west' },
    { max: 360, label: 'North' },
  ];
  for (const { max, label } of labels) {
    if (b <= max) return label;
  }
  return 'North';
}

/** Reference point for task-card compass (same as rider dashboard client). */
const BAGUIO_CENTER_LAT = 16.4023;
const BAGUIO_CENTER_LNG = 120.596;

// ---- Tasks (mt_driver_task) ----
router.get('/tasks', async (req, res) => {
  const { date, status, status_in } = req.query;
  const statusNormSql =
    "LOWER(REPLACE(REPLACE(TRIM(COALESCE(t.status,'')), ' ', ''), '_', ''))";
  let sql = `SELECT t.*, CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS driver_name,
    d.profile_photo AS driver_profile_photo,
    d.location_lat AS driver_lat, d.location_lng AS driver_lng,
    COALESCE(m.restaurant_name, m2.restaurant_name) AS restaurant_name,
    o.status AS order_status,
    o.delivery_time AS order_delivery_time,
    o.delivery_date AS order_delivery_date,
    o.date_created AS order_placed_at,
    del_addr.delivery_location_name, del_addr.delivery_google_lat, del_addr.delivery_google_lng,
    (
      SELECT COALESCE(NULLIF(TRIM(h.remarks), ''), NULLIF(TRIM(h.notes), ''), NULLIF(TRIM(h.remarks2), ''))
      FROM mt_order_history h
      WHERE (
        h.task_id = t.task_id
        OR (
          t.order_id IS NOT NULL AND CAST(t.order_id AS UNSIGNED) > 0
          AND h.order_id = t.order_id
          AND (h.task_id IS NULL OR CAST(h.task_id AS UNSIGNED) = 0)
        )
      )
      AND LOWER(REPLACE(REPLACE(TRIM(COALESCE(h.status,'')), ' ', ''), '_', '')) = 'advanceorder'
      ORDER BY h.date_created DESC, h.id DESC
      LIMIT 1
    ) AS advance_order_note
    FROM mt_driver_task t
    LEFT JOIN mt_driver d ON t.driver_id = d.driver_id
    LEFT JOIN mt_order o ON t.order_id = o.order_id
    LEFT JOIN mt_merchant m ON o.merchant_id = m.merchant_id
    LEFT JOIN mt_merchant m2 ON t.dropoff_merchant REGEXP '^[0-9]+$' AND m2.merchant_id = t.dropoff_merchant
    LEFT JOIN (
      SELECT da.order_id,
        da.location_name AS delivery_location_name,
        da.google_lat AS delivery_google_lat,
        da.google_lng AS delivery_google_lng
      FROM mt_order_delivery_address da
      INNER JOIN (
        SELECT order_id, MAX(id) AS max_id
        FROM mt_order_delivery_address
        GROUP BY order_id
      ) latest ON latest.order_id = da.order_id AND latest.max_id = da.id
    ) del_addr ON del_addr.order_id = t.order_id
    WHERE 1=1`;
  const params = [];
  if (date) {
    sql += ' AND (t.delivery_date = ? OR DATE(t.delivery_date) = ?)';
    params.push(date, date);
  }
  if (status_in) {
    const keys = String(status_in)
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/\s+/g, '').replace(/_/g, ''))
      .filter(Boolean);
    if (keys.length) {
      sql += ` AND ${statusNormSql} IN (${keys.map(() => '?').join(',')})`;
      params.push(...keys);
    }
  } else if (status) {
    sql += ' AND t.status = ?';
    params.push(status);
  }
  try {
    const map = await getSettingsMap();
    const hidePickup = map.hide_pickup_tasks === '1';
    const hideDelivery = map.hide_delivery_tasks === '1';
    const hideSuccessful = map.hide_successful_tasks === '1';
    if (hidePickup) {
      sql += " AND (t.trans_type IS NULL OR LOWER(TRIM(t.trans_type)) != 'pickup')";
    }
    if (hideDelivery) {
      sql += " AND (t.trans_type IS NULL OR LOWER(TRIM(t.trans_type)) != 'delivery')";
    }
    if (hideSuccessful) {
      sql += " AND (t.status IS NULL OR LOWER(TRIM(t.status)) NOT IN ('completed', 'successful', 'delivered'))";
    }
  } catch (_) {}
  sql += ' ORDER BY t.task_id DESC LIMIT 500';
  try {
    let [rows] = await pool.query(sql, params);
    rows = (rows || []).map((r) => {
      const out = { ...r };
      delete out.driver_lat;
      delete out.driver_lng;
      delete out.delivery_google_lat;
      delete out.delivery_google_lng;
      delete out.delivery_location_name;
      const delLat = parseFloat(r.delivery_google_lat);
      const delLng = parseFloat(r.delivery_google_lng);
      const delOk = Number.isFinite(delLat) && Number.isFinite(delLng);
      const tLat = parseFloat(r.task_lat);
      const tLng = parseFloat(r.task_lng);
      const mapLat = delOk ? delLat : tLat;
      const mapLng = delOk ? delLng : tLng;
      if (Number.isFinite(mapLat)) out.task_lat = mapLat;
      if (Number.isFinite(mapLng)) out.task_lng = mapLng;
      const lm = r.delivery_location_name != null ? String(r.delivery_location_name).trim() : '';
      if (lm) out.delivery_landmark = lm;
      /* Compass = sector of drop-off vs city center (delivery coords), not driver→customer or merchant. */
      if (Number.isFinite(mapLat) && Number.isFinite(mapLng)) {
        out.direction = bearingToCompass(getBearing(BAGUIO_CENTER_LAT, BAGUIO_CENTER_LNG, mapLat, mapLng));
      } else if (r.direction != null && String(r.direction).trim() !== '') {
        out.direction = String(r.direction).trim();
      } else {
        out.direction = null;
      }
      const advNote = r.advance_order_note != null ? String(r.advance_order_note).trim() : '';
      if (advNote) out.advance_order_note = advNote;
      else delete out.advance_order_note;
      return out;
    });

    const includeErrand = req.query.include_errand !== '0';
    if (includeErrand && date) {
      try {
        const [eRows] = await errandWibPool.query(
          `SELECT * FROM st_ordernew
           WHERE DATE(COALESCE(delivery_date, created_at, date_created)) = ?
           ${ST_ORDERNEW_EXCLUDE_ADMIN_DELETED_SQL}
           ORDER BY order_id DESC
           LIMIT 500`,
          [date]
        );
        const list = eRows || [];
        const driverIds = [
          ...new Set(
            list.map((r) => r.driver_id).filter((id) => id != null && String(id).trim() !== '')
          ),
        ].map((id) => parseInt(String(id), 10)).filter((n) => Number.isFinite(n));
        const errandDriverById = await fetchErrandStDriversByIds(errandWibPool, driverIds);
        await attachErrandDriverGroups(errandWibPool, errandDriverById);
        const needMtNames = driverIds.filter((id) => !errandDriverById.has(String(id)) || !errandDriverById.get(String(id))?.full_name);
        const mtDriverNameById = new Map();
        if (needMtNames.length) {
          const ph = needMtNames.map(() => '?').join(',');
          try {
            const [drows] = await pool.query(
              `SELECT driver_id, CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name
               FROM mt_driver WHERE driver_id IN (${ph})`,
              needMtNames
            );
            for (const d of drows || []) {
              mtDriverNameById.set(String(d.driver_id), String(d.full_name || '').trim() || null);
            }
          } catch (_) {
            /* optional */
          }
        }
        const teamIdsForErrand = [
          ...new Set(
            [...errandDriverById.values()]
              .map((v) => v.team_id)
              .filter((tid) => tid != null && Number.isFinite(tid) && tid > 0)
          ),
        ];
        const teamNameById = await fetchMtDriverTeamNamesByIds(pool, teamIdsForErrand);
        const merchantIds = list
          .map((r) => r.merchant_id)
          .filter((id) => id != null && String(id).trim() !== '')
          .map((id) => parseInt(String(id), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        const merchantById = await fetchErrandMerchantsByIds(errandWibPool, merchantIds);
        const clientIds = list
          .map((r) => r.client_id)
          .filter((id) => id != null && String(id).trim() !== '')
          .map((id) => parseInt(String(id), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        const clientById = await fetchErrandClientsByIds(errandWibPool, clientIds);
        const clientAddressesByClientId = await fetchErrandClientAddressesByClientIds(errandWibPool, clientIds);
        const orderIds = list
          .map((r) => r.order_id)
          .filter((id) => id != null && String(id).trim() !== '')
          .map((id) => parseInt(String(id), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        const latestHistoryStatusByOrderId = await fetchErrandLatestHistoryStatusByOrderIds(errandWibPool, orderIds);
        const errandMapped = list.map((r) =>
          mapStOrderRowToTaskListRow(
            r,
            errandDriverById,
            mtDriverNameById,
            merchantById,
            clientById,
            clientAddressesByClientId,
            latestHistoryStatusByOrderId,
            teamNameById
          )
        );
        rows = [...rows, ...errandMapped].sort((a, b) => {
          const ta = a.date_created ? new Date(a.date_created).getTime() : 0;
          const tb = b.date_created ? new Date(b.date_created).getTime() : 0;
          return tb - ta;
        });
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }

    await attachTimelineReadyForPickupFlags(pool, errandWibPool, rows);
    return res.json(rows);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json([]);
    }
    throw e;
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const {
      task_description, delivery_date, delivery_time, delivery_address, customer_name, contact_number,
      email_address, task_lat, task_lng, merchant_name, merchant_address, trans_type, payment_type, order_total_amount,
    } = req.body;
    const [result] = await pool.query(
      `INSERT INTO mt_driver_task (task_description, delivery_date, delivery_address, customer_name, contact_number,
        email_address, task_lat, task_lng, dropoff_merchant, drop_address, trans_type, status, date_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', NOW())`,
      [task_description || null, delivery_date || null, delivery_address || null, customer_name || null, contact_number || null,
        email_address || null, task_lat || null, task_lng || null, merchant_name || null, merchant_address || null, trans_type || null]
    );
    const taskId = result.insertId;
    try {
      await pool.query(
        `INSERT INTO mt_driver_bulk_push (push_title, push_message, status, date_created, date_process, ip_address)
         VALUES (?, ?, 'process', NOW(), NOW(), ?)`,
        ['New task', task_description || `Task #${taskId}`, req.ip || req.connection?.remoteAddress || null]
      );
    } catch (_) {}
    try {
      await sendPushToAllDrivers('New task', task_description || `Task #${taskId}`, { task_id: String(taskId), type: 'new_task' });
    } catch (_) {}
    await notifyAllDashboardAdmins(pool, {
      title: 'New task',
      message: ensureTaskIdMarkerInMessage(task_description || `Task #${taskId}`, taskId),
      type: 'new_task',
    }).catch(() => {});
    return res.json({ id: taskId, ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable. Please ensure mt_driver_task exists.' });
    }
    throw e;
  }
});

router.put('/tasks/:id/assign', express.json(), async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
  const driverId = parseInt(req.body?.driver_id, 10);
  const teamIdRaw = req.body?.team_id;
  const teamId = teamIdRaw != null && String(teamIdRaw).trim() !== '' ? parseInt(teamIdRaw, 10) : null;
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'driver_id required' });
  try {
    const [[task]] = await pool.query(
      'SELECT task_id, order_id, task_description, driver_id AS prev_driver_id FROM mt_driver_task WHERE task_id = ?',
      [taskId]
    );
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const prevDriverId = task.prev_driver_id;
    // Prefer setting team_id as well (if table has the column). Fall back gracefully.
    try {
      if (teamId && Number.isFinite(teamId)) {
        await pool.query('UPDATE mt_driver_task SET driver_id = ?, team_id = ?, status = ? WHERE task_id = ?', [driverId, teamId, 'assigned', taskId]);
      } else {
        await pool.query('UPDATE mt_driver_task SET driver_id = ?, status = ? WHERE task_id = ?', [driverId, 'assigned', taskId]);
      }
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        await pool.query('UPDATE mt_driver_task SET driver_id = ?, status = ? WHERE task_id = ?', [driverId, 'assigned', taskId]);
      } else {
        throw e;
      }
    }
    try {
      const oid = task.order_id != null ? parseInt(String(task.order_id), 10) : NaN;
      if (Number.isFinite(oid) && oid > 0) {
        await updateMtOrderStatusIfDeliveryComplete(pool, oid, 'acknowledged');
      }
    } catch (_) {
      /* mt_order.status optional — do not fail assignment */
    }
    let assignHistoryInsertId = null;
    try {
      assignHistoryInsertId = await insertMtOrderHistoryRow(pool, {
        orderId: task?.order_id || null,
        taskId,
        status: 'acknowledged',
        remarks: 'Driver assigned',
        updateByType: 'admin',
        actorId: req.adminUser?.admin_id ?? null,
        actorDisplayName: formatActorFromAdminUser(req.adminUser),
      });
    } catch (_) {
      /* mt_order_history optional — do not fail assignment */
    }
    try {
      await notifyDashboardAfterMtTaskHistoryRow(pool, {
        taskId,
        orderId: task.order_id,
        taskDescription: task.task_description,
        statusRaw: 'acknowledged',
        actorLabel: formatActorFromAdminUser(req.adminUser),
        historyInsertId: assignHistoryInsertId,
        historyRowForClassify: {
          status: 'acknowledged',
          remarks: 'Driver assigned',
          reason: null,
          notes: null,
          update_by_type: 'admin',
        },
      });
    } catch (_) {}
    notifyCustomerRiderAssignedForFoodTaskFireAndForget(pool, {
      taskId,
      orderId: task.order_id,
      prevDriverId,
      newDriverId: driverId,
    });
    notifyRiderOrderPushAfterAdminAssignFireAndForget(pool, {
      orderId: task.order_id,
      prevDriverId,
      newDriverId: driverId,
    });
    // Rider leaves the FIFO queue once they receive a task; they rejoin only from the app.
    try {
      await pool.query(
        `UPDATE mt_driver_queue SET left_at = NOW(), status = ? WHERE driver_id = ? AND left_at IS NULL`,
        ['left', driverId]
      );
    } catch (_) {}
    try {
      await pool.query(
        `INSERT INTO mt_driver_pushlog (driver_id, push_title, push_message, push_type, task_id, order_id, date_created, date_process, is_read)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 0)`,
        [driverId, 'Task assigned', task.task_description || `Task #${taskId}`, 'task_assigned', taskId, task.order_id || null]
      );
    } catch (_) {}
    try {
      await sendPushToDriver(driverId, 'Task assigned', task.task_description || `Task #${taskId}`, { task_id: String(taskId), type: 'task_assigned' });
    } catch (_) {}
    await notifyAllDashboardAdmins(pool, {
      title: 'Task assigned',
      message: task.task_description || `Task #${taskId}`,
      type: 'task_assigned',
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable. Please ensure mt_driver_task exists.' });
    }
    throw e;
  }
});

// ---- Errand DB (wheninba_ErrandWib.st_ordernew): detail + assign (drivers: st_driver on ErrandWib; optional mt_driver name fallback) ----

/**
 * Append admin/dispatcher timeline row to st_ordernew_history (schema variants).
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {number} orderId
 * @param {string} statusCanonical
 * @param {string} [remarks]
 */
async function appendErrandAdminHistory(errandPool, orderId, statusCanonical, remarks) {
  const st = String(statusCanonical || '').trim().toLowerCase() || 'updated';
  const rem = remarks != null && String(remarks).trim() ? String(remarks).trim() : '';
  await insertStOrdernewHistoryRow(errandPool, {
    orderId,
    status: st,
    remarks: rem || undefined,
  });
}

router.get('/errand-orders/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  try {
    const [[row]] = await errandWibPool.query('SELECT * FROM st_ordernew WHERE order_id = ? LIMIT 1', [orderId]);
    if (!row) return res.status(404).json({ error: 'Errand order not found' });

    const did =
      row.driver_id != null && String(row.driver_id).trim() !== ''
        ? parseInt(String(row.driver_id), 10)
        : NaN;
    const mid =
      row.merchant_id != null && String(row.merchant_id).trim() !== ''
        ? parseInt(String(row.merchant_id), 10)
        : NaN;
    const cid =
      row.client_id != null && String(row.client_id).trim() !== '' ? parseInt(String(row.client_id), 10) : NaN;

    const latestHistoryPromise = errandWibPool
      .query('SELECT status FROM st_ordernew_history WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId])
      .then(([[hr]]) => (hr?.status != null ? String(hr.status).trim() : null))
      .catch(() => null);

    const proofsPromise = fetchErrandProofsForOrder(errandWibPool, orderId).catch(() => []);

    const [
      driverDetail,
      merchantRow,
      clientBundle,
      latestHistoryStatus,
      orderDetails,
      orderHistoryRows,
      proofs,
    ] = await Promise.all([
      Number.isFinite(did) && did > 0
        ? resolveErrandDriverDetail(errandWibPool, pool, did)
        : Promise.resolve(null),
      Number.isFinite(mid)
        ? fetchErrandMerchantsByIds(errandWibPool, [mid]).then((mmap) => mmap.get(String(mid)) || null)
        : Promise.resolve(null),
      (async () => {
        if (!Number.isFinite(cid) || cid <= 0) return { clientRow: null, clientAddressRow: null };
        const cmap = await fetchErrandClientsByIds(errandWibPool, [cid]);
        const clientRow = cmap.get(String(cid)) || null;
        const addrMap = await fetchErrandClientAddressesByClientIds(errandWibPool, [cid]);
        const addrList = addrMap.get(String(cid)) || [];
        const clientAddressRow = pickClientAddressRow(row, addrList);
        return { clientRow, clientAddressRow };
      })(),
      latestHistoryPromise,
      fetchErrandOrderLineItems(errandWibPool, orderId, row),
      fetchErrandOrderHistory(errandWibPool, orderId, row),
      proofsPromise,
    ]);

    const { clientRow, clientAddressRow } = clientBundle;

    const payload = buildErrandTaskDetailPayload(
      row,
      driverDetail,
      merchantRow,
      clientRow,
      clientAddressRow,
      latestHistoryStatus,
      orderDetails,
      orderHistoryRows
    );
    try {
      const taskPhotos = proofs.map((p) => ({
        id: p.id,
        task_id: null,
        errand_order_id: orderId,
        photo_name: p.photo_name,
        date_created: p.date_created,
        proof_url: p.proof_url,
        proof_type: p.proof_type,
      }));
      payload.task_photos = taskPhotos;
      payload.proof_images = proofs.map((p) => p.proof_url).filter(Boolean);
      const rec = proofs.filter((p) => p.proof_type === 'receipt');
      const del = proofs.filter((p) => p.proof_type === 'delivery');
      payload.proof_receipt_url = rec.length ? rec[rec.length - 1].proof_url || null : null;
      payload.proof_delivery_url = del.length ? del[del.length - 1].proof_url || null : null;
    } catch (_) {
      /* optional */
    }
    return res.json(payload);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(404).json({ error: 'Errand orders table not found' });
    }
    throw e;
  }
});

router.put('/errand-orders/:orderId/assign', express.json(), async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const driverId = parseInt(req.body?.driver_id, 10);
  if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'driver_id required' });
  try {
    let prevDriverId = null;
    try {
      const [[prevRow]] = await errandWibPool.query('SELECT driver_id FROM st_ordernew WHERE order_id = ? LIMIT 1', [
        orderId,
      ]);
      prevDriverId = prevRow?.driver_id ?? null;
    } catch (_) {
      prevDriverId = null;
    }

    let result;
    try {
      [result] = await errandWibPool.query(
        `UPDATE st_ordernew SET driver_id = ?, delivery_status = 'assigned', assigned_at = NOW(), date_modified = NOW() WHERE order_id = ?`,
        [driverId, orderId]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [result] = await errandWibPool.query(
          `UPDATE st_ordernew SET driver_id = ?, delivery_status = 'assigned', date_modified = NOW() WHERE order_id = ?`,
          [driverId, orderId]
        );
      } else {
        throw e;
      }
    }
    if (!result.affectedRows) return res.status(404).json({ error: 'Errand order not found' });
    try {
      await pool.query(
        `UPDATE mt_driver_queue SET left_at = NOW(), status = ? WHERE driver_id = ? AND left_at IS NULL`,
        ['left', driverId]
      );
    } catch (_) {}
    let errandAssignMsg = `Errand order #${orderId}`;
    try {
      const [[er]] = await errandWibPool.query(
        'SELECT order_reference, order_uuid FROM st_ordernew WHERE order_id = ? LIMIT 1',
        [orderId]
      );
      if (er?.order_reference != null && String(er.order_reference).trim()) {
        errandAssignMsg = `Errand ${String(er.order_reference).trim()}`;
      }
    } catch (_) {}
    try {
      await sendPushToDriver(driverId, 'Errand order assigned', errandAssignMsg, {
        order_id: String(orderId),
        type: 'errand_order_assigned',
      });
    } catch (_) {}
    await notifyAllDashboardAdmins(pool, {
      title: 'Errand assigned',
      message: errandAssignMsg,
      type: 'task_assigned',
    }).catch(() => {});
    notifyRiderOrderPushAfterAdminAssignFireAndForget(pool, {
      orderId,
      prevDriverId,
      newDriverId: driverId,
    });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(400).json({
        error:
          e.message ||
          'UPDATE failed — check st_ordernew columns (driver_id, delivery_status, assigned_at, date_modified).',
      });
    }
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Errand orders table not found' });
    }
    throw e;
  }
});

router.put('/errand-orders/:orderId', express.json(), async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  const body = req.body || {};
  try {
    const [[orderRow]] = await errandWibPool.query('SELECT * FROM st_ordernew WHERE order_id = ? LIMIT 1', [orderId]);
    if (!orderRow) return res.status(404).json({ error: 'Errand order not found' });

    let didSomething = false;

    const splitCustomerName = (full) => {
      const s = String(full ?? '').trim();
      if (!s) return { first_name: '', last_name: '' };
      const i = s.indexOf(' ');
      if (i === -1) return { first_name: s, last_name: '' };
      return { first_name: s.slice(0, i).trim(), last_name: s.slice(i + 1).trim() };
    };

    const toMysqlDatetime = (v) => {
      if (v == null || v === '') return null;
      const s = String(v).trim();
      if (s.length >= 16 && s[10] === 'T') return `${s.slice(0, 10)} ${s.slice(11, 16)}:00`;
      if (s.length >= 10) return `${s.slice(0, 10)} 00:00:00`;
      return s;
    };

    const cid =
      orderRow.client_id != null && String(orderRow.client_id).trim() !== ''
        ? parseInt(String(orderRow.client_id), 10)
        : NaN;

    if (Number.isFinite(cid) && cid > 0) {
      const cUp = [];
      const cParams = [];
      if (body.customer_name !== undefined) {
        const { first_name: fn, last_name: ln } = splitCustomerName(body.customer_name);
        cUp.push('first_name = ?', 'last_name = ?');
        cParams.push(fn || null, ln || null);
      }
      if (body.email_address !== undefined) {
        cUp.push('email_address = ?');
        cParams.push(String(body.email_address || '').trim() || null);
      }
      if (body.contact_number !== undefined) {
        const ph = String(body.contact_number || '').trim() || null;
        cUp.push('contact_phone = ?');
        cParams.push(ph);
      }
      if (cUp.length) {
        await errandWibPool.query(`UPDATE st_client SET ${cUp.join(', ')} WHERE client_id = ?`, [...cParams, cid]);
        didSomething = true;
      }

      if (body.delivery_address !== undefined) {
        const addrMap = await fetchErrandClientAddressesByClientIds(errandWibPool, [cid]);
        const addrList = addrMap.get(String(cid)) || [];
        const addrRow = pickClientAddressRow(orderRow, addrList);
        const aid = addrRow?.address_id != null ? parseInt(String(addrRow.address_id), 10) : NaN;
        const fa = String(body.delivery_address || '').trim();
        if (fa && Number.isFinite(aid)) {
          for (const col of ['formatted_address', 'formattedAddress', 'address1']) {
            try {
              await errandWibPool.query(`UPDATE st_client_address SET ${col} = ? WHERE address_id = ?`, [fa, aid]);
              didSomething = true;
              break;
            } catch (_) {
              /* column name differs */
            }
          }
        }
      }
    } else if (body.delivery_address !== undefined && String(body.delivery_address || '').trim() !== '') {
      const fa = String(body.delivery_address).trim();
      try {
        await errandWibPool.query(
          'UPDATE st_ordernew SET formatted_address = ?, date_modified = NOW() WHERE order_id = ?',
          [fa, orderId]
        );
        didSomething = true;
      } catch (_) {
        /* optional column */
      }
    }

    if (body.delivery_date !== undefined) {
      const mysqlDt = toMysqlDatetime(body.delivery_date);
      try {
        await errandWibPool.query(
          'UPDATE st_ordernew SET delivery_date = ?, date_modified = NOW() WHERE order_id = ?',
          [mysqlDt, orderId]
        );
        didSomething = true;
      } catch (_) {
        /* optional */
      }
    }

    if (body.task_description !== undefined && String(body.task_description || '').trim() !== '') {
      const t = String(body.task_description).trim();
      for (const col of ['delivery_instruction', 'special_instructions', 'admin_notes', 'order_notes', 'notes']) {
        try {
          await errandWibPool.query(
            `UPDATE st_ordernew SET ${col} = ?, date_modified = NOW() WHERE order_id = ?`,
            [t, orderId]
          );
          didSomething = true;
          break;
        } catch (_) {
          /* try next column */
        }
      }
    }

    if (!didSomething) return res.status(400).json({ error: 'No fields to update' });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Errand orders table not found' });
    }
    throw e;
  }
});

router.put('/errand-orders/:orderId/status', express.json(), async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  const { status, reason } = req.body || {};
  const raw = (status || '').toString().trim();
  if (!raw) return res.status(400).json({ error: 'status required' });
  const canon = normalizeIncomingStatusRaw(raw);
  if (!canon || !ERRAND_CANONICAL_STATUSES.has(canon)) {
    return res.status(400).json({
      error: `Invalid status. Allowed: ${[...ERRAND_CANONICAL_STATUSES].sort().join(', ')}`,
    });
  }
  const remarks = reason != null && String(reason).trim() ? String(reason).trim() : '';

  try {
    const [[row]] = await errandWibPool.query('SELECT order_id FROM st_ordernew WHERE order_id = ? LIMIT 1', [orderId]);
    if (!row) return res.status(404).json({ error: 'Errand order not found' });

    let result;
    if (canon === 'unassigned' || canon === 'cancelled' || canon === 'declined') {
      try {
        [result] = await errandWibPool.query(
          `UPDATE st_ordernew SET driver_id = NULL, delivery_status = ?, date_modified = NOW() WHERE order_id = ?`,
          [canon, orderId]
        );
      } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
          [result] = await errandWibPool.query(
            `UPDATE st_ordernew SET driver_id = 0, delivery_status = ?, date_modified = NOW() WHERE order_id = ?`,
            [canon, orderId]
          );
        } else {
          throw e;
        }
      }
    } else {
      try {
        [result] = await errandWibPool.query(
          `UPDATE st_ordernew SET delivery_status = ?, date_modified = NOW() WHERE order_id = ?`,
          [canon, orderId]
        );
      } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
          [result] = await errandWibPool.query(
            `UPDATE st_ordernew SET delivery_status = ? WHERE order_id = ?`,
            [canon, orderId]
          );
        } else {
          throw e;
        }
      }
    }
    if (!result.affectedRows) return res.status(404).json({ error: 'Errand order not found' });

    await appendErrandAdminHistory(errandWibPool, orderId, canon, remarks);
    try {
      const [[erSt]] = await errandWibPool.query(
        'SELECT order_reference FROM st_ordernew WHERE order_id = ? LIMIT 1',
        [orderId]
      );
      const lbl =
        erSt?.order_reference != null && String(erSt.order_reference).trim()
          ? `Mangan ${String(erSt.order_reference).trim()}`
          : `Mangan order #${orderId}`;
      const actor = formatActorFromAdminUser(req.adminUser);
      const payload = errandNotifyFromCanonical(orderId, lbl, canon, actor);
      if (payload) {
        const mCat = errandCanonicalToMilestoneCategory(canon);
        if (mCat) {
          const mk = milestoneDedupeKeyForErrand(orderId, mCat);
          if (mk && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, mk))) {
            /* feed or driver path already notified this milestone */
          } else {
            await notifyAllDashboardAdmins(pool, payload).catch(() => {});
          }
        } else {
          await notifyAllDashboardAdmins(pool, payload).catch(() => {});
        }
      }
    } catch (_) {}
    return res.json({ ok: true, status: canon });
  } catch (e) {
    if (e.errno === 1265 || (e.message && /Data truncated|Incorrect.*enum/i.test(String(e.message)))) {
      return res.status(400).json({
        error:
          'This status is not allowed by the errand database for delivery_status. Use a value your schema accepts or extend the column.',
      });
    }
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Errand orders table not found' });
    }
    throw e;
  }
});

router.delete('/errand-orders/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  try {
    const [[row]] = await errandWibPool.query('SELECT order_id FROM st_ordernew WHERE order_id = ? LIMIT 1', [orderId]);
    if (!row) return res.status(404).json({ error: 'Errand order not found' });

    await appendErrandAdminHistory(errandWibPool, orderId, 'cancelled', 'Task deleted by admin');

    let result;
    try {
      [result] = await errandWibPool.query(
        `UPDATE st_ordernew SET driver_id = NULL, delivery_status = 'cancelled', date_modified = NOW() WHERE order_id = ?`,
        [orderId]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [result] = await errandWibPool.query(
          `UPDATE st_ordernew SET driver_id = 0, delivery_status = 'cancelled', date_modified = NOW() WHERE order_id = ?`,
          [orderId]
        );
      } else {
        throw e;
      }
    }
    if (!result.affectedRows) return res.status(404).json({ error: 'Errand order not found' });
    try {
      await errandWibPool.query(`UPDATE st_ordernew SET status = 'cancelled' WHERE order_id = ?`, [orderId]);
    } catch (_) {
      /* status column may be missing or enum */
    }
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Errand orders table not found' });
    }
    throw e;
  }
});

// ---- updateTask (edit task fields) ----
router.put('/tasks/:id', express.json(), async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
  const body = req.body || {};
  const allowed = {
    task_description: body.task_description,
    delivery_address: body.delivery_address,
    customer_name: body.customer_name,
    contact_number: body.contact_number,
    delivery_date: body.delivery_date,
    email_address: body.email_address,
  };
  const updates = [];
  const params = [];
  for (const [key, value] of Object.entries(allowed)) {
    if (value === undefined) continue;
    updates.push(`${key} = ?`);
    params.push(value == null || value === '' ? null : String(value).trim() || null);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(taskId);
  try {
    const [result] = await pool.query(
      `UPDATE mt_driver_task SET ${updates.join(', ')}, date_modified = NOW() WHERE task_id = ?`,
      params
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Task not found' });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable.' });
    }
    throw e;
  }
});

// ---- deleteTask ----
router.delete('/tasks/:id', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
  try {
    const [[taskBefore]] = await pool.query(
      'SELECT order_id FROM mt_driver_task WHERE task_id = ? LIMIT 1',
      [taskId]
    );
    if (!taskBefore) return res.status(404).json({ error: 'Task not found' });

    const oid =
      taskBefore.order_id != null ? parseInt(String(taskBefore.order_id), 10) : NaN;
    if (Number.isFinite(oid) && oid > 0) {
      try {
        await updateMtOrderStatusIfDeliveryComplete(pool, oid, 'declined');
      } catch (_) {
        /* mt_order.status optional */
      }
      try {
        await insertMtOrderHistoryRow(pool, {
          orderId: oid,
          taskId,
          status: 'declined',
          remarks: 'Task deleted',
          updateByType: 'admin',
          actorId: req.adminUser?.admin_id ?? null,
          actorDisplayName: formatActorFromAdminUser(req.adminUser),
        });
      } catch (_) {
        /* mt_order_history optional */
      }
    }

    const [result] = await pool.query('DELETE FROM mt_driver_task WHERE task_id = ?', [taskId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Task not found' });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable.' });
    }
    throw e;
  }
});

/** Task statuses accepted from dashboard / legacy admin (lowercase). Synonyms allowed for DB compatibility. */
const ADMIN_TASK_STATUS_ALLOWED = new Set([
  'unassigned',
  'assigned',
  'acknowledged',
  'started',
  'inprogress',
  'successful',
  'failed',
  'declined',
  'cancelled',
  'canceled',
  'delivered',
  'completed',
]);

// ---- changeStatus (dashboard-driven task status change) ----
router.put('/tasks/:id/status', express.json(), async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
  const { status, reason } = req.body || {};
  const raw = (status || '').toString().trim();
  if (!raw) return res.status(400).json({ error: 'status required' });
  const newStatus = raw.toLowerCase();
  if (!ADMIN_TASK_STATUS_ALLOWED.has(newStatus)) {
    return res.status(400).json({
      error: `Invalid status. Allowed: ${[...ADMIN_TASK_STATUS_ALLOWED].sort().join(', ')}`,
    });
  }
  const remarks = reason != null && String(reason).trim() ? String(reason).trim() : '';

  try {
    const [[taskBefore]] = await pool.query(
      'SELECT order_id, status, driver_id AS assign_driver_id FROM mt_driver_task WHERE task_id = ? LIMIT 1',
      [taskId]
    );
    if (!taskBefore) return res.status(404).json({ error: 'Task not found' });
    const prevTaskStatus = taskBefore.status;

    let result;
    if (newStatus === 'unassigned') {
      try {
        [result] = await pool.query(
          'UPDATE mt_driver_task SET status = ?, driver_id = NULL, team_id = NULL, date_modified = NOW() WHERE task_id = ?',
          [newStatus, taskId]
        );
      } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
          [result] = await pool.query(
            'UPDATE mt_driver_task SET status = ?, driver_id = NULL, date_modified = NOW() WHERE task_id = ?',
            [newStatus, taskId]
          );
        } else {
          throw e;
        }
      }
    } else {
      [result] = await pool.query(
        'UPDATE mt_driver_task SET status = ?, date_modified = NOW() WHERE task_id = ?',
        [newStatus, taskId]
      );
    }
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Task not found' });

    try {
      const oid =
        taskBefore.order_id != null ? parseInt(String(taskBefore.order_id), 10) : NaN;
      if (Number.isFinite(oid) && oid > 0) {
        await updateMtOrderStatusIfDeliveryComplete(pool, oid, newStatus);
      }
    } catch (_) {
      /* mt_order.status optional */
    }

    let historyInsertId = null;
    try {
      const [[task]] = await pool.query('SELECT order_id FROM mt_driver_task WHERE task_id = ?', [taskId]);
      historyInsertId = await insertMtOrderHistoryRow(pool, {
        orderId: task?.order_id || null,
        taskId,
        status: newStatus,
        remarks,
        updateByType: 'admin',
        actorId: req.adminUser?.admin_id ?? null,
        actorDisplayName: formatActorFromAdminUser(req.adminUser),
      });
    } catch (_) {
      /* mt_order_history optional — do not fail status update */
    }

    try {
      const [[trow]] = await pool.query(
        'SELECT task_description, order_id FROM mt_driver_task WHERE task_id = ? LIMIT 1',
        [taskId]
      );
      const actor = formatActorFromAdminUser(req.adminUser);
      await notifyDashboardAfterMtTaskHistoryRow(pool, {
        taskId,
        orderId: trow?.order_id,
        taskDescription: trow?.task_description,
        statusRaw: newStatus,
        actorLabel: actor,
        historyInsertId,
        historyRowForClassify: {
          status: newStatus,
          remarks,
          reason: null,
          notes: null,
          update_by_type: 'admin',
        },
      });
    } catch (_) {}

    notifyCustomerFoodTaskStatusPushFireAndForget(pool, {
      taskId,
      orderId: taskBefore.order_id,
      prevStatusRaw: prevTaskStatus,
      newStatusRaw: newStatus,
    });

    notifyRiderOrderPushAfterTaskStatusFireAndForget(pool, {
      orderId: taskBefore.order_id,
      driverId: taskBefore.assign_driver_id,
      prevStatus: prevTaskStatus,
      newStatus,
    });

    return res.json({ ok: true, status: newStatus });
  } catch (e) {
    if (e.errno === 1265 || (e.message && /Data truncated|Incorrect.*enum/i.test(String(e.message)))) {
      return res.status(400).json({
        error: 'This status is not allowed by the database for this column. Update the status ENUM or use a value your schema accepts.',
      });
    }
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable.' });
    }
    throw e;
  }
});

// ---- assignToAllDrivers (send task to all drivers; first to accept gets it or use auto-assign logic) ----
router.post('/tasks/:id/assign-all', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
  try {
    const [[task]] = await pool.query('SELECT task_id, order_id, task_description FROM mt_driver_task WHERE task_id = ?', [taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    try {
      await sendPushToAllDrivers('New task', task.task_description || `Task #${taskId}`, { task_id: String(taskId), type: 'new_task' });
    } catch (pushErr) {
      return res.status(500).json({ error: pushErr.message || 'Failed to send push to drivers' });
    }
    await pool.query(
      `INSERT INTO mt_driver_bulk_push (push_title, push_message, status, date_created, date_process, ip_address)
       VALUES (?, ?, 'process', NOW(), NOW(), ?)`,
      ['New task', task.task_description || `Task #${taskId}`, req.ip || req.connection?.remoteAddress || null]
    );
    await notifyAllDashboardAdmins(pool, {
      title: 'Task broadcast to drivers',
      message: ensureTaskIdMarkerInMessage(task.task_description || `Task #${taskId}`, taskId),
      type: 'new_task',
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable.' });
    }
    throw e;
  }
});

// ---- RetryAutoAssign ----
router.post('/tasks/:id/retry-auto-assign', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
  try {
    const [[task]] = await pool.query('SELECT task_id, order_id, task_description, status FROM mt_driver_task WHERE task_id = ?', [taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const s = (task.status || '').toLowerCase();
    if (s !== 'unassigned') {
      return res.status(400).json({ error: 'Task is not unassigned' });
    }
    await sendPushToAllDrivers('New task', task.task_description || `Task #${taskId}`, { task_id: String(taskId), type: 'new_task' });
    await notifyAllDashboardAdmins(pool, {
      title: 'Auto-assign retry',
      message: ensureTaskIdMarkerInMessage(task.task_description || `Task #${taskId}`, taskId),
      type: 'new_task',
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable.' });
    }
    throw e;
  }
});

/**
 * Dashboard: ping the order’s customer with the same preset as POST /driver/api/NotifyCustomer
 * (uses assigned rider id + shared 15s per-task rate limit on the backend).
 */
router.post('/notify-customer', async (req, res) => {
  const body = req.body || {};
  const taskIdRaw = parseInt(String(body.task_id ?? body.taskId ?? ''), 10);
  if (!Number.isFinite(taskIdRaw) || taskIdRaw === 0) {
    return res.status(400).json({ error: 'task_id required' });
  }
  const orderIdBody = parseInt(String(body.order_id ?? body.orderId ?? ''), 10);

  let driverId = NaN;
  try {
    if (taskIdRaw < 0) {
      const oid =
        Number.isFinite(orderIdBody) && orderIdBody > 0 ? orderIdBody : Math.abs(taskIdRaw);
      if (!errandWibPool) return res.status(503).json({ error: 'Errand orders unavailable.' });
      const [[row]] = await errandWibPool.query(
        'SELECT driver_id FROM st_ordernew WHERE order_id = ? LIMIT 1',
        [oid]
      );
      if (!row) return res.status(404).json({ error: 'Task not found' });
      driverId = row.driver_id != null ? parseInt(String(row.driver_id), 10) : NaN;
    } else {
      const [[task]] = await pool.query(
        'SELECT driver_id FROM mt_driver_task WHERE task_id = ? LIMIT 1',
        [taskIdRaw]
      );
      if (!task) return res.status(404).json({ error: 'Task not found' });
      driverId = task.driver_id != null ? parseInt(String(task.driver_id), 10) : NaN;
    }
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Task lookup unavailable.' });
    }
    throw e;
  }

  if (!Number.isFinite(driverId) || driverId <= 0) {
    return res.status(400).json({ error: 'Task has no assigned rider' });
  }

  try {
    const r = await sendCustomerTaskNotify(pool, errandWibPool, { id: driverId }, body);
    if (r.err) return res.status(400).json({ error: r.err });
    return res.json({ ok: true, details: r.details });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to notify customer' });
  }
});

router.get('/drivers', async (req, res) => {
  try {
    let rows;
    // Prefer last_login for status date/time; fall back to date_modified. Support email or email_address.
    const fullSelect = `d.driver_id AS id, d.username, CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
       d.phone, d.on_duty, d.team_id, t.team_name,
       d.email AS email,
       d.device_platform AS device,
       COALESCE(d.transport_description, d.licence_plate, '') AS vehicle,
       COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
       COALESCE(d.last_login, d.date_modified) AS status_updated_at`;
    const fromClause = `FROM mt_driver d LEFT JOIN mt_driver_team t ON d.team_id = t.team_id`;
    const orderClause = `ORDER BY d.first_name, d.last_name`;

    try {
      [rows] = await pool.query(
        `SELECT ${fullSelect} ${fromClause} ${orderClause}`
      );
    } catch (colErr) {
      if (colErr.code === 'ER_BAD_FIELD_ERROR') {
        try {
          [rows] = await pool.query(
            `SELECT d.driver_id AS id, d.username, CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
             d.phone, d.on_duty, d.team_id, t.team_name,
             d.email, d.device_platform AS device,
             COALESCE(d.transport_description, d.licence_plate, '') AS vehicle,
             COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
             COALESCE(d.last_login, d.date_modified) AS status_updated_at
             ${fromClause} ${orderClause}`
          );
        } catch (_) {
          try {
            [rows] = await pool.query(
              `SELECT d.driver_id AS id, d.username, CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
               d.phone, d.on_duty, d.team_id, t.team_name,
               d.email, d.device_platform AS device,
               COALESCE(d.transport_description, d.licence_plate, '') AS vehicle,
               COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
               d.date_modified AS status_updated_at
               ${fromClause} ${orderClause}`
            );
          } catch (__) {
            try {
              [rows] = await pool.query(
                `SELECT d.driver_id AS id, d.username, CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
                 d.phone, d.on_duty, d.team_id, t.team_name, d.date_modified AS status_updated_at FROM mt_driver d
                 LEFT JOIN mt_driver_team t ON d.team_id = t.team_id ${orderClause}`
              );
            } catch (___) {
              try {
                [rows] = await pool.query(
                  `SELECT driver_id AS id, username, CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name, phone, on_duty, team_id, date_modified AS status_updated_at FROM mt_driver ORDER BY first_name, last_name`
                );
              } catch (____) {
                [rows] = await pool.query(
                  `SELECT driver_id AS id, username, CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS full_name, phone, on_duty, team_id FROM mt_driver ORDER BY first_name, last_name`
                );
              }
            }
          }
        }
        rows = (rows || []).map((d) => ({
          ...d,
          status: d.status ?? 'active',
          team_name: d.team_name ?? null,
          email: d.email ?? null,
          device: d.device ?? null,
          vehicle: d.vehicle ?? null,
          status_updated_at: d.status_updated_at ?? null,
        }));
      } else throw colErr;
    }
    return res.json(rows || []);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return res.json([]);
    throw e;
  }
});

// ---- Send push to a single driver (admin) ----
router.post('/drivers/:id/send-push', async (req, res) => {
  const driverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  const { title, message } = req.body || {};
  const pushTitle = (title ?? 'Notification').toString().trim() || 'Notification';
  const pushMessage = (message ?? '').toString().trim() || 'You have a new notification.';
  try {
    const result = await sendPushToDriver(driverId, pushTitle, pushMessage, { type: 'admin_push' });
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to send push' });
    }
    try {
      await pool.query(
        `INSERT INTO mt_driver_pushlog (driver_id, push_title, push_message, push_type, task_id, order_id, date_created, date_process, is_read)
         VALUES (?, ?, ?, 'admin_push', NULL, NULL, NOW(), NOW(), 0)`,
        [driverId, pushTitle, pushMessage]
      );
    } catch (_) {
      /* optional — rider app inbox still gets FCM */
    }
    return res.json({ ok: true, message: 'Push sent' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to send push' });
  }
});

// ---- getDriverDetails (driver + tasks for date) - must be before getDriverInfo ----
router.get('/drivers/:id/details', async (req, res) => {
  // Debug/version marker so we can verify which server code is running in production.
  // Safe to leave in place; it does not expose sensitive data.
  res.set('X-Driver-Details-Version', '2026-03-18');
  const driverId = parseInt(req.params.id, 10);
  const dateStr = (req.query.date || '').toString().trim() || new Date().toISOString().slice(0, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  try {
    // Keep this route robust across schema differences:
    // - Fetch driver from mt_driver only (no join)
    // - Then (best-effort) fetch team_name from mt_driver_team
    const [driverRows] = await pool.query(
      `SELECT
         d.driver_id AS id,
         d.username,
         CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS full_name,
         d.first_name,
         d.last_name,
         d.email AS email,
         d.phone,
         d.on_duty,
         d.team_id,
         d.transport_type_id,
         COALESCE(d.transport_description, '') AS transport_description,
         COALESCE(d.licence_plate, '') AS licence_plate,
         COALESCE(d.color, '') AS color,
         d.device_platform AS device_platform,
         COALESCE(d.app_version, '') AS app_version,
         d.location_lat,
         d.location_lng,
         COALESCE(d.last_login, d.date_modified) AS last_seen
       FROM mt_driver d
       WHERE d.driver_id = ?`,
      [driverId]
    );

    if (!driverRows || !driverRows.length) return res.status(404).json({ error: 'Driver not found' });
    const d = driverRows[0];

    let teamName = null;
    if (d.team_id != null) {
      try {
        const [teamRows] = await pool.query('SELECT team_name FROM mt_driver_team WHERE team_id = ? LIMIT 1', [d.team_id]);
        teamName = teamRows && teamRows.length ? (teamRows[0].team_name ?? null) : null;
      } catch (_) {
        teamName = null;
      }
    }

    const driver = {
      id: d.id,
      username: d.username,
      full_name: d.full_name,
      first_name: d.first_name,
      last_name: d.last_name,
      email: d.email,
      phone: d.phone,
      on_duty: d.on_duty,
      team_id: d.team_id,
      team_name: teamName,
      transport_type_id: d.transport_type_id,
      transport_type: d.transport_description, // alias for frontend display
      transport_description: d.transport_description,
      licence_plate: d.licence_plate,
      color: d.color,
      device_platform: d.device_platform,
      app_version: d.app_version,
      location_lat: d.location_lat,
      location_lng: d.location_lng,
      last_seen: d.last_seen,
    };
    let tasks = [];
    try {
      const [taskRows] = await pool.query(
        `SELECT t.task_id, t.task_description, t.status, t.delivery_date, t.delivery_address, t.customer_name
         FROM mt_driver_task t WHERE t.driver_id = ? AND (t.delivery_date = ? OR DATE(t.delivery_date) = ?) ORDER BY t.task_id DESC`,
        [driverId, dateStr, dateStr]
      );
      tasks = taskRows || [];
    } catch (_) {
      // Some deployments may not have mt_driver_task or these columns; still return driver info.
      tasks = [];
    }

    return res.json({ driver, tasks });
  } catch (e) {
    // Don't mask DB/schema errors as "Driver not found"—that makes debugging impossible.
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(500).json({ error: 'Failed to load driver details' });
    }
    throw e;
  }
});

// ---- getDriverInfo (single driver for edit) ----
router.get('/drivers/:id', async (req, res) => {
  const driverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  try {
    const [rows] = await pool.query(
      `SELECT d.driver_id AS id, d.username, d.first_name, d.last_name,
       d.email AS email, d.phone, d.team_id, t.team_name,
       d.device_platform AS device,
       COALESCE(d.transport_description, d.licence_plate, '') AS vehicle,
       COALESCE(NULLIF(TRIM(d.status), ''), 'active') AS status,
       d.profile_photo, d.transport_type_id, d.licence_plate, d.color
       FROM mt_driver d LEFT JOIN mt_driver_team t ON d.team_id = t.team_id
       WHERE d.driver_id = ?`,
      [driverId]
    );
    if (!rows || !rows.length) return res.status(404).json({ error: 'Driver not found' });
    const driver = rows[0];
    driver.full_name = [driver.first_name, driver.last_name].filter(Boolean).join(' ').trim() || driver.username;
    return res.json(driver);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(404).json({ error: 'Driver not found' });
    }
    throw e;
  }
});

// ---- addAgent (create driver) ----
router.post('/drivers', express.json(), async (req, res) => {
  const { username, password, first_name, last_name, email, phone, team_id, vehicle, status } = req.body || {};
  const user = (username || '').toString().trim();
  if (!user) return res.status(400).json({ error: 'username required' });
  const pwd = (password || '').toString();
  if (!pwd) return res.status(400).json({ error: 'password required' });
  try {
    const hash = await bcrypt.hash(pwd, 10);
    const [result] = await pool.query(
      `INSERT INTO mt_driver (username, password, first_name, last_name, email, phone, team_id, transport_description, status, on_duty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        user,
        hash,
        (first_name || '').toString().trim() || null,
        (last_name || '').toString().trim() || null,
        (email || '').toString().trim() || null,
        (phone || '').toString().trim() || null,
        team_id != null && team_id !== '' ? parseInt(team_id, 10) : null,
        (vehicle || '').toString().trim() || null,
        (status || 'active').toString().trim()
      ]
    );
    const driverId = result.insertId;
    return res.json({ id: driverId, ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Username already exists' });
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Drivers table unavailable.' });
    }
    throw e;
  }
});

/**
 * Link a rider (mt_client) to a driver row: same credentials as rider app once client_id is set (Option A2).
 * Body JSON: { client_id, username?, password? } — password required only if the client row has no stored password.
 */
router.post('/drivers/promote-from-client', express.json(), async (req, res) => {
  const clientId = parseInt(String(req.body?.client_id ?? ''), 10);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'client_id required (mt_client.client_id in the primary DB)' });
  }
  const bodyUsername = (req.body?.username || '').toString().trim();
  const bodyPassword = (req.body?.password || '').toString();

  try {
    const [[existing]] = await pool.query('SELECT driver_id FROM mt_driver WHERE client_id = ? LIMIT 1', [clientId]);
    if (existing) {
      return res.status(400).json({ error: 'A driver is already linked to this client_id' });
    }
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'mt_driver.client_id missing. Run: node -r dotenv/config scripts/add-mt-driver-client-id.js' });
    }
    throw e;
  }

  let client = null;
  const selectAttempts = [
    'SELECT client_id, email_address, username, password, first_name, last_name FROM mt_client WHERE client_id = ? LIMIT 1',
    'SELECT client_id, email_address, password, first_name, last_name FROM mt_client WHERE client_id = ? LIMIT 1',
  ];
  try {
    for (const sql of selectAttempts) {
      try {
        const [rows] = await pool.query(sql, [clientId]);
        if (rows && rows[0]) {
          client = rows[0];
          break;
        }
      } catch (inner) {
        if (inner.code !== 'ER_BAD_FIELD_ERROR') throw inner;
      }
    }
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(404).json({ error: 'mt_client not found in this database' });
    }
    throw e;
  }

  if (!client) return res.status(404).json({ error: 'Client not found' });

  let storedFromClient = ((client.password || '') + '').trim();
  if (!storedFromClient) {
    try {
      const [[ph]] = await pool.query(
        'SELECT password_hash AS p FROM mt_client WHERE client_id = ? LIMIT 1',
        [clientId]
      );
      if (ph && ph.p) storedFromClient = String(ph.p).trim();
    } catch (_) {
      /* column may not exist */
    }
  }

  const email = (client.email_address || '').toString().trim();
  const unameFromClient = (client.username || '').toString().trim();
  const user = bodyUsername || email || unameFromClient;
  if (!user) return res.status(400).json({ error: 'username required (set username or ensure client has email_address)' });
  let passwordToStore = storedFromClient;
  if (bodyPassword.trim()) {
    passwordToStore = await bcrypt.hash(bodyPassword, 10);
  } else if (!storedFromClient) {
    return res.status(400).json({ error: 'Client has no password; provide password in body' });
  }

  const fn = (client.first_name || '').toString().trim() || null;
  const ln = (client.last_name || '').toString().trim() || null;

  try {
    const [result] = await pool.query(
      `INSERT INTO mt_driver (username, password, first_name, last_name, email, client_id, transport_description, status, on_duty)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', 0)`,
      [user, passwordToStore, fn, ln, email || null, clientId]
    );
    return res.json({ ok: true, id: result.insertId, client_id: clientId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Username already exists on mt_driver' });
    }
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({
        error:
          'INSERT failed (missing client_id/email/status on mt_driver?). Run scripts/add-mt-driver-client-id.js and align schema with POST /drivers.',
      });
    }
    throw e;
  }
});

// ---- addAgent (update driver) ----
router.put('/drivers/:id', express.json(), async (req, res) => {
  const driverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  const { username, password, first_name, last_name, email, phone, team_id, vehicle, status } = req.body || {};
  try {
    const [[existing]] = await pool.query('SELECT driver_id FROM mt_driver WHERE driver_id = ?', [driverId]);
    if (!existing) return res.status(404).json({ error: 'Driver not found' });
    let sql = 'UPDATE mt_driver SET first_name = ?, last_name = ?, email = ?, phone = ?, team_id = ?, transport_description = ?, status = ?';
    const params = [
      (first_name || '').toString().trim() || null,
      (last_name || '').toString().trim() || null,
      (email || '').toString().trim() || null,
      (phone || '').toString().trim() || null,
      team_id != null && team_id !== '' ? parseInt(team_id, 10) : null,
      (vehicle || '').toString().trim() || null,
      (status || 'active').toString().trim()
    ];
    if (username != null && (username + '').trim()) {
      sql += ', username = ?';
      params.push((username + '').trim());
    }
    if (password != null && (password + '').trim()) {
      const hash = await bcrypt.hash(password.toString(), 10);
      sql += ', password = ?';
      params.push(hash);
    }
    sql += ' WHERE driver_id = ?';
    params.push(driverId);
    await pool.query(sql, params);
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Drivers table unavailable.' });
    }
    throw e;
  }
});

// ---- driverUpdateStatus (on/off duty; optional status for approve/deny signup) ----
router.put('/drivers/:id/status', express.json(), async (req, res) => {
  const driverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  const onDuty = req.body?.on_duty;
  const status = req.body?.status;
  const updates = [];
  const params = [];
  if (onDuty !== undefined && onDuty !== null) {
    const val = parseInt(onDuty, 10) === 2 ? 2 : 1;
    updates.push('on_duty = ?');
    params.push(val);
  }
  if (status != null && String(status).trim() !== '') {
    const s = String(status).trim().toLowerCase();
    if (['active', 'pending', 'suspended', 'blocked', 'expired'].includes(s)) {
      updates.push('status = ?');
      params.push(s);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Provide on_duty (1 or 2) and/or status' });
  params.push(driverId);
  try {
    const [result] = await pool.query(
      `UPDATE mt_driver SET ${updates.join(', ')}, date_modified = NOW() WHERE driver_id = ?`,
      params
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Driver not found' });
    return res.json({ ok: true, ...(onDuty !== undefined && onDuty !== null ? { on_duty: parseInt(onDuty, 10) === 2 ? 2 : 1 } : {}), ...(status != null ? { status: String(status).trim() } : {}) });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Drivers table unavailable.' });
    }
    throw e;
  }
});

// ---- DeleteRecords (driver) ----
router.delete('/drivers/:id', async (req, res) => {
  const driverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  try {
    const [result] = await pool.query('DELETE FROM mt_driver WHERE driver_id = ?', [driverId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Driver not found' });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_FOREIGN_KEY_VIOLATION' || e.errno === 1451) {
      return res.status(400).json({ error: 'Cannot delete driver with assigned tasks. Unassign first.' });
    }
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Drivers table unavailable.' });
    }
    throw e;
  }
});

// ---- Teams (mt_driver_team) ----
router.get('/teams', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.team_id AS id, t.team_name AS name, t.status, t.date_created,
        (SELECT COUNT(*) FROM mt_driver d WHERE d.team_id = t.team_id) AS driver_count
       FROM mt_driver_team t ORDER BY t.team_name`
    );
    return res.json(rows || []);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return res.json([]);
    throw e;
  }
});

// ---- getTeam (single team for edit) ----
router.get('/teams/:id', async (req, res) => {
  const teamId = parseInt(req.params.id, 10);
  if (!Number.isFinite(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  try {
    const [rows] = await pool.query(
      `SELECT t.team_id AS id, t.team_name AS name, t.status, t.date_created,
        (SELECT COUNT(*) FROM mt_driver d WHERE d.team_id = t.team_id) AS driver_count
       FROM mt_driver_team t WHERE t.team_id = ?`,
      [teamId]
    );
    if (!rows || !rows.length) return res.status(404).json({ error: 'Team not found' });
    return res.json(rows[0]);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return res.status(404).json({ error: 'Team not found' });
    throw e;
  }
});

// ---- CreateTeam ----
router.post('/teams', express.json(), async (req, res) => {
  const name = (req.body?.name || req.body?.team_name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name or team_name required' });
  try {
    const [result] = await pool.query(
      'INSERT INTO mt_driver_team (team_name, status, date_created) VALUES (?, ?, NOW())',
      [name, 'active']
    );
    return res.json({ id: result.insertId, ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Teams table unavailable.' });
    }
    throw e;
  }
});

// ---- Update team ----
router.put('/teams/:id', express.json(), async (req, res) => {
  const teamId = parseInt(req.params.id, 10);
  const name = (req.body?.name || req.body?.team_name || '').toString().trim();
  if (!Number.isFinite(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  if (!name) return res.status(400).json({ error: 'name or team_name required' });
  try {
    const [result] = await pool.query('UPDATE mt_driver_team SET team_name = ? WHERE team_id = ?', [name, teamId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Team not found' });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Teams table unavailable.' });
    }
    throw e;
  }
});

// ---- DeleteRecords (team) ----
router.delete('/teams/:id', async (req, res) => {
  const teamId = parseInt(req.params.id, 10);
  if (!Number.isFinite(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  try {
    await pool.query('UPDATE mt_driver SET team_id = NULL WHERE team_id = ?', [teamId]);
    const [result] = await pool.query('DELETE FROM mt_driver_team WHERE team_id = ?', [teamId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Team not found' });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Teams table unavailable.' });
    }
    throw e;
  }
});

// ---- Push broadcast log (mt_driver_bulk_push) ----
router.get('/push-logs', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT bulk_id AS id, push_title AS title, push_message AS message, status,
        date_created, date_process, ip_address, team_id, user_type, user_id, fcm_response
       FROM mt_driver_bulk_push ORDER BY COALESCE(date_process, date_created) DESC, bulk_id DESC LIMIT 100`
    );
    return res.json(rows);
  } catch (e) {
    return res.json([]);
  }
});

// ---- Driver push logs (mt_driver_pushlog - per-driver notifications) ----
router.get('/driver-push-logs', async (req, res) => {
  const { date } = req.query;
  try {
    let sql = `SELECT p.push_id AS id, p.driver_id, p.push_title AS title, p.push_message AS message,
        p.push_type AS type, p.task_id, p.order_id, p.date_created AS date, p.is_read AS status
       FROM mt_driver_pushlog p WHERE 1=1`;
    const params = [];
    if (date) {
      sql += ' AND DATE(p.date_created) = ?';
      params.push(date);
    }
    sql += ' ORDER BY p.date_created DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    return res.json(rows || []);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return res.json([]);
    throw e;
  }
});

// ---- Rider FCM registry (mt_rider_device_reg) — debug / ops ----
router.get('/rider-fcm-devices', async (req, res) => {
  const driverId = parseInt(String(req.query.driver_id || ''), 10);
  if (!Number.isFinite(driverId) || driverId <= 0) {
    return res.status(400).json({ error: 'driver_id query parameter required' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT id, driver_id, device_id, device_platform, device_uuid, push_enabled, date_created, date_modified
       FROM mt_rider_device_reg WHERE driver_id = ? ORDER BY date_modified DESC`,
      [driverId]
    );
    return res.json(rows || []);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    throw e;
  }
});

router.get('/rider-fcm-push-logs', async (req, res) => {
  let sql = `SELECT id, driver_id, order_id, trigger_id, push_type, push_title, push_body, device_id, status,
    provider_response, error_message, date_created, date_modified
    FROM mt_rider_push_logs WHERE 1=1`;
  const params = [];
  const driverId = parseInt(String(req.query.driver_id || ''), 10);
  if (Number.isFinite(driverId) && driverId > 0) {
    sql += ' AND driver_id = ?';
    params.push(driverId);
  }
  const orderId = parseInt(String(req.query.order_id || ''), 10);
  if (Number.isFinite(orderId) && orderId > 0) {
    sql += ' AND order_id = ?';
    params.push(orderId);
  }
  sql += ' ORDER BY date_created DESC LIMIT 200';
  try {
    const [rows] = await pool.query(sql, params);
    return res.json(rows || []);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    throw e;
  }
});

router.post('/drivers/:id/rider-fcm-test-push', express.json(), async (req, res) => {
  const driverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  const { title, message, device_id } = req.body || {};
  const pushTitle = (title ?? 'Test').toString().trim() || 'Test';
  const pushMessage = (message ?? '').toString().trim() || 'Rider FCM test push';
  let token = device_id != null && String(device_id).trim() ? String(device_id).trim() : '';
  try {
    if (!token) {
      const [[row]] = await pool.query(
        `SELECT device_id FROM mt_rider_device_reg WHERE driver_id = ? AND push_enabled = 1
         AND device_id IS NOT NULL AND TRIM(device_id) <> '' ORDER BY date_modified DESC LIMIT 1`,
        [driverId]
      );
      token = row?.device_id ? String(row.device_id).trim() : '';
    }
    if (!token) {
      return res.status(400).json({ error: 'No device token — pass device_id or register from the rider app' });
    }
    const result = await sendPushToDevice(token, {
      title: pushTitle,
      body: pushMessage,
      data: { type: 'admin_rider_fcm_test', push_type: 'admin_rider_fcm_test' },
    });
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to send push' });
    }
    return res.json({ ok: true, messageId: result.messageId || null });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'mt_rider_device_reg not installed — run sql/wib_rider_device_and_push.sql' });
    }
    return res.status(500).json({ error: e.message || 'Failed to send push' });
  }
});

// ---- Assignment settings (mt_option) ----
async function getOption(name) {
  try {
    const [rows] = await pool.query('SELECT option_value FROM mt_option WHERE option_name = ? LIMIT 1', [name]);
    return rows.length ? rows[0].option_value : null;
  } catch (e) {
    return null;
  }
}
const ASSIGN_TO_VALUES = ['all', 'driver_with_no_task', 'all_with_max_number'];
const AUTO_ASSIGN_TYPE_VALUES = ['one_by_one', 'send_to_all'];

router.get('/assignment-settings', async (req, res) => {
  try {
    const driver_enabled_auto_assign = await getOption('driver_enabled_auto_assign');
    const driver_include_offline_driver = await getOption('driver_include_offline_driver');
    const driver_assign_onduty = await getOption('driver_assign_onduty');
    const driver_autoassign_notify_email = await getOption('driver_autoassign_notify_email');
    const driver_request_expire_minutes = await getOption('driver_request_expire_minutes');
    const driver_auto_retry_assignment = await getOption('driver_auto_retry_assignment');
    const driver_assign_to = await getOption('driver_assign_to');
    const driver_auto_assign_type = await getOption('driver_auto_assign_type');
    return res.json({
      driver_enabled_auto_assign: driver_enabled_auto_assign === '1' || driver_enabled_auto_assign === 1,
      driver_include_offline_driver: driver_include_offline_driver === '1' || driver_include_offline_driver === 1,
      driver_assign_onduty: driver_assign_onduty === '1' || driver_assign_onduty === 1,
      driver_autoassign_notify_email: driver_autoassign_notify_email || '',
      driver_request_expire_minutes: driver_request_expire_minutes != null && driver_request_expire_minutes !== '' ? parseInt(String(driver_request_expire_minutes), 10) : 10,
      driver_auto_retry_assignment: driver_auto_retry_assignment === '1' || driver_auto_retry_assignment === 1,
      driver_assign_to: ASSIGN_TO_VALUES.includes(driver_assign_to) ? driver_assign_to : 'all',
      driver_auto_assign_type: AUTO_ASSIGN_TYPE_VALUES.includes(driver_auto_assign_type) ? driver_auto_assign_type : 'one_by_one',
    });
  } catch (e) {
    return res.json({
      driver_enabled_auto_assign: false,
      driver_include_offline_driver: false,
      driver_assign_onduty: false,
      driver_autoassign_notify_email: '',
      driver_request_expire_minutes: 10,
      driver_auto_retry_assignment: false,
      driver_assign_to: 'all',
      driver_auto_assign_type: 'one_by_one',
    });
  }
});
router.put('/assignment-settings', async (req, res) => {
  try {
    const {
      driver_enabled_auto_assign,
      driver_include_offline_driver,
      driver_assign_onduty,
      driver_autoassign_notify_email,
      driver_request_expire_minutes,
      driver_auto_retry_assignment,
      driver_assign_to,
      driver_auto_assign_type,
    } = req.body;
    const opts = [
      [driver_enabled_auto_assign != null ? (driver_enabled_auto_assign ? '1' : '0') : null, 'driver_enabled_auto_assign'],
      [driver_include_offline_driver != null ? (driver_include_offline_driver ? '1' : '0') : null, 'driver_include_offline_driver'],
      [driver_assign_onduty != null ? (driver_assign_onduty ? '1' : '0') : null, 'driver_assign_onduty'],
      [driver_autoassign_notify_email != null ? driver_autoassign_notify_email : null, 'driver_autoassign_notify_email'],
      [driver_request_expire_minutes != null && driver_request_expire_minutes !== '' ? String(Math.max(1, Math.min(120, parseInt(driver_request_expire_minutes, 10) || 10))) : null, 'driver_request_expire_minutes'],
      [driver_auto_retry_assignment != null ? (driver_auto_retry_assignment ? '1' : '0') : null, 'driver_auto_retry_assignment'],
      [driver_assign_to != null && ASSIGN_TO_VALUES.includes(driver_assign_to) ? driver_assign_to : null, 'driver_assign_to'],
      [driver_auto_assign_type != null && AUTO_ASSIGN_TYPE_VALUES.includes(driver_auto_assign_type) ? driver_auto_assign_type : null, 'driver_auto_assign_type'],
    ].filter(([v]) => v !== undefined && v !== null);
    for (const [value, key] of opts) {
      const [existing] = await pool.query('SELECT 1 FROM mt_option WHERE option_name = ? LIMIT 1', [key]);
      if (existing.length) {
        await pool.query('UPDATE mt_option SET option_value = ? WHERE option_name = ?', [value, key]);
      } else {
        await pool.query('INSERT INTO mt_option (merchant_id, option_name, option_value) VALUES (0, ?, ?)', [key, value]);
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to save assignment settings' });
  }
});

// ---- Notification settings (stub: list + toggles from mt_option) ----
router.get('/notification-settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT option_name AS `key`, option_value AS value FROM mt_option WHERE option_name LIKE ? OR option_name LIKE ?', ['PICKUP_%', 'DELIVERY_%']);
    const toggles = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
    return res.json({
      list: { PICKUP: ['New task assigned', 'Task accepted'], DELIVERY: ['Task completed', 'Task failed'] },
      toggles,
    });
  } catch (e) {
    return res.json({
      list: { PICKUP: ['New task assigned', 'Task accepted'], DELIVERY: ['Task completed', 'Task failed'] },
      toggles: {},
    });
  }
});
router.put('/notification-settings', async (req, res) => {
  try {
    const { toggles } = req.body || {};
    for (const [key, value] of Object.entries(toggles || {})) {
      const [existing] = await pool.query('SELECT 1 FROM mt_option WHERE option_name = ? LIMIT 1', [key]);
      const v = value ? '1' : '0';
      if (existing.length) {
        await pool.query('UPDATE mt_option SET option_value = ? WHERE option_name = ?', [v, key]);
      } else {
        await pool.query('INSERT INTO mt_option (merchant_id, option_name, option_value) VALUES (0, ?, ?)', [key, v]);
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to save notification settings' });
  }
});

// ---- GetNotificationTPL (get notification template by name) ----
router.get('/notification-templates/:name', async (req, res) => {
  const name = (req.params.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Template name required' });
  const optionName = `notification_tpl_${name}`;
  try {
    const [rows] = await pool.query('SELECT option_value FROM mt_option WHERE option_name = ? LIMIT 1', [optionName]);
    const content = rows && rows.length ? (rows[0].option_value || '') : '';
    return res.json({ name, content });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ name, content: '' });
    throw e;
  }
});

// ---- SaveNotificationTemplate (save template content) ----
router.put('/notification-templates/:name', express.json(), async (req, res) => {
  const name = (req.params.name || '').toString().trim();
  const content = (req.body?.content != null ? req.body.content : req.body) + '';
  if (!name) return res.status(400).json({ error: 'Template name required' });
  const optionName = `notification_tpl_${name}`;
  try {
    const [existing] = await pool.query('SELECT 1 FROM mt_option WHERE option_name = ? LIMIT 1', [optionName]);
    if (existing.length) {
      await pool.query('UPDATE mt_option SET option_value = ? WHERE option_name = ?', [content, optionName]);
    } else {
      await pool.query('INSERT INTO mt_option (merchant_id, option_name, option_value) VALUES (0, ?, ?)', [optionName, content]);
    }
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'mt_option unavailable' });
    throw e;
  }
});

// ---- GetNotifications / getInitialNotifications (notification list for dashboard popup) ----
router.get('/notifications', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  try {
    const [rows] = await pool.query(
      `SELECT p.push_id AS id, p.driver_id, p.push_title AS title, p.push_message AS message,
        p.push_type AS type, p.task_id, p.date_created AS date, p.is_read
       FROM mt_driver_pushlog p ORDER BY p.date_created DESC LIMIT ?`,
      [limit]
    );
    return res.json(rows || []);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return res.json([]);
    throw e;
  }
});

// ---- Reports (task completion by time/team/driver/status) ----
router.get('/reports', async (req, res) => {
  try {
    const { time, team_id, driver_id, status, start_date, end_date } = req.query;
    let sql = `SELECT t.task_id, t.driver_id, t.status, t.date_created, CONCAT(COALESCE(d.first_name,''), ' ', COALESCE(d.last_name,'')) AS driver_name
      FROM mt_driver_task t LEFT JOIN mt_driver d ON t.driver_id = d.driver_id WHERE 1=1`;
    const params = [];
    if (time === 'week') {
      sql += ' AND t.date_created >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
    } else if (time === 'month') {
      sql += ' AND t.date_created >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (time === 'custom' && start_date) {
      sql += ' AND DATE(t.date_created) >= ?';
      params.push(start_date);
    }
    if (time === 'custom' && end_date) {
      sql += ' AND DATE(t.date_created) <= ?';
      params.push(end_date);
    }
    if (team_id) {
      sql += ' AND d.team_id = ?';
      params.push(team_id);
    }
    if (driver_id) {
      sql += ' AND t.driver_id = ?';
      params.push(driver_id);
    }
    if (status && status !== 'all') {
      sql += ' AND t.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY t.date_created DESC LIMIT 500';
    const [rows] = await pool.query(sql, params);
    return res.json(rows || []);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return res.json([]);
    throw e;
  }
});

// ---- loadTrackDate (dates available for track back) ----
router.get('/driver-trackback/dates', async (req, res) => {
  const driverId = (req.query.driver_id || '').toString().trim();
  if (!driverId) return res.json([]);
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT DATE(date_created) AS date FROM mt_driver_track_location WHERE driver_id = ? ORDER BY date DESC LIMIT 90',
      [driverId]
    );
    if (rows && rows.length) return res.json(rows.map((r) => r.date));
    const [fallback] = await pool.query(
      'SELECT DISTINCT DATE(date_modified) AS date FROM mt_driver WHERE driver_id = ? AND date_modified IS NOT NULL ORDER BY date DESC LIMIT 30',
      [driverId]
    );
    return res.json((fallback || []).map((r) => r.date));
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return res.json([]);
    throw e;
  }
});

// ---- Driver track back (location history: mt_driver_track_location, fallback mt_driver) ----
router.get('/driver-trackback', async (req, res) => {
  const { driver_id, date } = req.query;
  const dateStr = (date || new Date().toISOString().slice(0, 10)).toString().trim();
  if (!driver_id) return res.json([]);
  try {
    const [rows] = await pool.query(
      'SELECT latitude AS lat, longitude AS lng, date_created FROM mt_driver_track_location WHERE driver_id = ? AND DATE(date_created) = ? ORDER BY date_created ASC',
      [driver_id, dateStr]
    );
    if (rows && rows.length > 0) return res.json(rows);
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  try {
    const [fallback] = await pool.query(
      'SELECT driver_id, location_lat AS lat, location_lng AS lng, date_modified AS date_created FROM mt_driver WHERE driver_id = ? AND DATE(date_modified) = ? ORDER BY date_modified ASC',
      [driver_id, dateStr]
    );
    return res.json(fallback || []);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return res.json([]);
    throw e;
  }
});

// ---- cronCheckData (health check for cron / auto-assign) ----
router.get('/cron/check', async (req, res) => {
  try {
    const [[unassigned]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM mt_driver_task WHERE LOWER(TRIM(COALESCE(status,''))) = 'unassigned'"
    );
    return res.json({ ok: true, unassigned_tasks: unassigned?.cnt ?? 0 });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ ok: true, unassigned_tasks: 0 });
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- SaveTranslation (save language/translation settings) ----
router.put('/settings/translation', express.json(), async (req, res) => {
  const body = req.body || {};
  const keys = ['app_default_language', 'localize_calendar_language', 'app_language'];
  try {
    for (const key of keys) {
      if (body[key] === undefined) continue;
      const value = body[key] == null ? '' : String(body[key]).trim();
      try {
        const [ex] = await pool.query('SELECT 1 FROM settings WHERE `key` = ? LIMIT 1', [key]);
        if (ex.length) await pool.query('UPDATE settings SET value = ? WHERE `key` = ?', [value, key]);
        else await pool.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', [key, value]);
      } catch (tableErr) {
        if (tableErr.code === 'ER_NO_SUCH_TABLE') {
          const [ex] = await pool.query('SELECT 1 FROM mt_option WHERE option_name = ? LIMIT 1', [key]);
          if (ex.length) await pool.query('UPDATE mt_option SET option_value = ? WHERE option_name = ?', [value, key]);
          else await pool.query('INSERT INTO mt_option (merchant_id, option_name, option_value) VALUES (0, ?, ?)', [key, value]);
        } else throw tableErr;
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to save translation' });
  }
});

// ---- UploadCertificate (iOS push certificate) ----
router.post('/upload/certificate', uploadCert.single('certificate'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const relativePath = `/uploads/certificates/${req.file.filename}`;
  try {
    const key = 'ios_cert_path';
    const [ex] = await pool.query('SELECT 1 FROM settings WHERE `key` = ? LIMIT 1', [key]).catch(() => [[]]);
    if (ex && ex.length) await pool.query('UPDATE settings SET value = ? WHERE `key` = ?', [relativePath, key]);
    else await pool.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', [key, relativePath]).catch(() => {});
    const [exOpt] = await pool.query('SELECT 1 FROM mt_option WHERE option_name = ? LIMIT 1', [key]).catch(() => [[]]);
    if (exOpt && exOpt.length) await pool.query('UPDATE mt_option SET option_value = ? WHERE option_name = ?', [relativePath, key]);
    else await pool.query('INSERT INTO mt_option (merchant_id, option_name, option_value) VALUES (0, ?, ?)', [key, relativePath]).catch(() => {});
    return res.json({ ok: true, path: relativePath });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to save certificate path' });
  }
});

// ---- uploadprofilephoto (admin: set driver profile photo) ----
router.post('/upload/profile-photo', uploadProfile.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const driverId = parseInt(req.body?.driver_id || req.query?.driver_id, 10);
  if (!Number.isFinite(driverId)) return res.status(400).json({ error: 'driver_id required' });
  const relativePath = `/uploads/profiles/${req.file.filename}`;
  try {
    const [result] = await pool.query('UPDATE mt_driver SET profile_photo = ? WHERE driver_id = ?', [relativePath, driverId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Driver not found' });
    return res.json({ ok: true, path: relativePath });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to update profile photo' });
  }
});

// ---- uploadjsonAccount (FCM service account JSON) ----
router.post('/upload/json-account', uploadFcm.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const relativePath = `/uploads/fcm/${req.file.filename}`;
  try {
    const key = 'fcm_service_account_path';
    const [ex] = await pool.query('SELECT 1 FROM settings WHERE `key` = ? LIMIT 1', [key]).catch(() => [[]]);
    if (ex && ex.length) await pool.query('UPDATE settings SET value = ? WHERE `key` = ?', [relativePath, key]);
    else await pool.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', [key, relativePath]).catch(() => {});
    const [exOpt] = await pool.query('SELECT 1 FROM mt_option WHERE option_name = ? LIMIT 1', [key]).catch(() => [[]]);
    if (exOpt && exOpt.length) await pool.query('UPDATE mt_option SET option_value = ? WHERE option_name = ?', [relativePath, key]);
    else await pool.query('INSERT INTO mt_option (merchant_id, option_name, option_value) VALUES (0, ?, ?)', [key, relativePath]).catch(() => {});
    return res.json({ ok: true, path: relativePath });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to save path' });
  }
});

// ---- SMS logs (empty array if no table; tolerate column name differences) ----
router.get('/sms-logs', async (req, res) => {
  const attempts = [
    'SELECT * FROM mt_sms_logs ORDER BY date_created DESC LIMIT 200',
    'SELECT * FROM mt_sms_logs ORDER BY date_sent DESC LIMIT 200',
    'SELECT * FROM mt_sms_logs ORDER BY id DESC LIMIT 200',
    'SELECT * FROM mt_sms_log ORDER BY date_created DESC LIMIT 200',
    'SELECT * FROM mt_sms_log ORDER BY id DESC LIMIT 200',
  ];
  for (const sql of attempts) {
    try {
      const [rows] = await pool.query(sql);
      const list = rows || [];
      const normalized = list.map((r) => ({
        ...r,
        id: r.id ?? r.sms_id ?? r.log_id ?? null,
        date_created: r.date_created ?? r.date_sent ?? r.date_added ?? r.created_at ?? null,
        mobile_number: r.mobile_number ?? r.to ?? r.phone ?? r.recipient ?? null,
        message: r.message ?? r.sms_message ?? r.body ?? null,
        gateway: r.gateway ?? r.provider ?? null,
        status: r.status ?? r.sms_status ?? null,
      }));
      return res.json(normalized);
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') continue;
      return res.json([]);
    }
  }
  return res.json([]);
});

// ---- Email logs (stub) ----
router.get('/email-logs', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM mt_email_logs ORDER BY date_created DESC LIMIT 200');
    return res.json(rows);
  } catch (e) {
    return res.json([]);
  }
});

// ---- Map API logs (mt_driver_mapsapicall) ----
router.get('/map-api-logs', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, map_provider AS provider, api_functions AS api, api_response AS response, date_created AS date FROM mt_driver_mapsapicall ORDER BY date_created DESC LIMIT 200'
    );
    return res.json(rows);
  } catch (e) {
    return res.json([]);
  }
});

// ---- Location cascade (Option C: state/city/area for reporting & structured address) ----
// Static Philippines data; can be replaced by DB queries (mt_region, mt_province, mt_city) if tables exist
const PH_REGIONS = [
  { id: 'car', name: 'Cordillera Administrative Region (CAR)' },
  { id: 'ilocos', name: 'Ilocos Region' },
  { id: 'cagayan', name: 'Cagayan Valley' },
  { id: 'central-luzon', name: 'Central Luzon' },
  { id: 'ncr', name: 'National Capital Region (NCR)' },
  { id: 'calabarzon', name: 'CALABARZON' },
  { id: 'mimaropa', name: 'MIMAROPA' },
  { id: 'bicol', name: 'Bicol Region' },
  { id: 'western-visayas', name: 'Western Visayas' },
  { id: 'central-visayas', name: 'Central Visayas' },
  { id: 'eastern-visayas', name: 'Eastern Visayas' },
  { id: 'zamboanga', name: 'Zamboanga Peninsula' },
  { id: 'northern-mindanao', name: 'Northern Mindanao' },
  { id: 'davao', name: 'Davao Region' },
  { id: 'soccsksargen', name: 'SOCCSKSARGEN' },
  { id: 'caraga', name: 'Caraga' },
  { id: 'barmm', name: 'Bangsamoro (BARMM)' },
];
const PH_PROVINCES = [
  { id: 'benguet', region_id: 'car', name: 'Benguet' },
  { id: 'abra', region_id: 'car', name: 'Abra' },
  { id: 'ifugao', region_id: 'car', name: 'Ifugao' },
  { id: 'kalinga', region_id: 'car', name: 'Kalinga' },
  { id: 'mountain-province', region_id: 'car', name: 'Mountain Province' },
  { id: 'apayao', region_id: 'car', name: 'Apayao' },
  { id: 'ilocos-norte', region_id: 'ilocos', name: 'Ilocos Norte' },
  { id: 'ilocos-sur', region_id: 'ilocos', name: 'Ilocos Sur' },
  { id: 'la-union', region_id: 'ilocos', name: 'La Union' },
  { id: 'pangasinan', region_id: 'ilocos', name: 'Pangasinan' },
  { id: 'bataan', region_id: 'central-luzon', name: 'Bataan' },
  { id: 'bulacan', region_id: 'central-luzon', name: 'Bulacan' },
  { id: 'nueva-ecija', region_id: 'central-luzon', name: 'Nueva Ecija' },
  { id: 'pampanga', region_id: 'central-luzon', name: 'Pampanga' },
  { id: 'tarlac', region_id: 'central-luzon', name: 'Tarlac' },
  { id: 'zambales', region_id: 'central-luzon', name: 'Zambales' },
  { id: 'metro-manila', region_id: 'ncr', name: 'Metro Manila' },
  { id: 'batangas', region_id: 'calabarzon', name: 'Batangas' },
  { id: 'cavite', region_id: 'calabarzon', name: 'Cavite' },
  { id: 'laguna', region_id: 'calabarzon', name: 'Laguna' },
  { id: 'quezon', region_id: 'calabarzon', name: 'Quezon' },
  { id: 'rizal', region_id: 'calabarzon', name: 'Rizal' },
];
const PH_CITIES = [
  { id: 'baguio', province_id: 'benguet', name: 'Baguio City' },
  { id: 'la-trinidad', province_id: 'benguet', name: 'La Trinidad' },
  { id: 'baguio-benguet', province_id: 'benguet', name: 'Baguio (Benguet)' },
  { id: 'manila', province_id: 'metro-manila', name: 'Manila' },
  { id: 'quezon-city', province_id: 'metro-manila', name: 'Quezon City' },
  { id: 'caloocan', province_id: 'metro-manila', name: 'Caloocan' },
  { id: 'las-pinas', province_id: 'metro-manila', name: 'Las Piñas' },
  { id: 'makati', province_id: 'metro-manila', name: 'Makati' },
  { id: 'mandaluyong', province_id: 'metro-manila', name: 'Mandaluyong' },
  { id: 'marikina', province_id: 'metro-manila', name: 'Marikina' },
  { id: 'muntinlupa', province_id: 'metro-manila', name: 'Muntinlupa' },
  { id: 'navotas', province_id: 'metro-manila', name: 'Navotas' },
  { id: 'paranaque', province_id: 'metro-manila', name: 'Parañaque' },
  { id: 'pasay', province_id: 'metro-manila', name: 'Pasay' },
  { id: 'pasig', province_id: 'metro-manila', name: 'Pasig' },
  { id: 'pateros', province_id: 'metro-manila', name: 'Pateros' },
  { id: 'san-juan', province_id: 'metro-manila', name: 'San Juan' },
  { id: 'taguig', province_id: 'metro-manila', name: 'Taguig' },
  { id: 'valenzuela', province_id: 'metro-manila', name: 'Valenzuela' },
];

router.get('/location/regions', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name FROM mt_region ORDER BY name ASC').catch(() => [[]]);
    if (rows && rows.length > 0) return res.json(rows);
    return res.json(PH_REGIONS);
  } catch (e) {
    return res.json(PH_REGIONS);
  }
});

router.get('/location/provinces', async (req, res) => {
  const regionId = (req.query.region_id || '').toString().trim();
  if (!regionId) return res.json([]);
  try {
    const [rows] = await pool.query('SELECT id, region_id, name FROM mt_province WHERE region_id = ? ORDER BY name ASC', [regionId]).catch(() => [[]]);
    if (rows && rows.length > 0) return res.json(rows);
    const list = PH_PROVINCES.filter((p) => p.region_id === regionId);
    return res.json(list);
  } catch (e) {
    const list = PH_PROVINCES.filter((p) => p.region_id === regionId);
    return res.json(list);
  }
});

router.get('/location/cities', async (req, res) => {
  const provinceId = (req.query.province_id || '').toString().trim();
  if (!provinceId) return res.json([]);
  try {
    const [rows] = await pool.query('SELECT id, province_id, name FROM mt_city WHERE province_id = ? ORDER BY name ASC', [provinceId]).catch(() => [[]]);
    if (rows && rows.length > 0) return res.json(rows);
    const list = PH_CITIES.filter((c) => c.province_id === provinceId);
    return res.json(list);
  } catch (e) {
    const list = PH_CITIES.filter((c) => c.province_id === provinceId);
    return res.json(list);
  }
});

router.get('/location/postcodes', async (req, res) => {
  const cityId = (req.query.city_id || '').toString().trim();
  if (!cityId) return res.json([]);
  try {
    const [rows] = await pool.query('SELECT id, postcode, city_id FROM mt_postcode WHERE city_id = ? ORDER BY postcode ASC', [cityId]).catch(() => [[]]);
    if (rows && rows.length > 0) return res.json(rows.map((r) => ({ id: r.postcode || r.id, name: r.postcode || r.id })));
  } catch (e) {}
  return res.json([]);
});

const riderNotificationRoutes = require('./riderNotifications.routes');
router.use(riderNotificationRoutes);

const centralRoutes = require('./central');
router.use('/central', centralRoutes);

module.exports = router;
