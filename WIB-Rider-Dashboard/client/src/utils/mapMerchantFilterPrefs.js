import { api } from '../api';
import { getToken } from '../auth';

export const MAP_MERCHANT_FILTER_STORAGE_KEY = 'wib-map-merchant-filter-ids';

const FILTER_CHANGED = 'wib-map-merchant-filter-changed';

const HYDRATE_PATHS = ['settings/map-merchant-filter', 'user-preferences/map-merchant-filter'];

/** Read raw JSON array from localStorage; one-time migrate from legacy sessionStorage. */
function readMerchantFilterRaw() {
  try {
    let raw = localStorage.getItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
    if (raw == null || raw === '') {
      const legacy = sessionStorage.getItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
      if (legacy) {
        localStorage.setItem(MAP_MERCHANT_FILTER_STORAGE_KEY, legacy);
        sessionStorage.removeItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
        raw = legacy;
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
    return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean) : [];
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
  const normalized = Array.isArray(ids) ? ids.map((x) => String(x)).filter(Boolean) : [];
  try {
    if (normalized.length === 0) localStorage.removeItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
    else localStorage.setItem(MAP_MERCHANT_FILTER_STORAGE_KEY, JSON.stringify(normalized));
    sessionStorage.removeItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
  } catch (_) {}
  if (!opts.skipServerPut) persistMapMerchantFilterToServer(normalized);
  try {
    window.dispatchEvent(new CustomEvent(FILTER_CHANGED, { detail: { ids: normalized } }));
  } catch (_) {}
}

/** Load global merchant filter from API (shared for all admins). Tries both URL paths for older servers/bundles. */
export async function hydrateMapMerchantFilterFromServer() {
  if (!getToken()) return;
  for (const path of HYDRATE_PATHS) {
    try {
      const data = await api(path);
      if (data && Array.isArray(data.merchant_ids)) {
        saveMapMerchantFilterToSession(data.merchant_ids, { skipServerPut: true });
        return;
      }
      if (data && data.merchant_ids === null) return;
    } catch {
      /* try next path */
    }
  }
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
