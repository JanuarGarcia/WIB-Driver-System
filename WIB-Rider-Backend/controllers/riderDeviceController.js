'use strict';

const { pool } = require('../config/db');

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
    const { taskId, newRiderId, reason } = req.body;
    const adminId = req.rider.driverId; // Assuming admin is authenticated as a rider

    if (!taskId || !newRiderId) {
      return res.status(400).json({ code: 2, msg: 'taskId and newRiderId are required' });
    }

    const sql = `
      UPDATE mt_driver_task
      SET reassigned_to = ?, reassigned_by = ?, reassign_reason = ?, date_modified = CURRENT_TIMESTAMP
      WHERE id = ?
    `;

    const [result] = await pool.query(sql, [newRiderId, adminId, reason, taskId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ code: 2, msg: 'Task not found or no changes made' });
    }

    return res.json({ code: 1, msg: 'Task reassigned successfully' });
  } catch (error) {
    console.error('Error in reassignTask:', error);
    return res.status(500).json({ code: 2, msg: 'Failed to reassign task', error });
  }
}

module.exports = { register, unregister, reassignTask };
