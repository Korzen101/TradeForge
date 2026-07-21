// Trading engine: polls market data, evaluates the active strategy on each
// watchlist symbol, and places/exits orders through Alpaca with layered risk
// controls. Long-only. Every entry is a bracket order (stop-loss + take-profit
// held server-side at the broker), so positions stay protected even if this
// app or the computer goes offline.

const alpaca = require('./alpaca');
const store = require('./store');
const strategies = require('./strategies');
const tradelog = require('./tradelog');
const mailer = require('./mailer');
const logger = require('./logger');
const notify = require('./notify');
const earnings = require('./earnings');
const stream = require('./stream');

const BAR_MINUTES = { '1Min': 1, '5Min': 5, '15Min': 15 };
const HISTORY_DAYS = { '1Min': 4, '5Min': 10, '15Min': 21 };

let broadcast = () => {};
let running = false;
let timer = null;
let pulseTimer = null;
let ticking = false;
let halt = null;               // { reason, date } — no new entries today
let flattenedDate = null;      // ET date we already flattened on
let summarySentDate = null;    // local date we already emailed a summary
let lastActionTs = {};         // symbol -> ms of last entry/exit (cooldown)
let pendingExitReasons = {};   // symbol -> reason string for in-flight closes
let lastReconcileIso = null;
let lastTickInfo = { at: null, note: 'not started' };
let clockCache = { ts: 0, data: null };
let logs = [];
let signalStates = {};        // symbol -> { status, detail, price, ts }
let fillRefreshTimer = null;
let authFailed = false;       // Alpaca rejected the stored keys (401)

// ---------- helpers ----------

function setBroadcaster(fn) {
  broadcast = fn;
  stream.setHandlers({
    fill: (order) => {
      const mode = store.get().mode;
      processFill(order, mode)
        .then(() => refreshAfterFill(mode))
        .catch((e) => logger.warn('stream', 'fill processing failed: ' + e.message));
    },
    price: (symbol, price, t) => broadcast('tick', { symbol, price, t }),
    status: () => pushStatus()
  });
}

// A fill just streamed in — refresh account/positions shortly after (debounced).
function refreshAfterFill(mode) {
  if (fillRefreshTimer) return;
  fillRefreshTimer = setTimeout(async () => {
    fillRefreshTimer = null;
    try {
      broadcast('account', await alpaca.getAccount(mode));
      broadcast('positions', await alpaca.getPositions(mode));
    } catch (_) { /* next tick covers it */ }
  }, 800);
}

function syncStreams() {
  const s = store.get();
  if (alpaca.hasKeys(s.mode)) {
    stream.ensure(s.mode, s.watchlist.filter((w) => w.enabled).map((w) => w.symbol));
  } else {
    stream.stop();
  }
}

function setSignal(symbol, status, detail, price) {
  signalStates[symbol] = { status, detail, price: price ?? null, ts: new Date().toISOString() };
}

function log(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  logs.push(entry);
  if (logs.length > 500) logs = logs.slice(-500);
  broadcast('log', entry);
  // Mirror the activity feed into the technical file log.
  const fileLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn'
    : level === 'dim' ? 'debug' : 'info';
  logger[fileLevel]('engine', msg);
  if (level === 'error') notify.show('onError', 'TradeForge error', msg);
}

function getLogs() { return logs.slice(-300); }

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});

function etParts(date) {
  const parts = {};
  for (const p of ET_FMT.formatToParts(date)) parts[p.type] = p.value;
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute)
  };
}

function todayEt() { return etParts(new Date()).dateStr; }

function round2(v) { return Math.round(v * 100) / 100; }

async function getClock(mode) {
  if (Date.now() - clockCache.ts < 30000 && clockCache.data) return clockCache.data;
  const c = await alpaca.getClock(mode);
  clockCache = { ts: Date.now(), data: c };
  return c;
}

