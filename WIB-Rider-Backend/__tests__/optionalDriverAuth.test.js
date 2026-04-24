'use strict';

describe('middleware/auth optionalDriver', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('marks missing token as missing without failing request', async () => {
    jest.doMock('../config/db', () => ({
      pool: {
        query: jest.fn(),
      },
    }));

    const { optionalDriver } = require('../middleware/auth');
    const req = { query: {}, body: {}, headers: {} };
    const res = {};
    const next = jest.fn();

    await optionalDriver(req, res, next);

    expect(req.driver).toBeNull();
    expect(req.driverTokenState).toBe('missing');
    expect(next).toHaveBeenCalled();
  });

  test('marks stale token as invalid without failing request', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM mt_rider_session s/i.test(text)) {
        return [[{
          session_id: 11,
          session_driver_id: 9,
          session_push_token: 'old-token',
          session_is_active: 0,
          session_revoked_at: new Date('2026-04-24T00:00:00Z'),
          session_revoked_reason: 'logged_in_on_another_device',
        }]];
      }
      return [[]];
    });
    jest.doMock('../config/db', () => ({
      pool: { query },
    }));

    const { optionalDriver } = require('../middleware/auth');
    const req = { query: {}, body: { token: 'stale-token' }, headers: {} };
    const res = {};
    const next = jest.fn();

    await optionalDriver(req, res, next);

    expect(req.driver).toBeNull();
    expect(req.driverTokenState).toBe('invalid');
    expect(req.driverTokenReason).toBe('logged_in_on_another_device');
    expect(next).toHaveBeenCalled();
  });

  test('marks valid token as valid and attaches driver', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM mt_rider_session s/i.test(text)) {
        return [[{
          session_id: 22,
          session_driver_id: 9,
          session_device_id: 'push-token-1',
          session_device_uuid: 'uuid-1',
          session_device_name: 'Pixel',
          session_device_platform: 'android',
          session_push_token: 'push-token-1',
          session_is_active: 1,
          session_revoked_at: null,
          session_revoked_reason: null,
          id: 9,
          username: 'rider1',
          full_name: 'Rider One',
          team_id: 4,
          on_duty: 1,
          device_id: 'push-token-1',
          device_platform: 'android',
        }]];
      }
      if (/UPDATE mt_rider_session[\s\S]*last_seen_at = NOW\(\)/i.test(text)) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    });
    jest.doMock('../config/db', () => ({
      pool: { query },
    }));

    const { optionalDriver } = require('../middleware/auth');
    const req = { query: { token: 'good-token' }, body: {}, headers: {} };
    const res = {};
    const next = jest.fn();

    await optionalDriver(req, res, next);

    expect(req.driver).toEqual({
      id: 9,
      username: 'rider1',
      full_name: 'Rider One',
      team_id: 4,
      on_duty: 1,
      device_id: 'push-token-1',
      device_platform: 'android',
    });
    expect(req.driverSession).toEqual({
      id: 22,
      driverId: 9,
      deviceId: 'push-token-1',
      deviceUuid: 'uuid-1',
      deviceName: 'Pixel',
      devicePlatform: 'android',
      pushToken: 'push-token-1',
    });
    expect(req.driverTokenState).toBe('valid');
    expect(next).toHaveBeenCalled();
  });
});
