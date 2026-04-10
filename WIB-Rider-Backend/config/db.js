const mysql = require('mysql2/promise');

/**
 * Shared connection settings. Per-database overrides: DB_MERCIFULGOD_* and DB_ERRANDWIB_* (optional).
 * Primary pool (`pool`) keeps backward compatibility — all existing routes use `require('../config/db').pool`.
 *
 * TODO: Confirm which production schema owns legacy tables (mt_driver_task, mt_order, mt_admin_user, …).
 *       Typically the rider dashboard uses one DB; set DB_NAME to that. The named pools below are for
 *       cross-reading wheninba_MercifulGod vs wheninba_ErrandWib without mixing writes.
 */
/**
 * Default 10 per pool (three pools may exist → cap total client connections).
 * Raising this without raising MySQL max_user_connections / max_connections often causes
 * every API route to return 500 on shared hosting.
 */
function poolConnectionLimit() {
  const n = parseInt(String(process.env.DB_POOL_CONNECTION_LIMIT || '10'), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(200, n) : 10;
}

/** Optional second/third DB pools — keep small so raising DB_POOL_CONNECTION_LIMIT does not 3× MySQL usage. */
function auxPoolConnectionLimit() {
  const n = parseInt(String(process.env.DB_AUX_POOL_CONNECTION_LIMIT || '5'), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(100, n) : 5;
}

function baseConn(overrides = {}, connectionLimit = poolConnectionLimit()) {
  return {
    host: overrides.host ?? process.env.DB_HOST ?? 'localhost',
    port: parseInt(String((overrides.port ?? process.env.DB_PORT) || '3306'), 10),
    user: overrides.user ?? process.env.DB_USER ?? 'root',
    password: overrides.password ?? process.env.DB_PASSWORD ?? '',
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    connectTimeout: parseInt(String(process.env.DB_CONNECT_TIMEOUT_MS || '20000'), 10) || 20000,
  };
}

const mercifulOverrides = {
  host: process.env.DB_MERCIFULGOD_HOST,
  port: process.env.DB_MERCIFULGOD_PORT,
  user: process.env.DB_MERCIFULGOD_USER,
  password: process.env.DB_MERCIFULGOD_PASSWORD,
};
const errandOverrides = {
  host: process.env.DB_ERRANDWIB_HOST,
  port: process.env.DB_ERRANDWIB_PORT,
  user: process.env.DB_ERRANDWIB_USER,
  password: process.env.DB_ERRANDWIB_PASSWORD,
};

/** @type {string} Legacy primary — unchanged default for existing features. */
const primaryDatabase = process.env.DB_NAME || 'wib_driver';

/** wheninba_MercifulGod — use for MercifulGod-only reads (no cross-DB joins in SQL). */
const mercifulGodDatabase = process.env.DB_MERCIFULGOD_NAME || 'wheninba_MercifulGod';

/** wheninba_ErrandWib — use for Errand/WIB-only reads. */
const errandWibDatabase = process.env.DB_ERRANDWIB_NAME || 'wheninba_ErrandWib';

const pool = mysql.createPool({
  ...baseConn({}, poolConnectionLimit()),
  database: primaryDatabase,
});

const mercifulGodPool = mysql.createPool({
  ...baseConn(mercifulOverrides, auxPoolConnectionLimit()),
  database: mercifulGodDatabase,
});

const errandWibPool = mysql.createPool({
  ...baseConn(errandOverrides, auxPoolConnectionLimit()),
  database: errandWibDatabase,
});

module.exports = {
  pool,
  mercifulGodPool,
  errandWibPool,
  pools: {
    default: pool,
    mercifulGod: mercifulGodPool,
    errandWib: errandWibPool,
  },
  /** Introspection for health checks (non-secret). */
  databaseNames: {
    primary: primaryDatabase,
    mercifulGod: mercifulGodDatabase,
    errandWib: errandWibDatabase,
  },
};
