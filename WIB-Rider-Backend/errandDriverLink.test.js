describe('errandDriverLink', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('prefers explicit mt_driver.mangan_driver_id when linked st_driver exists', async () => {
    const mainPool = {
      query: jest.fn(async (sql, params) => {
        if (String(sql).includes('FROM mt_driver')) {
          expect(params).toEqual([14]);
          return [[{ driver_id: 14, mangan_driver_id: 301, email: 'clay.chunk@gmail.com', username: 'test123' }]];
        }
        throw new Error(`Unexpected main query: ${sql}`);
      }),
    };
    const errandPool = {
      query: jest.fn(async (sql, params) => {
        if (String(sql).includes('FROM st_driver WHERE driver_id = ?')) {
          if (params[0] === 301) return [[{ driver_id: 301, email: 'clay.chunk@gmail.com' }]];
          if (params[0] === 14) return [[]];
        }
        throw new Error(`Unexpected errand query: ${sql}`);
      }),
    };

    const { resolveErrandDriverLink } = require('./lib/errandDriverLink');
    const link = await resolveErrandDriverLink(mainPool, errandPool, 14);

    expect(link).toMatchObject({
      wibDriverId: 14,
      manganDriverId: 301,
      candidateDriverIds: [301, 14],
      source: 'mt_driver.mangan_driver_id',
    });
  });

  test('falls back to email match when ids differ and no explicit mapping exists', async () => {
    const mainPool = {
      query: jest.fn(async (sql) => {
        if (String(sql).includes('FROM mt_driver')) {
          return [[{ driver_id: 14, email: 'clay.chunk@gmail.com', username: 'test123', first_name: 'John', last_name: 'Clifford' }]];
        }
        throw new Error(`Unexpected main query: ${sql}`);
      }),
    };
    const errandPool = {
      query: jest.fn(async (sql, params) => {
        const text = String(sql);
        if (text.includes('FROM st_driver WHERE driver_id = ?')) {
          return [[]];
        }
        if (text.includes('`wib_sync_username`')) {
          return [[]];
        }
        if (text.includes('`email`')) {
          expect(params).toEqual(['clay.chunk@gmail.com']);
          return [[{ driver_id: 88, email: 'clay.chunk@gmail.com' }]];
        }
        throw new Error(`Unexpected errand query: ${sql}`);
      }),
    };

    const { resolveErrandDriverLink } = require('./lib/errandDriverLink');
    const link = await resolveErrandDriverLink(mainPool, errandPool, 14);

    expect(link).toMatchObject({
      wibDriverId: 14,
      manganDriverId: 88,
      candidateDriverIds: [88, 14],
      source: 'email:clay.chunk@gmail.com',
    });
  });
});
