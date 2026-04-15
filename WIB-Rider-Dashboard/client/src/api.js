import { getToken, clearToken, getAuthEpoch } from './auth';

/** True if a string looks like an HTML document (cPanel, 404 page, SPA index, etc.). */
export function looksLikeHtmlResponse(s) {
  if (s == null || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 24) return false;
  if (/^\s*<\s*!DOCTYPE/i.test(t)) return true;
  if (/^\s*<\s*html\b/i.test(t)) return true;
  if (/<!DOCTYPE\s+html/i.test(s)) return true;
  if (/<\s*html\b[\s>]/i.test(s) && /<\/html>/i.test(s)) return true;
  if (/<\s*head\b[^>]*>[\s\S]*<\s*title[^>]*>\s*cPanel/i.test(t)) return true;
  if (s.length > 200 && /cPanel\s+Login/i.test(s) && /<\/html>/i.test(s)) return true;
  return false;
}

/**
 * Normalize failed HTTP payloads so UI never shows multi‑KB HTML dumps.
 * @param {number} status
 * @param {unknown} data - parsed JSON body, or raw string from parse failure
 * @returns {{ error?: string, status?: number, code?: string, [k: string]: unknown }}
 */
export function normalizeHttpError(status, data) {
  const htmlMsg =
    'The server returned a web page instead of API data (wrong URL, hosting login, or session expired). Check that the dashboard points at the Node rider API, then try logging in again.';
  const authMsg = 'Your dashboard session has expired or you are not authorized. Please log in again.';

  if (typeof data === 'string') {
    if (looksLikeHtmlResponse(data)) {
      return {
        error: status === 401 || status === 403 ? authMsg : htmlMsg,
        status,
        code: status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'HTML_RESPONSE',
      };
    }
    const short = data.length > 500 ? `${data.slice(0, 400).trim()}…` : data;
    return { error: short || 'Request failed', status };
  }

  if (data && typeof data === 'object') {
    const o = /** @type {Record<string, unknown>} */ ({ ...data });
    if (typeof o.error === 'string' && looksLikeHtmlResponse(o.error)) {
      o.error = status === 401 || status === 403 ? authMsg : htmlMsg;
      o.code = status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'HTML_RESPONSE';
    }
    if (typeof o.message === 'string' && looksLikeHtmlResponse(o.message)) {
      o.message = typeof o.error === 'string' ? o.error : htmlMsg;
    }
    if (status === 401 || status === 403) {
      const errStr = typeof o.error === 'string' ? o.error.toLowerCase() : '';
      if (!errStr.includes('invalid credential')) {
        o.error = authMsg;
        o.code = 'AUTH_REQUIRED';
      }
    }
    if (!o.error && !o.message) o.error = 'Request failed';
    o.status = status;
    return o;
  }

  return { error: 'Request failed', status };
}

/**
 * Safe message for alerts / modals (handles thrown strings, HTML, huge blobs).
 * @param {unknown} err
 * @returns {string}
 */
export function userFacingApiError(err) {
  if (err == null) return 'Something went wrong.';
  if (typeof err === 'string') {
    if (looksLikeHtmlResponse(err)) {
      return 'The server returned a web page instead of JSON. Check the API URL and try logging in again.';
    }
    return err.length > 600 ? `${err.slice(0, 400).trim()}…` : err;
  }
  if (typeof err === 'object') {
    const o = /** @type {Record<string, unknown>} */ (err);
    const raw = o.error ?? o.message;
    if (typeof raw === 'string') {
      if (looksLikeHtmlResponse(raw)) {
        return typeof o.code === 'string' && o.code === 'HTML_RESPONSE'
          ? 'The server returned a web page instead of API data. Check VITE_API_URL / hosting configuration.'
          : 'Your session may have expired. Please log in again.';
      }
      return raw.length > 600 ? `${raw.slice(0, 400).trim()}…` : raw;
    }
  }
  return 'Something went wrong.';
}

// Prefer explicit env-configured base URL (useful for phones / other devices).
// Default /api: Vite dev proxy and dashboard server.js both map /api/* -> backend /admin/api/*.
// Do not use /admin/api in the browser on static hosting without that proxy.
export const API_BASE = import.meta.env.VITE_API_URL || '/api';
const API = API_BASE;

/** Coalesce identical in-flight GETs (Dashboard + TaskPanel often request the same `tasks?date=`). */
const __apiInflightGet = new Map();

/**
 * Map / Merchants table: logo <img> cannot send auth headers. This URL hits /admin/api/merchants/public-logo/…
 * (same path shape as JSON APIs) so it works through the dashboard /api proxy even when /uploads is not exposed on the dashboard host.
 * @param {string|null|undefined} filename basename only, e.g. rose-cafe.png
 * @returns {string|null}
 */
