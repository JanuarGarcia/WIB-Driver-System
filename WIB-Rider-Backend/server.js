require('dotenv').config();
const app = require('./app');
const { initFirebase } = require('./services/fcm');
const { errandWibPool } = require('./config/db');
const { ensureErrandProofTable } = require('./lib/errandProof');

const PORT = process.env.PORT || 3000;

initFirebase();

async function start() {
  try {
    await ensureErrandProofTable(errandWibPool);
  } catch (e) {
    console.warn('[errand] could not ensure st_driver_errand_photo:', e.message || e);
  }

  app.listen(PORT, () => {
    console.log(`WIB Rider Backend listening on http://localhost:${PORT}`);
    console.log(`  Driver API: http://localhost:${PORT}/driver/api`);
    console.log(`  Admin API:  http://localhost:${PORT}/admin/api`);
  });
}

start();
