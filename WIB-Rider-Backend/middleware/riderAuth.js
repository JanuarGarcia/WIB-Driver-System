'use strict';

const { validateApiKey, resolveDriver } = require('./auth');

/**
 * Same verification as /driver/api JSON routes: api_key + session token → mt_driver.
 * Sets `req.rider = { driverId }` for rider-device and future /api/riders handlers.
 */
function requireRiderAuth(req, res, next) {
  validateApiKey(req, res, () => {
    resolveDriver(req, res, () => {
      req.rider = {
        driverId: req.driver.id,
        authToken: req.driverAuthToken || null,
        session: req.driverSession || null,
      };
      next();
    });
  });
}

module.exports = { requireRiderAuth };
