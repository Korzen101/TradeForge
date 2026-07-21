// Realtime WebSocket streams from Alpaca:
//   - trade updates (order fills) -> instant trade-log/notifications, no
//     reconcile lag, trailing stops attach the moment a buy fills
//   - IEX market data (1-min bars) -> live prices for the dashboard
// Both reconnect with backoff. If a stream can't connect (e.g. Alpaca allows
// only ONE data connection per account — running the app on two machines at
// once will reject the second), the app quietly keeps working on REST polling.
const store = require('./store');
const logger = require('./logger');

const TRADE_URLS = {
  paper: 'wss://paper-api.alpaca.markets/stream',
  live: 'wss://api.alpaca.markets/stream'
};
const DATA_URL = 'wss://stream.data.alpaca.markets/v2/iex';

let handlers = { fill: () => {}, price: () => {}, status: () => {} };
let mode = null;
let symbols = [];
let stopped = true;

const conns = {
  trade: { ws: null, ok: false, retry: null, backoff: 5000 },
  data: { ws: null, ok: false, retry: null, backoff: 5000 }
};

function setHandlers(h) { handlers = { ...handlers, ...h }; }

function creds() {
  return {
    key: store.getSecret(mode === 'live' ? 'liveKey' : 'paperKey'),
    secret: store.getSecret(mode === 'live' ? 'liveSecret' : 'paperSecret')
  };
}

function teardown(name) {
  const c = conns[name];
  if (c.retry) { clearTimeout(c.retry); c.retry = null; }
  if (c.ws) {
    try { c.ws.onclose = null; c.ws.onerror = null; c.ws.close(); } catch (_) {}
    c.ws = null;
  }
  if (c.ok) { c.ok = false; handlers.status(); }
}

function scheduleReconnect(name, connectFn) {
  const c = conns[name];
  if (stopped || c.retry) return;
  c.retry = setTimeout(() => {
    c.retry = null;
    if (!stopped) connectFn();
  }, c.backoff);
  c.backoff = Math.min(c.backoff * 2, 120000);
}

// ---- trade updates (order fills) ----

function connectTrade() {
  teardown('trade');
  const { key, secret } = creds();
  if (!key || !secret) return;
  let ws;
  try { ws = new WebSocket(TRADE_URLS[mode]); } catch (e) {
    logger.warn('stream', 'trade stream open failed: ' + e.message);
    return scheduleReconnect('trade', connectTrade);
  }
  const c = conns.trade;
  c.ws = ws;
  ws.binaryType = 'arraybuffer';
  let debugFrames = 0;
  // NOTE: the trading stream uses the legacy auth message format
  // (authenticate/key_id), unlike the market-data stream (auth/key).
  ws.onopen = () => {
    logger.debug('stream', 'trade ws open — authenticating');
    ws.send(JSON.stringify({ action: 'auth', key, secret }));
  };
  ws.onmessage = (ev) => {
    let text = null;
    if (typeof ev.data === 'string') {
      text = ev.data;
    } else if (ev.data instanceof ArrayBuffer) {
      // Server sent a binary frame; try UTF-8 (some proxies re-frame JSON).
      try { text = new TextDecoder().decode(ev.data); } catch (_) {}
    }
    if (debugFrames < 3) {
      debugFrames++;
      const preview = text ? text.slice(0, 160)
        : '[binary ' + (ev.data && ev.data.byteLength) + ' bytes: ' +
          Array.from(new Uint8Array(ev.data.slice(0, 12))).map((b) => b.toString(16).padStart(2, '0')).join(' ') + ']';
      logger.debug('stream', 'trade ws frame: ' + preview);
    }
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    if (msg.stream === 'authorization') {
      if (msg.data && (msg.data.status === 'authorized' || msg.data.status === 'active')) {
        ws.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
        c.ok = true;
        c.backoff = 5000;
        logger.info('stream', `trade-updates stream connected (${mode})`);
        handlers.status();
      } else {
        logger.warn('stream', 'trade stream auth rejected');
        ws.close();
      }
    } else if (msg.stream === 'trade_updates' && msg.data) {
      const { event, order } = msg.data;
      // Only the terminal 'fill' carries the complete filled_qty. processFill
      // dedupes by order id, so forwarding an earlier 'partial_fill' would lock
      // in an understated quantity. An order that only ever partially fills and
      // is then cancelled is caught by the REST reconciler instead.
      if (event === 'fill' && order) {
        handlers.fill(order);
      }
    }
  };
  ws.onerror = () => { /* onclose follows */ };
  ws.onclose = (ev) => {
    const was = c.ok;
    c.ok = false;
    c.ws = null;
    logger.debug('stream', `trade ws closed (code ${ev && ev.code}, was ${was ? 'connected' : 'never authorized'})`);
    if (was) { logger.warn('stream', 'trade-updates stream disconnected'); handlers.status(); }
    scheduleReconnect('trade', connectTrade);
  };
}

// ---- market data (1-min bars for live prices) ----

function connectData() {
  teardown('data');
  const { key, secret } = creds();
  if (!key || !secret || !symbols.length) return;
  let ws;
  try { ws = new WebSocket(DATA_URL); } catch (e) {
    logger.warn('stream', 'data stream open failed: ' + e.message);
    return scheduleReconnect('data', connectData);
  }
  const c = conns.data;
  c.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ action: 'auth', key, secret }));
  ws.onmessage = (ev) => {
    let arr;
    try { arr = JSON.parse(ev.data); } catch (_) { return; }
    if (!Array.isArray(arr)) return;
    for (const m of arr) {
      if (m.T === 'success' && m.msg === 'authenticated') {
        ws.send(JSON.stringify({ action: 'subscribe', bars: symbols }));
        c.ok = true;
        c.backoff = 5000;
        logger.info('stream', `market-data stream connected (${symbols.length} symbols)`);
        handlers.status();
      } else if (m.T === 'b') {
        handlers.price(m.S, m.c, m.t);
      } else if (m.T === 'error') {
        // 406 = connection limit (another session holds the data stream).
        logger.warn('stream', `data stream error ${m.code}: ${m.msg} — falling back to polling`);
        if (m.code === 406) { c.backoff = 300000; } // don't fight over the slot
      }
    }
  };
  ws.onerror = () => { /* onclose follows */ };
  ws.onclose = () => {
    const was = c.ok;
    c.ok = false;
    c.ws = null;
    if (was) { logger.warn('stream', 'market-data stream disconnected'); handlers.status(); }
    scheduleReconnect('data', connectData);
  };
}

// Idempotent: reconnects only when mode/symbols actually changed or a
// connection is down. Called from the engine's pulse (every ~20s).
function ensure(newMode, newSymbols) {
  stopped = false;
  const symsChanged = newSymbols.join(',') !== symbols.join(',');
  const modeChanged = newMode !== mode;
  mode = newMode;
  symbols = newSymbols.slice();
  if (typeof WebSocket === 'undefined') return; // very old runtime; polling only
  if (modeChanged || (!conns.trade.ws && !conns.trade.retry)) connectTrade();
  if (modeChanged || symsChanged || (!conns.data.ws && !conns.data.retry)) connectData();
}

function stop() {
  stopped = true;
  teardown('trade');
  teardown('data');
}

function status() {
  return { trade: conns.trade.ok, data: conns.data.ok };
}

module.exports = { setHandlers, ensure, stop, status };
