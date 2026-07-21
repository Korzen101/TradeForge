// News view: market-wide headlines (Benzinga via Alpaca) or a single ticker.
TF.news = (() => {
  let currentSymbol = null;
  let lastFetch = 0;

  function renderChips() {
    const wl = (TF.state.settings && TF.state.settings.watchlist) || [];
    const row = TF.$('newsChips');
    row.innerHTML =
      `<button class="chip${!currentSymbol ? ' active' : ''}" data-news-sym="">Market</button>` +
      wl.map((w) =>
        `<button class="chip${w.symbol === currentSymbol ? ' active' : ''}" data-news-sym="${TF.esc(w.symbol)}">${TF.esc(w.symbol)}</button>`
      ).join('');
    row.querySelectorAll('[data-news-sym]').forEach((c) => {
      c.onclick = () => load(c.getAttribute('data-news-sym') || null);
    });
  }

  function thumbOf(item) {
    const imgs = item.images || [];
    const pick = imgs.find((x) => x.size === 'thumb') || imgs.find((x) => x.size === 'small') || imgs[0];
    return pick && /^https:\/\//.test(pick.url) ? pick.url : null;
  }

  function render(items) {
    const box = TF.$('newsList');
    if (!items.length) {
      box.innerHTML = `<div class="card"><p class="dim" style="text-align:center;padding:20px 0;">
        No recent stories${currentSymbol ? ' for ' + TF.esc(currentSymbol) : ''}.</p></div>`;
      return;
    }
    box.innerHTML = `<div class="card news-card">` + items.map((n) => {
      const thumb = thumbOf(n);
      const syms = (n.symbols || []).slice(0, 6).map((s) =>
        `<button class="news-sym" data-news-sym="${TF.esc(s)}">${TF.esc(s)}</button>`).join('');
      return `<div class="news-item">
        ${thumb ? `<img class="news-thumb" src="${TF.esc(thumb)}" alt="" loading="lazy" />` : '<div class="news-thumb news-thumb-empty">📰</div>'}
        <div class="news-body">
          <a class="news-headline" href="#" data-news-url="${TF.esc(n.url || '')}">${TF.esc(n.headline)}</a>
          <div class="news-meta">
            <span>${TF.esc(n.source || 'Benzinga')}</span> · <span>${TF.timeAgo(n.created_at)}</span>
            ${syms ? ' · ' + syms : ''}
          </div>
          ${n.summary ? `<div class="news-summary">${TF.esc(String(n.summary).slice(0, 220))}</div>` : ''}
        </div>
      </div>`;
    }).join('') + `</div>
    <p class="dim small">Headlines are provided by Benzinga through your Alpaca account and open in your browser.
      News moves prices fast — remember the earnings filter and your stops are there for a reason.</p>`;

    box.querySelectorAll('[data-news-url]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        const url = a.getAttribute('data-news-url');
        if (url) TF.api('app:openExternal', { url });
      };
    });
    box.querySelectorAll('.news-item [data-news-sym]').forEach((b) => {
      b.onclick = () => load(b.getAttribute('data-news-sym'));
    });
  }

  async function load(symbol) {
    currentSymbol = symbol || null;
    renderChips();
    const box = TF.$('newsList');
    box.innerHTML = '<div class="card"><p class="dim" style="text-align:center;padding:20px 0;">Loading headlines…</p></div>';
    try {
      const res = await TF.api('news:get', { symbol: currentSymbol });
      lastFetch = Date.now();
      TF.$('newsStamp').textContent = (currentSymbol ? currentSymbol + ' · ' : 'market · ') +
        'as of ' + TF.timeShort(res.at);
      render(res.news);
    } catch (e) {
      box.innerHTML = `<div class="card"><p class="dim" style="text-align:center;padding:20px 0;">${TF.esc(e.message)}</p></div>`;
    }
  }

  function search() {
    const v = TF.$('newsSymbol').value.trim().toUpperCase();
    if (v) load(v);
  }

  function onShow() {
    if (Date.now() - lastFetch > 120000) load(currentSymbol);
    else renderChips();
  }

  function init() {
    TF.$('btnNewsSearch').onclick = search;
    TF.$('newsSymbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    TF.$('btnNewsMarket').onclick = () => { TF.$('newsSymbol').value = ''; load(null); };
  }

  return { init, onShow };
})();
