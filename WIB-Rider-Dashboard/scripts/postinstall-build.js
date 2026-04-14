'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.env.SKIP_DASHBOARD_BUILD === '1') {
  console.log('[wib-rider-dashboard] SKIP_DASHBOARD_BUILD=1 — skipping client build.');
  process.exit(0);
}

const root = path.join(__dirname, '..');
if (!fs.existsSync(path.join(root, 'client', 'package.json'))) {
  process.exit(0);
}

console.log('[wib-rider-dashboard] postinstall: running npm run build (client/dist)...');
const result = spawnSync('npm run build', {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === 0 ? 0 : result.status || 1);
