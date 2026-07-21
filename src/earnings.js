// Earnings-day filter: stocks reporting earnings move violently, so the
// engine can skip symbols that report today. Uses Nasdaq's public earnings
// calendar. FAIL-OPEN by design: if the calendar can't be fetched, trading
// continues (with a warning in the technical log) rather than halting.
const logger = require('./logger');

let cache = { date: '', symbols: new Set(), fetchedOk: false };
let warnedDate = '';

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function refresh() {
  const today = todayLocal();
  if (cache.date === today && (cache.fetchedOk || warnedDate === today)) return cache;
  cache = { date: today, symbols: new Set(), fetchedOk: false };
  try {
    const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${today}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const rows = (json && json.data && json.data.rows) || [];
    for (const r of rows) {
      if (r && r.symbol) cache.symbols.add(String(r.symbol).toUpperCase());
    }
    cache.fetchedOk = true;
    logger.info('earnings', `calendar loaded: ${cache.symbols.size} symbols report today`);
  } catch (e) {
    if (warnedDate !== today) {
      warnedDate = today;
      logger.warn('earnings', 'calendar fetch failed (trading continues without the filter): ' + e.message);
    }
  }
  return cache;
}

function reportsToday(symbol) {
  return cache.symbols.has(String(symbol).toUpperCase());
}

function status() {
  return { date: cache.date, count: cache.symbols.size, fetchedOk: cache.fetchedOk };
}

module.exports = { refresh, reportsToday, status };
