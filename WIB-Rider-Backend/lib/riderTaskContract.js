'use strict';

const RIDER_TERMINAL_TASK_STATUSES = new Set([
  'successful',
  'completed',
  'failed',
  'declined',
  'rejected',
  'cancelled',
  'canceled',
  'delivered',
  'complete',
  'done',
]);

const RIDER_INACTIVE_TASK_STATUSES = new Set([...RIDER_TERMINAL_TASK_STATUSES, 'unassigned']);

function normalizeRiderTaskStatus(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const base = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const compact = base.replace(/_/g, '');

  if (compact === 'canceled' || compact === 'cancelled') return 'cancelled';
  if (compact === 'completed') return 'completed';
  if (compact === 'complete') return 'complete';
  if (compact === 'delivered') return 'delivered';
  if (compact === 'successful') return 'successful';
  if (compact === 'failed') return 'failed';
  if (compact === 'declined') return 'declined';
  if (compact === 'rejected') return 'rejected';
  if (compact === 'done') return 'done';
  if (compact === 'unassigned') return 'unassigned';

  return base;
}

function truthyContractFlag(v) {
  if (v == null || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

function parseTaskRowDriverId(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = row.driver_id ?? row.driverId;
  if (raw == null || String(raw).trim() === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function isRiderTerminalTaskStatus(raw) {
  const s = normalizeRiderTaskStatus(raw);
  return s != null && RIDER_TERMINAL_TASK_STATUSES.has(s);
}

function isRiderInactiveTaskStatus(raw) {
  const s = normalizeRiderTaskStatus(raw);
  return s != null && RIDER_INACTIVE_TASK_STATUSES.has(s);
}

function shouldIncludeActiveTaskListRow(row, options = {}) {
  const includeUnassigned = options.includeUnassigned === true;
  const expectedDriverId =
    options.driverId != null && Number.isFinite(Number(options.driverId)) ? Number(options.driverId) : null;
  const rowDriverId = parseTaskRowDriverId(row);

  if (!includeUnassigned) {
    if (rowDriverId == null || rowDriverId === 0) return false;
    if (expectedDriverId != null && rowDriverId !== expectedDriverId) return false;
  }

  const statusRaw = row?.status_raw ?? row?.status ?? null;
  if (statusRaw == null || String(statusRaw).trim() === '') return true;

  const normalized = normalizeRiderTaskStatus(statusRaw);
  if (!includeUnassigned && normalized === 'unassigned') return false;
  return !isRiderTerminalTaskStatus(normalized);
}

function readContractDeliveryAsap(row) {
  if (!row || typeof row !== 'object') return 0;
  const raw =
    row.delivery_asap ??
    row.deliveryAsap ??
    row.asap ??
    row.is_asap ??
    row.isAsap ??
    row.deliver_asap ??
    row.deliverAsap;
  return truthyContractFlag(raw) ? 1 : 0;
}

module.exports = {
  RIDER_TERMINAL_TASK_STATUSES,
  RIDER_INACTIVE_TASK_STATUSES,
  normalizeRiderTaskStatus,
  isRiderTerminalTaskStatus,
  isRiderInactiveTaskStatus,
  shouldIncludeActiveTaskListRow,
  readContractDeliveryAsap,
  truthyContractFlag,
  parseTaskRowDriverId,
};
