const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { success, error } = require('../lib/response');
const { sendPushToDriver, sendPushToAllDrivers } = require('../services/fcm');

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
/** Same as driver routes: absolute URLs for assets (set in .env for production). */
const PUBLIC_BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

/**
 * Clean mt_driver_task_photo.photo_name for disk URLs: basename, trim, strip wrapping <> from bad inserts,
 * collapse .jpg.jpg-style duplicates (must match likely on-disk filename).
 */
function sanitizeTaskProofFileName(photoName) {
  let s = String(photoName || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^<+/, '').replace(/>+$/, '').trim();
  s = path.basename(s);
  const doubleExt = /\.(jpg|jpeg|png|gif|webp)\.(jpg|jpeg|png|gif|webp)$/i.exec(s);
  if (doubleExt) s = s.slice(0, -(doubleExt[1].length + 1));
  if (!s || s === '.' || s === '..') return '';
  return s;
}

/** Basename as stored on legacy PHP disk (may include .jpg.jpg). */
function taskProofDriverBasename(photoName) {
  let s = String(photoName || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^<+/, '').replace(/>+$/, '').trim();
  s = path.basename(s);
  if (!s || s === '.' || s === '..') return '';
  return s;
}

/** Public URL for on-disk proof: legacy /upload/driver/ or /upload/task/ + sanitized name */
function buildTaskProofImageUrl(photoName) {
  const raw = String(photoName || '').trim().replace(/\\/g, '/');
  const lower = raw.toLowerCase();
  if (lower.includes('/driver/') || lower.includes('upload/driver')) {
    const base = taskProofDriverBasename(photoName);
    if (!base) return null;
    const rel = `/upload/driver/${encodeURIComponent(base)}`;
    return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${rel}` : rel;
  }
  const safe = sanitizeTaskProofFileName(photoName);
  if (!safe) return null;
  const rel = `/upload/task/${encodeURIComponent(safe)}`;
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${rel}` : rel;
}

async function fetchTaskProofPhotosWithUrls(pool, taskId) {
  try {
    const [photoRows] = await pool.query(
      'SELECT id, task_id, photo_name, date_created, ip_address FROM mt_driver_task_photo WHERE task_id = ? ORDER BY date_created ASC',
      [taskId]
    );
    const rows = photoRows || [];
    const task_photos = rows.map((row) => ({
      ...row,
      proof_url: buildTaskProofImageUrl(row.photo_name),
    }));
    const proof_images = task_photos.map((r) => r.proof_url).filter(Boolean);
    return { task_photos, proof_images };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return { task_photos: [], proof_images: [] };
    }
    throw e;
  }
}

// Upload dirs for admin (certificate, profile photo, FCM JSON)
const uploadsBase = path.join(__dirname, '..', 'uploads');
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
if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
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

/**
 * Merge category rows into best map (lowest cat_sequence wins per item_id).
 */
function mergeOrderItemCategoryMap(best, rows, itemIdKey, nameKey, seqKey) {
  for (const row of rows || []) {
    const iid = row[itemIdKey];
    const name = row[nameKey];
    if (iid == null || !name || !String(name).trim()) continue;
    const seqRaw = row[seqKey];
    const seqN = seqRaw != null && String(seqRaw).trim() !== '' && Number.isFinite(Number(seqRaw)) ? Number(seqRaw) : 999999;
    const k = String(iid);
    const n = String(name).trim();
    const prev = best.get(k);
    if (!prev || seqN < prev.seq) best.set(k, { name: n, seq: seqN });
  }
}

/**
 * Resolve category / subcategory / display names for mt_order_details lines:
 * mt_category_translation, mt_item_relationship_category, mt_item_relationship_subcategory,
 * mt_item_relationship_subcategory_item (parent inheritance), mt_item_translation.
 */
