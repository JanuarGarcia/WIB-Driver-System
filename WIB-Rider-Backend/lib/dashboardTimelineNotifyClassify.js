/**
 * Timeline row → dashboard notification milestone bucket (shared by admin feed, modal poll, driver status).
 */

function normalizeTimelineNotifyKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

function milestoneDedupeKeyForTask(taskId, category) {
  const tid = Number(taskId);
  if (!Number.isFinite(tid) || tid <= 0) return '';
  const c = normalizeTimelineNotifyKey(category);
  if (!c) return '';
  return `mt-task-${tid}-${c}`;
}

/** Mangan (st_ordernew) — same milestone from driver API + errand history feed must not double-insert inbox rows. */
function milestoneDedupeKeyForErrand(orderId, category) {
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) return '';
  const c = normalizeTimelineNotifyKey(category);
  if (!c) return '';
  return `so-task-${oid}-${c}`;
}

/** Maps ErrandWib canonical delivery_status → timeline notify category (subset). */
function errandCanonicalToMilestoneCategory(canonical) {
  const c = String(canonical || '').trim().toLowerCase();
  if (c === 'acknowledged') return 'accepted';
  if (c === 'successful' || c === 'delivered' || c === 'completed') return 'successful';
  return null;
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

/** Mangan / merchant timeline: "Preparing" (often only in status or embedded in remarks). */
function normalizedBlobImpliesPreparing(blob) {
  if (!blob) return false;
  if (blob.includes('notpreparing') || blob.includes('unpreparing')) return false;
  return blob === 'preparing' || blob.includes('preparing');
}

function historyRowIsRiderAcceptanceForNotify(row) {
  if (!row || typeof row !== 'object') return false;
  const parts = [row.status, row.remarks, row.reason, row.notes];
  const by = String(row.update_by_type || '').toLowerCase();
  const assignedByDispatcher = by === 'admin' || by === 'merchant';
  for (const p of parts) {
    const key = normalizeTimelineNotifyKey(p);
    if (!key) continue;
    if (normalizedBlobImpliesTaskAccepted(key)) return true;
    if (key.includes('taskaccepted') || key.includes('orderaccepted')) return true;
    if (key === 'acknowledged' || key === 'accepted' || key === 'accept') return true;
    if (key === 'assigned' && !assignedByDispatcher) return true;
    if (key === 'orderassigned' || key === 'driverassigned') return true;
  }
  return false;
}

function classifyTimelineHistoryForDashboardNotify(row) {
  if (!row || typeof row !== 'object') return null;
  const keys = [
    normalizeTimelineNotifyKey(row.status),
    normalizeTimelineNotifyKey(row.description),
    normalizeTimelineNotifyKey(row.remarks),
    normalizeTimelineNotifyKey(row.reason),
    normalizeTimelineNotifyKey(row.notes),
  ].filter(Boolean);
  if (keys.some((k) => k === 'successful' || k === 'completed' || k === 'delivered')) return 'successful';
  if (keys.some((k) => k === 'readyforpickup' || k === 'readypickup' || normalizedBlobImpliesReadyForPickup(k))) {
    return 'ready_for_pickup';
  }
  if (keys.some((k) => k === 'preparing' || normalizedBlobImpliesPreparing(k))) return 'preparing';
  if (keys.some((k) => k === 'inprogress' || normalizedBlobImpliesInProgress(k))) return 'inprogress';
  if (keys.some((k) => k === 'started')) return 'started';
  if (keys.some((k) => k === 'new' || k === 'created' || k === 'unassigned' || k === 'queued')) return 'created';
  if (historyRowIsRiderAcceptanceForNotify(row)) return 'accepted';
  if (keys.some((k) => k === 'acknowledged' || k === 'accepted' || k === 'accept')) return 'accepted';
  return null;
}

module.exports = {
  normalizeTimelineNotifyKey,
  milestoneDedupeKeyForTask,
  milestoneDedupeKeyForErrand,
  errandCanonicalToMilestoneCategory,
  classifyTimelineHistoryForDashboardNotify,
};
