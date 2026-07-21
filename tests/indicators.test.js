// Unit tests for the indicator math (pure functions — no Electron needed).
// Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const I = require('../src/indicators');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('sma computes rolling means with null warmup', () => {
  const out = I.sma([1, 2, 3, 4, 5], 2);
  assert.equal(out[0], null);
  near(out[1], 1.5);
  near(out[4], 4.5);
  near(I.sma([1, 2, 3, 4, 5], 5)[4], 3);
});

test('ema of a constant series is the constant', () => {
  const out = I.ema(new Array(50).fill(10), 5);
  near(out[49], 10);
  assert.equal(out[2], null);
});

test('rsi saturates at 100 for all gains, 0 for all losses', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 140 - i);
  near(I.rsi(up, 14)[39], 100);
  near(I.rsi(down, 14)[39], 0);
});

test('bollinger bands collapse to the mean on a constant series', () => {
  const c = new Array(40).fill(100);
  const bb = I.bollinger(c, 20, 2);
  near(bb.mid[39], 100);
  near(bb.upper[39], 100);
  near(bb.lower[39], 100);
});

test('atr is zero when bars have no range or gaps', () => {
  const flat = new Array(30).fill(100);
  near(I.atr(flat, flat, flat, 14)[29], 0);
});

test('rollingMaxPrior excludes the current bar', () => {
  const out = I.rollingMaxPrior([1, 2, 3, 4, 5], 2);
  near(out[2], 2); // max(1,2), not 3
  near(out[4], 4); // max(3,4), not 5
});

test('vwap of uniform prices equals the price', () => {
  const p = new Array(20).fill(50);
  const v = new Array(20).fill(1000);
  near(I.vwapFrom(p, p, p, v, 0)[19], 50);
});

test('supertrend follows the trend direction', () => {
  const n = 80;
  const upC = Array.from({ length: n }, (_, i) => 100 + i * 2);
  const upH = upC.map((x) => x + 1), upL = upC.map((x) => x - 1);
  assert.equal(I.supertrend(upH, upL, upC, 10, 3).trendUp[n - 1], true);
  const dnC = Array.from({ length: n }, (_, i) => 300 - i * 2);
  const dnH = dnC.map((x) => x + 1), dnL = dnC.map((x) => x - 1);
  assert.equal(I.supertrend(dnH, dnL, dnC, 10, 3).trendUp[n - 1], false);
});

test('stochastic %K nears 100 when closing at the highs', () => {
  const c = Array.from({ length: 40 }, (_, i) => 100 + i);
  const h = c.slice(), l = c.map((x) => x - 2);
  const st = I.stochastic(h, l, c, 14, 3, 3);
  assert.ok(st.k[39] > 90, `k=${st.k[39]}`);
});

test('macd line is positive in a steady uptrend', () => {
  const c = Array.from({ length: 100 }, (_, i) => 100 + i);
  const m = I.macd(c, 12, 26, 9);
  assert.ok(m.line[99] > 0);
  assert.ok(m.signal[99] > 0);
});

test('memoization returns cached results for the same array, fresh for new arrays', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const r1 = I.sma(a, 3);
  const r2 = I.sma(a, 3);
  assert.equal(r1, r2); // same reference = cache hit
  const b = a.slice();
  assert.notEqual(I.sma(b, 3), r1); // different array identity = recomputed
  near(I.sma(b, 3)[9], r1[9]); // ...but equal values
});
