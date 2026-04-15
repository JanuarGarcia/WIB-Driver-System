import { api } from '../api';
import {
  getToken,
  getDashboardAdminId,
  setDashboardAdminId,
  notifyDashboardAdminIdChanged,
} from '../auth';

/** Prefix for localStorage keys: exact legacy key, or `${prefix}:${adminId}` per account. */
export const MAP_MERCHANT_FILTER_STORAGE_KEY = 'wib-map-merchant-filter-ids';

const FILTER_CHANGED = 'wib-map-merchant-filter-changed';

const HYDRATE_PATHS = ['settings/map-merchant-filter', 'user-preferences/map-merchant-filter'];

export function getMapMerchantFilterStorageKey() {
  const id = getDashboardAdminId();
  return id ? `${MAP_MERCHANT_FILTER_STORAGE_KEY}:${id}` : MAP_MERCHANT_FILTER_STORAGE_KEY;
}

export async function ensureDashboardAdminId() {
  if (!getToken()) return null;
  const existing = getDashboardAdminId();
  if (existing) return existing;
  try {
    const me = await api('auth/me');
    const aid = me?.admin_id;
    if (aid != null && String(aid).trim() !== '') {
      const s = String(aid).trim();
      setDashboardAdminId(s, { skipEvent: true });
      migrateLegacyMapMerchantFilterLocalStorage();
      notifyDashboardAdminIdChanged();
      return s;
    }
  } catch (_) {}
  return null;
}

/** Copy unscoped legacy cache into the current account key after login. */
export function migrateLegacyMapMerchantFilterLocalStorage() {
  try {
    const id = getDashboardAdminId();
    if (!id) return;
    const scoped = `${MAP_MERCHANT_FILTER_STORAGE_KEY}:${id}`;
    if (localStorage.getItem(scoped) != null) return;
    const raw = localStorage.getItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
    if (raw == null || raw === '') return;
    localStorage.setItem(scoped, raw);
    localStorage.removeItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
    try {
      const parsed = JSON.parse(raw);
      const normalized = normalizeMapMerchantFilterIds(parsed);
      window.dispatchEvent(new CustomEvent(FILTER_CHANGED, { detail: { ids: normalized } }));
    } catch (_) {
      window.dispatchEvent(new CustomEvent(FILTER_CHANGED, { detail: { ids: [] } }));
    }
  } catch (_) {}
}

export function normalizeMapMerchantFilterIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  const seen = new Set();
  for (const x of ids) {
    if (x == null) continue;
    const s = String(x).trim();
    if (!s || s === 'null' || s === 'undefined') continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Read raw JSON array from localStorage; one-time migrate from legacy sessionStorage (unscoped only). */
function readMerchantFilterRaw() {
  try {
    const key = getMapMerchantFilterStorageKey();
    let raw = localStorage.getItem(key);
    if (raw == null || raw === '') {
      if (key === MAP_MERCHANT_FILTER_STORAGE_KEY) {
        const legacy = sessionStorage.getItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
        if (legacy) {
          localStorage.setItem(MAP_MERCHANT_FILTER_STORAGE_KEY, legacy);
          sessionStorage.removeItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
          raw = legacy;
        }
      }
    }
    return raw;
  } catch (_) {
    return null;
  }
}

export function loadMapMerchantFilterFromSession() {
  try {
    const raw = readMerchantFilterRaw();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeMapMerchantFilterIds(parsed);
  } catch (_) {
    return [];
  }
}

let persistTimer = null;

function persistMapMerchantFilterToServer(ids) {
  if (!getToken()) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const body = JSON.stringify({ merchant_ids: ids });
    api('settings/map-merchant-filter', { method: 'PUT', body })
      .catch(() => api('user-preferences/map-merchant-filter', { method: 'PUT', body }).catch(() => {}));
  }, 450);
}

/**
 * @param {string[]} ids
 * @param {{ skipServerPut?: boolean }} [opts]
 */
export function saveMapMerchantFilterToSession(ids, opts = {}) {
  const normalized = normalizeMapMerchantFilterIds(ids);
  try {
    const key = getMapMerchantFilterStorageKey();
    if (normalized.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(normalized));
    if (key === MAP_MERCHANT_FILTER_STORAGE_KEY) {
      sessionStorage.removeItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
    }
  } catch (_) {}
  if (!opts.skipServerPut) persistMapMerchantFilterToServer(normalized);
  try {
    window.dispatchEvent(new CustomEvent(FILTER_CHANGED, { detail: { ids: normalized } }));
  } catch (_) {}
}

/** Load merchant filter for the signed-in admin from API; updates local cache. @returns {Promise<boolean>} true if server responded with a definitive value */
export async function hydrateMapMerchantFilterFromServer() {
  await ensureDashboardAdminId();
  migrateLegacyMapMerchantFilterLocalStorage();
  if (!getToken()) return false;
  for (const path of HYDRATE_PATHS) {
    try {
      const data = await api(path);
      if (data && Array.isArray(data.merchant_ids)) {
        const cleaned = normalizeMapMerchantFilterIds(data.merchant_ids);
        saveMapMerchantFilterToSession(cleaned, { skipServerPut: true });
        return true;
      }
      if (data && data.merchant_ids === null) return true;
    } catch {
      /* try next path */
    }
  }
  return false;
}

let hydrateDebounce = null;

/** Re-fetch filter when the user returns to the tab / window (fixes missed first load or stale cache). */
export function setupMapMerchantFilterServerListeners() {
  const schedule = () => {
    if (!getToken()) return;
    clearTimeout(hydrateDebounce);
    hydrateDebounce = setTimeout(() => hydrateMapMerchantFilterFromServer(), 280);
  };
  const onVis = () => {
    if (document.visibilityState === 'visible') schedule();
  };
  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', onVis);
  return () => {
    clearTimeout(hydrateDebounce);
    window.removeEventListener('focus', schedule);
    document.removeEventListener('visibilitychange', onVis);
  };
}

export { FILTER_CHANGED };