function statusPayload() {
  const s = store.get();
  const strat = strategies.getById(s.strategy.active);
  return {
    running,
    mode: s.mode,
    halted: halt,
    market: clockCache.data,
    activeStrategy: strat ? strat.name : s.strategy.active,
    lastTick: lastTickInfo,
    hasKeys: alpaca.hasKeys(s.mode),
    authFailed,
    streaming: stream.status()
  };
}

function noteAuthResult(err) {
  if (err && err.status === 401) {
    if (!authFailed) {
      authFailed = true;
      log('error', '🔑 Alpaca rejected the stored API keys (401 unauthorized). If you regenerated keys on alpaca.markets, the old ones died instantly — paste the current pair into Settings.');
      pushStatus();
    }
    return true;
  }
  return false;
}

function pushStatus() { broadcast('status', statusPayload()); }

// ---------- reconciliation (order fills -> trade log) ----------

function strategyFromClientId(clientId) {
  if (!clientId || !clientId.startsWith('tf-')) return 'manual';
  const parts = clientId.split('-');
  const strat = strategies.getById(parts[1]);
  return strat ? strat.name : 'manual';
}

async function reconcile(mode) {
  if (!lastReconcileIso) {
    lastReconcileIso = new Date(Date.now() - 24 * 3600e3).toISOString();
  }
  let orders;
  try {
    orders = await alpaca.getClosedOrdersSince(mode, lastReconcileIso);
  } catch (e) {
    log('warn', 'Order reconcile failed: ' + e.message);
    return;
  }
  const fills = (orders || [])
    .filter((o) => Number(o.filled_qty) > 0 && o.filled_at)
    .sort((a, b) => Date.parse(a.filled_at) - Date.parse(b.filled_at));

  for (const o of fills) {
    await processFill(o, mode);
    const t = Date.parse(o.filled_at);
    if (t && new Date(t + 1000).toISOString() > lastReconcileIso) {
      lastReconcileIso = new Date(t + 1000).toISOString();
    }
  }
}

// One filled order -> trade log / notifications. Fed by BOTH the REST
// reconciler and the realtime trade-updates stream; seenOrderIds dedupes.
async function processFill(o, mode) {
  if (!o || Number(o.filled_qty) <= 0 || !o.filled_at) return;
  if (tradelog.hasSeenOrder(o.id)) return;
  tradelog.markSeen(o.id);
  const px = Number(o.filled_avg_price);
  {
    if (o.side === 'buy') {
      if (!tradelog.findOpen(o.symbol)) {
        tradelog.openTrade({
          symbol: o.symbol, qty: Number(o.filled_qty), entryPrice: px,
          entryTime: o.filled_at, strategy: strategyFromClientId(o.client_order_id),
          mode, entryOrderId: o.id
        });
        log('info', `Filled BUY ${o.filled_qty} ${o.symbol} @ $${px.toFixed(2)}`);
        broadcast('trade', { kind: 'open', symbol: o.symbol });
        notify.show('onTradeOpened', `Bought ${o.filled_qty} ${o.symbol}`, `Filled at $${px.toFixed(2)}`);
        if (o.client_order_id && o.client_order_id.startsWith('tf-')) {
          ensureTrailingProtection(mode, o.symbol);
        }
      }
    } else {
      const openRec = tradelog.findOpen(o.symbol);
      if (openRec) {
        let reason = pendingExitReasons[o.symbol] || '';
        delete pendingExitReasons[o.symbol];
        if (!reason) {
          if (o.type === 'limit') reason = 'take-profit hit';
          else if (o.type === 'trailing_stop') reason = 'trailing stop hit';
          else if (o.type === 'stop' || o.type === 'stop_limit') reason = 'stop-loss hit';
          else reason = 'closed';
        }
        const closed = tradelog.closeTrade(o.symbol, {
          exitPrice: px, exitTime: o.filled_at, exitOrderId: o.id, exitReason: reason
        });
        if (closed) {
          lastActionTs[o.symbol] = Date.parse(o.filled_at) || Date.now();
          const sign = closed.pl >= 0 ? '+' : '';
          log(closed.pl >= 0 ? 'good' : 'bad',
            `Closed ${o.symbol}: SELL ${closed.qty} @ $${px.toFixed(2)} — P/L ${sign}$${closed.pl.toFixed(2)} (${reason})`);
          broadcast('trade', { kind: 'close', trade: closed });
          notify.show('onTradeClosed',
            `${closed.pl >= 0 ? '📈' : '📉'} ${o.symbol} closed: ${sign}$${closed.pl.toFixed(2)}`, reason);
          maybeEmailTrade(closed, mode);
        }
      }
    }
  }
}

