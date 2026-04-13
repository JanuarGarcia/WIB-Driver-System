/**
 * When the dashboard home timeline stack shows a teal toast for an mt_order_history / errand row, the
 * notification poller often fetches the same milestone a moment later — avoid a second react-toastify popup.
 */

import { parseTaskIdFromNotificationMessage } from './riderNotificationNavigate';

const TTL_MS = 25000;
const suppressionUntil = new Map();

function pruneSuppression() {
  const now = Date.now();
  for (const [k, exp] of suppressionUntil) {
    if (exp <= now) suppressionUntil.delete(k);
  }
}

function normalizeTimelineStatusKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

function normalizedBlobImpliesTaskAccepted(blob) {
  if (!blob) return false;
  if (blob.includes('unaccepted') || blob.includes('notaccepted') || blob.includes('unacknowledged')) return false;
  if (blob.includes('unacknowledge')) return false;
  if (blob.includes('acknowledged')) return true;
  if (blob.includes('acknowledge') && !blob.includes('unacknowledge')) return true;
  if (blob.includes('accepted')) return true;
  return false;
}

function normalizedBlobImpliesReadyForPickup(blob) {
  if (!blob) return false;
  if (blob.includes('notready') && blob.includes('pickup')) return false;
  if (blob === 'readyforpickup' || blob === 'readypickup') return true;
  if (blob.includes('readyforpickup') || blob.includes('readypickup')) return true;
  if (blob.includes('ready') && blob.includes('pickup')) return true;
  return false;
}

function normalizedBlobImpliesInProgress(blob) {
  if (!blob) return false;
  if (blob.includes('notinprogress')) return false;
  if (blob === 'inprogress' || blob.includes('inprogress')) return true;
  if (blob.includes('reachedthedestination') || blob.includes('reacheddestination')) return true;
  if (blob.includes('reached') && blob.includes('destination')) return true;
  if (blob.includes('arrivedatdestination') || (blob.includes('arrived') && blob.includes('destination'))) return true;
  if (blob.includes('arrivedat') && (blob.includes('dropoff') || blob.includes('location'))) return true;
  if (blob.includes('enroute') || blob.includes('ontheway') || blob.includes('onitsway')) return true;
  return false;
}

function normalizedBlobImpliesPreparing(blob) {
  if (!blob) return false;
  if (blob.includes('notpreparing') || blob.includes('unpreparing')) return false;
  return blob === 'preparing' || blob.includes('preparing');
}

function historyRowIsRiderAcceptance(row) {
  if (!row || typeof row !== 'object') return false;
  const parts = [row.status, row.description, row.remarks, row.reason, row.notes];
  const by = String(row.update_by_type || '').toLowerCase();
  const assignedByDispatcher = by === 'admin' || by === 'merchant';
  for (const p of parts) {
    const key = normalizeTimelineStatusKey(p);
    if (!key) continue;
    if (key.includes('taskaccepted') || key.includes('orderaccepted')) return true;
    if (key === 'acknowledged' || key === 'accepted' || key === 'accept') return true;
    if (key === 'assigned' && !assignedByDispatcher) return true;
    if (key === 'orderassigned' || key === 'driverassigned') return true;
  }
  return false;
}

/** Mirrors server classifyTimelineHistoryForDashboardNotify + TaskDetailsModal (incl. description). */
export function classifyHistoryRowForNotifyMilestone(row) {
  if (!row || typeof row !== 'object') return null;
  const keys = [
    normalizeTimelineStatusKey(row.status),
    normalizeTimelineStatusKey(row.description),
    normalizeTimelineStatusKey(row.remarks),
    normalizeTimelineStatusKey(row.reason),
    normalizeTimelineStatusKey(row.notes),
  ].filter(Boolean);
  if (keys.some((k) => k === 'successful' || k === 'completed' || k === 'delivered')) return 'successful';
  if (keys.some((k) => k === 'readyforpickup' || k === 'readypickup' || normalizedBlobImpliesReadyForPickup(k))) {
    return 'ready_for_pickup';
  }
  if (keys.some((k) => k === 'preparing' || normalizedBlobImpliesPreparing(k))) return 'preparing';
  if (keys.some((k) => k === 'inprogress' || normalizedBlobImpliesInProgress(k))) return 'inprogress';
  if (keys.some((k) => k === 'started')) return 'started';
  if (keys.some((k) => k === 'new' || k === 'created' || k === 'unassigned' || k === 'queued')) return 'created';
  if (historyRowIsRiderAcceptance(row)) return 'accepted';
  if (keys.some((k) => k === 'acknowledged' || k === 'accepted' || k === 'accept')) return 'accepted';
  if (keys.some((k) => normalizedBlobImpliesTaskAccepted(k))) return 'accepted';
  return null;
}

