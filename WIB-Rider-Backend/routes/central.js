/**
 * Centralized read-only endpoints that touch named MySQL pools:
 * - mercifulGodPool  → DB_MERCIFULGOD_NAME (default wheninba_MercifulGod)
 * - errandWibPool    → DB_ERRANDWIB_NAME (default wheninba_ErrandWib)
 * - pool (default)   → DB_NAME — existing app tables (admin auth, tasks, …)
 *
 * TODO: Map domain tables to the correct pool before adding business queries here.
 *       Do not join across databases in SQL; merge in Node after separate queries.
 */

const express = require('express');
const router = express.Router();
const { pool, mercifulGodPool, errandWibPool, databaseNames } = require('../config/db');

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

/** Same rules as routes/admin.js `adminAuth` — session lives on primary `pool`. */
async function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.admin_key || req.body?.admin_key;
  if (ADMIN_SECRET && key === ADMIN_SECRET) return next();
  const token = (req.headers['x-dashboard-token'] || '').trim();
  if (token) {
    try {
      const [[user]] = await pool.query(
        'SELECT admin_id FROM mt_admin_user WHERE session_token = ? AND (status IS NULL OR status = 1 OR status = ?) LIMIT 1',
        [token, 'active']
      );
      if (user) return next();
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') return next(e);
    }
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

const SCHEMA_OVERVIEW_SQL = `
  SELECT
    DATABASE() AS current_database,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS table_count
`;

/**
 * @param {import('mysql2/promise').Pool} poolRef
 * @param {string} sourceLabel
 */
async function safeSchemaOverview(poolRef, sourceLabel) {
  try {
    const [rows] = await poolRef.query(SCHEMA_OVERVIEW_SQL);
    const row = rows && rows[0];
    return {
      ok: true,
      source: sourceLabel,
      current_database: row?.current_database ?? null,
      table_count: row?.table_count != null ? Number(row.table_count) : null,
    };
  } catch (e) {
    return {
      ok: false,
      source: sourceLabel,
      error: e.message || String(e),
      code: e.code || null,
    };
  }
}

/** Example: MercifulGod pool only — schema introspection (no app tables assumed). */
router.get('/merciful-god/ping', adminAuth, async (_req, res) => {
  const body = await safeSchemaOverview(mercifulGodPool, 'mercifulGod');
  res.json({ ...body, configuredDatabase: databaseNames.mercifulGod });
});

/** Example: ErrandWib pool only. */
router.get('/errand-wib/ping', adminAuth, async (_req, res) => {
  const body = await safeSchemaOverview(errandWibPool, 'errandWib');
  res.json({ ...body, configuredDatabase: databaseNames.errandWib });
});

/** Combined snapshot: primary pool + both named databases (parallel reads, merged JSON). */
router.get('/unified-overview', adminAuth, async (_req, res) => {
  const [primary, merciful, errand] = await Promise.all([
    safeSchemaOverview(pool, 'defaultPool'),
    safeSchemaOverview(mercifulGodPool, 'mercifulGod'),
    safeSchemaOverview(errandWibPool, 'errandWib'),
  ]);
  const okCount = [primary, merciful, errand].filter((x) => x.ok).length;
  res.json({
    generatedAt: new Date().toISOString(),
    databaseNames,
    defaultPool: primary,
    mercifulGod: merciful,
    errandWib: errand,
    summary: {
      connectionsReportingOk: okCount,
      totalOfThree: 3,
    },
  });
});

module.exports = router;