function maybeEmailTrade(closed, mode) {
  const s = store.get().email;
  if (!s.enabled || !s.perTrade) return;
  mailer.sendTradeClosed(closed, mode).then(
    () => log('info', `Emailed trade report for ${closed.symbol}`),
    (e) => log('warn', 'Trade email failed: ' + e.message)
  );
}

// Adopt broker positions that we have no record of (e.g. opened manually).
function adoptPositions(positions, mode) {
  for (const p of positions) {
    if (!tradelog.findOpen(p.symbol)) {
      tradelog.openTrade({
        symbol: p.symbol, qty: Number(p.qty), entryPrice: Number(p.avg_entry_price),
        entryTime: new Date().toISOString(), strategy: 'adopted', mode, entryOrderId: null
      });
      log('info', `Adopted existing position: ${p.qty} ${p.symbol}`);
    }
  }
  // Drop stale open records with no matching broker position.
  for (const rec of tradelog.listOpen()) {
    if (!positions.find((p) => p.symbol === rec.symbol)) {
      tradelog.closeTrade(rec.symbol, {
        exitPrice: rec.entryPrice, exitTime: new Date().toISOString(),
        exitOrderId: null, exitReason: 'position closed outside app (P/L unknown)'
      });
      log('warn', `Open record for ${rec.symbol} had no broker position — archived`);
    }
  }
}

// ---------- risk checks ----------

function tradesTodayCount() {
  const today = todayEt();
  const closedToday = tradelog.listClosed({ fromMs: 0 })
    .filter((t) => etParts(new Date(Date.parse(t.entryTime))).dateStr === today).length;
  const openToday = tradelog.listOpen()
    .filter((t) => etParts(new Date(Date.parse(t.entryTime))).dateStr === today).length;
  return closedToday + openToday;
}

function entryBlockReason({ account, positions, openOrders, symbol, price, risk, clock }) {
  if (halt) return `halted: ${halt.reason}`;
  if (positions.length >= risk.maxOpenPositions) return 'max open positions reached';
  if (positions.find((p) => p.symbol === symbol)) return 'already in position';
  if (openOrders.find((o) => o.symbol === symbol)) return 'order already pending';
  if (tradesTodayCount() >= risk.maxTradesPerDay) return 'max trades per day reached';
  const cd = lastActionTs[symbol];
  if (cd && Date.now() - cd < risk.cooldownMin * 60000) return 'cooldown active';
  if (risk.respectPDT && Number(account.equity) < 25000 && Number(account.daytrade_count) >= 3) {
    return 'PDT protection: 3 day trades already used (equity < $25k)';
  }
  if (risk.avoidEarnings && earnings.reportsToday(symbol)) {
    return 'reports earnings today';
  }
  if (clock && clock.next_close) {
    const minsToClose = (Date.parse(clock.next_close) - Date.now()) / 60000;
    const flattenMin = store.get().engine.flattenBeforeCloseMin;
    if (flattenMin > 0 && minsToClose <= flattenMin + 2) return 'too close to market close';
  }
  return null;
}

