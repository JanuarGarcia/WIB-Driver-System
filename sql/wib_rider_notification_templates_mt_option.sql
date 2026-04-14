-- Rider push copy: mt_option rows read by riderOrderPushService.js (notification_template_<EVENT_KEY>).
-- Inserts match routes/admin.js pattern: merchant_id = 0 for global options.
--
-- If your mt_option has NO column merchant_id, remove "merchant_id, " and the leading "0, " from each INSERT.
-- If INSERT fails with "Duplicate entry", use the UPDATE block at the bottom instead, or edit rows in phpMyAdmin.
--
-- Interpolation in titles/bodies: {order_id} and {driver_id} (see services/riderOrderPushService.js).

-- Safe on re-run: only inserts when option_name is missing (no UNIQUE on option_name required).

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_ORDER_ASSIGNED',
'{"enable_push":1,"push":{"title":"New delivery","body":"You have been assigned order #{order_id}."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_ORDER_ASSIGNED' LIMIT 1);

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_REASSIGNED',
'{"enable_push":1,"push":{"title":"Delivery reassigned","body":"You have been assigned order #{order_id}. The assignment was changed."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_REASSIGNED' LIMIT 1);

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_READY_FOR_PICKUP',
'{"enable_push":1,"push":{"title":"Ready for pickup","body":"Order #{order_id} is ready for pickup at the merchant."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_READY_FOR_PICKUP' LIMIT 1);

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_ORDER_CANCELLED',
'{"enable_push":1,"push":{"title":"Order cancelled","body":"Order #{order_id} is no longer assigned to you (cancelled or unassigned)."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_ORDER_CANCELLED' LIMIT 1);

INSERT INTO mt_option (merchant_id, option_name, option_value)
SELECT 0, 'notification_template_RIDER_DELIVERY_UPDATED',
'{"enable_push":1,"push":{"title":"Delivery update","body":"Order #{order_id} status was updated. Open the app for details."}}'
WHERE NOT EXISTS (SELECT 1 FROM mt_option WHERE option_name = 'notification_template_RIDER_DELIVERY_UPDATED' LIMIT 1);
