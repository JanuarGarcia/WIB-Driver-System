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
  verification: 50,
  pending_verification: 60,
  successful: 100,
  failed: 100,
  declined: 100,
  cancelled: 100,
};

function statusSnake(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function statusCompact(raw) {
  return statusSnake(raw).replace(/_/g, '');
}

const POOL_STATUS_ALIASES = new Set([
  'unassigned',
  'pending',
  'available',
  'open',
  'pendingaccept',
  'pool',
]);

const ACKNOWLEDGED_STATUS_ALIASES = new Set([
  'accepted',
  'readyforpickup',
  'pendingpickup',
  'forpickup',
  'awaitingpickup',
  'waitingfororder',
  'onthewayvendor',
  'onthewayrestaurant',
]);

const STARTED_STATUS_ALIASES = new Set([
  'started',
  'arrivedatvendor',
  'arrivedvendor',
  'arrivedatrestaurant',
  'arrivedrestaurant',
]);

const INPROGRESS_STATUS_ALIASES = new Set([
  'inprogress',
  'pickup',
  'pickedup',
  'orderpickup',
  'outfordelivery',
  'onthewaycustomer',
  'onthewaytocustomer',
  'enroutecustomer',
  'deliveryonitsway',
]);

const PENDING_VERIFICATION_STATUS_ALIASES = new Set([
  'pendingverification',
  'arrivedatcustomer',
  'arrivedcustomer',
  'arrivedatdestination',
  'reacheddestination',
  'reachedthedestination',
  'deliveredpendingverification',
]);

const SUCCESS_STATUS_ALIASES = new Set([
  'successful',
  'completed',
  'complete',
  'done',
  'delivered',
  'orderdelivered',
  'deliveredtocustomer',
]);

const FAILED_STATUS_ALIASES = new Set([
  'failed',
  'deliveryfailed',
  'faileddelivery',
  'failedtodeliver',
]);

const DECLINED_STATUS_ALIASES = new Set([
  'declined',
  'reject',
  'rejected',
]);

const CANCELLED_STATUS_ALIASES = new Set([
  'cancelled',
  'canceled',
  'cancelledbycustomer',
  'canceledbycustomer',
  'cancelledbyadmin',
  'canceledbyadmin',
]);

/**
 * Normalize legacy/raw Mangan wording to the rider app canonical ladder.
 * This is used for statuses coming back from ErrandWib / Mangan rows and history.
 *
 * @param {unknown} raw
 * @param {{ poolToAssigned?: boolean }} [options]
 * @returns {string|null}
 */
function normalizeErrandStatusForApp(raw, options = {}) {
  if (raw == null || String(raw).trim() === '') return null;
  const snake = statusSnake(raw);
  const compact = statusCompact(raw);
  const poolToAssigned = options.poolToAssigned !== false;

  if (CANONICAL.has(snake)) {
    if (snake === 'unassigned' && poolToAssigned) return 'assigned';
    return snake;
  }
  if (snake === 'pending_verification' || compact === 'pendingverification') return 'pending_verification';
  if (snake === 'ready_for_pickup') return 'acknowledged';
  if (POOL_STATUS_ALIASES.has(compact)) return poolToAssigned ? 'assigned' : 'unassigned';
  if (ACKNOWLEDGED_STATUS_ALIASES.has(compact)) return 'acknowledged';
  if (STARTED_STATUS_ALIASES.has(compact)) return 'started';
  if (INPROGRESS_STATUS_ALIASES.has(compact)) return 'inprogress';
  if (snake === 'verification' || compact === 'verification') return 'verification';
  if (PENDING_VERIFICATION_STATUS_ALIASES.has(compact)) return 'pending_verification';
  if (SUCCESS_STATUS_ALIASES.has(compact)) return 'successful';
  if (FAILED_STATUS_ALIASES.has(compact)) return 'failed';
  if (DECLINED_STATUS_ALIASES.has(compact)) return 'declined';
  if (CANCELLED_STATUS_ALIASES.has(compact)) return 'cancelled';

  return null;
}

/**
 * Normalize app / alias input to canonical status_raw (lowercase snake for multi-word).
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeIncomingStatusRaw(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = statusSnake(raw);
  const c = statusCompact(raw);

  if (c === 'new') return 'assigned';
  if (CANONICAL.has(s)) return s;
  if (s === 'pendingverification') return 'pending_verification';

  if (POOL_STATUS_ALIASES.has(c)) return 'unassigned';
  if (ACKNOWLEDGED_STATUS_ALIASES.has(c)) return 'acknowledged';
  if (STARTED_STATUS_ALIASES.has(c)) return 'started';
  if (INPROGRESS_STATUS_ALIASES.has(c)) return 'inprogress';
  if (s === 'verification' || c === 'verification') return 'verification';
  if (PENDING_VERIFICATION_STATUS_ALIASES.has(c)) return 'pending_verification';
  if (SUCCESS_STATUS_ALIASES.has(c)) return 'successful';
  if (FAILED_STATUS_ALIASES.has(c)) return 'failed';
  if (DECLINED_STATUS_ALIASES.has(c)) return 'declined';
  if (CANCELLED_STATUS_ALIASES.has(c)) return 'cancelled';

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
  const fromDelivery = normalizeErrandStatusForApp(deliveryStatus, { poolToAssigned: true });
  if (fromDelivery) return fromDelivery;
  const fromOrder = normalizeErrandStatusForApp(orderStatus, { poolToAssigned: true });
  if (fromOrder) return fromOrder;
  return 'assigned';
}

/**
 * Parse latest history label (canonical or legacy English) to canonical status.
 * @param {string|null|undefined} historyStatusRaw
 * @returns {string|null}
 */
function parseHistoryToCanonical(historyStatusRaw) {
  if (historyStatusRaw == null || String(historyStatusRaw).trim() === '') return null;
  const direct = normalizeErrandStatusForApp(historyStatusRaw, { poolToAssigned: true });
  if (direct) return direct;

  const h0 = String(historyStatusRaw).toLowerCase().replace(/\s+/g, ' ').trim();
  const c0 = h0.replace(/\s+/g, '').replace(/_/g, '');
  if (c0 === 'new' || c0.includes('advanceorder') || h0.includes('advance order')) return 'assigned';

  const h = h0;
  const c = c0;

  if (/\bdelivered\b|complete|successful/i.test(h) || c === 'delivered') return 'successful';
  if (c === 'failed') return 'failed';
  if (c.includes('declin')) return 'declined';
  if (c.includes('cancel')) return 'cancelled';
  if (c === 'assigned' || c === 'accepted' || h === 'accepted') return 'assigned';
  if (c.includes('acknowledg')) return 'acknowledged';
  if (c === 'started' || h.startsWith('started')) return 'started';
  if (c.includes('pendingverification')) return 'pending_verification';
  if (c.includes('verification')) return 'verification';
  if (c === 'inprogress') {
    return 'inprogress';
  }
  if (c.includes('arrivedatcustomer') || c.includes('reacheddestination')) {
    return 'pending_verification';
  }
  if (c.includes('way') || c.includes('transit') || c.includes('ontheway') || h.includes('on its way')) {
    if (c.includes('customer') || c.includes('delivery')) return 'inprogress';
    if (c.includes('vendor') || c.includes('restaurant')) return 'acknowledged';
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
    return fromHist || fromDel || 'assigned';
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
  normalizeErrandStatusForApp,
  mapDeliveryToCanonicalTaskStatus,
  parseHistoryToCanonical,
  deriveErrandDriverTaskStatus,
  isTerminal,
};
