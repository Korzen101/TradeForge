// Backtester v2: PORTFOLIO simulation — all symbols walk one shared timeline,
// so max-open-positions, max-trades-per-day, and the daily loss limit apply
// across the whole account, matching live behavior.
//
// Fill model (stated in the UI): signals evaluate on a bar's close; entries
// fill at the symbol's NEXT bar open; stop/target exits fill intrabar (gaps
// fill at the open, past the level); if a bar touches both stop and target
// the STOP wins; strategy exits fill at the bar's close; slippage is charged
// on every fill, both directions.
//
// Modes:
//   standard    — one run over the whole window
//   consistency — the window is split into 3 equal periods, each run
//                 independently, to expose one-lucky-month results
//   optimize    — coarse parameter grid tuned on the first 70% of the window
//                 (in-sample), then the winner is judged on the untouched
//                 last 30% (out-of-sample walk-forward)
const alpaca = require('./alpaca');
const store = require('./store');
const strategies = require('./strategies');
const logger = require('./logger');
const barcache = require('./barcache');

const BAR_MIN = { '1Min': 1, '5Min': 5, '15Min': 15 };

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});

function etParts(ms) {
  const p = {};
  for (const x of ET_FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

const round2 = (v) => Math.round(v * 100) / 100;

let current = null; // { cancelled }

function isRunning() { return !!current; }
function cancel() { if (current) current.cancelled = true; }

function sizeQty(px, risk, startEquity, advShares) {
  let value;
  if (risk.sizingMode === 'pctEquity') {
    value = startEquity * (risk.pctEquity / 100);
  } else if (risk.sizingMode === 'riskBased') {
    const distPct = risk.exitStyle === 'trailing' ? risk.trailPercent : risk.stopLossPct;
    value = distPct > 0 ? (risk.riskPerTrade / (distPct / 100)) : 0;
  } else {
    value = risk.positionValue;
  }
  value = Math.min(value, startEquity);
  let qty = Math.floor(value / px);
  if (risk.maxVolumePct > 0 && advShares > 0) {
    qty = Math.min(qty, Math.floor(advShares * (risk.maxVolumePct / 100)));
  }
  return qty;
}

// Regular-hours bars only, as parallel arrays per symbol + a merged timeline.
function prep(symbols, barsBySym) {
  const data = {};
  const timeline = [];
  for (const sym of symbols) {
    const o = [], h = [], l = [], c = [], v = [], t = [], ms = [], etDate = [], etMin = [];
    const dayStartIdx = {};
    for (const b of barsBySym[sym] || []) {
      const m = Date.parse(b.t);
      const et = etParts(m);
      if (et.min < 570 || et.min >= 960) continue;
      const i = c.length;
      o.push(b.o); h.push(b.h); l.push(b.l); c.push(b.c); v.push(b.v); t.push(b.t);
      ms.push(m); etDate.push(et.date); etMin.push(et.min);
      if (!(et.date in dayStartIdx)) dayStartIdx[et.date] = i;
      timeline.push({ sym, i, ms: m, etDate: et.date, etMin: et.min });
    }
    // Estimated average daily volume for the liquidity guard.
    const tail = v.slice(-300);
    const avgBarVol = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
    data[sym] = { o, h, l, c, v, t, ms, etDate, etMin, dayStartIdx, avgBarVol };
  }
  timeline.sort((a, b) => a.ms - b.ms || (a.sym < b.sym ? -1 : 1));
  return { data, timeline };
}

function mkCtx(A, i, params, pos, e) {
  return {
    c: A.c, h: A.h, l: A.l, v: A.v, t: A.t, i, params, pos,
    session: { startIdx: A.dayStartIdx[e.etDate] ?? -1, minutesSinceOpen: e.etMin - 570 }
  };
}

async function simulatePortfolio({ strat, params, data, timeline, fromMs, toMs, risk, eng, cfg, cancelRef, progress }) {
  const slip = cfg.slippagePct / 100;
  const barMin = BAR_MIN[cfg.timeframe] || 5;
  const positions = {};
  let openCount = 0;
  const pendingBuy = {};
  const lastExitMs = {};
  let day = null, dayPl = 0, dayTrades = 0, halted = false;
  const trades = [];
  let steps = 0;

  const closeTrade = (sym, px, reason, tt, ms) => {
    const p = positions[sym];
    const pl = (px - p.entry) * p.qty;
    dayPl += pl;
    lastExitMs[sym] = ms;
    trades.push({
      symbol: sym, qty: p.qty,
      entryPrice: round2(p.entry), entryTime: p.entryT,
      exitPrice: round2(px), exitTime: tt,
      pl: round2(pl), plPct: round2((px / p.entry - 1) * 10000) / 100,
      exitReason: reason, holdMin: Math.round((ms - p.entryMs) / 60000)
    });
    delete positions[sym];
    openCount--;
  };

  for (const e of timeline) {
    if (e.ms < fromMs) continue;
    if (e.ms > toMs) break;
    if (cancelRef.cancelled) throw new Error('cancelled');
    if (++steps % 1500 === 0) {
      await new Promise((r) => setImmediate(r));
      if (progress) progress(steps);
    }
    const A = data[e.sym];
    const i = e.i;

    if (e.etDate !== day) {
      day = e.etDate; dayPl = 0; dayTrades = 0; halted = false;
      for (const k in pendingBuy) pendingBuy[k] = false;
    }
    if (positions[e.sym] && positions[e.sym].entryDate !== e.etDate) {
      closeTrade(e.sym, A.o[i] * (1 - slip), 'overnight safety close', A.t[i], e.ms);
    }
    if (halted && risk.haltAction === 'flatten' && positions[e.sym]) {
      closeTrade(e.sym, A.o[i] * (1 - slip), 'daily loss limit — flattened', A.t[i], e.ms);
    }

    const nearClose = eng.flattenBeforeCloseMin > 0 &&
      e.etMin >= 960 - eng.flattenBeforeCloseMin - barMin;

    // Entry queued from this symbol's previous bar fills at this bar's open,
    // re-checked against the SHARED portfolio limits at fill time.
    if (pendingBuy[e.sym]) {
      pendingBuy[e.sym] = false;
      if (!halted && !nearClose && !positions[e.sym] &&
          openCount < risk.maxOpenPositions &&
          (risk.maxTradesPerDay <= 0 || dayTrades < risk.maxTradesPerDay) &&
          !(risk.cooldownMin > 0 && lastExitMs[e.sym] && e.ms - lastExitMs[e.sym] < risk.cooldownMin * 60000)) {
        const px = A.o[i] * (1 + slip);
        const barMin = BAR_MIN[cfg.timeframe] || 5;
        const advShares = A.avgBarVol * (390 / barMin);
        const qty = sizeQty(px, risk, cfg.startEquity, advShares);
        if (qty >= 1) {
          positions[e.sym] = {
            qty, entry: px, entryT: A.t[i], entryMs: e.ms, entryDate: e.etDate,
            high: A.h[i],
            stop: px * (1 - risk.stopLossPct / 100),
            tp: px * (1 + risk.takeProfitPct / 100)
          };
          openCount++;
          dayTrades++;
        }
      }
    }

    const p = positions[e.sym];
    if (p) {
      p.high = Math.max(p.high, A.h[i]);
      const trailing = risk.exitStyle === 'trailing';
      const stop = trailing ? p.high * (1 - risk.trailPercent / 100) : p.stop;
      let exit = null;
      if (A.o[i] <= stop) exit = { px: A.o[i], reason: trailing ? 'trailing stop (gap open)' : 'stop-loss (gap open)' };
      else if (A.l[i] <= stop) exit = { px: stop, reason: trailing ? 'trailing stop hit' : 'stop-loss hit' };
      else if (!trailing) {
        if (A.o[i] >= p.tp) exit = { px: A.o[i], reason: 'take-profit (gap open)' };
        else if (A.h[i] >= p.tp) exit = { px: p.tp, reason: 'take-profit hit' };
      }
      if (!exit && risk.maxHoldMin > 0 && (e.ms - p.entryMs) / 60000 >= risk.maxHoldMin) {
        exit = { px: A.c[i], reason: 'time exit' };
      }
      if (!exit && nearClose) exit = { px: A.c[i], reason: 'end-of-day flatten' };
      if (!exit && i >= 60) {
        let sig;
        try { sig = strat.evaluate(mkCtx(A, i, params, { qty: p.qty, entry: p.entry }, e)); }
        catch (_) { sig = { action: null }; }
        if (sig.action === 'sell') exit = { px: A.c[i], reason: sig.reason || 'strategy exit' };
      }
      if (exit) closeTrade(e.sym, exit.px * (1 - slip), exit.reason, A.t[i], e.ms);
    } else if (i >= 60 && !halted && !nearClose && openCount < risk.maxOpenPositions) {
      let sig;
      try { sig = strat.evaluate(mkCtx(A, i, params, null, e)); }
      catch (_) { sig = { action: null }; }
      if (sig.action === 'buy') pendingBuy[e.sym] = true;
    }

    if (!halted && risk.dailyLossLimit > 0 && dayPl <= -risk.dailyLossLimit) halted = true;
  }
  return trades;
}

function summarize(strat, trades) {
  const sorted = trades.slice().sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
  const wins = sorted.filter((t) => t.pl > 0);
  const losses = sorted.filter((t) => t.pl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pl, 0));
  let cum = 0, peak = 0, maxDD = 0;
  const equityCurve = sorted.map((t) => {
    cum += t.pl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
    return { t: t.exitTime, y: round2(cum) };
  });
  const perSymbol = {};
  for (const t of sorted) {
    const ps = perSymbol[t.symbol] || (perSymbol[t.symbol] = { trades: 0, wins: 0, pl: 0 });
    ps.trades++; if (t.pl > 0) ps.wins++; ps.pl = round2(ps.pl + t.pl);
  }
  const holdVals = sorted.filter((t) => t.holdMin !== null).map((t) => t.holdMin);
  return {
    strategyId: strat.id,
    strategyName: strat.name,
    stats: {
      count: sorted.length,
      wins: wins.length,
      losses: losses.length,
      winRate: sorted.length ? round2((wins.length / sorted.length) * 100) : 0,
      totalPl: round2(sorted.reduce((s, t) => s + t.pl, 0)),
      avgWin: wins.length ? round2(grossWin / wins.length) : 0,
      avgLoss: losses.length ? round2(grossLoss / losses.length) : 0,
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0),
      maxDrawdown: round2(maxDD),
      avgHoldMin: holdVals.length ? Math.round(holdVals.reduce((s, x) => s + x, 0) / holdVals.length) : null
    },
    equityCurve,
    perSymbol,
    trades: sorted.slice(-500)
  };
}

