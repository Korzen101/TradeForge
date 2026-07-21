// Settings store: JSON file in Electron userData, with secrets encrypted
// via OS-level encryption (DPAPI on Windows) using Electron safeStorage.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const SECRET_FIELDS = ['paperKey', 'paperSecret', 'liveKey', 'liveSecret', 'emailPass'];
const ENC_PREFIX = 'enc:v1:';

const DEFAULTS = {
  mode: 'paper', // 'paper' | 'live'
  liveArmed: false, // user must explicitly confirm live trading
  acknowledgedRisk: false,
  secrets: {}, // encrypted at rest; never sent to renderer
  watchlist: [
    { symbol: 'SPY', enabled: true },
    { symbol: 'QQQ', enabled: true },
    { symbol: 'AAPL', enabled: true },
    { symbol: 'MSFT', enabled: true },
    { symbol: 'NVDA', enabled: true },
    { symbol: 'AMZN', enabled: true },
    { symbol: 'META', enabled: true },
    { symbol: 'TSLA', enabled: false },
    { symbol: 'AMD', enabled: false },
    { symbol: 'GOOGL', enabled: false }
  ],
  strategy: {
    active: 'bollinger_reversion',
    params: {} // { strategyId: { key: value } } overrides
  },
  engine: {
    timeframe: '5Min', // 1Min | 5Min | 15Min
    pollSec: 30,
    marketHoursOnly: true,
    flattenBeforeCloseMin: 10, // 0 = disabled (hold through close)
    schedule: {
      enabled: false, // auto start/stop the engine daily (Eastern Time)
      start: '09:30',
      end: '16:00'
    }
  },
  risk: {
    sizingMode: 'fixed', // 'fixed' ($ per trade) | 'pctEquity' | 'riskBased'
    positionValue: 1000,
    pctEquity: 5,
    riskPerTrade: 50, // $ lost if the stop is hit (riskBased sizing)
    maxOpenPositions: 3,
    maxTradesPerDay: 8,
    dailyLossLimit: 300, // $; 0 = disabled
    haltAction: 'flatten', // 'flatten' | 'holdOnly' when daily loss limit hit
    exitStyle: 'fixed', // 'fixed' (bracket TP+SL) | 'trailing' (trailing stop)
    entryOrderType: 'limit', // 'limit' (marketable limit) | 'market'
    limitBufferPct: 0.15, // limit price = ask * (1 + buffer)
    maxVolumePct: 0.5, // cap position at % of avg daily volume; 0 = off
    stopLossPct: 1.0,
    takeProfitPct: 2.0,
    trailPercent: 1.5,
    maxHoldMin: 0, // time-based exit; 0 = off
    avoidEarnings: true,
    cooldownMin: 15,
    respectPDT: true
  },
  notifications: {
    enabled: true,
    onTradeOpened: false,
    onTradeClosed: true,
    onHalt: true,
    onError: false
  },
  app: {
    trayMode: false, // keep running in the system tray when the window closes
    launchAtLogin: false // start TradeForge when Windows starts
  },
  wizardDone: false,
  updates: {
    auto: true,
    feedUrl: '' // generic static-host URL containing latest.yml + installer
  },
  backtest: {
    days: 60,
    slippagePct: 0.02,
    startEquity: 100000
  },
  email: {
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    user: '',
    from: '',
    to: '',
    perTrade: true,
    dailySummary: true,
    summaryTime: '16:15' // local time HH:MM
  }
};

let filePath = null;
let cache = null;

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = Array.isArray(base) ? {} : { ...(base || {}) };
    for (const k of Object.keys(patch)) out[k] = deepMerge(base ? base[k] : undefined, patch[k]);
    return out;
  }
  return patch === undefined ? base : patch;
}

function load() {
  if (cache) return cache;
  filePath = path.join(app.getPath('userData'), 'settings.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Successful parse -> stash a known-good backup for corruption recovery.
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) {}
  } catch (e) {
    // Corrupt or missing; try the backup before falling back to defaults.
    try {
      saved = JSON.parse(fs.readFileSync(filePath + '.bak', 'utf8'));
      logger.error('store', 'settings.json unreadable — recovered from backup: ' + e.message);
    } catch (_) { /* true first run */ }
  }
  cache = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), saved);
  return cache;
}

