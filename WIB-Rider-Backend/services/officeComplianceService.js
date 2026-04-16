const { sendPushToDriver } = require('./fcm');
const { emitToDriver } = require('./driverRealtime');

const COMPLIANCE_BLOCK_MESSAGE = 'Please report to the office before resuming duty.';

const STATUS = {
  NOT_REPORTED: 'not_reported',
  REPORTED: 'reported',
};

function normalizeStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === STATUS.NOT_REPORTED ? STATUS.NOT_REPORTED : STATUS.REPORTED;
}

function normalizeRequired(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  const n = parseInt(String(raw), 10);
  if (Number.isFinite(n)) return n ? 1 : 0;
  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' ? 1 : 0;
}

function defaultComplianceState() {
  return {
    compliance_required: 0,
    compliance_status: STATUS.REPORTED,
    compliance_reason: null,
    compliance_note: null,
    flagged_at: null,
    flagged_by_admin_id: null,
    flagged_by_label: null,
    cleared_at: null,
    cleared_by_admin_id: null,
    cleared_by_label: null,
  };
}

function isComplianceBlocking(state) {
  if (!state) return false;
  return normalizeRequired(state.compliance_required) === 1 && normalizeStatus(state.compliance_status) === STATUS.NOT_REPORTED;
}

function compliancePayloadForDriver(state) {
  const s = state || defaultComplianceState();
  const required = normalizeRequired(s.compliance_required);
  const status = normalizeStatus(s.compliance_status);
  const reason = s.compliance_reason != null && String(s.compliance_reason).trim() ? String(s.compliance_reason).trim() : null;
  const note = s.compliance_note != null && String(s.compliance_note).trim() ? String(s.compliance_note).trim() : null;
  const blocking = required === 1 && status === STATUS.NOT_REPORTED;
  const message = blocking ? COMPLIANCE_BLOCK_MESSAGE : null;
  return {
    compliance_required: required,
    compliance_status: status,
    compliance_reason: reason,
    compliance_note: note,
    compliance_message: message,
    flagged_at: s.flagged_at ?? null,
    flagged_by: s.flagged_by_label ?? null,
    cleared_at: s.cleared_at ?? null,
    cleared_by: s.cleared_by_label ?? null,
  };
}

async function getDriverCompliance(pool, driverId) {
  const did = parseInt(String(driverId ?? ''), 10);
  if (!Number.isFinite(did) || did <= 0) return defaultComplianceState();
  try {
    const [[row]] = await pool.query(
      `SELECT compliance_required, compliance_status, compliance_reason, compliance_note,
              flagged_at, flagged_by_admin_id, flagged_by_label,
              cleared_at, cleared_by_admin_id, cleared_by_label
       FROM mt_driver_office_compliance
       WHERE driver_id = ?
       LIMIT 1`,
      [did]
    );
    if (!row) return defaultComplianceState();
    return {
      ...defaultComplianceState(),
      ...row,
    };
  } catch (e) {
    // Backward compatibility: if the compliance table isn't migrated yet, allow as default.
    if (e.code === 'ER_NO_SUCH_TABLE') return defaultComplianceState();
    throw e;
  }
}

function actorLabelFromAdminUser(adminUser) {
  if (!adminUser || typeof adminUser !== 'object') return null;
  const fn = adminUser.first_name != null ? String(adminUser.first_name).trim() : '';
  const ln = adminUser.last_name != null ? String(adminUser.last_name).trim() : '';
  const name = [fn, ln].filter(Boolean).join(' ').trim();
  if (name) return name;
  const u = adminUser.username != null ? String(adminUser.username).trim() : '';
  if (u) return u;
  const e = adminUser.email_address != null ? String(adminUser.email_address).trim() : '';
  return e || null;
}

/**
 * Set driver compliance and write audit trail. Also emits realtime/push updates and can force off duty.
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} driverId
 * @param {{
 *   action: 'flag'|'clear',
 *   reason?: string|null,
 *   note?: string|null,
 *   force_off_duty?: boolean,
 * }} input
 * @param {{ adminUser?: any }} ctx
 */