function computeQty(account, risk, price, advShares) {
  let value;
  if (risk.sizingMode === 'pctEquity') {
    value = Number(account.equity) * (risk.pctEquity / 100);
  } else if (risk.sizingMode === 'riskBased') {
    // Constant $ risk per trade: position sized so the stop distance equals
    // riskPerTrade. Tighter stops => larger positions, capped by equity.
    const distPct = risk.exitStyle === 'trailing' ? risk.trailPercent : risk.stopLossPct;
    value = distPct > 0 ? risk.riskPerTrade / (distPct / 100) : 0;
    value = Math.min(value, Number(account.equity) * 0.5);
  } else {
    value = risk.positionValue;
  }
  const bp = Number(account.buying_power) * 0.95;
  value = Math.min(value, bp);
  let qty = Math.floor(value / price);
  // Liquidity guard: never be more than maxVolumePct of the stock's average
  // daily volume — thin names can't absorb real size.
  if (risk.maxVolumePct > 0 && advShares > 0) {
    qty = Math.min(qty, Math.floor(advShares * (risk.maxVolumePct / 100)));
  }
  return qty >= 1 ? qty : 0;
}

// Marketable limit price for entries: a hair above the ask, capping slippage.
async function entryLimitPrice(mode, symbol, fallbackPrice, risk) {
  if ((risk.entryOrderType || 'limit') !== 'limit') return null;
  let ref = fallbackPrice;
  try {
    const snaps = await alpaca.getSnapshots(mode, [symbol]);
    const q = snaps[symbol] && snaps[symbol].latestQuote;
    if (q && Number(q.ap) > 0) ref = Number(q.ap);
  } catch (_) { /* fall back to last close */ }
  return round2(ref * (1 + (risk.limitBufferPct ?? 0.15) / 100));
}

// In trailing mode entries are plain market buys; the protective trailing
// stop is attached as soon as the fill is confirmed.
async function ensureTrailingProtection(mode, symbol) {
  const s = store.get();
  if (s.risk.exitStyle !== 'trailing') return;
  try {
    const positions = await alpaca.getPositions(mode);
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos || Number(pos.qty) <= 0) return;
    const openOrders = await alpaca.getOpenOrders(mode);
    if (openOrders.find((o) => o.symbol === symbol && o.side === 'sell' && o.type === 'trailing_stop')) return;
    await alpaca.submitTrailingStop(mode, {
      symbol, qty: Number(pos.qty),
      trailPercent: s.risk.trailPercent,
      clientId: `tf-trail-${Date.now()}`
    });
    log('info', `🛡 Trailing stop (${s.risk.trailPercent}%) attached to ${symbol}`);
  } catch (e) {
    log('warn', `${symbol}: could not attach trailing stop — ${e.message}`);
  }
}

// ---------- session context ----------

function buildSession(barsT, barMinutes) {
  const today = todayEt();
  let startIdx = -1;
  for (let j = 0; j < barsT.length; j++) {
    const p = etParts(new Date(Date.parse(barsT[j])));
    if (p.dateStr === today && p.minutes >= 570) { startIdx = j; break; }
  }
  if (startIdx < 0) return null;
  const minutesSinceOpen = Math.max(0, (Date.now() - Date.parse(barsT[startIdx])) / 60000);
  return { startIdx, minutesSinceOpen, barMinutes };
}

// ---------- main tick ----------

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await tickInner();
  } catch (e) {
    lastTickInfo = { at: new Date().toISOString(), note: 'error: ' + e.message };
    log('error', 'Engine tick error: ' + e.message);
  } finally {
    ticking = false;
  }
}