export function resolveMerchantPublicLogoUrl(filename) {
  const raw = filename != null ? String(filename).trim() : '';
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const baseName = (raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() || raw).split('?')[0].split('#')[0];
  if (!/\.(jpe?g|png|gif|webp)$/i.test(baseName)) return null;
  const enc = encodeURIComponent(baseName);
  const base = String(API_BASE || '/api').replace(/\/$/, '');
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return `${base}/merchants/public-logo/${enc}`;
  }
  const prefix = base.startsWith('/') ? base : `/${base}`;
  return `${prefix}/merchants/public-logo/${enc}`;
}

/** Covers the whole call (headers + body) — a slow `res.text()` was able to hang forever before. */
const API_FETCH_TIMEOUT_MS = Math.min(
  600000,
  Math.max(8000, Number(import.meta.env.VITE_API_FETCH_TIMEOUT_MS) || 75000)
);

/**
 * Absolute URL for EventSource under the same base as {@link api} (SSE cannot use fetch headers).
 * When VITE_API_URL points at the Node rider API, a relative `/api/...` URL would hit static hosting only.
 */
export function apiEventSourceUrl(path, queryString = '') {
  const base = API.replace(/\/$/, '');
  const pathStr = String(path || '').trim();
  const url = API.startsWith('http')
    ? pathStr.startsWith('/')
      ? base + pathStr
      : `${base}/${pathStr}`
    : pathStr.startsWith('/')
      ? pathStr
      : `${API}/${pathStr}`;
  const q = queryString
    ? queryString.startsWith('?')
      ? queryString
      : `?${queryString}`
    : '';
  return `${url}${q}`;
}

/** Origin where `/uploads/...` is served (matches API app in app.js). */
export function uploadsOrigin() {
  const raw = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '');
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const u = new URL(raw);
      let p = (u.pathname || '/').replace(/\/+$/, '');
      if (p === '/') p = '';
      if (p.endsWith('/admin/api')) p = p.slice(0, -'/admin/api'.length);
      else if (p.endsWith('/api')) p = p.slice(0, -'/api'.length);
      p = p.replace(/\/+$/, '');
      return `${u.protocol}//${u.host}${p}`;
    } catch {
      return raw
        .replace(/\/admin\/api\/?$/i, '')
        .replace(/\/api\/?$/i, '')
        .replace(/\/$/, '');
    }
  }
  if (import.meta.env.DEV) return 'http://localhost:3000';
  return '';
}

/** Turn relative upload paths into absolute URLs when the API is on another host (e.g. Vite dev or split deploy). */
export function resolveUploadUrl(path) {
  if (path == null || typeof path !== 'string') return path;
  const p = path.trim();
  if (!p) return p;
  const lower = p.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:')
  ) {
    return p;
  }
  const rel = p.startsWith('/') ? p : `/${p}`;
  const origin = uploadsOrigin();
  return origin ? `${origin}${rel}` : rel;
}

