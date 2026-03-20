/**
 * Pick a single display string from menu/category fields that may be JSON
 * (e.g. {"en":"Pizza","CSTM":"","ADMIN":""}) or plain text.
 */

function pickFromObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return '';
  const preferred = [
    'en',
    'EN',
    'eng',
    'Eng',
    'default',
    'DEFAULT',
    'Cstm',
    'cstm',
    'ADMIN',
    'admin',
  ];
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

function pickLocalizedMenuString(raw) {
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
    } catch (_) {
      /* keep str */
    }
  }
  return str;
}

module.exports = { pickLocalizedMenuString, pickFromObject };
