// Unit tests for strategy signal logic (pure — no Electron needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');

const T0 = Date.parse('2026-01-05T14:30:00Z'); // 09:30 ET
const stamp = (i) => new Date(T0 + i * 5 * 60000).toISOString();

// Build a ctx from a close series (highs/lows derived unless given).
function mkCtx(c, { h, l, v, pos = null, i = c.length - 1, session } = {}) {
  return {
    c,
    h: h || c.map((x) => x + 0.2),
    l: l || c.map((x) => x - 0.2),
    v: v || c.map(() => 1000),
    t: c.map((_, k) => stamp(k)),
    i,
    pos,
    session: session || { startIdx: 0, minutesSinceOpen: i * 5 },
    params: null // filled by evalWith
  };
}

function evalWith(id, ctx, overrides) {
  const strat = strategies.getById(id);
  ctx.params = strategies.resolveParams(strat, overrides);
  return strat.evaluate(ctx);
}

// Scan every bar and collect actions (fresh position-less evaluation per bar).
function scanActions(id, ctx) {
  const actions = new Set();
  const strat = strategies.getById(id);
  const params = strategies.resolveParams(strat, null);
  for (let i = 60; i < ctx.c.length; i++) {
    const r = strat.evaluate({ ...ctx, i, params, session: { startIdx: 0, minutesSinceOpen: i * 5 } });
    if (r.action) actions.add(r.action);
  }
  return actions;
}

test('donchian buys a breakout above the prior high', () => {
  const c = new Array(120).fill(100);
  c[119] = 105;
  const h = c.map((x) => x + 0.5);
  const r = evalWith('donchian_breakout', mkCtx(c, { h }));
  assert.equal(r.action, 'buy');
});

test('donchian exits on a breakdown below the prior low', () => {
  const c = new Array(120).fill(100);
  c[119] = 90;
  const l = c.map((x) => x - 0.5);
  const r = evalWith('donchian_breakout', mkCtx(c, { l, pos: { qty: 1, entry: 100 } }));
  assert.equal(r.action, 'sell');
});

test('bollinger reversion buys the snap back inside the lower band', () => {
  const c = new Array(150).fill(100);
  c[148] = 90;   // plunge below the band
  c[149] = 99.5; // close back above it
  const r = evalWith('bollinger_reversion', mkCtx(c));
  assert.equal(r.action, 'buy');
});

test('bollinger reversion sells at the middle-band target', () => {
  const c = new Array(150).fill(100);
  const r = evalWith('bollinger_reversion', mkCtx(c, { pos: { qty: 1, entry: 95 } }));
  assert.equal(r.action, 'sell'); // constant series: close == middle band
});

test('rsi2 buys a sharp dip inside an uptrend', () => {
  const c = Array.from({ length: 200 }, (_, i) => 100 + i * 0.25);
  c[198] = c[197] - 5;
  c[199] = c[198] - 5; // two hard down bars -> RSI(2) ~ 0, still above SMA100
  const r = evalWith('rsi2_reversion', mkCtx(c));
  assert.equal(r.action, 'buy');
});

test('ema crossover, macd, and supertrend all fire on a V-shaped reversal', () => {
  // Wobble prevents float-identical EMA convergence (a purely linear series
  // makes MACD line == signal to machine precision — never seen in real data).
  const c = [];
  for (let i = 0; i < 150; i++) c.push(200 - i * 0.5 + Math.sin(i / 3) * 2); // decline
  for (let i = 0; i < 80; i++) c.push(125 + i * 1.5 + Math.sin(i / 3) * 2);  // sharp recovery
  const ctx = mkCtx(c);
  for (const id of ['ema_crossover', 'macd_momentum', 'supertrend']) {
    assert.ok(scanActions(id, ctx).has('buy'), id + ' should produce a buy somewhere on the reversal');
  }
});

test('vwap reversion buys a stabilizing dip below vwap', () => {
  const c = new Array(60).fill(100);
  c[58] = 98.5;
  c[59] = 99.0; // ~1% below VWAP and ticking up
  const r = evalWith('vwap_reversion', mkCtx(c));
  assert.equal(r.action, 'buy');
});

test('opening range breakout buys a volume-confirmed break of the range high', () => {
  const c = [];
  for (let i = 0; i < 6; i++) c.push(100);      // 30-min opening range (high 100.5)
  for (let i = 6; i < 29; i++) c.push(100.3);   // drift below the range high
  c.push(101);                                   // breakout bar
  const h = c.map((x, i) => (i < 6 ? 100.5 : x + 0.15));
  const v = c.map((_, i) => (i === 29 ? 5000 : 1000));
  const r = evalWith('orb_breakout', mkCtx(c, { h, v, session: { startIdx: 0, minutesSinceOpen: 145 } }));
  assert.equal(r.action, 'buy');
});

test('every strategy is crash-safe and returns a valid action on random data', () => {
  // Seeded LCG random walk — deterministic across runs.
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const c = [100];
  for (let i = 1; i < 300; i++) c.push(Math.max(5, c[i - 1] * (1 + (rnd() - 0.5) * 0.02)));
  const h = c.map((x) => x * (1 + rnd() * 0.005));
  const l = c.map((x) => x * (1 - rnd() * 0.005));
  const v = c.map(() => Math.floor(rnd() * 10000) + 100);
  const VALID = [null, 'buy', 'sell'];
  for (const meta of strategies.list()) {
    const strat = strategies.getById(meta.id);
    const params = strategies.resolveParams(strat, null);
    for (let i = 1; i < c.length; i++) {
      for (const pos of [null, { qty: 10, entry: c[Math.max(0, i - 5)] }]) {
        const ctx = {
          c, h, l, v, t: c.map((_, k) => stamp(k)), i, params, pos,
          session: { startIdx: 0, minutesSinceOpen: i * 5 }
        };
        const r = strat.evaluate(ctx);
        assert.ok(r && typeof r === 'object', meta.id + ' returned non-object');
        assert.ok(VALID.includes(r.action), meta.id + ' returned bad action: ' + r.action);
      }
    }
  }
});
