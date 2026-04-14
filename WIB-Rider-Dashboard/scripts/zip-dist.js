'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'client', 'dist');
const indexHtml = path.join(distDir, 'index.html');

if (!fs.existsSync(indexHtml)) {
  console.error('Missing client/dist/index.html — run npm run build first.');
  process.exit(1);
}

const outZip = path.join(root, 'rider-dashboard-dist.zip');
try {
  fs.unlinkSync(outZip);
} catch (_) {}

const distQuoted = distDir.replace(/'/g, "''");
const outQuoted = outZip.replace(/'/g, "''");

if (process.platform === 'win32') {
  const ps = `Compress-Archive -LiteralPath '${distQuoted}' -DestinationPath '${outQuoted}' -Force`;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { stdio: 'inherit', cwd: root }
  );
  if (r.status !== 0) process.exit(r.status || 1);
} else {
  const r = spawnSync('zip', ['-r', outZip, 'dist'], {
    cwd: path.join(root, 'client'),
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('zip failed. Install zip (apt install zip) or upload client/dist another way.');
    process.exit(r.status || 1);
  }
}

console.log(`Created ${outZip} — upload this one file to cPanel, then extract so you have client/dist/...`);