async function setDriverCompliance(pool, driverId, input, ctx = {}) {
  const did = parseInt(String(driverId ?? ''), 10);
  if (!Number.isFinite(did) || did <= 0) {
    return { ok: false, error: 'Invalid driver id' };
  }

  const action = String(input?.action ?? '').trim().toLowerCase();
  if (action !== 'flag' && action !== 'clear') {
    return { ok: false, error: 'Invalid action (use flag or clear)' };
  }

  const adminUser = ctx.adminUser;
  const adminIdRaw = adminUser?.admin_id ?? adminUser?.id;
  const adminId = adminIdRaw != null ? parseInt(String(adminIdRaw), 10) : null;
  const actorLabel = actorLabelFromAdminUser(adminUser) || (adminId ? `Admin #${adminId}` : 'Admin');

  const reasonRaw = input?.reason != null ? String(input.reason).trim() : '';
  const noteRaw = input?.note != null ? String(input.note).trim() : '';
  const reason = reasonRaw ? reasonRaw : null;
  const note = noteRaw ? noteRaw : null;

  if (action === 'flag') {
    if (!reason) return { ok: false, error: 'reason is required when flagging' };
  }

  const toRequired = action === 'flag' ? 1 : 0;
  const toStatus = action === 'flag' ? STATUS.NOT_REPORTED : STATUS.REPORTED;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    /** @type {any} */
    let from = null;
    try {
      const [[row]] = await conn.query(
        `SELECT compliance_required, compliance_status, compliance_reason, compliance_note
         FROM mt_driver_office_compliance
         WHERE driver_id = ?
         LIMIT 1`,
        [did]
      );
      from = row || null;
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      // Not migrated: keep transactional behavior but skip persistence.
      await conn.rollback();
      return { ok: false, error: 'Compliance tables not migrated (run SQL migration)' };
    }

    const nowCols =
      action === 'flag'
        ? {
            flagged_at: 'NOW()',
            cleared_at: 'NULL',
          }
        : {
            flagged_at: 'flagged_at',
            cleared_at: 'NOW()',
          };

    const flaggedByAdminId = action === 'flag' ? (Number.isFinite(adminId) ? adminId : null) : null;
    const clearedByAdminId = action === 'clear' ? (Number.isFinite(adminId) ? adminId : null) : null;

    const upsertSql = `
      INSERT INTO mt_driver_office_compliance
        (driver_id, compliance_required, compliance_status, compliance_reason, compliance_note,
         flagged_at, flagged_by_admin_id, flagged_by_label,
         cleared_at, cleared_by_admin_id, cleared_by_label)
      VALUES
        (?, ?, ?, ?, ?, ${nowCols.flagged_at}, ?, ?, ${nowCols.cleared_at}, ?, ?)
      ON DUPLICATE KEY UPDATE
        compliance_required = VALUES(compliance_required),
        compliance_status = VALUES(compliance_status),
        compliance_reason = VALUES(compliance_reason),
        compliance_note = VALUES(compliance_note),
        flagged_at = ${nowCols.flagged_at === 'NOW()' ? 'VALUES(flagged_at)' : 'flagged_at'},
        flagged_by_admin_id = ${action === 'flag' ? 'VALUES(flagged_by_admin_id)' : 'flagged_by_admin_id'},
        flagged_by_label = ${action === 'flag' ? 'VALUES(flagged_by_label)' : 'flagged_by_label'},
        cleared_at = ${nowCols.cleared_at === 'NOW()' ? 'VALUES(cleared_at)' : 'cleared_at'},
        cleared_by_admin_id = ${action === 'clear' ? 'VALUES(cleared_by_admin_id)' : 'cleared_by_admin_id'},
        cleared_by_label = ${action === 'clear' ? 'VALUES(cleared_by_label)' : 'cleared_by_label'}
    `;

    await conn.query(upsertSql, [
      did,
      toRequired,
      toStatus,
      reason,
      note,
      flaggedByAdminId,
      action === 'flag' ? actorLabel : null,
      clearedByAdminId,
      action === 'clear' ? actorLabel : null,
    ]);

    await conn.query(
      `INSERT INTO mt_driver_office_compliance_audit
        (driver_id, action, from_required, to_required, from_status, to_status, from_reason, to_reason, from_note, to_note,
         changed_at, changed_by_admin_id, changed_by_label)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [
        did,
        action,
        from ? normalizeRequired(from.compliance_required) : 0,
        toRequired,
        from ? normalizeStatus(from.compliance_status) : STATUS.REPORTED,
        toStatus,
        from ? (from.compliance_reason != null ? String(from.compliance_reason) : null) : null,
        reason,
        from ? (from.compliance_note != null ? String(from.compliance_note) : null) : null,
        note,
        Number.isFinite(adminId) ? adminId : null,
        actorLabel,
      ]
    );

    let forcedOffDuty = false;
    if (action === 'flag' && input?.force_off_duty !== false) {
      // Force off duty (and remove from queue) when newly flagged.
      const oldUnix = Math.floor(Date.now() / 1000) - 35 * 60;
      try {
        await conn.query('UPDATE mt_driver SET on_duty = 0, last_online = ? WHERE driver_id = ?', [oldUnix, did]);
      } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
          await conn.query('UPDATE mt_driver SET on_duty = 0 WHERE driver_id = ?', [did]);
        } else {
          throw e;
        }
      }
      forcedOffDuty = true;
      try {
        await conn.query(
          "UPDATE mt_driver_queue SET left_at = NOW(), status = 'left' WHERE driver_id = ? AND left_at IS NULL",
          [did]
        );
      } catch (_) {
        /* optional */
      }
    }

    await conn.commit();

    const state = await getDriverCompliance(pool, did);
    const payload = compliancePayloadForDriver(state);

    // Realtime (SSE) if the app has a live connection.
    emitToDriver(did, 'compliance_update', payload);

    // Push fallback (FCM)
    void sendPushToDriver(
      did,
      payload.compliance_required === 1 && payload.compliance_status === STATUS.NOT_REPORTED
        ? 'Office compliance required'
        : 'Office compliance cleared',
      payload.compliance_message || 'Your office compliance status has been updated.',
      {
        type: 'compliance_update',
        compliance_required: payload.compliance_required,
        compliance_status: payload.compliance_status,
        compliance_reason: payload.compliance_reason || '',
      }
    ).catch(() => {});

    return { ok: true, state: payload, forced_off_duty: forcedOffDuty };
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  COMPLIANCE_BLOCK_MESSAGE,
  STATUS,
  getDriverCompliance,
  setDriverCompliance,
  isComplianceBlocking,
  compliancePayloadForDriver,
};

