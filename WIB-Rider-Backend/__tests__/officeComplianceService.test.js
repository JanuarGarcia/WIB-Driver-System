jest.mock('../services/fcm', () => ({
  sendPushToDriver: jest.fn(async () => ({ success: true })),
}));

jest.mock('../services/driverRealtime', () => ({
  emitToDriver: jest.fn(),
}));

const {
  COMPLIANCE_BLOCK_MESSAGE,
  getDriverCompliance,
  setDriverCompliance,
  isComplianceBlocking,
  compliancePayloadForDriver,
} = require('../services/officeComplianceService');

const { sendPushToDriver } = require('../services/fcm');
const { emitToDriver } = require('../services/driverRealtime');

function makePoolHarness({ initialRow = null, afterRow = null } = {}) {
  const connQueries = [];
  const poolQueries = [];

  const conn = {
    beginTransaction: jest.fn(async () => {}),
    commit: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}),
    release: jest.fn(() => {}),
    query: jest.fn(async (sql, params) => {
      connQueries.push({ sql: String(sql), params });
      if (/FROM\s+mt_driver_office_compliance\s+WHERE\s+driver_id/i.test(String(sql))) {
        return [[initialRow].filter(Boolean)];
      }
      return [{ affectedRows: 1, insertId: 1 }];
    }),
  };

  const pool = {
    getConnection: jest.fn(async () => conn),
    query: jest.fn(async (sql, params) => {
      poolQueries.push({ sql: String(sql), params });
      if (/FROM\s+mt_driver_office_compliance\s+WHERE\s+driver_id/i.test(String(sql))) {
        return [[afterRow].filter(Boolean)];
      }
      return [[null]];
    }),
  };

  return { pool, conn, connQueries, poolQueries };
}

describe('officeComplianceService', () => {
  test('default compliance payload is allowed', async () => {
    const { pool } = makePoolHarness({ afterRow: null });
    const s = await getDriverCompliance(pool, 123);
    expect(isComplianceBlocking(s)).toBe(false);
    const p = compliancePayloadForDriver(s);
    expect(p.compliance_required).toBe(0);
    expect(p.compliance_status).toBe('reported');
    expect(p.compliance_message).toBe(null);
  });

  test('blocking state is detected and has message', () => {
    const s = { compliance_required: 1, compliance_status: 'not_reported' };
    expect(isComplianceBlocking(s)).toBe(true);
    const p = compliancePayloadForDriver(s);
    expect(p.compliance_message).toBe(COMPLIANCE_BLOCK_MESSAGE);
  });

  test('flag transition writes audit and triggers realtime + push', async () => {
    const { pool } = makePoolHarness({
      initialRow: null,
      afterRow: {
        compliance_required: 1,
        compliance_status: 'not_reported',
        compliance_reason: 'violation',
        compliance_note: 'test',
        flagged_at: '2026-04-16 10:00:00',
        flagged_by_label: 'Alice Admin',
      },
    });

    const r = await setDriverCompliance(
      pool,
      55,
      { action: 'flag', reason: 'violation', note: 'test', force_off_duty: true },
      { adminUser: { admin_id: 9, first_name: 'Alice', last_name: 'Admin' } }
    );

    expect(r.ok).toBe(true);
    expect(r.forced_off_duty).toBe(true);
    expect(emitToDriver).toHaveBeenCalledWith(55, 'compliance_update', expect.any(Object));
    expect(sendPushToDriver).toHaveBeenCalledWith(
      55,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ type: 'compliance_update' })
    );
  });

  test('clear transition returns allowed payload', async () => {
    const { pool } = makePoolHarness({
      initialRow: {
        compliance_required: 1,
        compliance_status: 'not_reported',
        compliance_reason: 'remittance',
      },
      afterRow: {
        compliance_required: 0,
        compliance_status: 'reported',
        compliance_reason: null,
      },
    });

    const r = await setDriverCompliance(
      pool,
      88,
      { action: 'clear', note: 'settled', force_off_duty: false },
      { adminUser: { admin_id: 1, username: 'ops' } }
    );

    expect(r.ok).toBe(true);
    expect(r.state.compliance_required).toBe(0);
    expect(r.state.compliance_status).toBe('reported');
    expect(r.state.compliance_message).toBe(null);
  });
});

