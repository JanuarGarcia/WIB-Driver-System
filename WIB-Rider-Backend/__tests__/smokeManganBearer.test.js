'use strict';

const http = require('http');

describe('smokeManganBearer', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('logs in and sends Authorization bearer to a protected Mangan driver endpoint', async () => {
    const seen = {
      loginBody: null,
      authHeader: null,
      protectedBody: null,
      shiftAuthHeader: null,
    };
    const token = 'mock-user-token';

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/driver/login') {
          seen.loginBody = body ? JSON.parse(body) : null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, details: { user_token: token } }));
          return;
        }

        if (req.method === 'POST' && req.url === '/driver/profile') {
          seen.authHeader = req.headers.authorization || null;
          seen.protectedBody = body ? JSON.parse(body) : null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, details: { driver_uuid: 'driver-uuid-1' } }));
          return;
        }

        if (req.method === 'POST' && req.url === '/driver/shift') {
          seen.shiftAuthHeader = req.headers.authorization || null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, details: { schedule_uuid: 'schedule-uuid-1' } }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'not found' }));
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const originalLog = console.log;
    const originalError = console.error;
    console.log = jest.fn();
    console.error = jest.fn();

    try {
      const { smokeManganBearer } = require('../scripts/smoke-mangan-bearer');
      const out = await smokeManganBearer({
        username: 'demo-driver',
        password: 'demo-pass',
        baseUrl: `http://127.0.0.1:${port}`,
        protectedPath: '/driver/profile',
      });
      expect(out).toEqual({
        baseUrl: `http://127.0.0.1:${port}`,
        userToken: token,
        driverUuid: 'driver-uuid-1',
        scheduleUuid: 'schedule-uuid-1',
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
      await new Promise((resolve) => server.close(resolve));
    }

    expect(seen.loginBody).toEqual({
      username: 'demo-driver',
      password: 'demo-pass',
    });
    expect(seen.authHeader).toBe(`Bearer ${token}`);
    expect(seen.shiftAuthHeader).toBe(`Bearer ${token}`);
    expect(seen.protectedBody).toBe(null);
  });

  test('sends optional Mangan api_key in login and protected POST body', async () => {
    process.env.MANGAN_DRIVER_API_KEY = 'api-key-xyz';
    process.env.MANGAN_DRIVER_SEND_API_KEY_ON_LOGIN = '1';
    process.env.MANGAN_DRIVER_SEND_API_KEY_ON_ACTIONS = '1';

    const seen = {
      loginBody: null,
      authHeader: null,
      protectedBody: null,
      shiftAuthHeader: null,
    };
    const token = 'mock-user-token';

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/driver/login') {
          seen.loginBody = body ? JSON.parse(body) : null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, details: { user_token: token } }));
          return;
        }

        if (req.method === 'POST' && req.url === '/driver/profile') {
          seen.authHeader = req.headers.authorization || null;
          seen.protectedBody = body ? JSON.parse(body) : null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, details: { driver_uuid: 'driver-uuid-2' } }));
          return;
        }

        if (req.method === 'POST' && req.url === '/driver/shift') {
          seen.shiftAuthHeader = req.headers.authorization || null;
          const payload = body ? JSON.parse(body) : null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, details: { shift: { schedule_uuid: 'schedule-uuid-2' }, echoed: payload } }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'not found' }));
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const originalLog = console.log;
    const originalError = console.error;
    console.log = jest.fn();
    console.error = jest.fn();

    try {
      const { smokeManganBearer } = require('../scripts/smoke-mangan-bearer');
      const out = await smokeManganBearer({
        username: 'demo-driver',
        password: 'demo-pass',
        baseUrl: `http://127.0.0.1:${port}`,
        protectedPath: '/driver/profile',
        protectedBody: { order_uuid: 'uuid-1' },
      });
      expect(out).toEqual({
        baseUrl: `http://127.0.0.1:${port}`,
        userToken: token,
        driverUuid: 'driver-uuid-2',
        scheduleUuid: 'schedule-uuid-2',
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
      await new Promise((resolve) => server.close(resolve));
    }

    expect(seen.loginBody).toEqual({
      username: 'demo-driver',
      password: 'demo-pass',
      api_key: 'api-key-xyz',
    });
    expect(seen.authHeader).toBe(`Bearer ${token}`);
    expect(seen.shiftAuthHeader).toBe(`Bearer ${token}`);
    expect(seen.protectedBody).toEqual({
      order_uuid: 'uuid-1',
      api_key: 'api-key-xyz',
    });
  });
});
