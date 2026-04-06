/** Browser-only: show restaurant logos on Mapbox merchant pins (dashboard map). */
export const MAP_MERCHANT_LOGOS_KEY = 'wib_map_merchant_logos';

export const MAP_MERCHANT_LOGOS_CHANGED_EVENT = 'wib-map-merchant-logos-changed';

export function readMerchantLogosPreference() {
  try {
    return localStorage.getItem(MAP_MERCHANT_LOGOS_KEY) !== '0';
  } catch (_) {
    return true;
  }
}

export function writeMerchantLogosPreference(on) {
  try {
    localStorage.setItem(MAP_MERCHANT_LOGOS_KEY, on ? '1' : '0');
  } catch (_) {}
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(MAP_MERCHANT_LOGOS_CHANGED_EVENT, { detail: { on } }));
    } catch (_) {}
  }
}
