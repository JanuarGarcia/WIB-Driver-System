'use strict';

describe('driver auth token extraction', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('accepts token from common body/query aliases and auth headers', () => {
    jest.doMock('../config/db', () => ({ pool: { query: jest.fn() } }));

    const { getDriverTokenFromRequest } = require('../middleware/auth');

    expect(
      getDriverTokenFromRequest({
        query: { sessionToken: 'abc-123' },
        body: {},
        headers: {},
      })
    ).toBe('abc-123');

    expect(
      getDriverTokenFromRequest({
        query: {},
        body: { driver_token: 'def-456' },
        headers: {},
      })
    ).toBe('def-456');

    expect(
      getDriverTokenFromRequest({
        query: {},
        body: {},
        headers: { authorization: 'Bearer ghi-789' },
      })
    ).toBe('ghi-789');

    expect(
      getDriverTokenFromRequest({
        query: {},
        body: {},
        headers: { 'x-access-token': '"jkl-000"' },
      })
    ).toBe('jkl-000');
  });

  test('normalizes token prefixes and empty values safely', () => {
    jest.doMock('../config/db', () => ({ pool: { query: jest.fn() } }));

    const { normalizeDriverTokenCandidate } = require('../middleware/auth');

    expect(normalizeDriverTokenCandidate('Token xyz-1')).toBe('xyz-1');
    expect(normalizeDriverTokenCandidate(' "uvw-2" ')).toBe('uvw-2');
    expect(normalizeDriverTokenCandidate('')).toBeNull();
    expect(normalizeDriverTokenCandidate(null)).toBeNull();
  });
});
