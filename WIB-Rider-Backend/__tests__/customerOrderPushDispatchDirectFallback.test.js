'use strict';

describe('customer order push direct fallback', () => {
  const originalFetch = global.fetch;
  const envBackup = { ...process.env };

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...envBackup };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('uses direct FCM when customer dispatch config is missing', async () => {
    delete process.env.CUSTOMER_API_BASE_URL;
    delete process.env.WIBEATS_API_BASE_URL;
    delete process.env.PUSH_DISPATCH_SECRET;

    const insertMtMobile2PushLog = jest.fn().mockResolvedValue(undefined);
    const fetchClientFcmTokenAndDeviceRef = jest.fn().mockResolvedValue({
      token: 'legacy-token',
      deviceRef: 'legacy-ref',
    });
    const fetchMobile2DeviceRegContextForClient = jest.fn().mockResolvedValue({
      deviceId: 'new-token',
      devicePlatform: 'ios',
      installUuid: 'install-1',
      clientFullName: 'Test Customer',
    });
    const fetchMtClientDisplayName = jest.fn().mockResolvedValue('Test Customer');
    const resolvePushLogTriggerId = jest.fn().mockResolvedValue(77);
    const sendPushToFcmToken = jest.fn().mockResolvedValue({ success: true, messageId: 'direct-msg-1' });

    jest.doMock('../lib/mtMobile2PushLogs', () => ({ insertMtMobile2PushLog }));
    jest.doMock('../lib/customerFcmToken', () => ({ fetchClientFcmTokenAndDeviceRef }));
    jest.doMock('../services/fcm', () => ({ sendPushToFcmToken }));
    jest.doMock('../lib/mobile2DeviceRegLookup', () => ({
      fetchMobile2DeviceRegContextForClient,
      fetchMtClientDisplayName,
      resolvePushLogTriggerId,
    }));

    global.fetch = jest.fn();

    const pool = {
      query: jest.fn(async (sql) => {
        const text = String(sql);
        if (/SELECT client_id FROM mt_order/i.test(text)) {
          return [[{ client_id: 55 }]];
        }
        return [[]];
      }),
    };

    const svc = require('../lib/customerOrderPushDispatch');
    svc.notifyCustomerFoodTaskStatusPushFireAndForget(pool, {
      taskId: 88,
      orderId: 99,
      prevStatusRaw: 'acknowledged',
      newStatusRaw: 'started',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(sendPushToFcmToken).toHaveBeenCalledWith(
      'new-token',
      'DELIVERY DRIVER STARTED',
      expect.any(String),
      expect.objectContaining({
        order_id: '99',
        task_id: '88',
        push_type: 'driver_started',
        type: 'driver_started',
        show_popup: '1',
        popup_enabled: 'true',
        popup_type: 'driver_started',
        local_notification_type: 'driver_started',
      }),
      { useCustomerAndroidChannel: true }
    );
    expect(insertMtMobile2PushLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        clientId: 55,
        title: 'DELIVERY DRIVER STARTED',
        pushType: 'order',
        status: 'sent',
        jsonResponse: expect.stringContaining('"delivery_path":"direct_fcm"'),
      })
    );
  });
});