async function tickInner() {
  const s = store.get();
  const mode = s.mode;

  if (!alpaca.hasKeys(mode)) {
    lastTickInfo = { at: new Date().toISOString(), note: `no ${mode} API keys` };
    pushStatus();
    return;
  }

  const clock = await getClock(mode);

  // New ET day -> clear daily halt/flatten flags.
  const today = todayEt();
  if (halt && halt.date !== today) { halt = null; log('info', 'New trading day — halt cleared'); }
  if (flattenedDate && flattenedDate !== today) flattenedDate = null;

  let account, positions;
  try {
    account = await alpaca.getAccount(mode);
    positions = await alpaca.getPositions(mode);
  } catch (e) {
    if (noteAuthResult(e)) {
      lastTickInfo = { at: new Date().toISOString(), note: 'Alpaca rejected the API keys (401)' };
      pushStatus();
      return;
    }
    throw e;
  }
  if (authFailed) { authFailed = false; pushStatus(); }
  broadcast('account', account);
  broadcast('positions', positions);

  await reconcile(mode);
  adoptPositions(positions, mode);
  await maybeSendDailySummary(account, mode);
  if (s.risk.avoidEarnings) await earnings.refresh();

  if (s.engine.marketHoursOnly && !clock.is_open) {
    lastTickInfo = { at: new Date().toISOString(), note: 'market closed' };
    pushStatus();
    return;
  }

  // Daily loss limit (covers realized + unrealized via equity delta).
  const dayPl = Number(account.equity) - Number(account.last_equity);
  if (!halt && s.risk.dailyLossLimit > 0 && dayPl <= -s.risk.dailyLossLimit) {
    halt = { reason: `daily loss limit hit (${dayPl.toFixed(2)})`, date: today };
    log('bad', `⛔ Daily loss limit reached ($${dayPl.toFixed(2)}). No new entries today.`);
    notify.show('onHalt', '⛔ Trading halted', `Daily loss limit reached ($${dayPl.toFixed(2)}). No new entries today.`);
    if (s.risk.haltAction === 'flatten' && positions.length) {
      for (const p of positions) pendingExitReasons[p.symbol] = 'daily loss limit — flattened';
      await alpaca.closeAllPositions(mode);
      log('warn', 'All positions flattened due to daily loss limit.');
    }
    pushStatus();
    return;
  }

  // Flatten before close.
  const minsToClose = clock.next_close ? (Date.parse(clock.next_close) - Date.now()) / 60000 : 999;
  if (s.engine.flattenBeforeCloseMin > 0 && clock.is_open &&
      minsToClose <= s.engine.flattenBeforeCloseMin && flattenedDate !== today) {
    flattenedDate = today;
    if (positions.length) {
      for (const p of positions) pendingExitReasons[p.symbol] = 'end-of-day flatten';
      await alpaca.closeAllPositions(mode);
      log('info', `🌙 Market close in ${minsToClose.toFixed(0)} min — flattened ${positions.length} position(s).`);
    } else {
      log('info', '🌙 End-of-day window — no positions to flatten.');
    }
    lastTickInfo = { at: new Date().toISOString(), note: 'end-of-day flatten window' };
    pushStatus();
    return;
  }

  // Evaluate strategy on each enabled symbol.
  const strat = strategies.getById(s.strategy.active);
  if (!strat) {
    lastTickInfo = { at: new Date().toISOString(), note: 'no active strategy' };
    pushStatus();
    return;
  }
  const params = strategies.resolveParams(strat, (s.strategy.params || {})[strat.id]);
  const symbols = s.watchlist.filter((w) => w.enabled).map((w) => w.symbol);
  if (!symbols.length) {
    lastTickInfo = { at: new Date().toISOString(), note: 'watchlist empty' };
    pushStatus();
    return;
  }

  const tf = s.engine.timeframe;
  const startIso = new Date(Date.now() - HISTORY_DAYS[tf] * 24 * 3600e3).toISOString();
  const barsBySym = await alpaca.getBars(mode, symbols, tf, startIso);
  const openOrders = await alpaca.getOpenOrders(mode);

  // Sweep stale marketable-limit entries: if a buy hasn't filled within a few
  // minutes, the moment has passed — cancel rather than chase.
  for (const o of openOrders) {
    if (o.side === 'buy' && o.type === 'limit' &&
        o.client_order_id && o.client_order_id.startsWith('tf-') && !o.client_order_id.startsWith('tf-trail')) {
      const ageMin = (Date.now() - Date.parse(o.created_at)) / 60000;
      if (ageMin > 5) {
        try {
          await alpaca.cancelOrder(mode, o.id);
          log('dim', `${o.symbol}: unfilled entry order cancelled after ${Math.round(ageMin)} min`);
        } catch (_) { /* may have just filled */ }
      }
    }
  }

  let acted = 0;
  for (const symbol of symbols) {
    const bars = barsBySym[symbol] || [];
    if (bars.length < 60) {
      setSignal(symbol, 'skip', 'not enough bar history yet', null);
      continue;
    }
    const ctx = {
      c: bars.map((b) => b.c), h: bars.map((b) => b.h), l: bars.map((b) => b.l),
      v: bars.map((b) => b.v), t: bars.map((b) => b.t),
      i: bars.length - 1,
      params,
      pos: null,
      session: buildSession(bars.map((b) => b.t), BAR_MINUTES[tf])
    };
    const bp = positions.find((p) => p.symbol === symbol);
    if (bp) ctx.pos = { qty: Number(bp.qty), entry: Number(bp.avg_entry_price) };

    // Time-based exit: close positions held longer than the configured cap.
    if (ctx.pos && s.risk.maxHoldMin > 0) {
      const rec = tradelog.findOpen(symbol);
      const heldMin = rec ? (Date.now() - Date.parse(rec.entryTime)) / 60000 : 0;
      if (heldMin >= s.risk.maxHoldMin) {
        pendingExitReasons[symbol] = `time exit (held ${Math.round(heldMin)} min)`;
        try {
          await alpaca.closePosition(mode, symbol);
          lastActionTs[symbol] = Date.now();
          acted++;
          log('info', `⏱ ${symbol}: held ${Math.round(heldMin)} min ≥ ${s.risk.maxHoldMin} — time exit`);
          setSignal(symbol, 'sell', 'time exit', ctx.c[ctx.i]);
        } catch (e) {
          delete pendingExitReasons[symbol];
          log('error', `${symbol}: time exit failed — ${e.message}`);
        }
        continue;
      }
    }

    let sig;
    try {
      sig = strat.evaluate(ctx);
    } catch (e) {
      log('warn', `${symbol}: strategy error — ${e.message}`);
      setSignal(symbol, 'skip', 'strategy error: ' + e.message, ctx.c[ctx.i]);
      continue;
    }

    if (sig.action === 'sell' && ctx.pos) {
      pendingExitReasons[symbol] = sig.reason;
      try {
        await alpaca.closePosition(mode, symbol);
        lastActionTs[symbol] = Date.now();
        acted++;
        log('info', `SELL signal ${symbol}: ${sig.reason} — closing position`);
        setSignal(symbol, 'sell', sig.reason, ctx.c[ctx.i]);
      } catch (e) {
        delete pendingExitReasons[symbol];
        log('error', `${symbol}: close failed — ${e.message}`);
      }
    } else if (sig.action === 'buy' && !ctx.pos) {
      const price = ctx.c[ctx.i];
      const block = entryBlockReason({ account, positions, openOrders, symbol, price, risk: s.risk, clock });
      if (block) {
        log('dim', `${symbol}: buy signal skipped (${block})`);
        setSignal(symbol, 'skip', `buy signal, but: ${block}`, price);
        continue;
      }
      const barMin = BAR_MINUTES[tf] || 5;
      const volTail = ctx.v.slice(-100);
      const advShares = volTail.length
        ? (volTail.reduce((a, b) => a + b, 0) / volTail.length) * (390 / barMin)
        : 0;
      const qty = computeQty(account, s.risk, price, advShares);
      if (qty < 1) {
        log('dim', `${symbol}: buy signal skipped (size too small or liquidity guard at $${price.toFixed(2)})`);
        setSignal(symbol, 'skip', 'buy signal, but size too small / liquidity guard', price);
        continue;
      }
      const clientId = `tf-${strat.id}-${Date.now()}`;
      try {
        const limitPrice = await entryLimitPrice(mode, symbol, price, s.risk);
        const via = limitPrice ? `limit $${limitPrice}` : 'market';
        if (s.risk.exitStyle === 'trailing') {
          await alpaca.submitMarketBuy(mode, { symbol, qty, clientId, limitPrice });
          lastActionTs[symbol] = Date.now();
          acted++;
          log('info', `BUY ${qty} ${symbol} @ ~$${price.toFixed(2)} via ${via} (${sig.reason}) — trailing ${s.risk.trailPercent}% stop to follow`);
          // Attach protection promptly; the fill-reconciler also retries this.
          setTimeout(() => ensureTrailingProtection(mode, symbol), 4000);
        } else {
          const ref = limitPrice || price;
          let tp = round2(ref * (1 + s.risk.takeProfitPct / 100));
          let sl = round2(ref * (1 - s.risk.stopLossPct / 100));
          if (tp <= ref) tp = round2(ref + 0.01);
          if (sl >= ref) sl = round2(ref - 0.01);
          await alpaca.submitBracketBuy(mode, { symbol, qty, takeProfit: tp, stopLoss: sl, clientId, limitPrice });
          lastActionTs[symbol] = Date.now();
          acted++;
          log('info', `BUY ${qty} ${symbol} @ ~$${price.toFixed(2)} via ${via} (${sig.reason}) — TP $${tp} / SL $${sl}`);
        }
        setSignal(symbol, 'buy', sig.reason, price);
      } catch (e) {
        log('error', `${symbol}: buy failed — ${e.message}`);
      }
    } else {
      setSignal(symbol, ctx.pos ? 'hold' : 'watch', sig.reason || '—', ctx.c[ctx.i]);
    }
  }

  broadcast('signals', { at: new Date().toISOString(), states: signalStates });
  lastTickInfo = {
    at: new Date().toISOString(),
    note: `scanned ${symbols.length} symbols, ${acted ? acted + ' action(s)' : 'no action'}`
  };
  pushStatus();
}

