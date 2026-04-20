'use strict';

const express = require('express');
const router = express.Router();
const { requireRiderAuth } = require('../middleware/riderAuth');
const riderDeviceController = require('../controllers/riderDeviceController');

router.post('/devices/register', requireRiderAuth, riderDeviceController.register);
router.post('/devices/unregister', requireRiderAuth, riderDeviceController.unregister);
router.post('/tasks/reassign', requireRiderAuth, riderDeviceController.reassignTask);

module.exports = router;
