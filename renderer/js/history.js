// History view: closed trades, summary stats, CSV export.
TF.history = (() => {
  function currentFilter() {
    const days = Number(TF.$('histRange').value);
    const symbol = TF.$('histSymbol').value.trim() || null;
    let fromMs = 0;
    if (days === 1) {
      const now = new Date();
      fromMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    } else if (days > 1) {
      fromMs = Date.now() - days * 24 * 3600e3;
    }
    return { fromMs, symbol };
  }

  async function refresh() {
    const filter = currentFilter();
    const [trades, stats] = await Promise.all([
      TF.apiQuiet('trades:list', filter),
      TF.apiQuiet('trades:stats', filter)
    ]);
    if (stats) {
      const plEl = TF.$('hsPl');
      plEl.textContent = TF.money(stats.totalPl);
      plEl.className = 'stat-value ' + TF.plClass(stats.totalPl);
      TF.$('hsCount').textContent = `${stats.count} (${stats.wins}W / ${stats.losses}L)`;
      TF.$('hsWin').textContent = stats.count ? stats.winRate.toFixed(1) + '%' : '—';
      TF.$('hsAvg').textContent = stats.count
        ? `${TF.money(stats.avgWin)} / ${TF.money(-stats.avgLoss)}` : '—';
      TF.$('hsPf').textContent = stats.count
        ? (isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞') : '—';
    }
    renderAnalytics(trades || []);
    const body = TF.$('historyBody');
    if (!trades || !trades.length) {
      body.innerHTML = '<tr><td colspan="10" class="empty">No trades in this range</td></tr>';
      return;
    }
    body.innerHTML = trades.map((t) => `<tr>
      <td>${TF.dateTimeShort(t.exitTime)}</td>
      <td><b>${TF.esc(t.symbol)}</b></td>
      <td>${TF.esc(t.strategy)}</td>
      <td>${t.qty}</td>
      <td>${TF.money(t.entryPrice)}</td>
      <td>${TF.money(t.exitPrice)}</td>
      <td class="${TF.plClass(t.pl)}">${TF.money(t.pl)}</td>
      <td class="${TF.plClass(t.plPct)}">${TF.pct(t.plPct)}</td>
      <td class="dim">${TF.esc(t.exitReason)}</td>
      <td><input class="input note-input" data-note-id="${TF.esc(t.id)}"
        value="${TF.esc(t.note || '')}" placeholder="add note…" maxlength="300" /></td>
    </tr>`).join('');
    body.querySelectorAll('[data-note-id]').forEach((inp) => {
      inp.onchange = async () => {
        try {
          await TF.api('trades:note', { id: inp.getAttribute('data-note-id'), note: inp.value });
          TF.toast('Note saved', 'success');
        } catch (e) { TF.toast(e.message, 'error'); }
      };
    });
  }

  // Equity curve + by-strategy / by-symbol breakdown for the filtered trades.
  function renderAnalytics(trades) {
    const sorted = trades.slice().sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
    let cum = 0;
    TF.drawEquityCurve(TF.$('histEquity'), sorted.map((t) => ({ y: (cum += t.pl) })));

    const groupRows = (keyFn, emptyMsg) => {
      const groups = {};
      for (const t of trades) {
        const k = keyFn(t);
        const g = groups[k] || (groups[k] = { trades: 0, wins: 0, pl: 0 });
        g.trades++; if (t.pl > 0) g.wins++; g.pl += t.pl;
      }
      const rows = Object.entries(groups).sort((a, b) => b[1].pl - a[1].pl);
      if (!rows.length) return `<tr><td colspan="4" class="empty">${emptyMsg}</td></tr>`;
      return rows.map(([k, g]) => `<tr>
        <td><b>${TF.esc(k)}</b></td><td>${g.trades}</td>
        <td>${Math.round((g.wins / g.trades) * 100)}%</td>
        <td class="${TF.plClass(g.pl)}">${TF.money(g.pl)}</td></tr>`).join('');
    };
    TF.$('byStrategyBody').innerHTML = groupRows((t) => t.strategy || 'unknown', 'No trades yet');
    TF.$('bySymbolBody').innerHTML = groupRows((t) => t.symbol, 'No trades yet');
  }

  // Daily P/L calendar from the account's equity history.
  let calFetched = 0;
  const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  async function loadCalendar() {
    if (Date.now() - calFetched < 300000) return;
    const h = await TF.apiQuiet('account:history');
    const box = TF.$('plCalendar');
    if (!h || !h.timestamp || !h.timestamp.length) return;
    calFetched = Date.now();
    const byDate = {};
    let maxAbs = 1;
    h.timestamp.forEach((ts, i) => {
      const pl = Number(h.profit_loss && h.profit_loss[i]) || 0;
      const d = ET_DATE.format(new Date(ts * 1000)); // YYYY-MM-DD
      byDate[d] = pl;
      if (Math.abs(pl) > maxAbs) maxAbs = Math.abs(pl);
    });
    const dates = Object.keys(byDate).sort();
    const months = [...new Set(dates.map((d) => d.slice(0, 7)))].slice(-3);
    box.innerHTML = months.map((m) => {
      const [y, mo] = m.split('-').map(Number);
      const monthName = new Date(y, mo - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
      const daysInMonth = new Date(y, mo, 0).getDate();
      const firstDow = new Date(y, mo - 1, 1).getDay();
      let total = 0;
      let cells = '<span class="cal-cell cal-head">S</span><span class="cal-cell cal-head">M</span><span class="cal-cell cal-head">T</span><span class="cal-cell cal-head">W</span><span class="cal-cell cal-head">T</span><span class="cal-cell cal-head">F</span><span class="cal-cell cal-head">S</span>';
      for (let i = 0; i < firstDow; i++) cells += '<span class="cal-cell"></span>';
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${m}-${String(d).padStart(2, '0')}`;
        if (key in byDate) {
          const pl = byDate[key];
          total += pl;
          const alpha = 0.14 + 0.5 * Math.min(1, Math.abs(pl) / maxAbs);
          const bg = pl >= 0 ? `rgba(48,209,88,${alpha})` : `rgba(255,69,58,${alpha})`;
          cells += `<span class="cal-cell cal-day" style="background:${bg}" title="${key}: ${TF.money(pl)}">${d}</span>`;
        } else {
          cells += `<span class="cal-cell cal-off">${d}</span>`;
        }
      }
      return `<div class="cal-month">
        <div class="cal-title">${monthName}
          <span class="${TF.plClass(total)}">${TF.money(total)}</span></div>
        <div class="cal-grid">${cells}</div>
      </div>`;
    }).join('');
  }

  function init() {
    TF.$('histRange').onchange = refresh;
    loadCalendar();
    TF.$('histSymbol').oninput = () => { clearTimeout(init._t); init._t = setTimeout(refresh, 350); };
    TF.$('btnExportCsv').onclick = async () => {
      try {
        const res = await TF.api('trades:export', currentFilter());
        if (res.exported > 0) TF.toast(`Exported ${res.exported} trades to ${res.path}`, 'success');
      } catch (e) { TF.toast(e.message, 'error'); }
    };
    refresh();
  }

  function onShow() {
    refresh();
    loadCalendar();
  }

  return { init, refresh, onShow };
})();
