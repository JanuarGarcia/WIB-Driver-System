'use strict';

describe('sendCustomerTaskMessage popup payloads', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('customer message push includes popup/local notification metadata and logs it', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM mt_driver_task/i.test(text)) {
        return [[{ task_id: 44, order_id: 77, driver_id: 9, status: 'started' }]];
      }
      if (/SELECT client_id FROM mt_order/i.test(text)) {
        return [[{ client_id: 22 }]];
      }
      if (/INSERT INTO mt_driver_customer_message/i.test(text)) {
        return [{ insertId: 501 }];
      }
      return [[]];
    });

    const sendPushToFcmToken = jest.fn().mockResolvedValue({ success: true, messageId: 'msg-1' });
    const fetchClientFcmTokenAndDeviceRef = jest.fn().mockResolvedValue({ token: 'legacy-token', deviceRef: 'legacy-ref' });
    const fetchMobile2DeviceRegContextForClient = jest.fn().mockResolvedValue({
      deviceId: 'new-token',
      installUuid: 'install-22',
      devicePlatform: 'android',
    });
    const insertMtMobile2PushLog = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../services/fcm', () => ({ sendPushToFcmToken }));
    jest.doMock('../lib/customerFcmToken', () => ({ fetchClientFcmTokenAndDeviceRef }));
    jest.doMock('../lib/mobile2DeviceRegLookup', () => ({ fetchMobile2DeviceRegContextForClient }));
    jest.doMock('../lib/mtMobile2PushLogs', () => ({ insertMtMobile2PushLog }));

    const { sendCustomerTaskMessage } = require('../lib/sendCustomerTaskMessage');
    const out = await sendCustomerTaskMessage(
      { query },
      { query: jest.fn() },
      { id: 9 },
      {
        task_id: 44,
        message: 'Please answer the phone',
        push_title: 'Update from your rider',
        push_message: 'Please answer the phone',
        push_type: 'rider_customer_notify',
      }
    );

    expect(out).toEqual({
      err: null,
      details: {
        message_id: 501,
        push_sent: true,
      },
    });

    expect(sendPushToFcmToken).toHaveBeenCalledWith(
      'new-token',
      'Update from your rider',
      'Please answer the phone',
      expect.objectContaining({
        push_type: 'rider_customer_notify',
        type: 'rider_customer_notify',
        show_popup: '1',
        popup_enabled: 'true',
        popup_title: 'Update from your rider',
        popup_message: 'Please answer the phone',
        popup_type: 'rider_customer_notify',
        local_notification_title: 'Update from your rider',
        local_notification_body: 'Please answer the phone',
        local_notification_type: 'rider_customer_notify',
      }),
      { useCustomerAndroidChannel: true }
    );

    expect(insertMtMobile2PushLog).toHaveBeenCalledWith(
      { query },
      expect.objectContaining({
        clientId: 22,
        pushType: 'rider_customer_notify',
        status: 'sent',
        jsonResponse: expect.stringContaining('"show_popup":1'),
      })
    );
  });
});
