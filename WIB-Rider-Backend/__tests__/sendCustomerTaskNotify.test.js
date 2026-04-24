'use strict';

describe('sendCustomerTaskNotify', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('forwards custom notify payload fields through the notify route helper', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM mt_driver_task/i.test(text)) {
        return [[{ task_id: 44, order_id: 77, driver_id: 9, status: 'started' }]];
      }
      if (/SELECT client_id FROM mt_order/i.test(text)) {
        return [[{ client_id: 22 }]];
      }
      if (/INSERT INTO mt_driver_customer_message/i.test(text)) {
        return [{ insertId: 902 }];
      }
      return [[]];
    });

    const sendPushToFcmToken = jest.fn().mockResolvedValue({ success: true, messageId: 'notify-1' });
    const fetchClientFcmTokenAndDeviceRef = jest.fn().mockResolvedValue({ token: 'customer-token', deviceRef: 'device-ref' });
    const fetchMobile2DeviceRegContextForClient = jest.fn().mockResolvedValue(null);
    const insertMtMobile2PushLog = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../services/fcm', () => ({ sendPushToFcmToken }));
    jest.doMock('../lib/customerFcmToken', () => ({ fetchClientFcmTokenAndDeviceRef }));
    jest.doMock('../lib/mobile2DeviceRegLookup', () => ({ fetchMobile2DeviceRegContextForClient }));
    jest.doMock('../lib/mtMobile2PushLogs', () => ({ insertMtMobile2PushLog }));

    const { sendCustomerTaskNotify } = require('../lib/sendCustomerTaskMessage');

    const out = await sendCustomerTaskNotify(
      { query },
      { query: jest.fn() },
      { id: 9 },
      {
        task_id: 44,
        order_id: 77,
        message: 'Please check the gate',
        push_title: 'Rider update',
        push_message: 'Please check the gate now',
        push_type: 'custom_customer_ping',
      }
    );

    expect(out).toEqual({
      err: null,
      details: {
        message_id: 902,
        push_sent: true,
      },
    });
    expect(sendPushToFcmToken).toHaveBeenCalledWith(
      'customer-token',
      'Rider update',
      'Please check the gate now',
      expect.objectContaining({
        task_id: '44',
        order_id: '77',
        push_type: 'custom_customer_ping',
        popup_title: 'Rider update',
        popup_message: 'Please check the gate now',
        local_notification_title: 'Rider update',
        local_notification_body: 'Please check the gate now',
      }),
      { useCustomerAndroidChannel: true }
    );
  });
});
