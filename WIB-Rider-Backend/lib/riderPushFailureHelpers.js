'use strict';

const { pool } = require('../config/db');

/** FCM / HTTP token errors that mean the registration token should be retired. */
function isInvalidFcmRegistrationError(err) {
  const msg = String(err && err.message ? err.message : err || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('registration-token-not-registered') ||
    msg.includes('invalid registration') ||
    msg.includes('requested entity was not found') ||
    msg.includes('not a valid fcm registration token')
  );
}

/**
 * Disable a rider FCM row when the token is permanently invalid (mirrors customer/driver helpers).
 * @param {number} driverId
 * @param {string} deviceId
 * @param {unknown} err
 */
async function maybeDisableBadRiderToken(driverId, deviceId, err) {
  if (!driverId || !deviceId) return;
  if (!isInvalidFcmRegistrationError(err)) return;
  try {
    await pool.query(
      `UPDATE mt_rider_device_reg
       SET push_enabled = 0,
           is_active = 0,
           revoked_at = NOW(),
           revoked_reason = 'invalid_push_token',
           date_modified = CURRENT_TIMESTAMP
       WHERE driver_id = ? AND device_id = ?`,
      [driverId, String(deviceId).trim()]
    );
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        await pool.query(
          'UPDATE mt_rider_device_reg SET push_enabled = 0, date_modified = CURRENT_TIMESTAMP WHERE driver_id = ? AND device_id = ?',
          [driverId, String(deviceId).trim()]
        );
        return;
      } catch (e2) {
        if (e2.code === 'ER_NO_SUCH_TABLE') return;
        console.warn('maybeDisableBadRiderToken', e2.message || e2);
        return;
      }
    }
    if (e.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('maybeDisableBadRiderToken', e.message || e);
    }
  }
}

module.exports = { maybeDisableBadRiderToken, isInvalidFcmRegistrationError };