// ---------- daily summary ----------

function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function maybeSendDailySummary(account, mode) {
  const s = store.get().email;
  if (!s.enabled || !s.dailySummary) return;
  const today = localTodayStr();
  if (summarySentDate === today) return;
  const [hh, mm] = String(s.summaryTime || '16:15').split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const trades = tradelog.listClosed({ fromMs: startOfDay });
  summarySentDate = today;
  if (!trades.length) return; // nothing to report
  try {
    await mailer.sendDailySummary(trades, account, mode);
    log('info', `📧 Daily summary emailed (${trades.length} trades).`);
  } catch (e) {
    log('warn', 'Daily summary email failed: ' + e.message);
  }
}

async function sendSummaryNow() {
  const s = store.get();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const trades = tradelog.listClosed({ fromMs: startOfDay });
  let account = null;
  try { account = await alpaca.getAccount(s.mode); } catch (_) {}
  await mailer.sendDailySummary(trades, account, s.mode);
  return trades.length;
}

// ---------- lifecycle ----------

async function start() {
  const s = store.get();
  if (running) return statusPayload();
  if (!alpaca.hasKeys(s.mode)) {
    throw new Error(`No ${s.mode} API keys configured. Add them in Settings.`);
  }
  if (s.mode === 'live' && !s.liveArmed) {
    throw new Error('Live trading has not been confirmed in Settings.');
  }
  running = true;
  halt = null;
  syncStreams();
  lastReconcileIso = new Date(Date.now() - 24 * 3600e3).toISOString();
  log('info', `▶ Engine started — ${s.mode.toUpperCase()} mode, strategy: ${strategies.getById(s.strategy.active)?.name}, timeframe ${s.engine.timeframe}`);
  if (s.mode === 'live') log('warn', '⚠ LIVE MODE — real money is at risk.');
  const period = Math.max(10, Number(s.engine.pollSec) || 30) * 1000;
  timer = setInterval(tick, period);
  tick();
  pushStatus();
  return statusPayload();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
  log('info', '⏸ Engine stopped. (Open bracket orders remain protected at the broker.)');
  pushStatus();
  return statusPayload();
}

