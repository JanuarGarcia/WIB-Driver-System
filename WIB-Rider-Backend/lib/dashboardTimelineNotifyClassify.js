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
    normalizeTimelineNotifyKey(row.remarks),
    normalizeTimelineNotifyKey(row.reason),
    normalizeTimelineNotifyKey(row.notes),
  ].filter(Boolean);
  if (keys.some((k) => k === 'successful' || k === 'completed' || k === 'delivered')) return 'successful';
  if (keys.some((k) => k === 'readyforpickup' || k === 'readypickup' || normalizedBlobImpliesReadyForPickup(k))) {
    return 'ready_for_pickup';
  }
  if (keys.some((k) => k === 'inprogress' || normalizedBlobImpliesInProgress(k))) return 'inprogress';
  if (keys.some((k) => k === 'started')) return 'started';
  if (historyRowIsRiderAcceptanceForNotify(row)) return 'accepted';
  if (keys.some((k) => k === 'acknowledged' || k === 'accepted' || k === 'accept')) return 'accepted';
  return null;
}

module.exports = {
  normalizeTimelineNotifyKey,
  milestoneDedupeKeyForTask,
  classifyTimelineHistoryForDashboardNotify,
};
