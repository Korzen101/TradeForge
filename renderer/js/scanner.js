// Scanner view: today's most-active and biggest-moving stocks, with
// one-click add to the watchlist.
TF.scanner = (() => {
  let lastFetch = 0;

  const fmtVol = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(n);
  };

  function inList(sym) {
    return TF.state.settings.watchlist.some((w) => w.symbol === sym);
  }

  function addBtn(sym) {
    return inList(sym)
      ? '<span class="dim small">✓ in list</span>'
      : `<button class="btn btn-sm" data-scan-add="${TF.esc(sym)}">+ Add</button>`;
  }

  function errRow(msg) {
    return `<tr><td colspan="4" class="empty">${TF.esc(msg)}</td></tr>`;
  }

  function render(data) {
    const act = TF.$('scanActives');
    const gain = TF.$('scanGainers');
    const lose = TF.$('scanLosers');

    if (data.actives && data.actives.error) {
      act.innerHTML = errRow('Unavailable: ' + data.actives.error);
    } else {
      const rows = (data.actives && data.actives.most_actives) || [];
      act.innerHTML = rows.length ? rows.map((r) => `<tr>
        <td><b>${TF.esc(r.symbol)}</b></td>
        <td>${fmtVol(r.volume)}</td>
        <td>${fmtVol(r.trade_count)}</td>
        <td>${addBtn(r.symbol)}</td>
      </tr>`).join('') : errRow('No data');
    }

    const moverRows = (list, tbody) => {
      if (data.movers && data.movers.error) {
        tbody.innerHTML = errRow('Unavailable: ' + data.movers.error);
        return;
      }
      const rows = (data.movers && data.movers[list]) || [];
      tbody.innerHTML = rows.length ? rows.map((r) => `<tr>
        <td><b>${TF.esc(r.symbol)}</b></td>
        <td>${TF.money(r.price)}</td>
        <td class="${TF.plClass(r.percent_change)}">${TF.pct(r.percent_change)}</td>
        <td>${addBtn(r.symbol)}</td>
      </tr>`).join('') : errRow('No data');
    };
    moverRows('gainers', gain);
    moverRows('losers', lose);

    document.querySelectorAll('[data-scan-add]').forEach((btn) => {
      btn.onclick = async () => {
        const sym = btn.getAttribute('data-scan-add');
        try {
          const wl2 = [...TF.state.settings.watchlist, { symbol: sym, enabled: true }];
          TF.state.settings = await TF.api('settings:update', { watchlist: wl2 });
          TF.toast(`Added ${sym} to your stocks (enabled)`, 'success');
          TF.stocks.render();
          TF.charts.renderChips();
          btn.outerHTML = '<span class="dim small">✓ in list</span>';
        } catch (e) { TF.toast(e.message, 'error'); }
      };
    });
    TF.$('scanStamp').textContent = 'as of ' + TF.timeShort(data.at || new Date().toISOString());
  }

  async function refresh() {
    const btn = TF.$('btnScanRefresh');
    btn.disabled = true;
    try {
      const data = await TF.api('scanner:get');
      lastFetch = Date.now();
      render(data);
    } catch (e) {
      TF.toast(e.message, 'error');
    }
    btn.disabled = false;
  }

  function onShow() {
    if (Date.now() - lastFetch > 60000) refresh();
  }

  function init() {
    TF.$('btnScanRefresh').onclick = refresh;
  }

  return { init, onShow };
})();
