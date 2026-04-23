'use strict';

describe('riderDeviceController.reassignTask', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function makeRes() {
    const res = {
      status: jest.fn(function status(code) {
        res.statusCode = code;
        return res;
      }),
      json: jest.fn(function json(body) {
        res.body = body;
        return res;
      }),
    };
    return res;
  }

  test('sends unified task_assigned reassignment payload and stops writing legacy mobile2 driver logs', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/SELECT task_id, order_id, task_description, status AS prev_status, driver_id AS prev_driver_id FROM mt_driver_task WHERE task_id = \?/i.test(text)) {
        return [[{ task_id: 44, order_id: 77, task_description: 'Dropoff task', prev_status: 'pending', prev_driver_id: 9 }]];
      }
      if (/UPDATE mt_driver_task/i.test(text)) {
        return [{ affectedRows: 1 }];
      }
      if (/mt_mobile2_push_logs/i.test(text)) {
        throw new Error('legacy mobile2 log insert should not be used');
      }
      return [[]];
    });

    const sendPushToDriver = jest.fn().mockResolvedValue({ success: true, messageId: 'push-1' });

    jest.doMock('../config/db', () => ({ pool: { query } }));
    jest.doMock('../services/fcm', () => ({ sendPushToDriver }));

    const ctrl = require('../controllers/riderDeviceController');
    const req = {
      rider: { driverId: 5 },
      body: { taskId: 44, newRiderId: 12, reason: 'Driver unavailable' },
    };
    const res = makeRes();

    await ctrl.reassignTask(req, res);

    expect(sendPushToDriver).toHaveBeenCalledWith(
      12,
      'Task reassigned',
      'Dropoff task',
      {
        task_id: '44',
        type: 'task_assigned',
        reassigned: '1',
        order_id: '77',
        reason: 'Driver unavailable',
      }
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE mt_driver_task[\s\S]*SET driver_id = \?, reassigned_to = \?, reassigned_by = \?, reassign_reason = \?, status = 'assigned'[\s\S]*WHERE task_id = \?/i),
      [12, 12, 5, 'Driver unavailable', 44]
    );
    expect(res.json).toHaveBeenCalledWith({
      code: 1,
      msg: 'Task reassigned successfully',
      details: {
        task_id: 44,
        new_rider_id: 12,
        status: 'assigned',
        push_sent: true,
        order_id: 77,
      },
    });
  });

  test('falls back from task_id and reassignment columns to legacy id update when schema is older', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/SELECT task_id, order_id, task_description, status AS prev_status, driver_id AS prev_driver_id FROM mt_driver_task WHERE task_id = \?/i.test(text)) {
        const err = new Error('Unknown column task_id');
        err.code = 'ER_BAD_FIELD_ERROR';
        throw err;
      }
      if (/SELECT id AS task_id, order_id, task_description, status AS prev_status, driver_id AS prev_driver_id FROM mt_driver_task WHERE id = \?/i.test(text)) {
        return [[{ task_id: 91, order_id: null, task_description: null, prev_status: 'assigned', prev_driver_id: 4 }]];
      }
      if (/WHERE task_id = \?/i.test(text) && /UPDATE mt_driver_task/i.test(text)) {
        const err = new Error('Unknown column task_id');
        err.code = 'ER_BAD_FIELD_ERROR';
        throw err;
      }
      if (/SET driver_id = \?, reassigned_to = \?, reassigned_by = \?, reassign_reason = \?, status = 'assigned'[\s\S]*WHERE id = \?/i.test(text)) {
        const err = new Error('Unknown column reassigned_to');
        err.code = 'ER_BAD_FIELD_ERROR';
        throw err;
      }
      if (/SET driver_id = \?, status = 'assigned'[\s\S]*WHERE id = \?/i.test(text)) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    });

    const sendPushToDriver = jest.fn().mockResolvedValue({ success: false, error: 'No device token' });

    jest.doMock('../config/db', () => ({ pool: { query } }));
    jest.doMock('../services/fcm', () => ({ sendPushToDriver }));

    const ctrl = require('../controllers/riderDeviceController');
    const req = {
      rider: { driverId: 3 },
      body: { task_id: 91, new_rider_id: 14 },
    };
    const res = makeRes();

    await ctrl.reassignTask(req, res);

    expect(sendPushToDriver).toHaveBeenCalledWith(
      14,
      'Task reassigned',
      'Task #91',
      {
        task_id: '91',
        type: 'task_assigned',
        reassigned: '1',
      }
    );
    expect(res.json).toHaveBeenCalledWith({
      code: 1,
      msg: 'Task reassigned successfully',
      details: {
        task_id: 91,
        new_rider_id: 14,
        status: 'assigned',
        push_sent: false,
      },
    });
  });
});