function persist() {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function get() {
  return load();
}

// Partial deep-merge update. Secrets are ignored here; use setSecret.
function update(patch) {
  load();
  if (patch && patch.secrets) delete patch.secrets;
  cache = deepMerge(cache, patch);
  persist();
  return cache;
}

function encryptValue(plain) {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
  }
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
}

// Fields whose stored ciphertext exists but no longer decrypts (e.g. the
// Windows encryption context changed). Surfaced to the UI so the user gets
// told to re-enter keys instead of silently seeing empty fields.
let unreadableSecrets = [];

function decryptValue(stored, field) {
  if (!stored) return '';
  try {
    if (stored.startsWith(ENC_PREFIX)) {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    }
  } catch (e) {
    if (field && !unreadableSecrets.includes(field)) {
      unreadableSecrets.push(field);
      logger.error('store', `stored secret "${field}" failed to decrypt — re-entry required: ${e.message}`);
    }
    return '';
  }
  return '';
}

function setSecret(field, value) {
  if (!SECRET_FIELDS.includes(field)) throw new Error('Unknown secret field: ' + field);
  load();
  cache.secrets[field] = value ? encryptValue(String(value)) : '';
  // Round-trip verify so a broken write is caught at save time, not weeks later.
  if (value) {
    const back = decryptValue(cache.secrets[field], null);
    if (back !== String(value)) {
      logger.error('store', `secret "${field}" failed round-trip verification after encrypt`);
      throw new Error('Key could not be stored securely on this system — please try again');
    }
  }
  unreadableSecrets = unreadableSecrets.filter((f) => f !== field);
  persist();
}

function getSecret(field) {
  load();
  return decryptValue(cache.secrets[field] || '', field);
}

// Safe view for the renderer: secrets replaced with { set, last4 }.
function getPublic() {
  const s = JSON.parse(JSON.stringify(load()));
  const view = {};
  for (const f of SECRET_FIELDS) {
    const plain = getSecret(f);
    view[f] = { set: !!plain, last4: plain ? plain.slice(-4) : '' };
  }
  s.secrets = view;
  s.encryptionAvailable = safeStorage.isEncryptionAvailable();
  s.unreadableSecrets = unreadableSecrets.slice();
  return s;
}

function dataDir() {
  return app.getPath('userData');
}

// Write the in-memory settings to disk (called on app quit as a safety net;
// every update() already persists immediately).
function flush() {
  if (cache && filePath) persist();
}

// Paper and live each keep their own strategy, engine, risk, and watchlist.
// Switching modes snapshots the outgoing mode's values and restores the
// incoming mode's saved profile (first switch seeds the new mode from the
// current values). API keys and email settings are account-level and shared.
function switchMode(newMode) {
  load();
  const oldMode = cache.mode;
  if (newMode === oldMode) return cache;
  cache.profiles = cache.profiles || {};
  cache.profiles[oldMode] = {
    strategy: cache.strategy,
    engine: cache.engine,
    risk: cache.risk,
    watchlist: cache.watchlist
  };
  const incoming = cache.profiles[newMode];
  if (incoming) {
    // Merge over defaults so profiles saved by older versions gain any
    // newly-added settings instead of dropping them.
    const base = JSON.parse(JSON.stringify(DEFAULTS));
    cache.strategy = deepMerge(base.strategy, incoming.strategy);
    cache.engine = deepMerge(base.engine, incoming.engine);
    cache.risk = deepMerge(base.risk, incoming.risk);
    cache.watchlist = Array.isArray(incoming.watchlist) ? incoming.watchlist : base.watchlist;
  }
  cache.mode = newMode;
  persist();
  return cache;
}

// Reset everything to defaults, preserving API keys / email password and the
// one-time risk acknowledgment.
function reset() {
  load();
  const keepSecrets = cache.secrets || {};
  const keepAck = !!cache.acknowledgedRisk;
  cache = JSON.parse(JSON.stringify(DEFAULTS));
  cache.secrets = keepSecrets;
  cache.acknowledgedRisk = keepAck;
  persist();
  return cache;
}

module.exports = { get, getPublic, update, setSecret, getSecret, dataDir, flush, reset, switchMode, DEFAULTS };
