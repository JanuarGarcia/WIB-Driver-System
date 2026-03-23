/** Session key: Tasks panel writes selected list date so the dashboard map can match it. */
export const DASHBOARD_TASKS_MAP_DATE_KEY = 'wib-dashboard-tasks-map-date';

export const DASHBOARD_TASKS_MAP_DATE_EVENT = 'wib-dashboard-tasks-map-date-changed';

export function readDashboardTasksMapDateFromStorage() {
  try {
    const v = sessionStorage.getItem(DASHBOARD_TASKS_MAP_DATE_KEY);
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  } catch (_) {}
  return null;
}

export function todayDateStrLocal() {
  const x = new Date();
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const d = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function notifyDashboardTasksMapDateChanged() {
  try {
    window.dispatchEvent(new Event(DASHBOARD_TASKS_MAP_DATE_EVENT));
  } catch (_) {}
}

/**
 * Tasks that can be drawn on the map (delivery coordinates).
 * @param {Array<Record<string, unknown>>|null|undefined} tasks
 * @returns {Array<{ task_id: *, lat: number, lng: number, merchant_id?: *, delivery_address?: string, restaurant_name?: string, status?: string, order_id?: * }>}
 */
export function tasksWithMapCoordinates(tasks) {
  return (tasks || [])
    .map((t) => {
      const lat = t.task_lat != null ? Number(t.task_lat) : NaN;
      const lng = t.task_lng != null ? Number(t.task_lng) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        task_id: t.task_id,
        lat,
        lng,
        merchant_id: t.merchant_id ?? t.merchantId,
        delivery_address: t.delivery_address,
        restaurant_name: t.restaurant_name,
        status: t.status,
        order_id: t.order_id,
      };
    })
    .filter(Boolean);
}
