require('dotenv').config();
const app = require('./app');
const { initFirebase } = require('./services/fcm');
const { pool, errandWibPool } = require('./config/db');
const { ensureErrandProofTable } = require('./lib/errandProof');
const { ensureDashboardRiderNotificationTables } = require('./lib/ensureDashboardRiderNotifications');

const PORT = process.env.PORT || 3000;

initFirebase();

async function start() {
  try {
    await ensureErrandProofTable(errandWibPool);
  } catch (e) {
    console.warn('[errand] could not ensure st_driver_errand_photo:', e.message || e);
  }

  try {
    await ensureDashboardRiderNotificationTables(pool);
  } catch (e) {
    console.warn('[dashboard] could not ensure mt_dashboard_rider_notification:', e.message || e);
  }

  app.listen(PORT, () => {
    console.log(`WIB Rider Backend listening on http://localhost:${PORT}`);
    console.log(`  Driver API: http://localhost:${PORT}/driver/api`);
    console.log(`  Rider devices: http://localhost:${PORT}/api/riders/devices/...`);
    console.log(`  Admin API:  http://localhost:${PORT}/admin/api`);
  });
}

start();
