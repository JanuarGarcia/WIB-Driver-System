/**
 * In-memory rider (dashboard admin) notifications — no DB table.
 * Single Node process only: PM2 cluster / multiple API instances each have their own empty store.
 */

const crypto = require('crypto');

/** @typedef {{ id: string, riderId: string, title: string, message: string, type: string, viewed: boolean, createdAt: Date }} RiderNotification */

/** @type {RiderNotification[]} */
let notifications = [];

function newId() {
  return `n-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * @param {string} riderId
 * @returns {RiderNotification[]}
 */
function listUnreadForRider(riderId) {
  const rid = String(riderId);
  return notifications.filter((n) => n.riderId === rid && !n.viewed);
}

/**
 * @param {string} riderId
 * @param {string[]} notificationIds
 * @returns {number}
 */
function markViewedForRider(riderId, notificationIds) {
  const rid = String(riderId);
  const want = new Set((notificationIds || []).map((x) => String(x)));
  if (want.size === 0) return 0;
  let n = 0;
  for (const row of notifications) {
    if (row.riderId === rid && want.has(String(row.id))) {
      row.viewed = true;
      n += 1;
    }
  }
  return n;
}

/**
 * @param {string} riderId
 * @param {{ title?: string, message?: string, type?: string }} payload
 * @returns {RiderNotification}
 */
function createForRider(riderId, payload) {
  const rid = String(riderId);
  const row = {
    id: newId(),
    riderId: rid,
    title: (payload?.title || 'Notification').toString().trim() || 'Notification',
    message: payload?.message != null ? String(payload.message) : '',
    type: (payload?.type || 'info').toString().trim() || 'info',
    viewed: false,
    createdAt: new Date(),
  };
  notifications.push(row);
  return row;
}

function _clearAll() {
  notifications = [];
}

module.exports = {
  listUnreadForRider,
  markViewedForRider,
  createForRider,
  _clearAll,
};
