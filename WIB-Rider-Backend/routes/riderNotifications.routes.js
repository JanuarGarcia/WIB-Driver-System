const express = require('express');
const { attachRiderIdFromAdmin } = require('../middleware/riderNotificationAuth');
const ctrl = require('../controllers/riderNotifications.controller');

const router = express.Router();

router.use(attachRiderIdFromAdmin);

router.get('/rider/notifications', ctrl.list);
router.post('/rider/notifications/mark-viewed', express.json(), ctrl.markViewed);
router.post('/dev/create-notification', express.json(), ctrl.devCreate);

module.exports = router;
