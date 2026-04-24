'use strict';

describe('riderSessionService establishSingleDeviceSession', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('revokes previous sessions and activates only the current device token', async () => {
    const query = jest.fn(async (sql, params) => {
      const text = String(sql);
      if (/INFORMATION_SCHEMA\.COLUMNS/i.test(text)) {
        const table = params && params[0];
        if (table === 'mt_rider_device_reg') {
          return [[
            { c: 'driver_id' },
            { c: 'device_id' },
            { c: 'device_platform' },
            { c: 'device_uuid' },
            { c: 'device_name' },
            { c: 'push_enabled' },
            { c: 'is_active' },
            { c: 'session_id' },
            { c: 'auth_token' },
            { c: 'revoked_at' },
            { c: 'revoked_reason' },
            { c: 'last_seen_at' },
          ]];
        }
        return [[]];
      }
      if (/UPDATE mt_rider_session[\s\S]*auth_token <> \?/i.test(text)) {
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE mt_rider_device_reg[\s\S]*push_enabled = 0[\s\S]*device_id <> \?/i.test(text)) {
        return [{ affectedRows: 2 }];
      }
      if (/INSERT INTO mt_rider_session/i.test(text)) {
        return [{ insertId: 55 }];
      }
      if (/UPDATE mt_rider_session[\s\S]*last_seen_at = NOW\(\)/i.test(text)) {
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE mt_rider_device_reg[\s\S]*WHERE driver_id = \? AND device_id = \?/i.test(text)) {
        return [{ affectedRows: 0 }];
      }
      if (/INSERT INTO mt_rider_device_reg/i.test(text)) {
        return [{ insertId: 91 }];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    jest.doMock('../lib/mobile2DeviceRegLookup', () => ({
      loadTableColumnSet: jest.requireActual('../lib/mobile2DeviceRegLookup').loadTableColumnSet,
    }));

    const svc = require('../lib/riderSessionService');
    svc.resetColumnCache();

    const out = await svc.establishSingleDeviceSession(
      { query },
      7,
      'new-token',
      {
        device_id: 'push-token-new',
        device_uuid: 'install-1',
        device_name: 'Galaxy S24',
        device_platform: 'android',
      },
      {
        ipAddress: '127.0.0.1',
        revokedReason: 'logged_in_on_another_device',
      }
    );

    expect(out).toEqual({
      sessionId: 55,
      deviceId: 'install-1',
      deviceUuid: 'install-1',
      pushToken: 'push-token-new',
      devicePlatform: 'android',
      deviceName: 'Galaxy S24',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE mt_rider_session[\s\S]*auth_token <> \?/i),
      ['logged_in_on_another_device', 7, 'new-token']
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE mt_rider_device_reg[\s\S]*device_id <> \?/i),
      ['logged_in_on_another_device', 7, 'push-token-new']
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO mt_rider_session/i),
      [7, 'new-token', 'install-1', 'install-1', 'Galaxy S24', 'android', 'push-token-new', null, '127.0.0.1']
    );
    const insertDeviceCall = query.mock.calls.find(([sql]) => /INSERT INTO mt_rider_device_reg/i.test(String(sql)));
    expect(insertDeviceCall).toBeTruthy();
    expect(insertDeviceCall[1].slice(0, 8)).toEqual([7, 'push-token-new', 'android', 'install-1', 'Galaxy S24', 1, 1, 55]);
    expect(insertDeviceCall[1][8]).toBe('new-token');
    expect(insertDeviceCall[1][9]).toBeInstanceOf(Date);
  });

  test('finds a reusable active session for the same device to avoid rotating tokens on weak reconnects', async () => {
    const query = jest.fn(async (sql, params) => {
      const text = String(sql);
      if (/FROM mt_rider_session[\s\S]*device_uuid = \?/i.test(text)) {
        expect(params).toEqual([7, 'install-1', 'push-token-new', 'push-token-new']);
        return [[{
          id: 88,
          auth_token: 'stable-token',
          driver_id: 7,
          device_id: 'push-token-new',
          device_uuid: 'install-1',
          device_name: 'Galaxy S24',
          device_platform: 'android',
          push_token: 'push-token-new',
        }]];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const svc = require('../lib/riderSessionService');
    const out = await svc.findReusableDriverSession(
      { query },
      7,
      {
        device_id: 'push-token-new',
        device_uuid: 'install-1',
        device_platform: 'android',
      },
      {}
    );

    expect(out).toEqual({
      id: 88,
      authToken: 'stable-token',
      driverId: 7,
      deviceId: 'push-token-new',
      deviceUuid: 'install-1',
      deviceName: 'Galaxy S24',
      devicePlatform: 'android',
      pushToken: 'push-token-new',
    });
  });

  test('finds the active session for a device so GetAppSettings can recover after a stale-token reconnect', async () => {
    const query = jest.fn(async (sql, params) => {
      const text = String(sql);
      if (/FROM mt_rider_session s[\s\S]*INNER JOIN mt_driver d/i.test(text)) {
        expect(params).toEqual(['install-1', 'push-token-new', 'push-token-new']);
        return [[{
          session_id: 101,
          auth_token: 'recovered-token',
          session_driver_id: 7,
          session_device_id: 'push-token-new',
          session_device_uuid: 'install-1',
          session_device_name: 'Galaxy S24',
          session_device_platform: 'android',
          session_push_token: 'push-token-new',
          id: 7,
          username: 'rider1',
          full_name: 'Rider One',
          team_id: 2,
          on_duty: 1,
          device_id: 'push-token-new',
          device_platform: 'android',
        }]];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const svc = require('../lib/riderSessionService');
    const out = await svc.findActiveSessionForDevice(
      { query },
      {
        device_id: 'push-token-new',
        device_uuid: 'install-1',
      },
      {}
    );

    expect(out).toEqual({
      valid: true,
      tokenPresent: true,
      tokenStatus: 'valid',
      reason: null,
      recovered: true,
      authToken: 'recovered-token',
      driver: {
        id: 7,
        username: 'rider1',
        full_name: 'Rider One',
        team_id: 2,
        on_duty: 1,
        device_id: 'push-token-new',
        device_platform: 'android',
      },
      session: {
        id: 101,
        driverId: 7,
        deviceId: 'push-token-new',
        deviceUuid: 'install-1',
        deviceName: 'Galaxy S24',
        devicePlatform: 'android',
        pushToken: 'push-token-new',
      },
    });
  });
});
