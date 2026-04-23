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
    const query = jest.fn().mockResolvedValue([[]]);
    jest.doMock('../config/db', () => ({
      pool: { query },
    }));

    const { optionalDriver } = require('../middleware/auth');
    const req = { query: {}, body: { token: 'stale-token' }, headers: {} };
    const res = {};
    const next = jest.fn();

    await optionalDriver(req, res, next);

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM mt_driver WHERE token = \?/i),
      ['stale-token']
    );
    expect(req.driver).toBeNull();
    expect(req.driverTokenState).toBe('invalid');
    expect(next).toHaveBeenCalled();
  });

  test('marks valid token as valid and attaches driver', async () => {
    const query = jest.fn().mockResolvedValue([[{ id: 9, username: 'rider1', on_duty: 1 }]]);
    jest.doMock('../config/db', () => ({
      pool: { query },
    }));

    const { optionalDriver } = require('../middleware/auth');
    const req = { query: { token: 'good-token' }, body: {}, headers: {} };
    const res = {};
    const next = jest.fn();

    await optionalDriver(req, res, next);

    expect(req.driver).toEqual({ id: 9, username: 'rider1', on_duty: 1 });
    expect(req.driverTokenState).toBe('valid');
    expect(next).toHaveBeenCalled();
  });
});
