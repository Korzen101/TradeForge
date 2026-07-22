// Runs after a build/release: copies the freshly built installer to the Desktop
// under a FIXED, version-free name so there is always exactly one installer
// there, always current, and always the same clean filename to hand to someone.
// Any older version-stamped copies left on the Desktop are removed.
const fs = require('fs');
const path = require('path');
const os = require('os');

const version = require('../package.json').version;
const dist = path.join(__dirname, '..', 'dist');
const builtName = `TradeForge Setup ${version}.exe`;
const src = path.join(dist, builtName);

// The single, stable name the Desktop copy always uses.
const DESKTOP_NAME = 'TradeForge Setup.exe';

if (!fs.existsSync(src)) {
  console.log(`post-dist: ${builtName} not found in dist/`);
  process.exit(0);
}

const desktop = path.join(os.homedir(), 'Desktop');
try {
  fs.copyFileSync(src, path.join(desktop, DESKTOP_NAME));
  console.log(`post-dist: installer (v${version}) copied to ${path.join(desktop, DESKTOP_NAME)}`);

  // Sweep up any version-stamped copies from older releases. The trailing
  // space in the pattern means the fixed-name copy above is never matched.
  for (const f of fs.readdirSync(desktop)) {
    if (/^TradeForge Setup .+\.exe$/.test(f)) {
      try {
        fs.rmSync(path.join(desktop, f));
        console.log('post-dist: removed old ' + f);
      } catch (_) { /* in use; harmless to leave */ }
    }
  }
} catch (e) {
  console.log('post-dist: copy failed — ' + e.message);
}
