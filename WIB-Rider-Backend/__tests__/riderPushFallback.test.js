'use strict';

describe('rider push fallback behavior', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('sendRiderOrderPush falls back to mt_driver.device_id when mt_rider_device_reg has no rows', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM\s+`?mt_option`?/i.test(text)) {
        return [[{ option_value: JSON.stringify({ enable_push: 1, push_title: 'Assigned', push_body: 'Task body' }) }]];
      }
      if (/FROM\s+`?mt_rider_device_reg`?/i.test(text)) {
        return [[]];
      }
      if (/FROM\s+mt_driver/i.test(text)) {
        return [[{ id: 7, device_id: 'legacy-token', device_platform: 'android' }]];
      }
      if (/INSERT\s+INTO\s+`?mt_rider_push_logs`?/i.test(text)) {
        return [{ insertId: 123 }];
      }
      if (/INSERT\s+INTO\s+mt_driver_pushlog/i.test(text)) {
        return [{ insertId: 456 }];
      }
      if (/UPDATE\s+`?mt_rider_push_logs`?/i.test(text)) {
        return [{}];
      }
      if (/INSERT\s+INTO\s+mt_rider_order_trigger/i.test(text)) {
        return [{ insertId: 55 }];
      }
      return [[]];
    });

    const sendPushToDevice = jest.fn().mockResolvedValue({ success: true, messageId: 'm-1' });
    const maybeDisableBadRiderToken = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../config/db', () => ({ pool: { query } }));
    jest.doMock('../services/fcm', () => ({
      sendPushToDevice,
      logDriverInboxNotification: jest.fn(async (poolArg, payload) => {
        await poolArg.query(
          `INSERT INTO mt_driver_pushlog (driver_id, push_title, push_message, push_type, task_id, order_id, date_created, date_process, is_read)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 0)`,
          [payload.driverId, payload.title, payload.body, payload.pushType, payload.taskId, payload.orderId]
        );
      }),
    }));
    jest.doMock('../lib/riderPushFailureHelpers', () => ({ maybeDisableBadRiderToken }));

    const svc = require('../services/riderOrderPushService');
    const out = await svc.sendRiderOrderPush({
      orderId: 88,
      driverId: 7,
      eventKey: 'RIDER_ORDER_ASSIGNED',
      orderStatus: 'assigned',
    });

    expect(out).toEqual({ skipped: false });
    expect(sendPushToDevice).toHaveBeenCalledWith(
      'legacy-token',
      expect.objectContaining({
        title: 'Assigned',
        body: 'Task body',
        data: expect.objectContaining({
          type: 'rider_order_assigned',
          push_type: 'rider_order_assigned',
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          screen: 'task_detail',
        }),
      })
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT\s+INTO\s+mt_driver_pushlog/i),
      [7, 'Assigned', 'Task body', 'rider_order_assigned', null, 88]
    );
    expect(maybeDisableBadRiderToken).not.toHaveBeenCalled();
  });

  test('sendPushToDriver enriches payload for rider app routing', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM\s+mt_rider_device_reg/i.test(text)) {
        return [[]];
      }
      if (/SELECT\s+device_id\s+FROM\s+mt_driver/i.test(text)) {
        return [[{ device_id: 'driver-token' }]];
      }
      if (/INSERT\s+INTO\s+mt_driver_pushlog/i.test(text)) {
        return [{ insertId: 987 }];
      }
      if (/FROM\s+mt_option/i.test(text)) {
        return [[{ value: JSON.stringify({ project_id: 'x', client_email: 'x@y.z', private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n' }) }]];
      }
      return [[]];
    });

    const send = jest.fn().mockResolvedValue('msg-1');
    const initializeApp = jest.fn();
    const cert = jest.fn(() => ({}));

    jest.doMock('../config/db', () => ({ pool: { query } }));
    jest.unmock('../services/fcm');
    jest.doMock('firebase-admin', () => ({
      apps: [],
      initializeApp,
      credential: { cert },
      messaging: undefined,
      __esModule: false,
      default: undefined,
    }));

    const fcm = require('../services/fcm');
    const firebaseAdmin = require('firebase-admin');
    firebaseAdmin.initializeApp.mockImplementation(() => {
      firebaseAdmin.apps.push({});
    });
    firebaseAdmin.messaging = () => ({ send });
    firebaseAdmin.apps[0] = { messaging: () => ({ send }) };

    const res = await fcm.sendPushToDriver(9, 'Task assigned', 'Body', {
      type: 'task_assigned',
      task_id: '101',
      order_id: '202',
    });

    expect(res).toEqual({ success: true, messageId: 'msg-1' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'driver-token',
        data: expect.objectContaining({
          type: 'task_assigned',
          push_type: 'task_assigned',
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          screen: 'task_detail',
          task_id: '101',
          order_id: '202',
        }),
      })
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT\s+INTO\s+mt_driver_pushlog/i),
      [9, 'Task assigned', 'Body', 'task_assigned', 101, 202]
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          push_nonce: expect.any(String),
        }),
      })
    );
  });

  test('sendPushToDriver falls back to a simpler inbox insert when mt_driver_pushlog schema lacks date_process', async () => {
    let insertAttempt = 0;
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM\s+mt_rider_device_reg/i.test(text)) {
        return [[]];
      }
      if (/SELECT\s+device_id\s+FROM\s+mt_driver/i.test(text)) {
        return [[{ device_id: 'driver-token' }]];
      }
      if (/INSERT\s+INTO\s+mt_driver_pushlog/i.test(text)) {
        insertAttempt += 1;
        if (insertAttempt === 1) {
          const err = new Error('Unknown column date_process');
          err.code = 'ER_BAD_FIELD_ERROR';
          throw err;
        }
        return [{ insertId: 321 }];
      }
      if (/FROM\s+mt_option/i.test(text)) {
        return [[{ value: JSON.stringify({ project_id: 'x', client_email: 'x@y.z', private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n' }) }]];
      }
      return [[]];
    });

    const send = jest.fn().mockResolvedValue('msg-2');
    const initializeApp = jest.fn();
    const cert = jest.fn(() => ({}));

    jest.doMock('../config/db', () => ({ pool: { query } }));
    jest.unmock('../services/fcm');
    jest.doMock('firebase-admin', () => ({
      apps: [],
      initializeApp,
      credential: { cert },
      messaging: undefined,
      __esModule: false,
      default: undefined,
    }));

    const fcm = require('../services/fcm');
    const firebaseAdmin = require('firebase-admin');
    firebaseAdmin.initializeApp.mockImplementation(() => {
      firebaseAdmin.apps.push({});
    });
    firebaseAdmin.messaging = () => ({ send });
    firebaseAdmin.apps[0] = { messaging: () => ({ send }) };

    const res = await fcm.sendPushToDriver(9, 'Retry insert', 'Body', { type: 'admin_push' });

    expect(res).toEqual({ success: true, messageId: 'msg-2' });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT\s+INTO\s+mt_driver_pushlog .*date_process/i),
      [9, 'Retry insert', 'Body', 'admin_push', null, null]
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT\s+INTO\s+mt_driver_pushlog .*is_read/i),
      [9, 'Retry insert', 'Body', 'admin_push', null, null]
    );
  });
});
