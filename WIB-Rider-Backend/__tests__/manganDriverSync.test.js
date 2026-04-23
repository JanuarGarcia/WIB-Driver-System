'use strict';

function makeJwt(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('manganDriverSync credential resolution', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.MANGAN_DRIVER_SYNC_ENABLED = '1';
    process.env.MANGAN_DRIVER_API_BASE_URL = 'https://order.example.test';
    delete process.env.MANGAN_DRIVER_API_KEY;
    delete process.env.MANGAN_SYNC_FALLBACK_USERNAME;
    delete process.env.MANGAN_SYNC_FALLBACK_PASSWORD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  test('falls back to mt_driver mangan_api credentials when st_driver sync columns are empty', async () => {
    const errandPool = {
      query: jest.fn(async (sql, params) => {
        const text = String(sql);
        if (/FROM st_ordernew/i.test(text)) {
          return [[{ order_uuid: 'uuid-123', driver_id: 7 }]];
        }
        if (/FROM st_driver/i.test(text)) {
          return [[{ u: null, p: null, email: null, password: null }]];
        }
        throw new Error(`Unexpected errandPool query: ${text}`);
      }),
    };

    const mainPool = {
      query: jest.fn(async (sql, params) => {
        const text = String(sql);
        if (/FROM mt_driver/i.test(text)) {
          expect(params).toEqual([7]);
          return [[{ u: 'legacy-driver@example.com', p: 'plain-secret' }]];
        }
        throw new Error(`Unexpected mainPool query: ${text}`);
      }),
    };

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 1,
            details: { user_token: makeJwt(4102444800) },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 1, details: { ok: true } }),
      });
    global.fetch = fetchMock;

    const { syncErrandStatusToMangan } = require('../lib/manganDriverSync');
    const out = await syncErrandStatusToMangan({
      mainPool,
      errandPool,
      driver: { id: 7 },
      orderId: 88,
      orderUuid: null,
      canonical: 'assigned',
    });

    expect(out).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'acceptorder',
      })
    );
    expect(mainPool.query).toHaveBeenCalledWith(expect.stringMatching(/FROM mt_driver/i), [7]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://order.example.test/driver/login');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      username: 'legacy-driver@example.com',
      password: 'plain-secret',
    });
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://order.example.test/driver/acceptorder');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      order_uuid: 'uuid-123',
    });
  });

  test('includes optional api_key in login and protected Mangan action payloads', async () => {
    process.env.MANGAN_DRIVER_API_KEY = 'mobile-api-key-123';

    const errandPool = {
      query: jest.fn(async (sql) => {
        const text = String(sql);
        if (/FROM st_ordernew/i.test(text)) {
          return [[{ order_uuid: 'uuid-456', driver_id: 12 }]];
        }
        if (/FROM st_driver/i.test(text)) {
          return [[{ u: 'driver@example.com', p: 'driver-pass', email: null, password: null }]];
        }
        throw new Error(`Unexpected errandPool query: ${text}`);
      }),
    };

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 1,
            details: { user_token: makeJwt(4102444800) },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 1, details: { ok: true } }),
      });
    global.fetch = fetchMock;

    const { syncErrandStatusToMangan } = require('../lib/manganDriverSync');
    const out = await syncErrandStatusToMangan({
      mainPool: null,
      errandPool,
      driver: { id: 12 },
      orderId: 99,
      orderUuid: null,
      canonical: 'successful',
      extras: { otpCode: '4321' },
    });

    expect(out).toEqual(expect.objectContaining({ ok: true, action: 'orderdelivered' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      username: 'driver@example.com',
      password: 'driver-pass',
      api_key: 'mobile-api-key-123',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      order_uuid: 'uuid-456',
      otp_code: '4321',
      api_key: 'mobile-api-key-123',
    });
  });
});
