/**
 * Parse dashboard notification `message` for deep-linking and display.
 * Backend appends " · By {name}" and includes "Task #123" or "Mangan order #456".
 */

const BY_SUFFIX = /\s·\sBy\s+(.+)$/i;

export function parseActorFromNotificationMessage(message) {
  const s = String(message || '').trim();
  const m = s.match(BY_SUFFIX);
  return m ? m[1].trim() : '';
}

export function stripActorSuffixForDisplay(message) {
  const s = String(message || '').trim();
  return s.replace(BY_SUFFIX, '').trim();
}

/**
 * @returns {number|null} food task id (positive) or errand pseudo-id (negative order id)
 */
export function parseTaskIdFromNotificationMessage(message) {
  const s = String(message || '');
  const mangan = s.match(/Mangan\s+order\s*#\s*(\d+)/i);
  if (mangan) {
    const n = parseInt(mangan[1], 10);
    return Number.isFinite(n) && n > 0 ? -n : null;
  }
  const task = s.match(/Task\s*#\s*(\d+)/i);
  if (task) {
    const n = parseInt(task[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** Open dashboard task / Mangan order modal (Dashboard listens; App routes home first if needed). */
export function dispatchOpenTaskFromNotification(taskId) {
  if (taskId == null || !Number.isFinite(Number(taskId)) || Number(taskId) === 0) return;
  try {
    window.dispatchEvent(new CustomEvent('wib-dashboard-open-task', { detail: { taskId: Number(taskId) } }));
  } catch (_) {
    /* ignore */
  }
}
