/**
 * Rider-submitted text when moving a task / Mangan order to a negative terminal state.
 * Used by driver ChangeTaskStatus + ChangeErrandOrderStatus.
 */

const MIN_LEN = 5;
const MAX_LEN = 2000;

/** Food task `status` / errand-ish raw strings (normalized: lower, no spaces/underscores). */
const FOOD_STATUS_REQUIRING_REASON = new Set([
  'cancelled',
  'canceled',
  'failed',
  'declined',
  'rejected',
  'unassigned',
]);

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeFoodTaskStatusKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

/**
 * @param {unknown} statusRaw
 * @returns {boolean}
 */
function foodTaskStatusRequiresRiderReason(statusRaw) {
  return FOOD_STATUS_REQUIRING_REASON.has(normalizeFoodTaskStatusKey(statusRaw));
}

/**
 * Errand canonical from `normalizeIncomingStatusRaw` (already lower snake).
 * @param {unknown} canonical
 * @returns {boolean}
 */
function errandCanonicalRequiresRiderReason(canonical) {
  const s = String(canonical || '')
    .toLowerCase()
    .trim();
  return s === 'cancelled' || s === 'failed' || s === 'declined' || s === 'unassigned';
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, reason: string } | { ok: false, error: string }}
 */
function validateRiderOutcomeReason(raw) {
  const s = raw != null ? String(raw).trim() : '';
  if (s.length < MIN_LEN) {
    return {
      ok: false,
      error: `A rider reason is required (${MIN_LEN}–${MAX_LEN} characters) for this status.`,
    };
  }
  if (s.length > MAX_LEN) {
    return { ok: false, error: `Reason is too long (maximum ${MAX_LEN} characters).` };
  }
  return { ok: true, reason: s };
}

module.exports = {
  MIN_LEN,
  MAX_LEN,
  normalizeFoodTaskStatusKey,
  foodTaskStatusRequiresRiderReason,
  errandCanonicalRequiresRiderReason,
  validateRiderOutcomeReason,
};
