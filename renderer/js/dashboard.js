// Dashboard view: engine control, account stats, positions, activity log.
TF.dashboard = (() => {
  let logBuffer = [];

  function renderStatus(st) {
    TF.state.status = st;
    const btn = TF.$('btnEngine');
    if (st.running) {
      btn.textContent = '■ Stop Engine';
      btn.classList.add('running');
    } else {
      btn.textContent = '▶ Start Engine';
      btn.classList.remove('running');
    }
    const pm = TF.$('pillMarket');
    const live = st.streaming && st.streaming.data;
    if (st.market) {
      if (st.market.is_open) {
        pm.innerHTML = (live ? '<span class="live-dot"></span>' : '') +
          'Market Open' + (live ? ' · live feed' : '');
        pm.className = 'pill open';
      } else {
        const next = st.market.next_open ? TF.dateTimeShort(st.market.next_open) : '';
        pm.textContent = 'Market Closed' + (next ? ' · opens ' + next : '');
        pm.className = 'pill closed';
      }
    } else {
      pm.textContent = 'Market —';
      pm.className = 'pill';
    }
    TF.$('pillStrategy').textContent = st.activeStrategy || '—';
    TF.$('lastTickNote').textContent = st.lastTick && st.lastTick.at
      ? `last scan ${TF.timeShort(st.lastTick.at)} — ${st.lastTick.note}` : '';

    const halt = TF.$('haltBanner');
    if (st.halted) {
      halt.textContent = '⛔ Trading halted for today: ' + st.halted.reason +
        ' (restart the engine to override)';
      halt.classList.remove('hidden');
    } else {
      halt.classList.add('hidden');
    }
    TF.$('setupBanner').classList.toggle('hidden', !!st.hasKeys);
    TF.$('authBanner').classList.toggle('hidden', !st.authFailed);
    TF.$('dashSubtitle').textContent = st.hasKeys
      ? (st.running ? 'Engine is scanning your watchlist.' : 'Engine stopped — press Start to begin scanning.')
      : 'Connect your Alpaca keys in Settings to begin.';
  }

  function renderAccount(a) {
    TF.state.account = a;
    if (!a) return;
    TF.$('stEquity').textContent = TF.money(a.equity);
    const dayPl = Number(a.equity) - Number(a.last_equity);
    const dayPct = Number(a.last_equity) > 0 ? (dayPl / Number(a.last_equity)) * 100 : 0;
    const el = TF.$('stDayPl');
    el.textContent = `${TF.money(dayPl)} (${TF.pct(dayPct)})`;
    el.className = 'stat-value ' + TF.plClass(dayPl);
    TF.$('stBp').textContent = TF.money(a.buying_power, 0);
    TF.$('stCash').textContent = TF.money(a.cash, 0);
    const dt = TF.$('stDayTrades');
    dt.textContent = String(a.daytrade_count ?? '—');
    dt.className = 'stat-value ' + (Number(a.equity) < 25000 && Number(a.daytrade_count) >= 3 ? 'neg' : '');
  }

  function renderPositions(list) {
    TF.state.positions = list || [];
    const body = TF.$('positionsBody');
    if (!list || !list.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No open positions</td></tr>';
      return;
    }
    body.innerHTML = list.map((p) => {
      const pl = Number(p.unrealized_pl);
      const plPct = Number(p.unrealized_plpc) * 100;
      return `<tr>
        <td><b>${TF.esc(p.symbol)}</b></td>
        <td>${TF.esc(p.qty)}</td>
        <td>${TF.money(p.avg_entry_price)}</td>
        <td>${TF.money(p.current_price)}</td>
        <td class="${TF.plClass(pl)}">${TF.money(pl)} (${TF.pct(plPct)})</td>
        <td><button class="btn btn-sm btn-danger-outline" data-close="${TF.esc(p.symbol)}">Close</button></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = async () => {
        const sym = b.getAttribute('data-close');
        if (await TF.confirm('Close position?', `Sell your entire ${sym} position at market?`)) {
          try {
            await TF.api('position:close', { symbol: sym });
            TF.toast(`Closing ${sym}…`, 'success');
          } catch (e) { TF.toast(e.message, 'error'); }
        }
      };
    });
  }

  // Per-symbol strategy signal states, pushed after every engine scan.
  const SIG_LABEL = { buy: 'BUY', sell: 'SELL', hold: 'HOLDING', watch: 'WATCHING', skip: 'SKIPPED' };
  function renderSignals(data) {
    const body = TF.$('signalsBody');
    const entries = Object.entries((data && data.states) || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (!entries.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">Start the engine to see live signal states</td></tr>';
      return;
    }
    body.innerHTML = entries.map(([sym, s]) => `<tr>
      <td><b>${TF.esc(sym)}</b></td>
      <td>${s.price !== null ? TF.money(s.price) : '—'}</td>
      <td><span class="sig-chip sig-${TF.esc(s.status)}">${SIG_LABEL[s.status] || s.status}</span></td>
      <td class="dim">${TF.esc(s.detail)}</td>
    </tr>`).join('');
  }

  // Live streamed price -> refresh that position's P/L without waiting for a poll.
  function onTick(data) {
    const pos = TF.state.positions.find((p) => p.symbol === data.symbol);
    if (!pos) return;
    const entry = Number(pos.avg_entry_price);
    pos.current_price = String(data.price);
    pos.unrealized_pl = String((data.price - entry) * Number(pos.qty));
    pos.unrealized_plpc = String(entry > 0 ? (data.price / entry - 1) : 0);
    renderPositions(TF.state.positions);
  }

  function pushLog(entry) {
    logBuffer.push(entry);
    if (logBuffer.length > 300) logBuffer = logBuffer.slice(-300);
    renderLogs();
  }

  function renderLogs() {
    const feed = TF.$('logFeed');
    feed.innerHTML = logBuffer.slice().reverse().map((l) =>
      `<div class="log-line ${TF.esc(l.level)}"><span class="ts">${TF.timeShort(l.ts)}</span>${TF.esc(l.msg)}</div>`
    ).join('');
  }

  async function refreshToday() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const s = await TF.apiQuiet('trades:stats', { fromMs: startOfDay });
    if (!s) return;
    const el = TF.$('stToday');
    el.textContent = `${s.count} / ${s.winRate.toFixed(0)}% / ${TF.money(s.totalPl)}`;
    el.className = 'stat-value ' + TF.plClass(s.totalPl);
  }

  async function toggleEngine() {
    const btn = TF.$('btnEngine');
    btn.disabled = true;
    try {
      if (TF.state.status && TF.state.status.running) {
        renderStatus(await TF.api('engine:stop'));
        TF.toast('Engine stopped');
      } else {
        const mode = TF.state.settings ? TF.state.settings.mode : 'paper';
        if (mode === 'live') {
          const sure = await TF.confirm('Start LIVE engine?',
            'The engine will trade with real money automatically while running. Continue?');
          if (!sure) { btn.disabled = false; return; }
        }
        renderStatus(await TF.api('engine:start'));
        TF.toast('Engine started', 'success');
      }
    } catch (e) {
      TF.toast(e.message, 'error');
    }
    btn.disabled = false;
  }

  // Live index mini-charts (TradingView widget; index CFD feeds are the
  // symbols the free embed supports).
  function miniChartUrl(symbol) {
    const cfg = {
      symbol, dateRange: '1D', colorTheme: 'dark',
      isTransparent: true, autosize: true, locale: 'en'
    };
    return 'https://www.tradingview-widget.com/embed-widget/mini-symbol-overview/?locale=en#'
      + encodeURIComponent(JSON.stringify(cfg));
  }

  function loadMarketCharts() {
    // Index ETFs rather than CFD feeds: CFDs trade nearly 24h, so the charts
    // kept moving after the US close. SPY/DIA/QQQ stop at the closing bell.
    TF.$('miniSpx').src = miniChartUrl('AMEX:SPY');
    TF.$('miniDow').src = miniChartUrl('AMEX:DIA');
    TF.$('miniNdq').src = miniChartUrl('NASDAQ:QQQ');
  }

  async function init() {
    TF.$('btnEngine').onclick = toggleEngine;
    loadMarketCharts();
    TF.$('btnCloseAll').onclick = async () => {
      if (!TF.state.positions.length) { TF.toast('No open positions'); return; }
      if (await TF.confirm('Close ALL positions?',
        `Sell all ${TF.state.positions.length} open position(s) at market?`)) {
        try {
          await TF.api('positions:closeAll');
          TF.toast('Closing all positions…', 'success');
        } catch (e) { TF.toast(e.message, 'error'); }
      }
    };
    TF.$('linkGoSettings').onclick = (e) => { e.preventDefault(); TF.showView('settings'); };
    TF.$('linkAuthSettings').onclick = (e) => { e.preventDefault(); TF.showView('settings'); };

    const logs = await TF.apiQuiet('logs:get');
    if (logs) { logBuffer = logs; renderLogs(); }
    renderStatus(await TF.api('engine:status'));
    const acct = await TF.apiQuiet('account:get');
    if (acct) renderAccount(acct);
    const pos = await TF.apiQuiet('positions:get');
    if (pos) renderPositions(pos);
    refreshToday();
    setInterval(refreshToday, 60000);
  }

  return { init, renderStatus, renderAccount, renderPositions, pushLog, refreshToday, renderSignals, onTick };
})();
