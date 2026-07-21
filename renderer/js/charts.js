// Charts view: TradingView widget embed, symbol chips synced to watchlist.
TF.charts = (() => {
  let currentSymbol = null;

  // Studies overlaid on the chart, matched to the active strategy.
  const STUDY_MAP = {
    bollinger_reversion: ['BB@tv-basicstudies'],
    rsi2_reversion: ['RSI@tv-basicstudies'],
    ema_crossover: ['MAExp@tv-basicstudies'],
    macd_momentum: ['MACD@tv-basicstudies'],
    vwap_reversion: ['VWAP@tv-basicstudies'],
    orb_breakout: ['VWAP@tv-basicstudies'],
    squeeze_breakout: ['BB@tv-basicstudies'],
    stochastic_reversal: ['Stochastic@tv-basicstudies'],
    donchian_breakout: [],
    supertrend: []
  };

  function buildUrl(symbol, interval) {
    const active = TF.state.settings ? TF.state.settings.strategy.active : '';
    const studies = STUDY_MAP[active] || [];
    const params = new URLSearchParams({
      symbol,
      interval,
      theme: 'dark',
      style: '1',
      locale: 'en',
      toolbarbg: '16161a',
      hide_top_toolbar: '0',
      hide_side_toolbar: '0',
      allow_symbol_change: '1',
      save_image: '0',
      timezone: 'exchange',
      withdateranges: '1'
    });
    for (const s of studies) params.append('studies', s);
    return 'https://s.tradingview.com/widgetembed/?' + params.toString();
  }

  function loadChart(symbol) {
    currentSymbol = symbol;
    const interval = TF.$('chartInterval').value;
    TF.$('tvFrame').src = buildUrl(symbol, interval);
    document.querySelectorAll('#chartSymbols .chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.sym === symbol));
  }

  function renderChips() {
    const wl = (TF.state.settings && TF.state.settings.watchlist) || [];
    const row = TF.$('chartSymbols');
    row.innerHTML = wl.map((w) =>
      `<button class="chip${w.symbol === currentSymbol ? ' active' : ''}" data-sym="${TF.esc(w.symbol)}">${TF.esc(w.symbol)}</button>`
    ).join('');
    row.querySelectorAll('.chip').forEach((c) => {
      c.onclick = () => loadChart(c.dataset.sym);
    });
  }

  function onShow() {
    renderChips();
    const wl = (TF.state.settings && TF.state.settings.watchlist) || [];
    if (!currentSymbol && wl.length) loadChart(wl[0].symbol);
  }

  function init() {
    TF.$('chartInterval').onchange = () => { if (currentSymbol) loadChart(currentSymbol); };
  }

  return { init, onShow, renderChips };
})();
