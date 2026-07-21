// Technical indicators. All functions take plain number arrays and return
// arrays aligned to the input (null until enough data to compute).

function sma(vals, period) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += vals[i];
  seed /= period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  for (let i = period; i < vals.length; i++) {
    out[i] = vals[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// EMA over a series that may lead with nulls (e.g. MACD line).
function emaOverNullable(vals, period) {
  const out = new Array(vals.length).fill(null);
  const start = vals.findIndex((v) => v !== null);
  if (start < 0) return out;
  const slice = vals.slice(start);
  const e = ema(slice, period);
  for (let i = 0; i < e.length; i++) out[start + i] = e[i];
  return out;
}

// Wilder's RSI.
function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalP = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  const signal = emaOverNullable(line, signalP);
  const hist = line.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i] : null));
  return { line, signal, hist };
}

function stdev(vals, period) {
  const out = new Array(vals.length).fill(null);
  const means = sma(vals, period);
  for (let i = period - 1; i < vals.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = vals[j] - means[i];
      s += d * d;
    }
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  const upper = mid.map((m, i) => (m !== null ? m + mult * sd[i] : null));
  const lower = mid.map((m, i) => (m !== null ? m - mult * sd[i] : null));
  return { mid, upper, lower, sd };
}

// Wilder's ATR.
function atr(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  const tr = new Array(closes.length).fill(0);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < closes.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

function keltner(highs, lows, closes, period = 20, mult = 1.5) {
  const mid = ema(closes, period);
  const a = atr(highs, lows, closes, period);
  const upper = mid.map((m, i) => (m !== null && a[i] !== null ? m + mult * a[i] : null));
  const lower = mid.map((m, i) => (m !== null && a[i] !== null ? m - mult * a[i] : null));
  return { mid, upper, lower };
}

function stochastic(highs, lows, closes, kPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const raw = new Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    raw[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const k = smaOverNullable(raw, kSmooth);
  const d = smaOverNullable(k, dSmooth);
  return { k, d };
}

function smaOverNullable(vals, period) {
  const out = new Array(vals.length).fill(null);
  const start = vals.findIndex((v) => v !== null);
  if (start < 0) return out;
  const slice = vals.slice(start);
  const s = sma(slice, period);
  for (let i = 0; i < s.length; i++) out[start + i] = s[i];
  return out;
}

// Rolling max/min of the PRIOR `period` bars (excludes current bar).
function rollingMaxPrior(vals, period) {
  const out = new Array(vals.length).fill(null);
  for (let i = period; i < vals.length; i++) {
    let m = -Infinity;
    for (let j = i - period; j < i; j++) if (vals[j] > m) m = vals[j];
    out[i] = m;
  }
  return out;
}

function rollingMinPrior(vals, period) {
  const out = new Array(vals.length).fill(null);
  for (let i = period; i < vals.length; i++) {
    let m = Infinity;
    for (let j = i - period; j < i; j++) if (vals[j] < m) m = vals[j];
    out[i] = m;
  }
  return out;
}

// Session VWAP starting at index `startIdx` (inclusive).
function vwapFrom(highs, lows, closes, volumes, startIdx) {
  const out = new Array(closes.length).fill(null);
  if (startIdx < 0 || startIdx >= closes.length) return out;
  let cumPV = 0, cumV = 0;
  for (let i = startIdx; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumPV += tp * volumes[i];
    cumV += volumes[i];
    out[i] = cumV > 0 ? cumPV / cumV : closes[i];
  }
  return out;
}

// Supertrend. Returns { trendUp: bool[], line: number[] }.
function supertrend(highs, lows, closes, period = 10, mult = 3) {
  const n = closes.length;
  const trendUp = new Array(n).fill(null);
  const line = new Array(n).fill(null);
  const a = atr(highs, lows, closes, period);
  let fUb = null, fLb = null, up = true;
  for (let i = 0; i < n; i++) {
    if (a[i] === null) continue;
    const hl2 = (highs[i] + lows[i]) / 2;
    const ub = hl2 + mult * a[i];
    const lb = hl2 - mult * a[i];
    if (fUb === null) {
      fUb = ub; fLb = lb; up = closes[i] > hl2;
    } else {
      fUb = (ub < fUb || closes[i - 1] > fUb) ? ub : fUb;
      fLb = (lb > fLb || closes[i - 1] < fLb) ? lb : fLb;
      if (up && closes[i] < fLb) up = false;
      else if (!up && closes[i] > fUb) up = true;
    }
    trendUp[i] = up;
    line[i] = up ? fLb : fUb;
  }
  return { trendUp, line };
}

function avgVolume(volumes, period = 20) {
  return sma(volumes, period);
}

// ---- memoization ----
// Strategies recompute indicators on every evaluate() call. Results only
// depend on the input arrays (by identity — callers never mutate them) and
// the numeric parameters, so cache per-array via WeakMap. This turns the
// backtester's O(bars²) behavior into O(bars), and entries are garbage-
// collected with their arrays, so the live engine (fresh arrays every tick)
// can never see stale values.
const MEMO = new WeakMap();

function memoize(name, fn) {
  return (...args) => {
    const anchor = args[0];
    if (!Array.isArray(anchor)) return fn(...args);
    let m = MEMO.get(anchor);
    if (!m) { m = new Map(); MEMO.set(anchor, m); }
    const key = name + ':' + args.filter((a) => typeof a === 'number').join(',');
    if (m.has(key)) return m.get(key);
    const v = fn(...args);
    m.set(key, v);
    return v;
  };
}

module.exports = {
  sma: memoize('sma', sma),
  ema: memoize('ema', ema),
  rsi: memoize('rsi', rsi),
  macd: memoize('macd', macd),
  bollinger: memoize('bb', bollinger),
  atr: memoize('atr', atr),
  keltner: memoize('kc', keltner),
  stochastic: memoize('stoch', stochastic),
  rollingMaxPrior: memoize('rmax', rollingMaxPrior),
  rollingMinPrior: memoize('rmin', rollingMinPrior),
  vwapFrom: memoize('vwap', vwapFrom),
  supertrend: memoize('st', supertrend),
  avgVolume: memoize('avol', avgVolume),
  stdev: memoize('sd', stdev)
};
