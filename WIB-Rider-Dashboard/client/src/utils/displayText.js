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
