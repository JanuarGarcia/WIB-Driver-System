/**
 * Lightweight in-memory rate limit for POST /driver/api/Login (per IP + normalized login key).
 */

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX = 40;
const buckets = new Map();

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  const first = xff.split(',')[0].trim();
  if (first) return first;
  return (req.socket?.remoteAddress || req.ip || 'unknown').toString();
}

/**
 * @returns {true} if allowed, {false} if rate limited
 */
function checkDriverLoginRateLimit(req, loginKey) {
  const windowMs = parseInt(process.env.DRIVER_LOGIN_RATE_WINDOW_MS || String(DEFAULT_WINDOW_MS), 10);
  const max = parseInt(process.env.DRIVER_LOGIN_RATE_MAX || String(DEFAULT_MAX), 10);
  const w = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
  const m = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX;

  const ip = clientIp(req);
  const k = `${ip}:${(loginKey || '').trim().toLowerCase()}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + w };
    buckets.set(k, b);
  }
  b.count += 1;
  if (b.count > m) return false;
  if (buckets.size > 20000) buckets.clear();
  return true;
}

module.exports = { checkDriverLoginRateLimit, clientIp };
