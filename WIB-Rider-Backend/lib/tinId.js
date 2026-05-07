const MAX_LEN = 50;
const TIN_ID_RE = /^[0-9-]+$/;

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string|null } | { ok: false, error: string }}
 */
function validateOptionalTinId(raw) {
  const s = raw != null ? String(raw) : '';
  const trimmed = s.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > MAX_LEN) return { ok: false, error: `TIN ID is too long (maximum ${MAX_LEN} characters).` };
  if (!TIN_ID_RE.test(trimmed)) {
    return { ok: false, error: 'TIN ID must contain numbers and dashes only (example: 123-456-789-000).' };
  }
  return { ok: true, value: trimmed };
}

module.exports = {
  MAX_LEN,
  validateOptionalTinId,
};

