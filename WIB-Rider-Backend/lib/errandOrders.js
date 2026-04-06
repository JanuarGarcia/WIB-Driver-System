/**
 * Maps st_ordernew (wheninba_ErrandWib) rows into task-list shapes for the dashboard.
 * task_id is negative (-order_id) so it cannot collide with mt_driver_task.task_id.
 */

function mapDeliveryToTaskStatus(deliveryStatus, orderStatus) {
  const ds = String(deliveryStatus || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
  if (ds === 'unassigned') return 'unassigned';
  if (ds === 'assigned') return 'assigned';
  if (ds === 'delivered') return 'delivered';
  if (ds === 'cancelled' || ds === 'canceled') return 'cancelled';
  if (ds === 'pickedup' || ds === 'picked_up' || ds === 'ontheway' || ds === 'in_transit') return 'inprogress';
  const os = String(orderStatus || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
  if (os === 'rejected' || os === 'cancelled' || os === 'canceled') return 'cancelled';
  if (os === 'delivered') return 'delivered';
  return 'unassigned';
}

function driverDisplayName(map, driverId) {
  if (driverId == null || driverId === '') return null;
  const k = String(driverId);
  return map.get(k) || null;
}

/**
 * @param {Record<string, unknown>} row - st_ordernew row
 * @param {Map<string, string>} driverNameById - from mt_driver (primary pool)
 */
function mapStOrderRowToTaskListRow(row, driverNameById) {
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const safeId = Number.isFinite(oid) ? oid : 0;
  const driverId = row.driver_id != null ? parseInt(String(row.driver_id), 10) : null;
  const driverName = Number.isFinite(driverId)
    ? driverDisplayName(driverNameById, driverId)
    : null;
  const status = mapDeliveryToTaskStatus(row.delivery_status, row.status);
  const desc =
    row.order_reference != null && String(row.order_reference).trim()
      ? `Errand ${String(row.order_reference).trim()}`
      : `Errand order #${safeId}`;
  const created = row.date_created || row.created_at || row.date_modified || null;

  return {
    task_source: 'errand',
    task_id: safeId > 0 ? -safeId : 0,
    st_order_id: safeId,
    order_id: safeId,
    status,
    delivery_status: row.delivery_status != null ? String(row.delivery_status) : null,
    order_status_raw: row.status != null ? String(row.status) : null,
    task_description: desc,
    delivery_address: row.formatted_address != null ? String(row.formatted_address).trim() : '',
    delivery_date: row.delivery_date,
    task_lat: null,
    task_lng: null,
    date_created: created,
    merchant_id: row.merchant_id,
    restaurant_name: row.merchant_id != null ? `Merchant #${row.merchant_id}` : null,
    driver_id: Number.isFinite(driverId) ? driverId : null,
    driver_name: driverName,
    driver_profile_photo: null,
    payment_status: row.payment_status,
    payment_code: row.payment_code,
    service_code: row.service_code,
    total: row.total,
  };
}

/**
 * Build GET /errand-orders/:id detail payload (mirrors task modal shape partially).
 */
function buildErrandTaskDetailPayload(row, driverName) {
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const safeId = Number.isFinite(oid) ? oid : 0;
  const driverId = row.driver_id != null ? parseInt(String(row.driver_id), 10) : null;
  const status = mapDeliveryToTaskStatus(row.delivery_status, row.status);
  const desc =
    row.order_reference != null && String(row.order_reference).trim()
      ? `Errand ${String(row.order_reference).trim()}`
      : `Errand order #${safeId}`;

  const task = {
    task_source: 'errand',
    task_id: safeId > 0 ? -safeId : 0,
    st_order_id: safeId,
    order_id: safeId,
    order_uuid: row.order_uuid,
    status,
    delivery_status: row.delivery_status,
    task_description: desc,
    delivery_address: row.formatted_address != null ? String(row.formatted_address).trim() : '',
    delivery_date: row.delivery_date,
    customer_name: null,
    contact_number: null,
    email_address: null,
    trans_type: row.service_code != null ? String(row.service_code) : 'delivery',
    payment_type: row.payment_code != null ? String(row.payment_code) : null,
    restaurant_name: row.merchant_id != null ? `Merchant #${row.merchant_id}` : null,
    driver_id: Number.isFinite(driverId) ? driverId : null,
    driver_name: driverName || null,
    driver_phone: null,
    task_lat: null,
    task_lng: null,
    date_created: row.date_created || row.created_at || null,
    advance_order_note: null,
  };

  const order = {
    order_id: safeId,
    trans_type: row.service_code,
    payment_type: row.payment_code,
    sub_total: row.sub_total,
    total_w_tax: row.total,
    delivery_date: row.delivery_date,
    date_created: row.date_created || row.created_at,
    contact_number: null,
    order_change: row.amount_due,
  };

  return {
    task_source: 'errand',
    task,
    order,
    merchant: null,
    order_details: [],
    task_photos: [],
    proof_images: [],
    order_history: [],
    errand_order: row,
  };
}

module.exports = {
  mapStOrderRowToTaskListRow,
  buildErrandTaskDetailPayload,
  mapDeliveryToTaskStatus,
};
