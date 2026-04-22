'use strict';

describe('customer order push dispatch', () => {
  const originalFetch = global.fetch;
  const envBackup = { ...process.env };

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...envBackup };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('rider status change dispatch posts popup metadata and records mt_mobile2_push_logs payload details', async () => {
    process.env.CUSTOMER_API_BASE_URL = 'https://customer.example.com';
    process.env.PUSH_DISPATCH_SECRET = 'secret';

    const insertMtMobile2PushLog = jest.fn().mockResolvedValue(undefined);
    const fetchClientFcmTokenAndDeviceRef = jest.fn().mockResolvedValue({ token: 'legacy-token', deviceRef: 'legacy-ref' });
    const fetchMobile2DeviceRegContextForClient = jest.fn().mockResolvedValue({
      deviceId: 'new-token',
      devicePlatform: 'android',
      installUuid: 'install-1',
      clientFullName: 'Test Customer',
    });
    const fetchMtClientDisplayName = jest.fn().mockResolvedValue('Test Customer');
    const resolvePushLogTriggerId = jest.fn().mockResolvedValue(77);

    jest.doMock('../lib/mtMobile2PushLogs', () => ({ insertMtMobile2PushLog }));
    jest.doMock('../lib/customerFcmToken', () => ({ fetchClientFcmTokenAndDeviceRef }));
    jest.doMock('../lib/mobile2DeviceRegLookup', () => ({
      fetchMobile2DeviceRegContextForClient,
      fetchMtClientDisplayName,
      resolvePushLogTriggerId,
    }));

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, sent: 1 }),
    });

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

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, fetchOpts] = global.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body).toEqual(
      expect.objectContaining({
        client_id: '55',
        order_id: '99',
        push_type: 'driver_started',
        type: 'driver_started',
        show_popup: 1,
        popup_enabled: true,
        popup_type: 'driver_started',
        local_notification_type: 'driver_started',
      })
    );

    expect(insertMtMobile2PushLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        clientId: 55,
        title: 'DELIVERY DRIVER STARTED',
        body: expect.any(String),
        pushType: 'order',
        status: 'sent',
        jsonResponse: expect.stringContaining('"popup_type":"driver_started"'),
      })
    );
  });
});
