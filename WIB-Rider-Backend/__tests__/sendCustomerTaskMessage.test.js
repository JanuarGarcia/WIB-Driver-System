'use strict';

describe('sendCustomerTaskMessage push target resolution', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('prefers mt_mobile2_device_reg token for new customer app deliveries', async () => {
    const fetchClientFcmTokenAndDeviceRef = jest.fn().mockResolvedValue({
      token: 'legacy-client-token',
      deviceRef: 'legacy-device-ref',
    });
    const fetchMobile2DeviceRegContextForClient = jest.fn().mockResolvedValue({
      deviceId: 'mobile2-token',
      installUuid: 'mobile2-install',
      devicePlatform: 'android',
      clientFullName: 'Test Customer',
    });

    jest.doMock('../lib/customerFcmToken', () => ({ fetchClientFcmTokenAndDeviceRef }));
    jest.doMock('../lib/mobile2DeviceRegLookup', () => ({ fetchMobile2DeviceRegContextForClient }));

    const { resolveCustomerPushTarget } = require('../lib/sendCustomerTaskMessage');
    const out = await resolveCustomerPushTarget({}, 'mt_client', 55);

    expect(out).toEqual({
      token: 'mobile2-token',
      deviceRef: 'mobile2-install',
      devicePlatform: 'android',
      source: 'mt_mobile2_device_reg',
    });
    expect(fetchClientFcmTokenAndDeviceRef).toHaveBeenCalledWith({}, 'mt_client', 55);
    expect(fetchMobile2DeviceRegContextForClient).toHaveBeenCalledWith({}, 55);
  });

  test('falls back to legacy token lookup for non-mobile2 customer tables', async () => {
    const fetchClientFcmTokenAndDeviceRef = jest.fn().mockResolvedValue({
      token: 'st-client-token',
      deviceRef: 'st-device-ref',
    });
    const fetchMobile2DeviceRegContextForClient = jest.fn();

    jest.doMock('../lib/customerFcmToken', () => ({ fetchClientFcmTokenAndDeviceRef }));
    jest.doMock('../lib/mobile2DeviceRegLookup', () => ({ fetchMobile2DeviceRegContextForClient }));

    const { resolveCustomerPushTarget } = require('../lib/sendCustomerTaskMessage');
    const out = await resolveCustomerPushTarget({}, 'st_client', 99);

    expect(out).toEqual({
      token: 'st-client-token',
      deviceRef: 'st-device-ref',
      devicePlatform: null,
      source: 'st_client',
    });
    expect(fetchMobile2DeviceRegContextForClient).not.toHaveBeenCalled();
  });
});