async function attachOrderDetailCategories(pool, detailRows, merchantId) {
  if (!Array.isArray(detailRows) || detailRows.length === 0) return detailRows;
  const itemIds = [];
  const seen = new Set();
  for (const r of detailRows) {
    const id = r.item_id ?? r.menu_item_id ?? r.itemId;
    if (id == null || String(id).trim() === '') continue;
    if (String(id).trim() === '0') continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    itemIds.push(id);
  }
  if (itemIds.length === 0) return detailRows;

  const ph = itemIds.map(() => '?').join(',');
  const mid = merchantId != null && merchantId !== '' ? Number(merchantId) : null;
  const midOk = mid != null && Number.isFinite(mid);

  const bestCat = new Map();

  const tryBlock = async (fn) => {
    try {
      await fn();
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  };

  await tryBlock(async () => {
    const sql = `SELECT ct.item_id AS tid,
        COALESCE(NULLIF(TRIM(c.category_name_trans), ''), NULLIF(TRIM(c.category_name), '')) AS resolved_category,
        COALESCE(c.sequence, 999999) AS cat_sequence
       FROM mt_category_translation ct
       LEFT JOIN mt_category c ON c.cat_id = ct.cat_id
       WHERE ct.item_id IN (${ph})`;
    if (midOk) {
      const [rows] = await pool.query(`${sql} AND ct.merchant_id = ? ORDER BY ct.item_id ASC, cat_sequence ASC, ct.id ASC`, [...itemIds, mid]);
      mergeOrderItemCategoryMap(bestCat, rows, 'tid', 'resolved_category', 'cat_sequence');
    }
    const [rowsAll] = await pool.query(`${sql} ORDER BY ct.item_id ASC, cat_sequence ASC, ct.id ASC`, itemIds);
    mergeOrderItemCategoryMap(bestCat, rowsAll, 'tid', 'resolved_category', 'cat_sequence');
  });

  await tryBlock(async () => {
    const sql = `SELECT irc.item_id AS tid,
        COALESCE(NULLIF(TRIM(c.category_name_trans), ''), NULLIF(TRIM(c.category_name), '')) AS resolved_category,
        COALESCE(c.sequence, 999999) AS cat_sequence
       FROM mt_item_relationship_category irc
       LEFT JOIN mt_category c ON c.cat_id = irc.cat_id
       WHERE irc.item_id IN (${ph})`;
    if (midOk) {
      const [rows] = await pool.query(`${sql} AND irc.merchant_id = ? ORDER BY irc.item_id ASC, cat_sequence ASC, irc.id ASC`, [...itemIds, mid]);
      mergeOrderItemCategoryMap(bestCat, rows, 'tid', 'resolved_category', 'cat_sequence');
    }
    const [rowsAll] = await pool.query(`${sql} ORDER BY irc.item_id ASC, cat_sequence ASC, irc.id ASC`, itemIds);
    mergeOrderItemCategoryMap(bestCat, rowsAll, 'tid', 'resolved_category', 'cat_sequence');
  });

  const parentBySub = new Map();
  await tryBlock(async () => {
    let sql = `SELECT sub_item_id AS sid, item_id AS pid FROM mt_item_relationship_subcategory_item WHERE sub_item_id IN (${ph})`;
    const params = [...itemIds];
    if (midOk) {
      sql += ' AND merchant_id = ?';
      params.push(mid);
    }
    const [rows] = await pool.query(`${sql} ORDER BY id ASC`, params);
    for (const r of rows || []) {
      if (r.sid == null || r.pid == null) continue;
      const ks = String(r.sid);
      if (!parentBySub.has(ks)) parentBySub.set(ks, String(r.pid));
    }
  });

  for (let pass = 0; pass < Math.min(itemIds.length, 8); pass += 1) {
    let changed = false;
    for (const id of itemIds) {
      const ks = String(id);
      if (bestCat.has(ks)) continue;
      const pid = parentBySub.get(ks);
      if (!pid) continue;
      const p = bestCat.get(pid);
      if (p) {
        bestCat.set(ks, { name: p.name, seq: p.seq + 1000 + pass });
        changed = true;
      }
    }
    if (!changed) break;
  }

  const bestSub = new Map();
  const mergeSub = (rows, nameCol, seqCol) => {
    for (const row of rows || []) {
      const iid = row.tid;
      const name = row[nameCol];
      if (iid == null || !name || !String(name).trim()) continue;
      const seqN = row[seqCol] != null && Number.isFinite(Number(row[seqCol])) ? Number(row[seqCol]) : 999999;
      const k = String(iid);
      const n = String(name).trim();
      const prev = bestSub.get(k);
      if (!prev || seqN < prev.seq) bestSub.set(k, { name: n, seq: seqN });
    }
  };

  await tryBlock(async () => {
    const sql = `SELECT irs.item_id AS tid,
        COALESCE(NULLIF(TRIM(s.subcategory_name), ''), NULLIF(TRIM(s.sub_cat_name), ''), NULLIF(TRIM(s.name), '')) AS sub_name,
        COALESCE(irs.id, 0) AS sub_row_id
       FROM mt_item_relationship_subcategory irs
       LEFT JOIN mt_subcategory s ON s.subcat_id = irs.subcat_id
       WHERE irs.item_id IN (${ph})`;
    const params = midOk ? [...itemIds, mid] : [...itemIds];
    const [rows] = await pool.query(
      midOk ? `${sql} AND irs.merchant_id = ? ORDER BY irs.item_id ASC, irs.id ASC` : `${sql} ORDER BY irs.item_id ASC, irs.id ASC`,
      params
    );
    mergeSub(rows, 'sub_name', 'sub_row_id');
  });

  for (let pass = 0; pass < Math.min(itemIds.length, 8); pass += 1) {
    let changed = false;
    for (const id of itemIds) {
      const ks = String(id);
      if (bestSub.has(ks)) continue;
      const pid = parentBySub.get(ks);
      if (!pid) continue;
      const p = bestSub.get(pid);
      if (p) {
        bestSub.set(ks, { name: p.name, seq: p.seq + 1000 });
        changed = true;
      }
    }
    if (!changed) break;
  }

  const nameTrans = new Map();
  await tryBlock(async () => {
    const [trows] = await pool.query(
      `SELECT item_id AS tid, item_name AS tname, language AS lang
       FROM mt_item_translation
       WHERE item_id IN (${ph})
       ORDER BY item_id ASC,
         CASE WHEN LOWER(TRIM(COALESCE(language,''))) = 'en' THEN 0 ELSE 1 END,
         id ASC`,
      itemIds
    );
    for (const r of trows || []) {
      const k = String(r.tid);
      if (!r.tname || !String(r.tname).trim()) continue;
      if (!nameTrans.has(k)) nameTrans.set(k, String(r.tname).trim());
    }
  });

  return detailRows.map((r) => {
    const idVal = r.item_id ?? r.menu_item_id ?? r.itemId;
    if (idVal == null || String(idVal).trim() === '' || String(idVal).trim() === '0') return { ...r };
    const k = String(idVal);
    const existingCat = r.category_name != null && String(r.category_name).trim() !== '' ? String(r.category_name).trim() : '';
    const cat = existingCat || bestCat.get(k)?.name || r.category_name;
    const sub = bestSub.get(k)?.name;
    const tname = nameTrans.get(k);
    const out = { ...r, category_name: cat || r.category_name };
    if (sub && String(sub).trim()) out.subcategory_name = String(sub).trim();
    if (tname) out.item_name_display = tname;
    return out;
  });
}

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

/** Allow either ADMIN_SECRET (x-admin-key) or valid dashboard session token (mt_admin_user). */
async function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.admin_key || req.body?.admin_key;
  if (ADMIN_SECRET && key === ADMIN_SECRET) return next();
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
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') { /* fall through to 401 */ }
      else return next(e);
    }
  }
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

