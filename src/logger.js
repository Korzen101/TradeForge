// Technical file logger for troubleshooting. Writes daily files to
// <userData>/logs/tradeforge-YYYY-MM-DD.log and cleans up after itself:
// files older than RETENTION_DAYS are deleted, and a runaway day is capped
// at MAX_FILE_BYTES (rotated once to *.overflow.log).
// Never log secrets: no API keys, no passwords, no auth headers.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 7;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

let dir = null;
let stream = null;
let streamDate = '';
let writesSinceSizeCheck = 0;

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fileFor(date) {
  return path.join(dir, `tradeforge-${date}.log`);
}

function init() {
  dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  cleanup();
  // Re-run retention cleanup periodically for long-running sessions.
  setInterval(cleanup, 6 * 3600 * 1000).unref();
}

function cleanup() {
  if (!dir) return;
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^tradeforge-.*\.log$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_) { /* file busy; next pass gets it */ }
    }
  } catch (_) { /* logging must never break the app */ }
}

function ensureStream() {
  const today = localDate();
  if (stream && streamDate === today) {
    // Occasionally enforce the per-day size cap.
    if (++writesSinceSizeCheck >= 200) {
      writesSinceSizeCheck = 0;
      try {
        const f = fileFor(today);
        if (fs.existsSync(f) && fs.statSync(f).size > MAX_FILE_BYTES) {
          stream.end();
          stream = null;
          const overflow = path.join(dir, `tradeforge-${today}.overflow.log`);
          try { fs.rmSync(overflow, { force: true }); } catch (_) {}
          fs.renameSync(f, overflow);
        }
      } catch (_) {}
    }
    if (stream) return;
  }
  if (stream) { try { stream.end(); } catch (_) {} }
  streamDate = today;
  stream = fs.createWriteStream(fileFor(today), { flags: 'a' });
}

function write(level, source, msg, detail) {
  if (!dir) return; // not initialized yet
  try {
    ensureStream();
    let line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] [${source}] ${msg}`;
    if (detail !== undefined) {
      try { line += ' | ' + JSON.stringify(detail); } catch (_) {}
    }
    stream.write(line + '\n');
  } catch (_) { /* never throw from the logger */ }
}

const info = (source, msg, detail) => write('info', source, msg, detail);
const warn = (source, msg, detail) => write('warn', source, msg, detail);
const error = (source, msg, detail) => write('error', source, msg, detail);
const debug = (source, msg, detail) => write('debug', source, msg, detail);

function getDir() { return dir; }

module.exports = { init, info, warn, error, debug, getDir };
