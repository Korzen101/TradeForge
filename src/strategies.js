// Strategy library. Each strategy:
//   evaluate(ctx) -> { action: 'buy' | 'sell' | null, reason: string }
// ctx = {
//   c, h, l, v, t: aligned arrays (closes, highs, lows, volumes, ISO timestamps)
//   i: index of the last completed bar
//   params: resolved params (defaults + user overrides)
//   pos: { qty, entry } | null   (long-only; 'sell' means exit)
//   session: { startIdx, minutesSinceOpen } | null  (today's regular session)
// }
// All strategies are long-only. Hard stop-loss / take-profit are handled by
// the engine via bracket orders, independent of strategy exits.

const I = require('./indicators');

function crossedAbove(a, b, i) {
  return a[i] !== null && b[i] !== null && a[i - 1] !== null && b[i - 1] !== null &&
    a[i - 1] <= b[i - 1] && a[i] > b[i];
}
function crossedBelow(a, b, i) {
  return a[i] !== null && b[i] !== null && a[i - 1] !== null && b[i - 1] !== null &&
    a[i - 1] >= b[i - 1] && a[i] < b[i];
}

const STRATEGIES = [
  {
    id: 'bollinger_reversion',
    name: 'Bollinger Band Reversion',
    category: 'Mean Reversion',
    blurb: 'Buys when price snaps back inside the lower Bollinger Band after an oversold stretch; exits at the middle or upper band.',
    profile: 'Historically high win rate in range-bound/choppy markets; struggles in strong downtrends. Small average wins — depends on strict stops.',
    params: [
      { key: 'period', label: 'Band period', def: 20, min: 5, max: 100, step: 1,
        help: 'How many bars build the moving average and bands. Shorter reacts faster to price but produces more false "snap-back" signals; longer is steadier but slower.' },
      { key: 'mult', label: 'Std dev multiplier', def: 2, min: 1, max: 4, step: 0.1,
        help: 'Band width in standard deviations. At 2.0, price closes outside the bands only ~5% of the time — raising it means rarer but more extreme oversold entries.' },
      { key: 'exitAt', label: 'Exit target (mid=1, upper=2)', def: 1, min: 1, max: 2, step: 1,
        help: 'Where to take profit: 1 sells at the middle band (hit more often, smaller wins); 2 holds for the upper band (bigger wins, but price often turns back early).' }
    ],
    evaluate(ctx) {
      const { c, i, params, pos } = ctx;
      const bb = I.bollinger(c, params.period, params.mult);
      if (bb.lower[i] === null || bb.lower[i - 1] === null) return { action: null, reason: 'warming up' };
      if (!pos) {
        if (c[i - 1] < bb.lower[i - 1] && c[i] > bb.lower[i]) {
          return { action: 'buy', reason: `re-entered lower BB (close ${c[i].toFixed(2)} > band ${bb.lower[i].toFixed(2)})` };
        }
        return { action: null, reason: 'no setup' };
      }
      const target = params.exitAt >= 2 ? bb.upper[i] : bb.mid[i];
      if (target !== null && c[i] >= target) {
        return { action: 'sell', reason: `reached ${params.exitAt >= 2 ? 'upper' : 'middle'} band target ${target.toFixed(2)}` };
      }
      return { action: null, reason: 'holding to band target' };
    }
  },
  {
    id: 'rsi2_reversion',
    name: 'RSI(2) Mean Reversion',
    category: 'Mean Reversion',
    blurb: 'Connors-style deep-oversold dip buying: RSI(2) under the buy threshold while price holds above a long moving average; exits when RSI recovers.',
    profile: 'Among the highest historical win rates of published short-term strategies on liquid ETFs (Connors Research). Wins are small; the trend filter is essential.',
    params: [
      { key: 'rsiPeriod', label: 'RSI period', def: 2, min: 2, max: 14, step: 1,
        help: 'RSI lookback in bars. 2 is the Connors classic — deliberately twitchy, measuring a two-bar panic rather than a broad trend.' },
      { key: 'buyBelow', label: 'Buy when RSI below', def: 10, min: 2, max: 30, step: 1,
        help: 'Entry threshold. Below 10 means only deep, washed-out dips qualify. Raising it trades more often but each dip is weaker.' },
      { key: 'exitAbove', label: 'Exit when RSI above', def: 65, min: 40, max: 90, step: 1,
        help: 'Sell once RSI recovers past this level. Lower exits are quicker and safer; higher squeezes more from each bounce.' },
      { key: 'trendSma', label: 'Trend filter SMA', def: 100, min: 20, max: 200, step: 5,
        help: 'Only buy dips while price is above this long moving average — i.e. buy panics inside an uptrend instead of catching a collapsing stock.' }
    ],
    evaluate(ctx) {
      const { c, i, params, pos } = ctx;
      const r = I.rsi(c, params.rsiPeriod);
      const trend = I.sma(c, params.trendSma);
      if (r[i] === null) return { action: null, reason: 'warming up' };
      if (!pos) {
        const trendOk = trend[i] === null || c[i] > trend[i];
        if (r[i] < params.buyBelow && trendOk) {
          return { action: 'buy', reason: `RSI(${params.rsiPeriod}) ${r[i].toFixed(1)} < ${params.buyBelow} above trend SMA` };
        }
        return { action: null, reason: 'no setup' };
      }
      if (r[i] > params.exitAbove) {
        return { action: 'sell', reason: `RSI recovered to ${r[i].toFixed(1)}` };
      }
      return { action: null, reason: 'waiting for RSI recovery' };
    }
  },
  {
    id: 'ema_crossover',
    name: 'EMA 9/21 Crossover',
    category: 'Trend Following',
    blurb: 'Classic momentum entry: fast EMA crossing above slow EMA opens a position; the reverse cross closes it.',
    profile: 'Lower win rate (~35–45% historically) but catches the occasional large trend move. Whipsaws in flat markets — best on trending symbols.',
    params: [
      { key: 'fast', label: 'Fast EMA', def: 9, min: 3, max: 50, step: 1,
        help: 'The quick average tracking recent price. Smaller enters trends earlier but gets faked out more often in chop.' },
      { key: 'slow', label: 'Slow EMA', def: 21, min: 10, max: 200, step: 1,
        help: 'The baseline trend average. The wider the gap between fast and slow, the more decisive a move must be before the bot acts.' }
    ],
    evaluate(ctx) {
      const { c, i, params, pos } = ctx;
      const fast = I.ema(c, params.fast);
      const slow = I.ema(c, params.slow);
      if (!pos && crossedAbove(fast, slow, i)) {
        return { action: 'buy', reason: `EMA${params.fast} crossed above EMA${params.slow}` };
      }
      if (pos && crossedBelow(fast, slow, i)) {
        return { action: 'sell', reason: `EMA${params.fast} crossed below EMA${params.slow}` };
      }
      return { action: null, reason: pos ? 'trend intact' : 'no cross' };
    }
  },
  {
    id: 'macd_momentum',
    name: 'MACD Momentum',
    category: 'Momentum',
    blurb: 'Buys when the MACD line crosses above its signal line with a rising histogram; exits on the opposite cross.',
    profile: 'Moderate historical win rate; performs best when a symbol is making sustained directional moves. Late entries by design.',
    params: [
      { key: 'fast', label: 'Fast EMA', def: 12, min: 5, max: 50, step: 1,
        help: 'Short EMA of the pair whose difference forms the MACD line — the "speed" of price.' },
      { key: 'slow', label: 'Slow EMA', def: 26, min: 10, max: 100, step: 1,
        help: 'Long EMA of the pair. 12/26 are the values Gerald Appel published in the 1970s and remain the standard.' },
      { key: 'signal', label: 'Signal period', def: 9, min: 3, max: 30, step: 1,
        help: 'Smoothing of the MACD line itself; the trade fires when MACD crosses this signal line. Shorter = earlier but noisier crosses.' }
    ],
    evaluate(ctx) {
      const { c, i, params, pos } = ctx;
      const m = I.macd(c, params.fast, params.slow, params.signal);
      if (!pos && crossedAbove(m.line, m.signal, i) && m.hist[i] !== null && m.hist[i] > 0) {
        return { action: 'buy', reason: 'MACD crossed above signal' };
      }
      if (pos && crossedBelow(m.line, m.signal, i)) {
        return { action: 'sell', reason: 'MACD crossed below signal' };
      }
      return { action: null, reason: pos ? 'momentum intact' : 'no cross' };
    }
  },
  {
    id: 'vwap_reversion',
    name: 'VWAP Reversion',
    category: 'Mean Reversion',
    blurb: 'Intraday classic: buys when price stretches a set % below session VWAP and starts to stabilize; exits when price tags VWAP.',
    profile: 'High historical win rate on liquid large caps in normal conditions; dangerous on news-driven selloffs — keep the stop-loss on.',
    params: [
      { key: 'devPct', label: 'Deviation below VWAP %', def: 0.5, min: 0.1, max: 3, step: 0.1,
        help: 'How far price must stretch below the session\'s volume-weighted average price before it counts as oversold. Larger = rarer but stronger snap-back setups; 0.5% suits calm large-caps, 1%+ suits volatile names.' }
    ],
    evaluate(ctx) {
      const { c, h, l, v, i, params, pos, session } = ctx;
      if (!session || session.startIdx < 0) return { action: null, reason: 'no session data' };
      const vw = I.vwapFrom(h, l, c, v, session.startIdx);
      if (vw[i] === null) return { action: null, reason: 'warming up' };
      if (!pos) {
        const dev = (vw[i] - c[i]) / vw[i] * 100;
        if (dev >= params.devPct && c[i] > c[i - 1]) {
          return { action: 'buy', reason: `${dev.toFixed(2)}% below VWAP and stabilizing` };
        }
        return { action: null, reason: 'no setup' };
      }
      if (c[i] >= vw[i]) return { action: 'sell', reason: 'tagged VWAP' };
      return { action: null, reason: 'holding to VWAP' };
    }
  },
  {
    id: 'orb_breakout',
    name: 'Opening Range Breakout',
    category: 'Breakout',
    blurb: 'Waits for the first N minutes of the session to define a range, then buys a breakout above the range high on elevated volume.',
    profile: 'One of the most-studied day-trading setups. Win rate is modest but winners tend to run; volume confirmation filters weak breaks.',
    params: [
      { key: 'rangeMin', label: 'Opening range (minutes)', def: 30, min: 5, max: 90, step: 5,
        help: 'How many minutes after the 9:30 open define the range. 30 is the classic; shorter ranges give earlier breakouts that fail more often.' },
      { key: 'volMult', label: 'Volume multiple', def: 1.2, min: 1, max: 3, step: 0.1,
        help: 'The breakout bar\'s volume must be at least this multiple of the recent average — real breakouts attract volume, quiet ones tend to drift back.' },
      { key: 'exitBufferPct', label: 'Exit if back below high by %', def: 0.3, min: 0.1, max: 2, step: 0.1,
        help: 'How much the price may dip back under the range high before the bot gives up on the breakout. Bigger buffer = more breathing room but larger give-back.' }
    ],
    evaluate(ctx) {
      const { c, h, v, t, i, params, pos, session } = ctx;
      if (!session || session.startIdx < 0) return { action: null, reason: 'no session data' };
      if (session.minutesSinceOpen < params.rangeMin) return { action: null, reason: 'range forming' };
      const openTs = Date.parse(t[session.startIdx]);
      let orHigh = -Infinity;
      for (let j = session.startIdx; j <= i; j++) {
        if (Date.parse(t[j]) - openTs < params.rangeMin * 60000) {
          if (h[j] > orHigh) orHigh = h[j];
        } else break;
      }
      if (!isFinite(orHigh)) return { action: null, reason: 'no range bars' };
      const avgVol = I.avgVolume(v, 20);
      if (!pos) {
        const volOk = avgVol[i] === null || v[i] >= avgVol[i] * params.volMult;
        if (c[i - 1] <= orHigh && c[i] > orHigh && volOk) {
          return { action: 'buy', reason: `broke opening-range high ${orHigh.toFixed(2)} on volume` };
        }
        return { action: null, reason: 'no breakout' };
      }
      if (c[i] < orHigh * (1 - params.exitBufferPct / 100)) {
        return { action: 'sell', reason: 'fell back below opening-range high' };
      }
      return { action: null, reason: 'breakout holding' };
    }
  },
  {
    id: 'squeeze_breakout',
    name: 'Bollinger Squeeze Breakout',
    category: 'Breakout',
    blurb: 'Detects volatility compression (Bollinger Bands inside Keltner Channels), then buys the upside expansion when bands release.',
    profile: 'Selective — fires rarely, but historically strong reward/risk when volatility expands after compression (TTM Squeeze family).',
    params: [
      { key: 'period', label: 'Period', def: 20, min: 10, max: 50, step: 1,
        help: 'Lookback for both the Bollinger Bands and Keltner Channel.' },
      { key: 'bbMult', label: 'BB std dev', def: 2, min: 1, max: 3, step: 0.1,
        help: 'Bollinger width in standard deviations — the "volatility" band that squeezes when the market goes quiet.' },
      { key: 'kcMult', label: 'Keltner ATR mult', def: 1.5, min: 1, max: 3, step: 0.1,
        help: 'Keltner width in ATRs. A squeeze = Bollinger fully inside Keltner. Widening this makes squeezes more common; narrowing makes them rarer and more explosive.' }
    ],
    evaluate(ctx) {
      const { c, h, l, i, params, pos } = ctx;
      const bb = I.bollinger(c, params.period, params.bbMult);
      const kc = I.keltner(h, l, c, params.period, params.kcMult);
      const emaMid = kc.mid;
      if (bb.upper[i] === null || kc.upper[i] === null || bb.upper[i - 1] === null || kc.upper[i - 1] === null) {
        return { action: null, reason: 'warming up' };
      }
      const inSqueezePrev = bb.upper[i - 1] < kc.upper[i - 1] && bb.lower[i - 1] > kc.lower[i - 1];
      if (!pos) {
        if (inSqueezePrev && c[i] > bb.upper[i]) {
          return { action: 'buy', reason: 'squeeze released to the upside' };
        }
        return { action: null, reason: inSqueezePrev ? 'in squeeze, waiting' : 'no squeeze' };
      }
      if (emaMid[i] !== null && c[i] < emaMid[i]) {
        return { action: 'sell', reason: 'closed below channel midline' };
      }
      return { action: null, reason: 'riding expansion' };
    }
  },
  {
    id: 'stochastic_reversal',
    name: 'Stochastic Reversal',
    category: 'Mean Reversion',
    blurb: 'Buys when %K crosses above %D deep in oversold territory; exits when the cross reverses in overbought territory.',
    profile: 'Solid historical win rate in sideways markets, similar temperament to RSI strategies. Prone to early entries in strong downtrends.',
    params: [
      { key: 'kPeriod', label: '%K period', def: 14, min: 5, max: 30, step: 1,
        help: 'Lookback for %K — where the current price sits within the recent high-low range (0 = at the lows, 100 = at the highs).' },
      { key: 'kSmooth', label: '%K smoothing', def: 3, min: 1, max: 10, step: 1,
        help: 'Smoothing applied to raw %K. Higher = cleaner but later signals.' },
      { key: 'dSmooth', label: '%D smoothing', def: 3, min: 1, max: 10, step: 1,
        help: '%D is a moving average of %K; the buy trigger is %K crossing above %D.' },
      { key: 'oversold', label: 'Oversold level', def: 20, min: 5, max: 40, step: 1,
        help: 'The cross only counts as a reversal if it happens down here. Lower = deeper washouts only.' },
      { key: 'overbought', label: 'Overbought level', def: 80, min: 60, max: 95, step: 1,
        help: 'Exits trigger when %K crosses back down in this upper zone.' }
    ],
    evaluate(ctx) {
      const { c, h, l, i, params, pos } = ctx;
      const st = I.stochastic(h, l, c, params.kPeriod, params.kSmooth, params.dSmooth);
      if (st.k[i] === null || st.d[i] === null) return { action: null, reason: 'warming up' };
      if (!pos) {
        if (crossedAbove(st.k, st.d, i) && st.k[i] < params.oversold + 10 && st.d[i] < params.oversold + 10 && Math.min(st.k[i - 1], st.d[i - 1]) < params.oversold) {
          return { action: 'buy', reason: `%K crossed %D from oversold (${st.k[i].toFixed(0)})` };
        }
        return { action: null, reason: 'no setup' };
      }
      if (crossedBelow(st.k, st.d, i) && st.k[i] > params.overbought - 10) {
        return { action: 'sell', reason: `%K crossed below %D in overbought (${st.k[i].toFixed(0)})` };
      }
      return { action: null, reason: 'holding' };
    }
  },
  {
    id: 'donchian_breakout',
    name: 'Donchian Channel Breakout',
    category: 'Breakout',
    blurb: 'Turtle-style: buys a close above the prior N-bar high; exits on a close below the prior M-bar low.',
    profile: 'The classic trend-capture system. Win rate is low (~30–40% historically) but average winners are large — needs patience and discipline.',
    params: [
      { key: 'entryPeriod', label: 'Entry lookback', def: 20, min: 5, max: 100, step: 1,
        help: 'Buy when price closes above the highest high of this many prior bars. Longer = only major, well-established breakouts qualify.' },
      { key: 'exitPeriod', label: 'Exit lookback', def: 10, min: 3, max: 50, step: 1,
        help: 'Exit when price closes below the lowest low of this many prior bars — a trailing floor that rises as the trend advances. Shorter locks in profit sooner.' }
    ],
    evaluate(ctx) {
      const { c, h, l, i, params, pos } = ctx;
      const hh = I.rollingMaxPrior(h, params.entryPeriod);
      const ll = I.rollingMinPrior(l, params.exitPeriod);
      if (hh[i] === null || ll[i] === null) return { action: null, reason: 'warming up' };
      if (!pos && c[i] > hh[i]) {
        return { action: 'buy', reason: `closed above ${params.entryPeriod}-bar high ${hh[i].toFixed(2)}` };
      }
      if (pos && c[i] < ll[i]) {
        return { action: 'sell', reason: `closed below ${params.exitPeriod}-bar low ${ll[i].toFixed(2)}` };
      }
      return { action: null, reason: pos ? 'trend intact' : 'no breakout' };
    }
  },
  {
    id: 'supertrend',
    name: 'Supertrend Follower',
    category: 'Trend Following',
    blurb: 'Rides the ATR-based Supertrend line: buys when trend flips up, exits when it flips down.',
    profile: 'Popular volatility-adaptive trend system. Fewer whipsaws than raw MA crosses; still gives back profit at trend turns.',
    params: [
      { key: 'period', label: 'ATR period', def: 10, min: 5, max: 30, step: 1,
        help: 'Lookback for Average True Range — the volatility measure that sets how far the trend line trails price.' },
      { key: 'mult', label: 'ATR multiplier', def: 3, min: 1, max: 6, step: 0.5,
        help: 'Distance of the Supertrend line in ATRs. Larger = fewer whipsaw flips but gives back more profit before exiting; smaller = tighter but jumpier.' }
    ],
    evaluate(ctx) {
      const { c, h, l, i, params, pos } = ctx;
      const st = I.supertrend(h, l, c, params.period, params.mult);
      if (st.trendUp[i] === null || st.trendUp[i - 1] === null) return { action: null, reason: 'warming up' };
      if (!pos && st.trendUp[i] && !st.trendUp[i - 1]) {
        return { action: 'buy', reason: 'Supertrend flipped up' };
      }
      if (pos && !st.trendUp[i] && st.trendUp[i - 1]) {
        return { action: 'sell', reason: 'Supertrend flipped down' };
      }
      return { action: null, reason: pos ? 'uptrend intact' : 'waiting for flip' };
    }
  }
];

function list() {
  return STRATEGIES.map((s) => ({
    id: s.id, name: s.name, category: s.category, blurb: s.blurb, profile: s.profile, params: s.params
  }));
}

function getById(id) {
  return STRATEGIES.find((s) => s.id === id) || null;
}

function resolveParams(strategy, overrides) {
  const out = {};
  for (const p of strategy.params) {
    const o = overrides && overrides[p.key];
    out[p.key] = typeof o === 'number' && isFinite(o) ? o : p.def;
  }
  return out;
}

module.exports = { list, getById, resolveParams };