router.use(adminAuth);

/** Shared by all dashboard admins — stored in `settings` or `mt_option` like other site options. */
const DASHBOARD_MAP_MERCHANT_FILTER_KEY = 'dashboard_map_merchant_filter_ids';

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

async function handleGetDashboardMapMerchantFilter(_req, res) {
  try {
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
    await upsertGlobalSettingKey(jsonStr, DASHBOARD_MAP_MERCHANT_FILTER_KEY);
    return res.json({ ok: true, merchant_ids: normalized });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to save map merchant filter' });
  }
}

// ---- Global dashboard map merchant filter (all admins, all devices) ----
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
    google_api_key, mapbox_access_token, map_provider, fcm_server_key, fcm_service_account_json,
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

  return {
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

  const rows = await fetchDriverRowsForAgentDashboard(filters);

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
  const run = async (sql) => {
    try {
      const [rows] = await pool.query(sql);
      res.json(rows || []);
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
  const shape = (rows) => (rows || []).map((r) => ({
    merchant_id: r.merchant_id,
    restaurant_name: r.restaurant_name || null,
    lat: Number(r.lat),
    lng: Number(r.lng),
    logo_url: r.logo_url || r.logo || r.image_url || null,
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

/**
 * Activity timeline: rows for this task_id plus order-level rows (same order_id, task_id NULL/0).
 * Deduplicates by id, sorts oldest-first like the classic driver app.
 */
async function fetchMergedTaskOrderHistory(pool, taskId, orderId) {
  try {
    const [taskRows] = await pool.query(
      `SELECT ${ORDER_HISTORY_SELECT_COLS} FROM mt_order_history WHERE task_id = ?`,
      [taskId]
    );
    const byId = new Map();
    for (const row of taskRows || []) {
      if (row && row.id != null) byId.set(Number(row.id), row);
    }
    const oid = orderId != null && String(orderId).trim() !== '' && String(orderId).trim() !== '0' ? orderId : null;
    if (oid != null) {
      const [orderOnlyRows] = await pool.query(
        `SELECT ${ORDER_HISTORY_SELECT_COLS} FROM mt_order_history WHERE order_id = ? AND (task_id IS NULL OR task_id = 0)`,
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
        SELECT COALESCE(MAX(h.id), 0) AS cursor
        FROM mt_order_history h
        INNER JOIN mt_driver_task t ON ${historyLinkSql}
        WHERE ${taskCondsSql}`;
      const [rows] = await pool.query(cursorSql, [...taskParams]);
      const cursor = rows && rows[0] ? Number(rows[0].cursor) || 0 : 0;
      return res.json({ cursor, events: [] });
    }

    const listSql = `
      SELECT h.id, h.order_id, h.status, h.remarks, h.date_created, h.update_by_type, h.update_by_name, h.reason, h.notes,
        t.task_id AS resolved_task_id
      FROM mt_order_history h
      INNER JOIN mt_driver_task t ON ${historyLinkSql}
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
    return res.json({ cursor: nextCursor, events: list });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ cursor: afterId, events: [] });
    }
    console.error('[order-history/feed]', e.message || e, e.code);
    return res.status(200).json({ cursor: afterId, events: [] });
  }
});

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
  if (orderId) {
    try {
      const [orderRows] = await pool.query('SELECT * FROM mt_order WHERE order_id = ? LIMIT 1', [orderId]);
      result.order = orderRows.length ? orderRows[0] : null;
      if (result.order) {
        const [detailRows] = await pool.query('SELECT * FROM mt_order_details WHERE order_id = ? ORDER BY id', [orderId]);
        const merchantId = result.order.merchant_id;
        result.order_details = await attachOrderDetailCategories(pool, detailRows || [], merchantId);
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

  // Activity Timeline: task rows + order-only history (initial_order, preparing, etc.), oldest first
  try {
    result.order_history = await fetchMergedTaskOrderHistory(pool, id, task.order_id);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      result.order_history = [];
    } else {
      throw e;
    }
  }

  // Proof of delivery: mt_driver_task_photo for this task (+ proof_urls for timeline)
  const { task_photos, proof_images } = await fetchTaskProofPhotosWithUrls(pool, id);
  result.task_photos = task_photos;
  result.proof_images = proof_images;

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
    del_addr.delivery_location_name, del_addr.delivery_google_lat, del_addr.delivery_google_lng
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
      const drLat = r.driver_lat != null && r.driver_lng != null ? parseFloat(r.driver_lat) : null;
      const drLng = r.driver_lat != null && r.driver_lng != null ? parseFloat(r.driver_lng) : null;
      if (Number.isFinite(drLat) && Number.isFinite(drLng) && Number.isFinite(mapLat) && Number.isFinite(mapLng)) {
        out.direction = bearingToCompass(getBearing(drLat, drLng, mapLat, mapLng));
      } else if (r.direction != null && String(r.direction).trim() !== '') {
        out.direction = String(r.direction).trim();
      } else {
        out.direction = null;
      }
      return out;
    });
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
    const [[task]] = await pool.query('SELECT task_id, order_id, task_description FROM mt_driver_task WHERE task_id = ?', [taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
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
      await pool.query(
        `INSERT INTO mt_driver_pushlog (driver_id, push_title, push_message, push_type, task_id, order_id, date_created, date_process, is_read)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 0)`,
        [driverId, 'Task assigned', task.task_description || `Task #${taskId}`, 'task_assigned', taskId, task.order_id || null]
      );
    } catch (_) {}
    try {
      await sendPushToDriver(driverId, 'Task assigned', task.task_description || `Task #${taskId}`, { task_id: String(taskId), type: 'task_assigned' });
    } catch (_) {}
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable. Please ensure mt_driver_task exists.' });
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
      const [[task]] = await pool.query('SELECT order_id FROM mt_driver_task WHERE task_id = ?', [taskId]);
      await pool.query(
        'INSERT INTO mt_order_history (order_id, task_id, status, remarks, date_created, update_by_type) VALUES (?, ?, ?, ?, NOW(), ?)',
        [task?.order_id || null, taskId, newStatus, remarks, 'admin']
      );
    } catch (_) {
      /* mt_order_history optional — do not fail status update */
    }

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
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Tasks table unavailable.' });
    }
    throw e;
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
    if (result.success) return res.json({ ok: true, message: 'Push sent' });
    return res.status(400).json({ error: result.error || 'Failed to send push' });
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

// ---- SMS logs (stub: empty array if no table) ----
router.get('/sms-logs', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM mt_sms_logs ORDER BY date_created DESC LIMIT 200');
    return res.json(rows);
  } catch (e) {
    return res.json([]);
  }
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

module.exports = router;