export async function api(path, options = {}) {
  const authEpochAtStart = getAuthEpoch();
  const base = API.replace(/\/$/, '');
  const url = API.startsWith('http')
    ? (path.startsWith('/') ? base + path : `${base}/${path}`)
    : (path.startsWith('/') ? path : `${API}/${path}`);
  const { skipDedupe, signal: userSignal, fetchTimeoutMs: fetchTimeoutOpt, ...fetchOptions } = options;
  const headers = { 'Content-Type': 'application/json', ...fetchOptions.headers };
  const timeoutMs =
    fetchTimeoutOpt != null &&
    Number.isFinite(Number(fetchTimeoutOpt)) &&
    Number(fetchTimeoutOpt) >= 3000 &&
    Number(fetchTimeoutOpt) <= 120000
      ? Number(fetchTimeoutOpt)
      : API_FETCH_TIMEOUT_MS;
  const token = getToken();
  if (token) headers['x-dashboard-token'] = token;

  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const hasBody = fetchOptions.body != null && String(fetchOptions.body).trim() !== '';
  const canDedupe =
    method === 'GET' &&
    skipDedupe !== true &&
    userSignal == null &&
    fetchOptions.signal == null &&
    !hasBody;
  const dedupeKey = canDedupe ? `GET ${url}` : null;
  if (dedupeKey) {
    const hit = __apiInflightGet.get(dedupeKey);
    if (hit) return hit;
  }

  const runFetch = async () => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    if (userSignal) {
      if (userSignal.aborted) ctrl.abort();
      else userSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    let res;
    try {
      res = await fetch(url, { ...fetchOptions, headers, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(tid);
      const aborted = e && (e.name === 'AbortError' || String(e.message || '').toLowerCase().includes('abort'));
      if (aborted) {
        throw {
          error: 'Request timed out. The server may be busy — wait a moment or refresh the page.',
          code: 'TIMEOUT',
        };
      }
      throw e;
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || String(e.message || '').toLowerCase().includes('abort'));
      clearTimeout(tid);
      if (aborted) {
        throw {
          error: 'Request timed out. The server may be busy — wait a moment or refresh the page.',
          code: 'TIMEOUT',
        };
      }
      throw e;
    } finally {
      clearTimeout(tid);
    }
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      if (looksLikeHtmlResponse(text)) {
        const normalized = normalizeHttpError(res.status, text);
        const isLoginAttempt = /\/auth\/login\b/i.test(url);
        if (
          normalized.code === 'AUTH_REQUIRED' &&
          !isLoginAttempt &&
          typeof window !== 'undefined' &&
          getAuthEpoch() === authEpochAtStart
        ) {
          try {
            clearToken();
            window.dispatchEvent(new CustomEvent('wib-dashboard-session-expired'));
          } catch (_) {}
        }
        throw normalized;
      }
      throw { error: 'Invalid response from server', message: e instanceof Error ? e.message : String(e) };
    }

    if (typeof data === 'string' && looksLikeHtmlResponse(data)) {
      data = { error: data };
    }

    if (!res.ok) {
      const normalized = normalizeHttpError(res.status, data);
      const isLoginAttempt = /\/auth\/login\b/i.test(url);
      if (
        normalized.code === 'AUTH_REQUIRED' &&
        !isLoginAttempt &&
        typeof window !== 'undefined' &&
        getAuthEpoch() === authEpochAtStart
      ) {
        try {
          clearToken();
          window.dispatchEvent(new CustomEvent('wib-dashboard-session-expired'));
        } catch (_) {}
      }
      throw normalized;
    }
    return data;
  };

  if (dedupeKey) {
    const p = runFetch();
    __apiInflightGet.set(dedupeKey, p);
    p.finally(() => {
      if (__apiInflightGet.get(dedupeKey) === p) __apiInflightGet.delete(dedupeKey);
    });
    return p;
  }

  return runFetch();
}

export function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleString();
}

/** Calendar date only (no time) — use for order delivery_date, etc. */
export function formatDateOnly(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) {
    const s = String(d).trim();
    return s.length >= 10 ? s.slice(0, 10) : s || '—';
  }
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Activity timeline: "March 21, 2026, 2:14 PM" (no seconds). */
export function formatActivityTimelineDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const datePart = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const timePart = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${datePart}, ${timePart}`;
}

/** Compact timeline time (legacy rider UI style): "Mar 24, 26 8:56 am". */
export function formatActivityTimelineDateTimeShort(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const mon = dt.toLocaleDateString('en-US', { month: 'short' });
  const day = dt.getDate();
  const yy = String(dt.getFullYear()).slice(-2);
  const timePart = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  return `${mon}-${day}-${yy} ${timePart}`;
}

/** Normalize status strings for class lookup ("Ready For Pickup", "initial_order", etc.). */
function statusClassKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

/** Status class for tags - matches WIB Driver app + classic rider Activity Timeline */
export function statusClass(s) {
  if (!s) return 'status-default';
  const v = statusClassKey(s);
  if (v === 'failed') return 'status-red';
  if (['declined', 'cancelled', 'canceled'].includes(v)) return 'status-amber';
  if (
    ['assigned', 'unassigned', 'acknowledged', 'successful', 'completed', 'delivered'].includes(v)
  ) {
    return 'status-green';
  }
  if (
    [
      'started',
      'inprogress',
      'photo',
      'verification',
      'preparing',
      'readypickup',
      'readyforpickup',
      'initialorder',
      'deliveryonitsway',
      'arrivedat',
      'advanceorder',
    ].includes(v)
  ) {
    return 'status-blue';
  }
  return 'status-default';
}

/** Status badge label - matches WIB Driver app task_details_screen _statusBadgeLabel */
export function statusLabel(s) {
  if (!s || !String(s).trim()) return 'UNKNOWN';
  const v = String(s).toLowerCase().trim();
  switch (v) {
    case 'acknowledged': return 'ACCEPTED';
    case 'started': return 'STARTED';
    case 'inprogress': return 'IN PROGRESS';
    case 'successful': return 'DELIVERED';
    case 'failed': return 'FAILED';
    case 'declined': return 'REJECTED';
    case 'cancelled':
    case 'canceled': return 'CANCELLED';
    default: return v.toUpperCase();
  }
}

/** Same as statusClass - for display class (Status column only) */
export function statusDisplayClass(s) {
  return statusClass(s);
}

/** Centralized backend: MercifulGod pool only (admin session required). */
export function centralMercifulGodPing() {
  return api('central/merciful-god/ping');
}

/** Centralized backend: ErrandWib pool only. */
export function centralErrandWibPing() {
  return api('central/errand-wib/ping');
}

