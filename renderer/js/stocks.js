// Stocks view: watchlist management with live snapshots.
TF.stocks = (() => {
  let snapshots = {};

  function render() {
    const wl = TF.state.settings.watchlist || [];
    const body = TF.$('watchlistBody');
    if (!wl.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">Watchlist is empty — add a symbol above</td></tr>';
      return;
    }
    body.innerHTML = wl.map((w) => {
      const snap = snapshots[w.symbol];
      let last = '—', chg = '—', chgCls = '';
      if (snap && snap.latestTrade) {
        last = TF.money(snap.latestTrade.p);
        if (snap.prevDailyBar && snap.prevDailyBar.c) {
          const pct = ((snap.latestTrade.p - snap.prevDailyBar.c) / snap.prevDailyBar.c) * 100;
          chg = TF.pct(pct);
          chgCls = TF.plClass(pct);
        }
      }
      return `<tr>
        <td><b>${TF.esc(w.symbol)}</b></td>
        <td>${last}</td>
        <td class="${chgCls}">${chg}</td>
        <td>
          <label class="switch"><input type="checkbox" data-toggle="${TF.esc(w.symbol)}" ${w.enabled ? 'checked' : ''} />
          <span class="slider"></span></label>
        </td>
        <td><button class="btn btn-sm" data-remove="${TF.esc(w.symbol)}">Remove</button></td>
      </tr>`;
    }).join('');

    body.querySelectorAll('[data-toggle]').forEach((inp) => {
      inp.onchange = async () => {
        const sym = inp.getAttribute('data-toggle');
        const wl2 = TF.state.settings.watchlist.map((w) =>
          w.symbol === sym ? { ...w, enabled: inp.checked } : w);
        TF.state.settings = await TF.api('settings:update', { watchlist: wl2 });
      };
    });
    body.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = async () => {
        const sym = btn.getAttribute('data-remove');
        const wl2 = TF.state.settings.watchlist.filter((w) => w.symbol !== sym);
        TF.state.settings = await TF.api('settings:update', { watchlist: wl2 });
        render();
        TF.charts.renderChips();
      };
    });
  }

  async function refreshSnapshots() {
    const snaps = await TF.apiQuiet('snapshots:get');
    if (snaps) { snapshots = snaps; render(); }
  }

  async function addSymbol() {
    const inp = TF.$('addSymbolInput');
    const sym = inp.value.trim().toUpperCase();
    if (!sym) return;
    if (TF.state.settings.watchlist.find((w) => w.symbol === sym)) {
      TF.toast(sym + ' is already on the list'); return;
    }
    const btn = TF.$('btnAddSymbol');
    btn.disabled = true;
    try {
      const asset = await TF.api('watchlist:validate', { symbol: sym });
      const wl2 = [...TF.state.settings.watchlist, { symbol: asset.symbol, enabled: true }];
      TF.state.settings = await TF.api('settings:update', { watchlist: wl2 });
      inp.value = '';
      TF.toast(`Added ${asset.symbol} (${asset.name || asset.exchange})`, 'success');
      render();
      refreshSnapshots();
      TF.charts.renderChips();
    } catch (e) {
      TF.toast(e.message, 'error');
    }
    btn.disabled = false;
  }

  function init() {
    TF.$('btnAddSymbol').onclick = addSymbol;
    TF.$('addSymbolInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addSymbol();
    });
    render();
    refreshSnapshots();
    setInterval(refreshSnapshots, 30000);
  }

  return { init, render, onShow: refreshSnapshots };
})();
