/**
 * Map ErrandWib `st_ordernew` (and variants) payment fields to driver-app enums.
 * Flutter expects: cod | paymongo_gcash | pyr (see paymentMethodDisplay).
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {string|null}
 */
function normalizeDriverPaymentType(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [
    row.payment_type,
    row.paymentType,
    row.payment_method,
    row.paymentMethod,
    row.payment_code,
    row.paymentCode,
    row.pay_mode,
    row.payMode,
  ];
  for (const raw of candidates) {
    if (raw == null || String(raw).trim() === '') continue;
    const mapped = mapPaymentRawToEnum(String(raw).trim());
    if (mapped) return mapped;
  }
  return null;
}

/**
 * @param {string} raw
 * @returns {'cod'|'paymongo_gcash'|'pyr'|null}
 */
function mapPaymentRawToEnum(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const compact = lower.replace(/[\s\-_.]+/g, '').replace(/'/g, '');

  if (compact === 'cod' || compact === 'cashondelivery' || (lower.includes('cash') && lower.includes('deliver'))) {
    return 'cod';
  }
  if (
    compact === 'paymongo_gcash' ||
    compact === 'paymongogcash' ||
    (lower.includes('paymongo') && lower.includes('gcash')) ||
    compact === 'gcash'
  ) {
    return 'paymongo_gcash';
  }
  if (compact === 'pyr' || lower.includes('qr') || compact === 'manual' || lower.includes('manual pay')) {
    return 'pyr';
  }
  if (lower === 'cod' || lower === 'paymongo_gcash' || lower === 'pyr') return lower;

  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string|null}
 */
function normalizeDriverPaymentStatus(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [
    row.payment_status,
    row.paymentStatus,
    row.order_payment_status,
    row.orderPaymentStatus,
    row.is_paid,
    row.isPaid,
    row.payment_state,
  ];
  for (const raw of candidates) {
    if (raw == null || String(raw).trim() === '') continue;
    const s = String(raw).toLowerCase().trim();
    if (['paid', 'complete', 'completed', 'success', 'successful', '1', 'true', 'yes', 'settled'].includes(s)) {
      return 'paid';
    }
    if (['unpaid', 'pending', '0', 'false', 'no', 'awaiting', 'due'].includes(s)) {
      return 'unpaid';
    }
  }
  for (const raw of candidates) {
    if (raw != null && String(raw).trim() !== '') return String(raw).trim();
  }
  return null;
}

module.exports = {
  normalizeDriverPaymentType,
  normalizeDriverPaymentStatus,
  mapPaymentRawToEnum,
};
