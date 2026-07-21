// Minimal Alpaca REST client (trading + market data), paper and live.
// Uses the free IEX data feed. No SDK dependency — plain fetch.

const store = require('./store');
const logger = require('./logger');

const BASES = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets'
};
const DATA_BASE = 'https://data.alpaca.markets';

function credsFor(mode) {
  const key = store.getSecret(mode === 'live' ? 'liveKey' : 'paperKey');
  const secret = store.getSecret(mode === 'live' ? 'liveSecret' : 'paperSecret');
  return { key, secret };
}

function hasKeys(mode) {
  const { key, secret } = credsFor(mode);
  return !!(key && secret);
}

async function request(mode, base, path, { method = 'GET', body } = {}) {
  const { key, secret } = credsFor(mode);
  if (!key || !secret) {
    const err = new Error(`No ${mode} API keys configured`);
    err.code = 'NO_KEYS';
    throw err;
  }
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    // Network-level failure (offline, DNS, TLS) — no URL params are logged
    // beyond the path, and never any credentials.
    logger.warn('alpaca', `${method} ${path.split('?')[0]} network error: ${e.message}`);
    throw new Error(`Network error reaching Alpaca: ${e.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.msg)) || text || res.statusText;
    logger.debug('alpaca', `${method} ${path.split('?')[0]} -> ${res.status}: ${String(msg).slice(0, 300)}`);
    const err = new Error(`Alpaca ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const trade = (mode, path, opts) => request(mode, BASES[mode], path, opts);
const data = (mode, path, opts) => request(mode, DATA_BASE, path, opts);

// ---- Trading API ----

const getAccount = (mode) => trade(mode, '/v2/account');
const getClock = (mode) => trade(mode, '/v2/clock');
const getPositions = (mode) => trade(mode, '/v2/positions');
const getOpenOrders = (mode) => trade(mode, '/v2/orders?status=open&limit=200');

function getClosedOrdersSince(mode, afterIso) {
  const q = new URLSearchParams({
    status: 'closed', limit: '200', direction: 'asc', after: afterIso
  });
  return trade(mode, '/v2/orders?' + q.toString());
}

const getAsset = (mode, symbol) => trade(mode, '/v2/assets/' + encodeURIComponent(symbol.toUpperCase()));

// Entry orders: market, or marketable limit (limitPrice set) which caps the
// worst-case fill price on thin/fast names.
function submitBracketBuy(mode, { symbol, qty, takeProfit, stopLoss, clientId, limitPrice }) {
  return trade(mode, '/v2/orders', {
    method: 'POST',
    body: {
      symbol,
      qty: String(qty),
      side: 'buy',
      type: limitPrice ? 'limit' : 'market',
      ...(limitPrice ? { limit_price: String(limitPrice) } : {}),
      time_in_force: 'day',
      order_class: 'bracket',
      client_order_id: clientId,
      take_profit: { limit_price: String(takeProfit) },
      stop_loss: { stop_price: String(stopLoss) }
    }
  });
}

function submitMarketBuy(mode, { symbol, qty, clientId, limitPrice }) {
  return trade(mode, '/v2/orders', {
    method: 'POST',
    body: {
      symbol,
      qty: String(qty),
      side: 'buy',
      type: limitPrice ? 'limit' : 'market',
      ...(limitPrice ? { limit_price: String(limitPrice) } : {}),
      time_in_force: 'day',
      client_order_id: clientId
    }
  });
}

const cancelOrder = (mode, id) => trade(mode, '/v2/orders/' + encodeURIComponent(id), { method: 'DELETE' });

// Daily account equity/P&L series for the calendar view.
const getPortfolioHistory = (mode, period = '3M') =>
  trade(mode, `/v2/account/portfolio/history?period=${period}&timeframe=1D`);

// Trailing stop sell that protects an open long position.
function submitTrailingStop(mode, { symbol, qty, trailPercent, clientId }) {
  return trade(mode, '/v2/orders', {
    method: 'POST',
    body: {
      symbol,
      qty: String(qty),
      side: 'sell',
      type: 'trailing_stop',
      trail_percent: String(trailPercent),
      time_in_force: 'day',
      client_order_id: clientId
    }
  });
}

// Closes a position at market; cancel_orders drops bracket legs first.
const closePosition = (mode, symbol) =>
  trade(mode, `/v2/positions/${encodeURIComponent(symbol)}?cancel_orders=true`, { method: 'DELETE' });

const closeAllPositions = (mode) =>
  trade(mode, '/v2/positions?cancel_orders=true', { method: 'DELETE' });

// ---- Market data (IEX feed = free tier) ----

// Multi-symbol bars, paginated. Returns { SYM: [{t,o,h,l,c,v}, ...] } (ascending).
async function getBars(mode, symbols, timeframe, startIso, perSymbolLimit = 400) {
  const out = {};
  for (const s of symbols) out[s] = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({
      symbols: symbols.join(','),
      timeframe,
      start: startIso,
      limit: '10000',
      adjustment: 'raw',
      feed: 'iex',
      sort: 'asc'
    });
    if (pageToken) q.set('page_token', pageToken);
    const res = await data(mode, '/v2/stocks/bars?' + q.toString());
    const bars = (res && res.bars) || {};
    for (const sym of Object.keys(bars)) {
      if (!out[sym]) out[sym] = [];
      out[sym].push(...bars[sym]);
    }
    pageToken = res && res.next_page_token;
    if (!pageToken) break;
  }
  for (const s of Object.keys(out)) {
    if (out[s].length > perSymbolLimit) out[s] = out[s].slice(-perSymbolLimit);
  }
  return out;
}

// Market news (Benzinga via Alpaca). No symbols = market-wide latest.
function getNews(mode, { symbols, limit = 30 } = {}) {
  const q = new URLSearchParams({
    limit: String(limit),
    sort: 'desc',
    exclude_contentless: 'true',
    include_content: 'false'
  });
  if (symbols) q.set('symbols', symbols);
  return data(mode, '/v1beta1/news?' + q.toString());
}

// Market screeners: today's biggest movers and highest-volume names.
const getMovers = (mode) => data(mode, '/v1beta1/screener/stocks/movers?top=20');
const getMostActives = (mode) => data(mode, '/v1beta1/screener/stocks/most-actives?by=volume&top=20');

// Latest snapshot per symbol (price, day change).
async function getSnapshots(mode, symbols) {
  if (!symbols.length) return {};
  const q = new URLSearchParams({ symbols: symbols.join(','), feed: 'iex' });
  const res = await data(mode, '/v2/stocks/snapshots?' + q.toString());
  // API has returned both { snapshots: {SYM: ...} } and {SYM: ...} shapes.
  return (res && res.snapshots) || res || {};
}

module.exports = {
  hasKeys, getAccount, getClock, getPositions, getOpenOrders, getClosedOrdersSince,
  getAsset, submitBracketBuy, submitMarketBuy, submitTrailingStop,
  closePosition, closeAllPositions, getBars, getSnapshots,
  getMovers, getMostActives, getNews, cancelOrder, getPortfolioHistory
};
