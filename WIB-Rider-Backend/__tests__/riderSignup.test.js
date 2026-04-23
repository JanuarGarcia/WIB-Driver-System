const {
  createDriverSignup,
  findDriverSignupConflict,
  isRiderSignupEnabled,
  normalizeRiderSignupStatus,
  resolveRiderSignupPayload,
  riderSignupSuccessMessage,
} = require('../lib/riderSignup');

function badFieldError(message = 'Unknown column') {
  const err = new Error(message);
  err.code = 'ER_BAD_FIELD_ERROR';
  return err;
}

describe('riderSignup helpers', () => {
  test('signup toggle defaults off and accepts on values', () => {
    expect(isRiderSignupEnabled({})).toBe(false);
    expect(isRiderSignupEnabled({ enabled_signup: '1' })).toBe(true);
    expect(isRiderSignupEnabled({ enabled_signup: 'on' })).toBe(true);
    expect(isRiderSignupEnabled({ enabled_signup: '0' })).toBe(false);
  });

  test('normalizes signup payload aliases and full name', () => {
    const payload = resolveRiderSignupPayload({
      email_address: 'newrider@example.com',
      password: 'secret123',
      name: 'Jane Driver',
      mobile_number: '+63 912 345 6789',
      device_token: 'abc123',
      os: 'Android',
    });

    expect(payload.username).toBe('newrider@example.com');
    expect(payload.email).toBe('newrider@example.com');
    expect(payload.first_name).toBe('Jane');
    expect(payload.last_name).toBe('Driver');
    expect(payload.phone).toBe('+63 912 345 6789');
    expect(payload.device_id).toBe('abc123');
    expect(payload.device_platform).toBe('Android');
  });

  test('finds signup conflicts across username and phone', async () => {
    const pool = {
      query: jest.fn(async (sql) => {
        const text = String(sql);
        if (/LOWER\(TRIM\(`username`\)\)/i.test(text)) return [[{ exists: 1 }]];
        return [[]];
      }),
    };

    await expect(findDriverSignupConflict(pool, { username: 'taken', phone: '09123456789' })).resolves.toBe('Username already exists');
  });

  test('retries narrower mt_driver insert shapes for rider signup', async () => {
    const pool = {
      query: jest.fn(async (sql) => {
        const text = String(sql);
        if (/INSERT INTO mt_driver/i.test(text) && /password_bcrypt/i.test(text)) throw badFieldError();
        if (/INSERT INTO mt_driver/i.test(text) && /transport_type_id/i.test(text)) throw badFieldError();
        if (/INSERT INTO mt_driver/i.test(text)) return [{ insertId: 77 }];
        if (/UPDATE mt_driver SET device_id/i.test(text)) return [{ affectedRows: 1 }];
        return [[]];
      }),
    };

    const created = await createDriverSignup(pool, {
      username: 'fresh-rider',
      password: 'secret123',
      first_name: 'Fresh',
      last_name: 'Rider',
      email: 'fresh@example.com',
      phone: '09123456789',
      vehicle: 'Motorcycle',
      device_id: 'device-1',
      device_platform: 'android',
      status: 'pending',
    });

    expect(created).toEqual({
      driverId: 77,
      username: 'fresh-rider',
      status: 'pending',
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE mt_driver SET device_id = \?, device_platform = \? WHERE driver_id = \?/i),
      ['device-1', 'android', 77]
    );
  });

  test('maps signup status and success messages', () => {
    expect(normalizeRiderSignupStatus('pending')).toBe('pending');
    expect(normalizeRiderSignupStatus('weird')).toBe('active');
    expect(riderSignupSuccessMessage('inactive')).toMatch(/inactive/i);
    expect(riderSignupSuccessMessage('active')).toMatch(/log in/i);
  });
});
