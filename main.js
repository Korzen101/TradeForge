const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Pin the settings location explicitly so every way of launching the app —
// desktop shortcut, exe double-click, dev mode, future renames — resolves the
// exact same folder instead of deriving it from the app name.
app.setPath('userData', path.join(app.getPath('appData'), 'TradeForge'));

const store = require('./src/store');
const alpaca = require('./src/alpaca');
const engine = require('./src/engine');
const strategies = require('./src/strategies');
const tradelog = require('./src/tradelog');
const mailer = require('./src/mailer');
const logger = require('./src/logger');
const notify = require('./src/notify');
const earnings = require('./src/earnings');
const backtest = require('./src/backtest');
const updater = require('./src/updater');

// A trading app should log crashes and keep running rather than vanish.
process.on('uncaughtException', (e) => {
  logger.error('process', 'uncaughtException: ' + (e && e.message), { stack: e && e.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection: ' + (reason && reason.message ? reason.message : String(reason)));
});

const SMOKE = process.argv.includes('--smoke');
let win = null;
let tray = null;
let appQuitting = false;

function broadcast(channel, data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('push', { channel, data });
  }
  if (channel === 'status' && tray) updateTrayMenu(data);
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

// ---------- system tray ----------

function updateTrayMenu(status) {
  if (!tray) return;
  const st = status || engine.statusPayload();
  const modeLabel = (st.mode || 'paper').toUpperCase();
  tray.setToolTip(`TradeForge — engine ${st.running ? 'RUNNING' : 'stopped'} (${modeLabel})`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Engine: ${st.running ? 'running' : 'stopped'} · ${modeLabel}`, enabled: false },
    { type: 'separator' },
    { label: 'Open TradeForge', click: showWindow },
    {
      label: st.running ? 'Stop engine' : 'Start engine',
      click: async () => {
        try {
          if (engine.isRunning()) engine.stop();
          else await engine.start();
        } catch (e) {
          notify.show(null, 'Engine', e.message);
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit TradeForge', click: () => { appQuitting = true; app.quit(); } }
  ]));
}

function syncTray() {
  const wanted = !!store.get().app.trayMode;
  if (wanted && !tray) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
      tray = new Tray(img);
      tray.on('double-click', showWindow);
      updateTrayMenu();
    } catch (e) {
      logger.warn('tray', 'could not create tray icon: ' + e.message);
    }
  } else if (!wanted && tray) {
    tray.destroy();
    tray = null;
  }
}

// Keep Windows' "start at login" registration in sync with the setting.
function syncLoginItem() {
  if (!app.isPackaged) return; // never register the dev runner
  try {
    app.setLoginItemSettings({
      openAtLogin: !!store.get().app.launchAtLogin,
      path: process.execPath,
      args: ['--hidden']
    });
  } catch (e) {
    logger.warn('app', 'login item sync failed: ' + e.message);
  }
}

const START_HIDDEN = process.argv.includes('--hidden');

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    show: !SMOKE && !(START_HIDDEN && store.get().app.trayMode),
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    title: 'TradeForge',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links never open windows inside the app — they go to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Auto-launched at login without tray mode: start minimized, not hidden.
  if (START_HIDDEN && !SMOKE && !store.get().app.trayMode) {
    win.minimize();
  }

  // Crash guard: if the UI process dies, reload it — the engine (main
  // process) keeps trading through it either way.
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('app', 'renderer process gone: ' + (details && details.reason));
    if (details && details.reason !== 'clean-exit' && win && !win.isDestroyed()) {
      setTimeout(() => { try { win.reload(); } catch (_) {} }, 1000);
    }
  });
  win.on('unresponsive', () => logger.warn('app', 'window unresponsive'));

  // Tray mode: closing the window hides it and the engine keeps running.
  win.on('close', (e) => {
    if (store.get().app.trayMode && !appQuitting && !SMOKE) {
      e.preventDefault();
      win.hide();
      notify.show(null, 'TradeForge is still running',
        'Minimized to the system tray. Right-click the tray icon to quit.');
    }
  });

  // Mirror renderer errors into the technical log (Electron has emitted both
  // signatures for this event across versions).
  win.webContents.on('console-message', (_e, levelOrDetails, message) => {
    const isObj = typeof levelOrDetails === 'object' && levelOrDetails !== null;
    const lvl = isObj ? levelOrDetails.level : levelOrDetails;
    const msg = isObj ? levelOrDetails.message : message;
    if (lvl === 'error' || lvl === 3) logger.error('renderer', String(msg));
  });

  if (SMOKE) {
    const errors = [];
    win.webContents.on('console-message', (event, levelOrDetails, message) => {
      if (typeof levelOrDetails === 'object' && levelOrDetails !== null) {
        if (levelOrDetails.level === 'error') errors.push(levelOrDetails.message);
      } else if (levelOrDetails >= 3) {
        errors.push(message);
      }
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log('SMOKE_FAIL load: ' + code + ' ' + desc);
      app.exit(1);
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        if (errors.length) {
          console.log('SMOKE_FAIL\n' + errors.join('\n'));
          app.exit(1);
        } else {
          console.log('SMOKE_OK');
          app.exit(0);
        }
      }, 4000);
    });
  }
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload) };
    } catch (e) {
      logger.warn('ipc', `${channel} failed: ${e.message || e}`);
      return { ok: false, error: e.message || String(e) };
    }
  });
}

handle('settings:get', () => store.getPublic());
handle('settings:reset', () => {
  store.reset();
  logger.info('settings', 'all settings reset to defaults');
  broadcast('status', engine.statusPayload());
  return store.getPublic();
});
handle('settings:update', (patch) => {
  patch = patch || {};
  // store.get() returns the live cache object, so capture the primitive now.
  const fromMode = store.get().mode;
  // Mode switches swap the per-mode profile (strategy/engine/risk/watchlist)
  // and always stop the engine first so it can't trade the wrong account.
  if (patch.mode && patch.mode !== fromMode) {
    if (engine.isRunning()) {
      engine.stop();
      logger.info('engine', 'stopped automatically due to mode switch');
    }
    store.switchMode(patch.mode);
    logger.info('settings', `mode switched ${fromMode} -> ${patch.mode}`);
    delete patch.mode;
  }
  store.update(patch);
  // Leaving live mode always disarms it; entering live requires explicit arm.
  if (store.get().mode !== 'live' && store.get().liveArmed) {
    store.update({ liveArmed: false });
  }
  syncTray();
  syncLoginItem();
  broadcast('status', engine.statusPayload());
  return store.getPublic();
});
handle('secrets:set', ({ field, value }) => {
  store.setSecret(field, value || '');
  return store.getPublic();
});

handle('conn:test', async ({ mode }) => {
  const acct = await alpaca.getAccount(mode);
  return {
    accountNumber: acct.account_number,
    status: acct.status,
    equity: acct.equity,
    currency: acct.currency,
    patternDayTrader: acct.pattern_day_trader
  };
});

handle('account:get', () => alpaca.getAccount(store.get().mode));
handle('account:history', async () => {
  const mode = store.get().mode;
  if (!alpaca.hasKeys(mode)) return null;
  return alpaca.getPortfolioHistory(mode, '3M');
});
handle('positions:get', () => alpaca.getPositions(store.get().mode));
handle('clock:get', () => alpaca.getClock(store.get().mode));
handle('position:close', ({ symbol }) => engine.manualClose(symbol));
handle('positions:closeAll', () => engine.manualCloseAll());

handle('watchlist:validate', async ({ symbol }) => {
  const asset = await alpaca.getAsset(store.get().mode, symbol);
  if (!asset.tradable) throw new Error(`${symbol.toUpperCase()} is not tradable on Alpaca`);
  return { symbol: asset.symbol, name: asset.name, exchange: asset.exchange };
});
handle('snapshots:get', async () => {
  const s = store.get();
  const symbols = s.watchlist.map((w) => w.symbol);
  if (!symbols.length || !alpaca.hasKeys(s.mode)) return {};
  return alpaca.getSnapshots(s.mode, symbols);
});

handle('strategies:list', () => strategies.list());

handle('scanner:get', async () => {
  const mode = store.get().mode;
  const [movers, actives] = await Promise.all([
    alpaca.getMovers(mode).catch((e) => ({ error: e.message })),
    alpaca.getMostActives(mode).catch((e) => ({ error: e.message }))
  ]);
  return { movers, actives, at: new Date().toISOString() };
});

handle('trades:note', ({ id, note }) => tradelog.setNote(id, String(note || '').slice(0, 300)));

handle('news:get', async ({ symbol } = {}) => {
  const mode = store.get().mode;
  let symbols;
  if (symbol) {
    const s = String(symbol).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) throw new Error('Enter a valid ticker symbol (e.g. AAPL)');
    symbols = s;
  }
  const res = await alpaca.getNews(mode, { symbols, limit: 30 });
  return { news: (res && res.news) || [], symbol: symbols || null, at: new Date().toISOString() };
});

handle('engine:start', () => engine.start());
handle('engine:stop', () => engine.stop());
handle('engine:status', () => engine.statusPayload());
handle('logs:get', () => engine.getLogs());

handle('trades:list', ({ fromMs, toMs, symbol } = {}) =>
  tradelog.listClosed({ fromMs: fromMs || 0, toMs: toMs || Infinity, symbol: symbol || null })
    .sort((a, b) => Date.parse(b.exitTime) - Date.parse(a.exitTime)));
handle('trades:stats', ({ fromMs, toMs, symbol } = {}) =>
  tradelog.stats({ fromMs: fromMs || 0, toMs: toMs || Infinity, symbol: symbol || null }));
handle('trades:clear', () => tradelog.clearAll());
handle('trades:export', async ({ fromMs, toMs, symbol } = {}) => {
  const trades = tradelog.listClosed({ fromMs: fromMs || 0, toMs: toMs || Infinity, symbol: symbol || null });
  const res = await dialog.showSaveDialog(win, {
    title: 'Export trades',
    defaultPath: 'tradeforge-trades.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return { exported: 0 };
  fs.writeFileSync(res.filePath, tradelog.toCsv(trades), 'utf8');
  return { exported: trades.length, path: res.filePath };
});

handle('email:test', () => mailer.sendTest());
handle('email:summaryNow', () => engine.sendSummaryNow());

handle('backtest:run', (cfg) => {
  if (backtest.isRunning()) throw new Error('A backtest is already running');
  backtest.run(cfg || {}, (evt) => broadcast('bt', evt))
    .then((result) => broadcast('bt', { type: 'done', result }))
    .catch((e) => {
      if (e.message !== 'cancelled') logger.warn('backtest', e.message);
      broadcast('bt', { type: e.message === 'cancelled' ? 'cancelled' : 'error', msg: e.message });
    });
  return { started: true };
});
handle('backtest:cancel', () => backtest.cancel());
handle('backtest:export', async (result) => {
  const isOptimize = result && result.mode === 'optimize';
  if (!result || (!isOptimize && (!Array.isArray(result.results) || !result.results.length))) {
    throw new Error('No backtest result to export — run a backtest first');
  }
  const res = await dialog.showSaveDialog(win, {
    title: 'Export backtest results',
    defaultPath: 'tradeforge-backtest.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return { exported: false };
  const cfg = result.config || {};
  const lines = [
    'TradeForge Backtest Export' + (isOptimize ? ' (parameter optimization)' : ''),
    'Generated,' + new Date().toISOString(),
    `Window,${cfg.days} days,Timeframe,${cfg.timeframe}`,
    `Symbols,"${(cfg.symbols || []).join(' ')}"`,
    `Slippage % per side,${cfg.slippagePct},Starting equity,${cfg.startEquity}`,
    ''
  ];
  if (isOptimize) {
    const fp = (p) => '"' + Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ') + '"';
    const st = (x) => [x.count, x.winRate, x.profitFactor === Infinity ? 'inf' : x.profitFactor, x.totalPl, x.maxDrawdown].join(',');
    lines.push(`Strategy,"${result.strategyName}"`, `Split at,${result.splitAt}`, `Verdict,"${result.verdict}"`, '',
      'Set,Parameters,In/Out,Trades,Win %,Profit Factor,Net P/L,Max Drawdown',
      `Best,${fp(result.best.params)},in-sample,${st(result.best.inStats)}`,
      `Best,${fp(result.best.params)},out-of-sample,${st(result.best.outStats)}`,
      `Current,${fp(result.baseline.params)},in-sample,${st(result.baseline.inStats)}`,
      `Current,${fp(result.baseline.params)},out-of-sample,${st(result.baseline.outStats)}`, '',
      'Rank,Parameters,Trades,Win %,Profit Factor,Net P/L,Max Drawdown');
    result.grid.forEach((g, i) => lines.push(`${i + 1},${fp(g.params)},${st(g.stats)}`));
    fs.writeFileSync(res.filePath, lines.join('\n'), 'utf8');
    return { exported: true, path: res.filePath };
  }
  lines.push('Strategy,Net P/L,Trades,Wins,Losses,Win %,Profit Factor,Max Drawdown,Avg Win,Avg Loss,Avg Hold (min)');
  for (const r of result.results) {
    const s = r.stats;
    const pf = s.profitFactor === Infinity || s.profitFactor > 1e8 ? 'inf' : s.profitFactor;
    lines.push([`"${r.strategyName}"`, s.totalPl, s.count, s.wins, s.losses, s.winRate,
      pf, s.maxDrawdown, s.avgWin, s.avgLoss, s.avgHoldMin ?? ''].join(','));
  }
  lines.push('', 'Strategy,Symbol,Qty,Entry Time,Entry,Exit Time,Exit,P/L $,P/L %,Held (min),Exit Reason');
  for (const r of result.results) {
    for (const t of r.trades || []) {
      lines.push([`"${r.strategyName}"`, t.symbol, t.qty, t.entryTime, t.entryPrice,
        t.exitTime, t.exitPrice, t.pl, t.plPct, t.holdMin ?? '',
        '"' + String(t.exitReason || '').replace(/"/g, "'") + '"'].join(','));
    }
  }
  fs.writeFileSync(res.filePath, lines.join('\n'), 'utf8');
  return { exported: true, path: res.filePath };
});

handle('update:check', () => updater.check());
handle('update:install', () => updater.install());
handle('update:state', () => updater.getState());

// "Am I ready for live?" — honest thresholds over the last 30 days of paper.
handle('readiness:get', () => {
  const fromMs = Date.now() - 30 * 24 * 3600e3;
  const trades = tradelog.listClosed({ fromMs }).filter((t) => t.mode === 'paper');
  const wins = trades.filter((t) => t.pl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pl <= 0).reduce((s, t) => s + t.pl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const totalPl = trades.reduce((s, t) => s + t.pl, 0);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades.slice().sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime))) {
    cum += t.pl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  const tradingDays = new Set(trades.map((t) => String(t.exitTime).slice(0, 10))).size;
  const lossLimit = store.get().risk.dailyLossLimit || 300;
  const ddCap = Math.max(500, 5 * lossLimit);
  return {
    window: '30 days (paper trades)',
    checks: [
      { name: 'Sample size', pass: trades.length >= 60, detail: `${trades.length} closed trades — need 60+ for the stats to mean anything` },
      { name: 'Trading days', pass: tradingDays >= 20, detail: `${tradingDays} distinct days — need 20+ to cover varied market conditions` },
      { name: 'Profitable overall', pass: totalPl > 0, detail: `net P/L ${totalPl >= 0 ? '+' : ''}$${totalPl.toFixed(2)}` },
      { name: 'Profit factor ≥ 1.3', pass: pf >= 1.3, detail: `profit factor ${pf === Infinity ? '∞' : pf.toFixed(2)} — wins must outweigh losses with margin` },
      { name: 'Drawdown contained', pass: maxDD <= ddCap, detail: `worst peak-to-trough $${maxDD.toFixed(2)} (cap $${ddCap})` }
    ]
  };
});

// Settings transfer between machines. Secrets never travel: API keys and the
// email password are excluded, and imports always land in disarmed paper mode.
handle('settings:exportFile', async () => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export TradeForge settings',
    defaultPath: 'tradeforge-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { exported: false };
  const s = JSON.parse(JSON.stringify(store.get()));
  delete s.secrets;
  delete s.liveArmed;
  fs.writeFileSync(res.filePath, JSON.stringify({
    app: 'TradeForge', version: app.getVersion(),
    exportedAt: new Date().toISOString(), settings: s
  }, null, 2), 'utf8');
  return { exported: true, path: res.filePath };
});
handle('settings:importFile', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import TradeForge settings',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { imported: false };
  const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
  if (!raw || raw.app !== 'TradeForge' || typeof raw.settings !== 'object') {
    throw new Error('Not a TradeForge settings file');
  }
  const incoming = raw.settings;
  delete incoming.secrets;
  incoming.mode = 'paper';       // imports always start safe
  incoming.liveArmed = false;
  if (engine.isRunning()) engine.stop();
  store.update(incoming);
  logger.info('settings', 'settings imported from file (mode forced to paper)');
  syncTray();
  return { imported: true };
});

// Support bundle: system info + recent technical logs in one text file.
handle('support:bundle', async () => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save support bundle',
    defaultPath: `tradeforge-support-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }]
  });
  if (res.canceled || !res.filePath) return { saved: false };
  const parts = [
    '==== TradeForge support bundle ====',
    'Generated: ' + new Date().toISOString(),
    `Version: ${app.getVersion()} | Electron: ${process.versions.electron} | ` +
    `Node: ${process.versions.node} | OS: ${process.platform} ${require('os').release()}`,
    'Exe: ' + process.execPath,
    'UserData: ' + app.getPath('userData'),
    ''
  ];
  try {
    const pub = store.getPublic();
    delete pub.secrets;
    parts.push('==== settings (no secrets) ====', JSON.stringify(pub, null, 2), '');
  } catch (_) {}
  try {
    const dir = logger.getDir();
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort()) {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
      parts.push(`==== ${name} (last ${Math.min(lines.length, 3000)} lines) ====`,
        lines.slice(-3000).join('\n'), '');
    }
  } catch (e) { parts.push('log read failed: ' + e.message); }
  fs.writeFileSync(res.filePath, parts.join('\n'), 'utf8');
  return { saved: true, path: res.filePath };
});

