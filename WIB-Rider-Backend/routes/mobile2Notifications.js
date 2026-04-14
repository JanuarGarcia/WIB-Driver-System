'use strict';

const express = require('express');
const { requireMobile2CustomerAuth } = require('../middleware/mobile2CustomerAuth');
const mobile2NotificationsController = require('../controllers/mobile2NotificationsController');

const router = express.Router();

router.get('/notifications', requireMobile2CustomerAuth, mobile2NotificationsController.list);
router.post('/notifications', requireMobile2CustomerAuth, mobile2NotificationsController.list);
router.post('/notifications/read', requireMobile2CustomerAuth, mobile2NotificationsController.markRead);
router.post('/notifications/read-all', requireMobile2CustomerAuth, mobile2NotificationsController.markReadAll);

module.exports = router;
