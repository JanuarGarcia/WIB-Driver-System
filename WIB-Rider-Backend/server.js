require('dotenv').config();
const app = require('./app');
const { initFirebase } = require('./services/fcm');

const PORT = process.env.PORT || 3000;

initFirebase();

app.listen(PORT, () => {
  console.log(`WIB Rider Backend listening on http://localhost:${PORT}`);
  console.log(`  Driver API: http://localhost:${PORT}/driver/api`);
  console.log(`  Admin API:  http://localhost:${PORT}/admin/api`);
});
