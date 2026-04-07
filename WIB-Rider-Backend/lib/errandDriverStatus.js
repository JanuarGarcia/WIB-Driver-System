/**
 * Driver-visible errand order statuses — aligned with mt_driver_task.status / ChangeTaskStatus.
 * Stored on st_ordernew.delivery_status (varchar); history uses the same canonical lowercase strings.
 */

/** @type {Set<string>} */
const CANONICAL = new Set([
  'unassigned',
  'assigned',
  'acknowledged',
  'started',
  'inprogress',
  'verification',
  'pending_verification',
  'successful',
  'failed',
  'declined',
  'cancelled',
]);

const TERMINAL = new Set(['successful', 'failed', 'declined', 'cancelled']);

/** Progress ordering for merging legacy history vs delivery_status */
const RANK = {
  unassigned: 0,
  assigned: 10,
  acknowledged: 20,
  started: 30,
  inprogress: 40,
  verification: 40,
  pending_verification: 40,
  successful: 100,
  failed: 100,
  declined: 100,
  cancelled: 100,
};

/**
 * Normalize app / alias input to canonical status_raw (lowercase snake for multi-word).
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeIncomingStatusRaw(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
  const c = s.replace(/_/g, '');

  if (c === 'new') return 'assigned';
  if (c === 'reject' || c === 'rejected') return 'declined';
  if (c === 'accepted') return 'acknowledged';
  if (c === 'inprogress' || c === 'in_progress') return 'inprogress';
  if (c === 'completed' || c === 'delivered') return 'successful';
  if (c === 'canceled') return 'cancelled';

  if (CANONICAL.has(s)) return s;
  if (s === 'pendingverification') return 'pending_verification';

  return null;
}

/**
 * @param {string} s
 */
function isTerminal(s) {
  return TERMINAL.has(s);
}

/**
 * Map st_ordernew.delivery_status (+ order.status) to canonical driver task status.
 * @param {unknown} deliveryStatus
 * @param {unknown} orderStatus
 * @returns {string}
 */
function mapDeliveryToCanonicalTaskStatus(deliveryStatus, orderStatus) {
  if (deliveryStatus != null && String(deliveryStatus).trim() !== '') {
    const norm = normalizeIncomingStatusRaw(deliveryStatus);
    if (norm) return norm;
    const ds = String(deliveryStatus)
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/_/g, '');
    if (ds === 'delivered') return 'successful';
    if (ds === 'pickedup' || ds === 'picked_up' || ds === 'ontheway' || ds === 'intransit' || ds === 'in_transit') {
      return 'inprogress';
    }
    if (ds === 'pendingverification') return 'pending_verification';
  }
  const os = String(orderStatus || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
  if (os === 'rejected' || os === 'cancelled' || os === 'canceled') return 'cancelled';
  if (os === 'delivered') return 'successful';
  if (!String(deliveryStatus || '').trim() && (os === 'new' || os === 'pending')) return 'unassigned';
  return 'unassigned';
}

/**
 * Parse latest history label (canonical or legacy English) to canonical status.
 * @param {string|null|undefined} historyStatusRaw
 * @returns {string|null}
 */
function parseHistoryToCanonical(historyStatusRaw) {
  if (historyStatusRaw == null || String(historyStatusRaw).trim() === '') return null;
  const h0 = String(historyStatusRaw).toLowerCase().replace(/\s+/g, ' ').trim();
  const c0 = h0.replace(/\s+/g, '').replace(/_/g, '');
  if (c0 === 'new' || c0.includes('advanceorder') || h0.includes('advance order')) return 'unassigned';

  const direct = normalizeIncomingStatusRaw(historyStatusRaw);
  if (direct) return direct;

  const h = h0;
  const c = c0;

  if (/\bdelivered\b|complete|successful/i.test(h) || c === 'delivered') return 'successful';
  if (c === 'failed') return 'failed';
  if (c.includes('declin')) return 'declined';
  if (c.includes('cancel')) return 'cancelled';
  if (c === 'assigned' || c === 'accepted' || h === 'accepted') return 'assigned';
  if (c.includes('acknowledg')) return 'acknowledged';
  if (c === 'started' || h.startsWith('started')) return 'started';
  if (c === 'inprogress' || c.includes('verification') || c.includes('pendingverification')) {
    if (c.includes('pending')) return 'pending_verification';
    if (c.includes('verification')) return 'verification';
    return 'inprogress';
  }
  if (c.includes('way') || c.includes('transit') || c.includes('ontheway') || h.includes('on its way')) {
    return 'inprogress';
  }
  if (c.includes('pick') || c.includes('prepar') || c.includes('cooking')) return 'inprogress';

  return null;
}

/**
 * @param {string} s
 */
function rankOf(s) {
  return RANK[s] != null ? RANK[s] : -1;
}

/**
 * Merge delivery row + optional latest history for list/detail (legacy rows may disagree).
 * @param {unknown} deliveryStatus
 * @param {unknown} orderStatus
 * @param {string|null|undefined} latestHistoryStatus
 * @param {number|null|undefined} driverId
 * @returns {string}
 */
function deriveErrandDriverTaskStatus(deliveryStatus, orderStatus, latestHistoryStatus, driverId) {
  const fromDel = mapDeliveryToCanonicalTaskStatus(deliveryStatus, orderStatus);
  const fromHist = parseHistoryToCanonical(latestHistoryStatus);

  if (fromHist && isTerminal(fromHist)) return fromHist;
  if (isTerminal(fromDel)) return fromDel;

  const hasDriver = driverId != null && Number.isFinite(Number(driverId)) && Number(driverId) > 0;
  if (!hasDriver) {
    if (fromDel === 'unassigned' || fromDel === 'assigned') return 'unassigned';
    return fromHist || fromDel || 'unassigned';
  }

  const rDel = rankOf(fromDel);
  const rHist = fromHist != null ? rankOf(fromHist) : -1;
  if (rHist > rDel) return /** @type {string} */ (fromHist);
  return fromDel || fromHist || 'assigned';
}

module.exports = {
  CANONICAL,
  TERMINAL,
  normalizeIncomingStatusRaw,
  mapDeliveryToCanonicalTaskStatus,
  parseHistoryToCanonical,
  deriveErrandDriverTaskStatus,
  isTerminal,
};
