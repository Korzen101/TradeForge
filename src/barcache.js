// Local cache for historical bars so repeated backtests don't re-download the
// same data. Past bars never change, so entries are valid for 12h (to pick up
// the newest session) and files older than 7 days are deleted.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const TTL_MS = 12 * 3600 * 1000;
const RETENTION_MS = 7 * 24 * 3600 * 1000;

function dir() {
  const d = path.join(app.getPath('userData'), 'cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileFor(tf, sym) {
  return path.join(dir(), `bars-${tf}-${sym}.json`);
}

function get(tf, sym, startIso) {
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(tf, sym), 'utf8'));
    if (Date.now() - j.fetchedAt > TTL_MS) return null;
    if (j.startIso > startIso) return null; // cached window starts too late
    return j.bars.filter((b) => b.t >= startIso);
  } catch (_) {
    return null;
  }
}

function put(tf, sym, startIso, bars) {
  try {
    fs.writeFileSync(fileFor(tf, sym), JSON.stringify({
      fetchedAt: Date.now(), startIso, bars: bars || []
    }));
  } catch (e) {
    logger.debug('barcache', 'write failed: ' + e.message);
  }
}

function cleanup() {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    for (const name of fs.readdirSync(dir())) {
      if (!/^bars-.*\.json$/.test(name)) continue;
      const full = path.join(dir(), name);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch (_) {}
    }
  } catch (_) {}
}

module.exports = { get, put, cleanup };
