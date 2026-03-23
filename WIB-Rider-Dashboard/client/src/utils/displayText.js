/**
 * Clean location / merchant names that were double-escaped in DB or JSON
 * (e.g. Ali\\'s → Ali's, \/ → /). Display-only; does not change stored data.
 */
export function sanitizeLocationDisplayName(raw) {
  if (raw == null) return '';
  let s = String(raw);
  if (!s) return s;
  for (let i = 0; i < 12; i++) {
    const next = s
      .replace(/\\(["'])/g, '$1')
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\\/g, '');
  return s.trim();
}

/**
 * Merchant / restaurant labels on map and settings: remove forward and back slashes
 * (common JSON/path artifacts). Display-only.
 */
export function sanitizeMerchantDisplayName(raw) {
  const base = sanitizeLocationDisplayName(raw);
  if (!base) return '';
  return base.replace(/[/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickFromObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return '';
  const preferred = ['en', 'EN', 'eng', 'Eng', 'default', 'DEFAULT', 'Cstm', 'cstm', 'ADMIN', 'admin'];
  for (const k of preferred) {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      const v = o[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && !Number.isNaN(v)) return String(v);
  }
  return '';
}

/** Resolve menu/category JSON blobs like {"EN":"","CSTM":""} to one display string. */
export function pickLocalizedMenuString(raw) {
  if (raw == null) return '';
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return pickFromObject(raw);
  }
  let str = typeof raw === 'string' ? raw : String(raw);
  str = str.trim();
  if (!str) return '';
  if ((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'))) {
    try {
      const o = JSON.parse(str);
      if (o && typeof o === 'object') {
        const fromObj = pickFromObject(o);
        if (fromObj) return fromObj;
      }
    } catch {
      /* keep str */
    }
  }
  return str;
}
