// Trade log: open trades (entered, not yet exited) and closed round trips,
// persisted to trades.json in userData.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let filePath = null;
let db = null; // { open: [], closed: [], seenOrderIds: [] }

function load() {
  if (db) return db;
  filePath = path.join(app.getPath('userData'), 'trades.json');
  try {
    db = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    db = { open: [], closed: [], seenOrderIds: [] };
  }
  db.open = db.open || [];
  db.closed = db.closed || [];
  db.seenOrderIds = db.seenOrderIds || [];
  return db;
}

function persist() {
  const tmp = filePath + '.tmp';
  // Cap growth: keep last 5000 closed trades and last 2000 seen order ids.
  if (db.closed.length > 5000) db.closed = db.closed.slice(-5000);
  if (db.seenOrderIds.length > 2000) db.seenOrderIds = db.seenOrderIds.slice(-2000);
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function hasSeenOrder(orderId) {
  return load().seenOrderIds.includes(orderId);
}

function markSeen(orderId) {
  load();
  if (!db.seenOrderIds.includes(orderId)) db.seenOrderIds.push(orderId);
}

function openTrade({ symbol, qty, entryPrice, entryTime, strategy, mode, entryOrderId }) {
  load();
  const rec = {
    id: 'T' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    symbol, qty, entryPrice, entryTime, strategy, mode, entryOrderId
  };
  db.open.push(rec);
  persist();
  return rec;
}

function findOpen(symbol) {
  return load().open.find((t) => t.symbol === symbol) || null;
}

function listOpen() {
  return load().open.slice();
}

function closeTrade(symbol, { exitPrice, exitTime, exitOrderId, exitReason }) {
  load();
  const idx = db.open.findIndex((t) => t.symbol === symbol);
  if (idx < 0) return null;
  const t = db.open.splice(idx, 1)[0];
  const pl = (exitPrice - t.entryPrice) * t.qty;
  const plPct = t.entryPrice > 0 ? ((exitPrice - t.entryPrice) / t.entryPrice) * 100 : 0;
  const closed = {
    ...t, exitPrice, exitTime, exitOrderId, exitReason: exitReason || '',
    pl: Math.round(pl * 100) / 100,
    plPct: Math.round(plPct * 10000) / 10000
  };
  db.closed.push(closed);
  persist();
  return closed;
}

function removeOpen(symbol) {
  load();
  const idx = db.open.findIndex((t) => t.symbol === symbol);
  if (idx >= 0) { db.open.splice(idx, 1); persist(); }
}

function listClosed({ fromMs = 0, toMs = Infinity, symbol = null } = {}) {
  return load().closed.filter((t) => {
    const ts = Date.parse(t.exitTime);
    if (!(ts >= fromMs && ts <= toMs)) return false;
    if (symbol && t.symbol !== symbol.toUpperCase()) return false;
    return true;
  });
}

function stats(filter) {
  const trades = listClosed(filter || {});
  const wins = trades.filter((t) => t.pl > 0);
  const losses = trades.filter((t) => t.pl <= 0);
  const totalPl = trades.reduce((s, t) => s + t.pl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pl, 0));
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    totalPl: Math.round(totalPl * 100) / 100,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)
  };
}

function setNote(id, note) {
  load();
  const t = db.closed.find((x) => x.id === id);
  if (!t) throw new Error('Trade not found');
  t.note = note;
  persist();
  return { id, note };
}

function clearAll() {
  load();
  db = { open: [], closed: [], seenOrderIds: [] };
  persist();
}

function toCsv(trades) {
  const head = 'Date,Symbol,Strategy,Mode,Qty,Entry,Exit,P/L $,P/L %,Entry Time,Exit Time,Exit Reason,Notes';
  const rows = trades.map((t) => [
    (t.exitTime || '').slice(0, 10), t.symbol, t.strategy, t.mode, t.qty,
    t.entryPrice, t.exitPrice, t.pl, t.plPct.toFixed(2),
    t.entryTime, t.exitTime, '"' + String(t.exitReason || '').replace(/"/g, "'") + '"',
    '"' + String(t.note || '').replace(/"/g, "'") + '"'
  ].join(','));
  return [head, ...rows].join('\n');
}

module.exports = {
  openTrade, closeTrade, findOpen, listOpen, removeOpen,
  listClosed, stats, clearAll, toCsv, hasSeenOrder, markSeen, setNote
};
