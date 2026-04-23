'use strict';

const { pool } = require('../config/db');
const { sendPushToDriver } = require('../services/fcm');

function toPositiveInt(value) {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchDriverTask(taskId) {
  const tid = toPositiveInt(taskId);
  if (!tid) return null;

  const attempts = [
    [
      'SELECT task_id, order_id, task_description, status AS prev_status, driver_id AS prev_driver_id FROM mt_driver_task WHERE task_id = ? LIMIT 1',
      [tid],
    ],
    [
      'SELECT id AS task_id, order_id, task_description, status AS prev_status, driver_id AS prev_driver_id FROM mt_driver_task WHERE id = ? LIMIT 1',
      [tid],
    ],
  ];

  for (const [sql, params] of attempts) {
    try {
      const [[row]] = await pool.query(sql, params);
      if (row) return row;
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') continue;
      throw e;
    }
  }

  return null;
}

async function updateDriverTaskAssignment({ taskId, newRiderId, actorId, reason }) {
  const tid = toPositiveInt(taskId);
  const did = toPositiveInt(newRiderId);
  const aid = toPositiveInt(actorId);
  if (!tid || !did) return { affectedRows: 0 };

  const attempts = [
    [
      `UPDATE mt_driver_task
       SET driver_id = ?, reassigned_to = ?, reassigned_by = ?, reassign_reason = ?, status = 'assigned', date_modified = CURRENT_TIMESTAMP
       WHERE task_id = ?`,
      [did, did, aid, reason || null, tid],
    ],
    [
      `UPDATE mt_driver_task
       SET driver_id = ?, status = 'assigned', date_modified = CURRENT_TIMESTAMP
       WHERE task_id = ?`,
      [did, tid],
    ],
    [
      `UPDATE mt_driver_task
       SET driver_id = ?, reassigned_to = ?, reassigned_by = ?, reassign_reason = ?, status = 'assigned', date_modified = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [did, did, aid, reason || null, tid],
    ],
    [
      `UPDATE mt_driver_task
       SET driver_id = ?, status = 'assigned', date_modified = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [did, tid],
    ],
  ];

  for (const [sql, params] of attempts) {
    try {
      const [result] = await pool.query(sql, params);
      return result || { affectedRows: 0 };
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') continue;
      throw e;
    }
  }

  return { affectedRows: 0 };
}

async function register(req, res) {
  try {
    const driverId = req.rider.driverId;
    const deviceId = String(req.body.device_id || '').trim();
    const platform = String(req.body.device_platform || '').trim().toLowerCase();
    const deviceUuid = req.body.device_uuid ? String(req.body.device_uuid).trim() : null;
    const pushEnabled = req.body.push_enabled === undefined ? 1 : Number(req.body.push_enabled) ? 1 : 0;
    if (!deviceId) return res.json({ code: 2, msg: 'device_id required', details: null });

    const sql = `
      INSERT INTO mt_rider_device_reg (driver_id, device_id, device_platform, device_uuid, push_enabled)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        device_platform = VALUES(device_platform),
        device_uuid = COALESCE(VALUES(device_uuid), device_uuid),
        push_enabled = VALUES(push_enabled),
        date_modified = CURRENT_TIMESTAMP
    `;
    await pool.query(sql, [driverId, deviceId, platform, deviceUuid, pushEnabled]);

    const [[row]] = await pool.query(
      'SELECT id FROM mt_rider_device_reg WHERE driver_id = ? AND device_id = ? LIMIT 1',
      [driverId, deviceId]
    );

    return res.json({
      code: 1,
      msg: 'ok',
      details: { device_row_id: row?.id ?? null, driver_id: driverId },
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ code: 2, msg: 'mt_rider_device_reg missing — run sql/wib_rider_device_and_push.sql', details: null });
    }
    console.error('riderDeviceController.register', e);
    return res.json({ code: 2, msg: 'register failed', details: null });
  }
}

async function unregister(req, res) {
  try {
    const driverId = req.rider.driverId;
    const deviceId = req.body.device_id ? String(req.body.device_id).trim() : null;
    if (deviceId) {
      await pool.query(
        'UPDATE mt_rider_device_reg SET push_enabled = 0, date_modified = CURRENT_TIMESTAMP WHERE driver_id = ? AND device_id = ?',
        [driverId, deviceId]
      );
    } else {
      await pool.query(
        'UPDATE mt_rider_device_reg SET push_enabled = 0, date_modified = CURRENT_TIMESTAMP WHERE driver_id = ?',
        [driverId]
      );
    }
    return res.json({ code: 1, msg: 'ok', details: null });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ code: 2, msg: 'mt_rider_device_reg missing — run sql/wib_rider_device_and_push.sql', details: null });
    }
    console.error('riderDeviceController.unregister', e);
    return res.json({ code: 2, msg: 'unregister failed', details: null });
  }
}

async function reassignTask(req, res) {
  try {
    const taskId = toPositiveInt(req.body?.task_id ?? req.body?.taskId);
    const newRiderId = toPositiveInt(req.body?.new_rider_id ?? req.body?.newRiderId);
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    const adminId = req.rider.driverId;

    if (!taskId || !newRiderId) {
      return res.status(400).json({ code: 2, msg: 'taskId and newRiderId are required' });
    }

    const task = await fetchDriverTask(taskId);
    if (!task) {
      return res.status(404).json({ code: 2, msg: 'Task not found' });
    }

    const result = await updateDriverTaskAssignment({
      taskId,
      newRiderId,
      actorId: adminId,
      reason,
    });
    if (Number(result?.affectedRows || 0) === 0) {
      const existingTask = await fetchDriverTask(taskId);
      if (!existingTask) {
        return res.status(404).json({ code: 2, msg: 'Task not found' });
      }
    }

    const normalizedTaskId = toPositiveInt(task.task_id) || taskId;
    const orderId = toPositiveInt(task.order_id);
    const notificationData = {
      task_id: String(normalizedTaskId),
      type: 'task_assigned',
      reassigned: '1',
    };
    if (orderId) notificationData.order_id = String(orderId);
    if (reason) notificationData.reason = reason;

    const notificationResult = await sendPushToDriver(
      newRiderId,
      'Task reassigned',
      task.task_description || `Task #${normalizedTaskId}`,
      notificationData
    );

    if (!notificationResult.success) {
      console.error('riderDeviceController.reassignTask push', notificationResult.error);
    }

    return res.json({
      code: 1,
      msg: 'Task reassigned successfully',
      details: {
        task_id: normalizedTaskId,
        new_rider_id: newRiderId,
        status: 'assigned',
        push_sent: notificationResult.success === true,
        ...(orderId ? { order_id: orderId } : {}),
      },
    });
  } catch (error) {
    console.error('Error in reassignTask:', error);
    return res.status(500).json({ code: 2, msg: 'Failed to reassign task', error });
  }
}

module.exports = { register, unregister, reassignTask };