handle('app:openExternal', ({ url }) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});
handle('app:openData', () => shell.openPath(store.dataDir()));
handle('app:openLogs', () => shell.openPath(logger.getDir() || store.dataDir()));
handle('app:version', () => app.getVersion());

// ---------- lifecycle ----------

app.setAppUserModelId('com.tradeforge.app');

// Only one TradeForge at a time — a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    logger.init();
    logger.info('app', `TradeForge ${app.getVersion()} started`, {
      exe: process.execPath, cwd: process.cwd(), electron: process.versions.electron
    });

    // Record how this launch happened — makes "my settings are missing"
    // reports diagnosable after the fact.
    try {
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'last-launch.json'), JSON.stringify({
        at: new Date().toISOString(),
        exe: process.execPath,
        cwd: process.cwd(),
        version: app.getVersion(),
        userData: dir
      }, null, 2));
    } catch (_) { /* diagnostics only */ }

    engine.setBroadcaster(broadcast);
    engine.startPulse();
    notify.init(showWindow);
    updater.init((s) => broadcast('update', s));
    createWindow();
    syncTray();
    syncLoginItem();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Belt-and-braces: settings persist on every change, and once more on exit.
  app.on('before-quit', () => {
    appQuitting = true;
    try { store.flush(); } catch (_) {}
    logger.info('app', 'quit');
  });

  app.on('window-all-closed', () => {
    // Engine stops with the app; bracket orders remain protected broker-side.
    // (In tray mode the window hides instead of closing, so we never get here.)
    app.quit();
  });
}