// ---------- daily schedule (auto start/stop, Eastern Time) ----------

const ET_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
let autoSched = { date: '', started: false, stopped: false };

function checkSchedule() {
  const s = store.get();
  const sch = (s.engine && s.engine.schedule) || {};
  if (!sch.enabled) return;
  const now = new Date();
  const wd = ET_WEEKDAY.format(now);
  if (wd === 'Sat' || wd === 'Sun') return;
  const et = etParts(now);
  if (autoSched.date !== et.dateStr) autoSched = { date: et.dateStr, started: false, stopped: false };
  const toMin = (str, dflt) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : dflt;
  };
  const startMin = toMin(sch.start, 570);
  const endMin = toMin(sch.end, 960);
  const within = et.minutes >= startMin && et.minutes < endMin;
  if (within && !running && !autoSched.started) {
    // Fires once per day: if you stop the engine manually mid-window, it
    // stays stopped until tomorrow rather than fighting you every 20s.
    autoSched.started = true;
    start().then(() => {
      log('info', `⏰ Engine auto-started by schedule (${sch.start}–${sch.end} ET)`);
      notify.show(null, 'TradeForge', 'Engine auto-started on schedule');
    }).catch((e) => log('warn', 'Scheduled auto-start failed: ' + e.message));
  } else if (running && et.minutes >= endMin && !autoSched.stopped) {
    autoSched.stopped = true;
    stop();
    log('info', '⏰ Engine auto-stopped — end of the scheduled trading window');
    notify.show(null, 'TradeForge', 'Engine stopped — end of scheduled trading window');
  }
}

