/**
 * MySQL query helper that enforces a hard timeout and attempts to abort in-flight work.
 * Designed to prevent hung HTTP requests when the DB is locked, saturated, or slow.
 */

/**
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {() => void} [onTimeout]
 */
function promiseTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let t = null;
  const timeoutPromise = new Promise((_, reject) => {
    t = setTimeout(() => {
      try {
        if (onTimeout) onTimeout();
      } finally {
        const err = new Error(`Operation timed out after ${ms}ms`);
        err.code = 'ETIMEDOUT';
        reject(err);
      }
    }, ms);
  });
  return Promise.race([promise.finally(() => t && clearTimeout(t)), timeoutPromise]);
}

function clampInt(n, fallback, min, max) {
  const v = parseInt(String(n ?? ''), 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/**
 * Run a query with a strict timeout (and best-effort DB-level lock wait timeout).
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} sql
 * @param {any[]} params
 * @param {{ timeoutMs?: number, lockWaitTimeoutSec?: number, connectTimeoutMs?: number }} [opts]
 */
async function queryWithTimeout(pool, sql, params = [], opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs, 8000, 250, 60000);
  const connectTimeoutMs = clampInt(opts.connectTimeoutMs, Math.min(2000, timeoutMs), 250, 60000);
  const lockWaitTimeoutSec = clampInt(opts.lockWaitTimeoutSec, 5, 1, 60);

  /** @type {import('mysql2/promise').PoolConnection|null} */
  let conn = null;
  try {
    conn = await promiseTimeout(pool.getConnection(), connectTimeoutMs);
    try {
      await conn.query('SET SESSION innodb_lock_wait_timeout = ?', [lockWaitTimeoutSec]);
    } catch {
      // ignore on older MySQL / limited perms
    }

    const queryPromise = conn.query({ sql, timeout: timeoutMs }, params);
    return await promiseTimeout(queryPromise, timeoutMs, () => {
      try {
        if (conn && typeof conn.destroy === 'function') conn.destroy();
      } catch {
        // ignore
      }
    });
  } finally {
    try {
      if (conn && typeof conn.release === 'function') conn.release();
    } catch {
      // ignore (may be destroyed)
    }
  }
}

module.exports = { queryWithTimeout, promiseTimeout };

