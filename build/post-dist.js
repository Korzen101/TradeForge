// Runs after `npm run dist`: copies the freshly built installer for the
// CURRENT version to the Desktop and removes stale older-version copies,
// so the shareable installer there is always the latest.
const fs = require('fs');
const path = require('path');
const os = require('os');

const version = require('../package.json').version;
const dist = path.join(__dirname, '..', 'dist');
const name = `TradeForge Setup ${version}.exe`;
const src = path.join(dist, name);
if (!fs.existsSync(src)) {
  console.log(`post-dist: ${name} not found in dist/`);
  process.exit(0);
}
const desktop = path.join(os.homedir(), 'Desktop');
try {
  // Remove outdated installer copies from the Desktop first.
  for (const f of fs.readdirSync(desktop)) {
    if (/^TradeForge Setup .*\.exe$/.test(f) && f !== name) {
      try {
        fs.rmSync(path.join(desktop, f));
        console.log('post-dist: removed stale ' + f);
      } catch (_) {}
    }
  }
  fs.copyFileSync(src, path.join(desktop, name));
  console.log('post-dist: installer copied to ' + path.join(desktop, name));
} catch (e) {
  console.log('post-dist: copy failed — ' + e.message);
}
