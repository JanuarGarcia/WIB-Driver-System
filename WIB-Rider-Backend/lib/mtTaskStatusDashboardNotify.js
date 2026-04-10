/**
 * mt_order_history rows are also fan-out by order-history/feed + timeline-updates. Reserve mt-h-<id> and
 * per-task milestone keys before inserting inbox rows so the driver/dashboard status path does not duplicate them.
 */

const riderNotificationService = require('../services/riderNotification.service');
const { foodTaskNotifyFromStatus, notifyAllDashboardAdmins } = require('./dashboardRiderNotify');
const {
  classifyTimelineHistoryForDashboardNotify,
  milestoneDedupeKeyForTask,
  milestoneDedupeKeyForErrand,
} = require('./dashboardTimelineNotifyClassify');

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{
 *   taskId: number,
 *   orderId: string|number|null,
 *   taskDescription: string|null,
 *   statusRaw: string,
 *   actorLabel: string,
 *   historyInsertId: number|null|undefined,
 *   historyRowForClassify: Record<string, unknown>,
 * }} p
 */
async function notifyDashboardAfterMtTaskHistoryRow(pool, p) {
  const payload = foodTaskNotifyFromStatus(p.taskId, p.orderId, p.taskDescription, p.statusRaw, p.actorLabel);
  if (!payload) return;

  const hid = p.historyInsertId != null ? Number(p.historyInsertId) : NaN;
  if (Number.isFinite(hid) && hid > 0) {
    if (!(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, `mt-h-${hid}`))) {
      return;
    }
    const cat = classifyTimelineHistoryForDashboardNotify(p.historyRowForClassify || {});
    if (cat) {
      const mk = milestoneDedupeKeyForTask(p.taskId, cat);
      if (mk && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, mk))) {
        return;
      }
      const oid = p.orderId != null ? Number(p.orderId) : NaN;
      if (Number.isFinite(oid) && oid > 0) {
        const eMk = milestoneDedupeKeyForErrand(oid, cat);
        if (eMk && !(await riderNotificationService.tryConsumeTimelineNotifyKey(pool, eMk))) {
          return;
        }
      }
    }
  }

  await notifyAllDashboardAdmins(pool, payload).catch(() => {});
}

module.exports = { notifyDashboardAfterMtTaskHistoryRow };