/**
 * Map timeline milestone → API notification `type` (matches fan-out payloads).
 * Mangan: driver "assigned" history rows classify as `accepted` but the inbox uses `task_assigned`.
 */
function milestoneCategoryToNotificationType(category, row, isMangan) {
  if (!category) return null;
  if (category === 'created') return 'new_task';
  if (category === 'ready_for_pickup') return 'ready_pickup';
  if (category === 'accepted') {
    if (isMangan && normalizeTimelineStatusKey(row?.status) === 'assigned') return 'task_assigned';
    return 'task_accepted';
  }
  if (category === 'successful') return 'task_done';
  if (category === 'started' || category === 'inprogress' || category === 'preparing') return 'new_task';
  return null;
}

function registerKey(key) {
  if (!key) return;
  pruneSuppression();
  suppressionUntil.set(key, Date.now() + TTL_MS);
}

/**
 * Call when the home timeline teal toast is shown for a standard-task feed event.
 */
export function markNotificationToastSuppressedFromMtFeedEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  const tid = ev.resolved_task_id != null ? Number(ev.resolved_task_id) : NaN;
  if (!Number.isFinite(tid) || tid <= 0) return;
  const rowShape = {
    status: ev.status,
    remarks: ev.remarks,
    reason: ev.reason,
    notes: ev.notes,
    update_by_type: ev.update_by_type,
  };
  const cat = classifyHistoryRowForNotifyMilestone(rowShape);
  const type = milestoneCategoryToNotificationType(cat, rowShape, false);
  if (!type) return;
  registerKey(`${type}|${tid}`);
}

/**
 * Call when the home timeline teal toast is shown for a Mangan / errand feed event.
 */
export function markNotificationToastSuppressedFromErrandFeedEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  const oid = ev.resolved_errand_order_id != null ? Number(ev.resolved_errand_order_id) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return;
  const pseudoTaskId = -oid;
  const rowShape = {
    status: ev.status,
    remarks: ev.remarks,
    reason: ev.reason,
    notes: ev.notes,
    update_by_type: ev.update_by_type,
  };
  const cat = classifyHistoryRowForNotifyMilestone(rowShape);
  const type = milestoneCategoryToNotificationType(cat, rowShape, true);
  if (!type) return;
  registerKey(`${type}|${pseudoTaskId}`);
}

/**
 * Task Details modal timeline poll (same milestones as server fan-out).
 */
export function markNotificationToastSuppressedFromModalHistoryRow(row, taskId) {
  if (!row || typeof row !== 'object') return;
  const tid = Number(taskId);
  if (!Number.isFinite(tid) || tid <= 0) return;
  const cat = classifyHistoryRowForNotifyMilestone(row);
  const type = milestoneCategoryToNotificationType(cat, row, false);
  if (!type) return;
  registerKey(`${type}|${tid}`);
}

/**
 * @param {{ type?: string, message?: string }} notification
 * @returns {boolean}
 */
export function shouldSuppressRiderNotificationToast(notification) {
  const n = notification || {};
  const type = String(n.type || '').trim().toLowerCase();
  const tid = parseTaskIdFromNotificationMessage(String(n.message || ''));
  if (!type || tid == null || !Number.isFinite(Number(tid)) || Number(tid) === 0) return false;
  pruneSuppression();
  const key = `${type}|${tid}`;
  const exp = suppressionUntil.get(key);
  return exp != null && exp > Date.now();
}