// Coarse grid around each parameter's default (plus the user's current value).
function optimizeGrid(strat, currentParams) {
  const axes = strat.params.map((p) => {
    const dec = (String(p.step).split('.')[1] || '').length;
    const snap = (v) => {
      const clamped = Math.min(p.max, Math.max(p.min, Math.round(v / p.step) * p.step));
      return Number(clamped.toFixed(dec));
    };
    const vals = new Set([snap(p.def * 0.6), snap(p.def), snap(p.def * 1.5)]);
    if (currentParams && typeof currentParams[p.key] === 'number') vals.add(snap(currentParams[p.key]));
    return { key: p.key, values: [...vals] };
  });
  let combos = [{}];
  for (const ax of axes) {
    const next = [];
    for (const c of combos) for (const v of ax.values) next.push({ ...c, [ax.key]: v });
    combos = next;
  }
  if (combos.length > 60) {
    const stride = Math.ceil(combos.length / 60);
    combos = combos.filter((_, i) => i % stride === 0).slice(0, 60);
  }
  return combos;
}

const pfScore = (st) => (st.count >= 15
  ? (st.profitFactor === Infinity ? 1e9 : st.profitFactor)
  : -1);

async function run(cfg, push) {
  if (current) throw new Error('A backtest is already running');
  current = { cancelled: false };
  try {
    const s = store.get();
    const symbols = s.watchlist.filter((w) => w.enabled).map((w) => w.symbol);
    if (!symbols.length) throw new Error('No enabled symbols on the Stocks list');
    if (!alpaca.hasKeys(s.mode)) throw new Error(`No ${s.mode} API keys — historical data comes through your Alpaca account`);

    const timeframe = cfg.timeframe || s.engine.timeframe;
    const days = Math.min(365, Math.max(5, Number(cfg.days) || 60));
    const mode = cfg.mode || 'standard';
    const fullCfg = {
      timeframe, days, mode,
      slippagePct: Number(cfg.slippagePct ?? s.backtest.slippagePct) || 0,
      startEquity: Number(cfg.startEquity ?? s.backtest.startEquity) || 100000
    };

    const startIso = new Date(Date.now() - days * 24 * 3600e3).toISOString();
    barcache.cleanup();
    const barsBySym = {};
    const missing = [];
    for (const sym of symbols) {
      const cached = barcache.get(timeframe, sym, startIso);
      if (cached) barsBySym[sym] = cached;
      else missing.push(sym);
    }
    push({
      type: 'progress', pct: 2,
      note: missing.length
        ? `Downloading bars for ${missing.length} symbols (${symbols.length - missing.length} cached)…`
        : 'Using cached historical bars…'
    });
    if (missing.length) {
      const fetched = await alpaca.getBars(s.mode, missing, timeframe, startIso, 30000);
      for (const sym of missing) {
        barsBySym[sym] = fetched[sym] || [];
        barcache.put(timeframe, sym, startIso, barsBySym[sym]);
      }
    }
    const { data, timeline } = prep(symbols, barsBySym);
    if (!timeline.length) throw new Error('No historical bars returned for the selected window');
    const tlFrom = timeline[0].ms;
    const tlTo = timeline[timeline.length - 1].ms;
    const config = { ...fullCfg, symbols, strategyId: cfg.strategyId };
    const base = { data, timeline, risk: s.risk, eng: s.engine, cfg: fullCfg, cancelRef: current };

    // ---- optimize (single strategy only) ----
    if (mode === 'optimize') {
      if (cfg.strategyId === 'ALL') throw new Error('Pick a single strategy to optimize');
      const strat = strategies.getById(cfg.strategyId || s.strategy.active);
      const baseParams = strategies.resolveParams(strat, (s.strategy.params || {})[strat.id]);
      const combos = optimizeGrid(strat, baseParams);
      const splitMs = tlFrom + (tlTo - tlFrom) * 0.7;
      const graded = [];
      for (let k = 0; k < combos.length; k++) {
        push({ type: 'progress', pct: Math.round(5 + 70 * (k / combos.length)),
          note: `Testing parameter set ${k + 1}/${combos.length} (in-sample)…` });
        const trades = await simulatePortfolio({ ...base, strat, params: combos[k], fromMs: 0, toMs: splitMs });
        graded.push({ params: combos[k], stats: summarize(strat, trades).stats });
      }
      graded.sort((a, b) => pfScore(b.stats) - pfScore(a.stats) || b.stats.totalPl - a.stats.totalPl);
      const best = graded[0];
      push({ type: 'progress', pct: 80, note: 'Judging the winner on unseen data (out-of-sample)…' });
      const bestOut = summarize(strat,
        await simulatePortfolio({ ...base, strat, params: best.params, fromMs: splitMs, toMs: Infinity }));
      push({ type: 'progress', pct: 90, note: 'Scoring your current parameters for comparison…' });
      const blIn = summarize(strat,
        await simulatePortfolio({ ...base, strat, params: baseParams, fromMs: 0, toMs: splitMs })).stats;
      const blOut = summarize(strat,
        await simulatePortfolio({ ...base, strat, params: baseParams, fromMs: splitMs, toMs: Infinity })).stats;

      let verdict;
      const inPF = best.stats.profitFactor === Infinity ? 99 : best.stats.profitFactor;
      const outPF = bestOut.stats.profitFactor === Infinity ? 99 : bestOut.stats.profitFactor;
      if (bestOut.stats.count < 10) {
        verdict = 'Too few out-of-sample trades to judge — extend the history window before trusting this.';
      } else if (outPF >= Math.max(1.05, inPF * 0.6) && bestOut.stats.totalPl > 0) {
        verdict = 'The tuned parameters held up on unseen data — a genuinely promising sign. Still: paper trade them before believing it.';
      } else {
        verdict = 'Warning: performance collapsed on the unseen 30%. These numbers are likely overfit to the past — prefer the defaults.';
      }
      logger.info('backtest', `optimize ${strat.id}: ${combos.length} combos, out-of-sample PF ${bestOut.stats.profitFactor}`);
      return {
        mode: 'optimize', config,
        strategyId: strat.id, strategyName: strat.name,
        grid: graded.slice(0, 10),
        best: { params: best.params, inStats: best.stats, outStats: bestOut.stats, outCurve: bestOut.equityCurve },
        baseline: { params: baseParams, inStats: blIn, outStats: blOut },
        splitAt: new Date(splitMs).toISOString(),
        verdict
      };
    }

    // ---- standard / consistency ----
    const stratIds = cfg.strategyId === 'ALL'
      ? strategies.list().map((x) => x.id)
      : [cfg.strategyId || s.strategy.active];
    const results = [];
    for (let si = 0; si < stratIds.length; si++) {
      const strat = strategies.getById(stratIds[si]);
      if (!strat) continue;
      const params = strategies.resolveParams(strat, (s.strategy.params || {})[strat.id]);
      const span = 92 / stratIds.length;
      const pctBase = 5 + span * si;
      const progress = (steps) => push({
        type: 'progress',
        pct: Math.round(pctBase + span * Math.min(1, steps / timeline.length)),
        note: `${strat.name} — simulating portfolio…`
      });
      if (mode === 'consistency') {
        const segs = [];
        const allTrades = [];
        for (let g = 0; g < 3; g++) {
          const fromMs = tlFrom + ((tlTo - tlFrom) / 3) * g;
          const toMs = g === 2 ? Infinity : tlFrom + ((tlTo - tlFrom) / 3) * (g + 1);
          const trades = await simulatePortfolio({ ...base, strat, params, fromMs, toMs, progress });
          const sum = summarize(strat, trades);
          segs.push({
            label: `Period ${g + 1}`,
            from: new Date(fromMs).toISOString().slice(0, 10),
            to: toMs === Infinity ? new Date(tlTo).toISOString().slice(0, 10) : new Date(toMs).toISOString().slice(0, 10),
            stats: sum.stats
          });
          allTrades.push(...trades);
        }
        const res = summarize(strat, allTrades);
        res.segments = segs;
        results.push(res);
      } else {
        const trades = await simulatePortfolio({ ...base, strat, params, fromMs: 0, toMs: Infinity, progress });
        results.push(summarize(strat, trades));
      }
    }
    results.sort((a, b) => pfScore(b.stats) - pfScore(a.stats) || b.stats.totalPl - a.stats.totalPl);
    logger.info('backtest', `completed (${mode}): ${stratIds.length} strategies × ${symbols.length} symbols, ${days}d ${timeframe}`);
    return { mode, config, results };
  } finally {
    current = null;
  }
}

module.exports = { run, cancel, isRunning };
