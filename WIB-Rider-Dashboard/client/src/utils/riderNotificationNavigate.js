/**
 * Parse dashboard notification `message` for deep-linking and display.
 * Backend appends " · By {name}" and includes "Task #123" or "Mangan order #456".
 */

const BY_SUFFIX = /\s·\sBy\s+(.+)$/i;

/** Backend may still attach "By Driver #0" when task.driver_id is unset — never show that as a person. */
function isUnassignedDriverActorLabel(actor) {
  const a = String(actor || '').trim();
  return /^driver\s*#\s*0$/i.test(a) || /^rider\s*#\s*0$/i.test(a);
}

export function parseActorFromNotificationMessage(message) {
  const s = String(message || '').trim();
  const m = s.match(BY_SUFFIX);
  if (!m) return '';
  const actor = m[1].trim();
  if (isUnassignedDriverActorLabel(actor)) return '';
  return actor;
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
  const errand = s.match(/Errand\s+order\s*#\s*(\d+)/i);
  if (errand) {
    const n = parseInt(errand[1], 10);
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
 * Mangan/errand deep links use negative pseudo task ids. Collapse legacy duplicate payloads
 * ("Errand accepted" vs "Task accepted" vs "Mangan accepted") to one inbox row.
 */
function normalizeManganDedupeTitle(title, type) {
  const t = String(title || '').trim().toLowerCase();
  const ty = String(type || '').trim().toLowerCase();
  /* Any task_done for errand/Mangan (negative pseudo id) shares one bucket — "Successful delivery" has no \bdelivered\b. */
  if (ty === 'task_done') return 'milestone_done';
  if (ty === 'task_accepted' || /\baccepted\b/.test(t) || t.includes('acknowledged')) return 'milestone_accepted';
  if (/\b(completed|delivered)\b/.test(t)) return 'milestone_done';
  if (ty === 'task_assigned' || /\bassigned\b/.test(t)) return 'milestone_assigned';
  return t;
}

/**
 * Build a dedupe key for "same status, same target" notifications.
 * This is used client-side to collapse duplicate rows where one payload has actor and one does not.
 */
export function buildNotificationDedupeKey(notification) {
  const n = notification || {};
  const type = String(n.type || '').trim().toLowerCase();
  let title = String(n.title || '').trim().toLowerCase();
  const message = String(n.message || '');
  const targetId = parseTaskIdFromNotificationMessage(message);
  if (targetId != null && targetId < 0) {
    title = normalizeManganDedupeTitle(title, type);
  }
  const actorless = formatNotificationMessageForDisplay(message).toLowerCase();
  const targetPart = targetId != null ? `target:${targetId}` : `msg:${actorless}`;
  return `${type}|${title}|${targetPart}`;
}

/**
 * When one logical notification was inserted twice (different DB ids), mark every id in the same batch
 * that shares a dedupe key with any item we surfaced (toast / panel).
 */
export function notificationIdsSharingDedupeKeysWith(surfaced, sameBatch) {
  if (!Array.isArray(surfaced) || surfaced.length === 0) return [];
  if (!Array.isArray(sameBatch) || sameBatch.length === 0) return surfaced.map((n) => String(n.id)).filter(Boolean);
  const keys = new Set(surfaced.map((n) => buildNotificationDedupeKey(n)));
  const out = new Set();
  for (const n of sameBatch) {
    if (!n || n.id == null) continue;
    if (keys.has(buildNotificationDedupeKey(n))) out.add(String(n.id));
  }
  return [...out];
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
