describe('manganDriverSync', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      MANGAN_DRIVER_SYNC_ENABLED: '1',
      MANGAN_DRIVER_API_BASE_URL: 'https://order.wheninbaguioeat.com',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('posts driver action with token auth header and JSON order_uuid body', async () => {
    process.env.MANGAN_DRIVER_API_KEY = 'mobile-api-key-123';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        text: async () => JSON.stringify({ code: 1, details: { user_token: 'jwt-token-123' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 1,
            msg: 'OK',
            details: { order_uuid: '22e4ff4e-3f8f-11f1-9338-e4580b2fcd75' },
          }),
      });
    global.fetch = fetchMock;

    const errandPool = {
      query: jest.fn(async (sql) => {
        if (String(sql).includes('FROM st_ordernew')) {
          return [[{ order_uuid: '22e4ff4e-3f8f-11f1-9338-e4580b2fcd75', driver_id: 88 }]];
        }
        if (String(sql).includes('FROM st_driver')) {
          return [[{ u: 'driver@example.com', p: 'secret123', email: null, password: null }]];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const mainPool = {
      query: jest.fn(async () => [[]]),
    };

    const { syncErrandStatusToMangan } = require('./lib/manganDriverSync');

    const result = await syncErrandStatusToMangan({
      mainPool,
      errandPool,
      driver: { id: 88 },
      orderId: 123,
      canonical: 'assigned',
    });

    expect(result).toMatchObject({ ok: true, action: 'acceptorder' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const loginCall = fetchMock.mock.calls[0];
    expect(String(loginCall[0])).toBe('https://order.wheninbaguioeat.com/driver/login');
    expect(loginCall[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer mobile-api-key-123',
      }),
      body: JSON.stringify({ username: 'driver@example.com', password: 'secret123' }),
    });

    const actionCall = fetchMock.mock.calls[1];
    expect(String(actionCall[0])).toBe('https://order.wheninbaguioeat.com/driver/acceptorder');
    expect(actionCall[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'token jwt-token-123',
      }),
      body: JSON.stringify({ order_uuid: '22e4ff4e-3f8f-11f1-9338-e4580b2fcd75' }),
    });
  });
});