// Light monitor so the dashboard stays live while the engine is stopped.
function startPulse() {
  if (pulseTimer) return;
  pulseTimer = setInterval(async () => {
    syncStreams();
    checkSchedule();
    if (running) return;
    const s = store.get();
    if (!alpaca.hasKeys(s.mode)) return;
    try {
      const clock = await getClock(s.mode);
      const account = await alpaca.getAccount(s.mode);
      const positions = await alpaca.getPositions(s.mode);
      broadcast('account', account);
      broadcast('positions', positions);
      await maybeSendDailySummary(account, s.mode);
      if (authFailed) authFailed = false;
      pushStatus();
    } catch (e) {
      noteAuthResult(e); // offline errors stay quiet; 401s get surfaced
    }
  }, 20000);
}

async function manualClose(symbol) {
  const s = store.get();
  pendingExitReasons[symbol] = 'manual close';
  await alpaca.closePosition(s.mode, symbol);
  log('info', `Manual close requested for ${symbol}`);
  if (!running) setTimeout(() => reconcile(s.mode).catch(() => {}), 4000);
}

async function manualCloseAll() {
  const s = store.get();
  const positions = await alpaca.getPositions(s.mode);
  for (const p of positions) pendingExitReasons[p.symbol] = 'manual close all';
  await alpaca.closeAllPositions(s.mode);
  log('info', `Manual close-all requested (${positions.length} positions)`);
  if (!running) setTimeout(() => reconcile(s.mode).catch(() => {}), 4000);
}

function isRunning() { return running; }

module.exports = {
  setBroadcaster, start, stop, startPulse, isRunning,
  statusPayload, getLogs, manualClose, manualCloseAll, sendSummaryNow
};
