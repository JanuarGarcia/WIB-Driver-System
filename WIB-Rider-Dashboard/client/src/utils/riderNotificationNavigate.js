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
  const noBy = s.replace(BY_SUFFIX, '').trim();
  // Keep deep-link marker (Task #123) in raw message, but hide it in UI in favor of Order #… which admins recognize.
  return noBy.replace(/\s·\sTask\s*#\s*\d+\b/gi, '').trim();
}

/**
 * UI-safe notification line:
 * - removes trailing " · By ..."
 * - removes trailing deep-link marker " · Task #..."
 * - if a legacy payload only has "Task #...", show it as "Order #..." in UI
 */
export function formatNotificationMessageForDisplay(message) {
  const base = stripActorSuffixForDisplay(message);
  if (!base) return '';
  if (!/order\s*#/i.test(base) && /task\s*#\s*\d+/i.test(base)) {
    return base.replace(/task\s*#\s*(\d+)/gi, 'Order #$1').trim();
  }
  return base;
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

/**
 * Build a dedupe key for "same status, same target" notifications.
 * This is used client-side to collapse duplicate rows where one payload has actor and one does not.
 */
export function buildNotificationDedupeKey(notification) {
  const n = notification || {};
  const type = String(n.type || '').trim().toLowerCase();
  const title = String(n.title || '').trim().toLowerCase();
  const message = String(n.message || '');
  const targetId = parseTaskIdFromNotificationMessage(message);
  const actorless = formatNotificationMessageForDisplay(message).toLowerCase();
  const targetPart = targetId != null ? `target:${targetId}` : `msg:${actorless}`;
  return `${type}|${title}|${targetPart}`;
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
