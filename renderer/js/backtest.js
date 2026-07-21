// Backtest view: configure, run with live progress, render results
// (single-strategy detail or all-strategy comparison).
TF.backtest = (() => {
  let running = false;
  let lastResult = null;

  function money(v) { return TF.money(v); }

  function setRunning(on) {
    running = on;
    TF.$('btRun').disabled = on;
    TF.$('btCancel').classList.toggle('hidden', !on);
    TF.$('btProgressWrap').classList.toggle('hidden', !on);
    if (!on) { TF.$('btFill').style.width = '0%'; TF.$('btNote').textContent = ''; }
  }

  function showMetricsInfo() {
    TF.infoModal('Reading backtest results',
      'How the simulation fills orders: signals evaluate on a bar\'s close and buy at the NEXT bar\'s open; stops and targets fill inside the bar (gaps fill at the open, past your level); if a bar touches both the stop and the target, the stop wins — the worst case is assumed. Slippage is charged on every fill, both directions. Real trading only gets worse than this, never better.',
      [
        { name: 'Net P/L', body: 'Total profit or loss of every simulated trade added together, after slippage. The headline number — but read it alongside the drawdown and trade count, never alone.' },
        { name: 'Trades (W/L)', body: 'How many round trips the strategy took, split into winners and losers. Under ~60 trades the other statistics are mostly luck; more trades = more trustworthy numbers.' },
        { name: 'Win Rate', body: 'Percentage of trades that made money. A high win rate does NOT mean profitable — a strategy that wins 80% of the time with small gains can be destroyed by its 20% of large losses. Judge it together with profit factor.' },
        { name: 'Profit Factor', body: 'Gross winnings divided by gross losses. 1.0 = broke even; below 1.0 = lost money; 1.3+ over a large sample is genuinely decent. This is the single best number for comparing strategies.' },
        { name: 'Max Drawdown', body: 'The deepest peak-to-valley drop in the equity curve — the worst losing stretch you would have sat through. Ask honestly: would you have kept the bot running after losing this much? If not, the strategy is untradeable for you regardless of its final P/L.' },
        { name: 'Equity curve', body: 'Running total of P/L, trade by trade. You want a reasonably steady climb. A curve that spikes on one lucky trade, or one that whipsaws violently, is a warning sign even when it ends green.' },
        { name: 'By Symbol', body: 'The same strategy often works on some stocks and fails on others. Use this table to prune losers from your Stocks list — that alone can flip a losing configuration to a winning one.' },
        { name: 'Held', body: 'Minutes from entry fill to exit fill for each simulated trade. Sanity-check it against your intent — a "day trading" setup holding for 6 hours is really a swing strategy in disguise.' }
      ]);
  }

  function resultHead(title, cfgNote) {
    return `<div class="card-head"><h2>${title}</h2>
      <span class="row-inline" style="margin:0">
        <span class="dim small">${cfgNote}</span>
        <button class="btn btn-sm" id="btExport">Export CSV</button>
        <button class="info-btn inline" id="btMetricsInfo" title="What do these numbers mean?">i</button>
      </span></div>`;
  }

  function wireResultButtons() {
    const exp = TF.$('btExport');
    if (exp) exp.onclick = async () => {
      try {
        const r = await TF.api('backtest:export', lastResult);
        if (r.exported) TF.toast('Exported to ' + r.path, 'success');
      } catch (e) { TF.toast(e.message, 'error'); }
    };
    const info = TF.$('btMetricsInfo');
    if (info) info.onclick = showMetricsInfo;
  }

  function statCards(st) {
    const pf = st.profitFactor === null ? '—'
      : (st.profitFactor === Infinity || st.profitFactor > 1e8 ? '∞' : st.profitFactor.toFixed(2));
    return `<div class="stat-grid five">
      <div class="stat-card"><div class="stat-label">Net P/L</div>
        <div class="stat-value ${TF.plClass(st.totalPl)}">${money(st.totalPl)}</div></div>
      <div class="stat-card"><div class="stat-label">Trades</div>
        <div class="stat-value">${st.count} (${st.wins}W/${st.losses}L)</div></div>
      <div class="stat-card"><div class="stat-label">Win Rate</div>
        <div class="stat-value">${st.count ? st.winRate.toFixed(1) + '%' : '—'}</div></div>
      <div class="stat-card"><div class="stat-label">Profit Factor</div>
        <div class="stat-value">${pf}</div></div>
      <div class="stat-card"><div class="stat-label">Max Drawdown</div>
        <div class="stat-value neg">${st.maxDrawdown ? '-' + money(st.maxDrawdown).replace('-', '') : '—'}</div></div>
    </div>`;
  }

  function renderSingle(res, cfg) {
    const box = TF.$('btResults');
    const st = res.stats;
    const symRows = Object.entries(res.perSymbol)
      .sort((a, b) => b[1].pl - a[1].pl)
      .map(([sym, s]) => `<tr><td><b>${TF.esc(sym)}</b></td><td>${s.trades}</td>
        <td>${s.trades ? Math.round((s.wins / s.trades) * 100) + '%' : '—'}</td>
        <td class="${TF.plClass(s.pl)}">${money(s.pl)}</td></tr>`).join('') ||
      '<tr><td colspan="4" class="empty">No trades generated</td></tr>';
    const tradeRows = res.trades.slice().reverse().slice(0, 200).map((t) => `<tr>
      <td>${TF.dateTimeShort(t.exitTime)}</td><td><b>${TF.esc(t.symbol)}</b></td><td>${t.qty}</td>
      <td>${money(t.entryPrice)}</td><td>${money(t.exitPrice)}</td>
      <td class="${TF.plClass(t.pl)}">${money(t.pl)}</td>
      <td>${t.holdMin !== null ? t.holdMin + 'm' : '—'}</td>
      <td class="dim">${TF.esc(t.exitReason)}</td></tr>`).join('');
    box.innerHTML = `
      <div class="card">
        ${resultHead(TF.esc(res.strategyName),
          `${cfg.days}d · ${cfg.timeframe} · ${cfg.symbols.length} symbols · slippage ${cfg.slippagePct}%/side`)}
        ${statCards(st)}
        <canvas id="btEquityCanvas" class="equity-canvas"></canvas>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-head"><h2>By Symbol</h2></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Symbol</th><th>Trades</th><th>Win %</th><th>P/L</th></tr></thead>
            <tbody>${symRows}</tbody></table></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Simulated Trades</h2><span class="dim small">latest 200</span></div>
          <div class="table-wrap" style="max-height:340px;overflow-y:auto;"><table>
            <thead><tr><th>Exit</th><th>Sym</th><th>Qty</th><th>Buy</th><th>Sell</th><th>P/L</th><th>Held</th><th>Reason</th></tr></thead>
            <tbody>${tradeRows || '<tr><td colspan="8" class="empty">No trades</td></tr>'}</tbody></table></div>
        </div>
      </div>`;
    if (res.segments) {
      box.insertAdjacentHTML('beforeend', segmentsCard(res.segments));
    }
    TF.drawEquityCurve(TF.$('btEquityCanvas'), res.equityCurve);
    wireResultButtons();
  }

  function segmentsCard(segments) {
    const profitable = segments.filter((g) => g.stats.totalPl > 0).length;
    const rows = segments.map((g) => `<tr>
      <td><b>${TF.esc(g.label)}</b> <span class="dim small">${TF.esc(g.from)} → ${TF.esc(g.to)}</span></td>
      <td>${g.stats.count}</td>
      <td>${g.stats.count ? g.stats.winRate.toFixed(0) + '%' : '—'}</td>
      <td>${g.stats.profitFactor === Infinity ? '∞' : g.stats.profitFactor.toFixed(2)}</td>
      <td class="${TF.plClass(g.stats.totalPl)}">${money(g.stats.totalPl)}</td>
    </tr>`).join('');
    const note = profitable === 3
      ? 'Profitable in all three periods — the edge looks consistent rather than one lucky stretch.'
      : profitable === 0
        ? 'Unprofitable in every period — this configuration has no edge in this window.'
        : `Profitable in only ${profitable} of 3 periods — results may hinge on one favorable stretch. Be skeptical.`;
    return `<div class="card">
      <div class="card-head"><h2>Consistency Across Periods</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Period</th><th>Trades</th><th>Win %</th><th>PF</th><th>P/L</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="dim small">${note}</p>
    </div>`;
  }

  function fmtParams(params) {
    return Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' · ');
  }

  function renderOptimize(r) {
    const box = TF.$('btResults');
    const warn = r.verdict.startsWith('Warning');
    const pf = (v) => (v === Infinity || v > 1e8 ? '∞' : Number(v).toFixed(2));
    const cmpRow = (label, params, inS, outS) => `<tr>
      <td><b>${label}</b><br><span class="dim small">${TF.esc(fmtParams(params))}</span></td>
      <td>${inS.count} · ${pf(inS.profitFactor)} · <span class="${TF.plClass(inS.totalPl)}">${money(inS.totalPl)}</span></td>
      <td>${outS.count} · ${pf(outS.profitFactor)} · <span class="${TF.plClass(outS.totalPl)}">${money(outS.totalPl)}</span></td>
    </tr>`;
    const gridRows = r.grid.map((g, i) => `<tr>
      <td>${i + 1}. <span class="dim small">${TF.esc(fmtParams(g.params))}</span></td>
      <td>${g.stats.count}</td>
      <td>${g.stats.count ? g.stats.winRate.toFixed(0) + '%' : '—'}</td>
      <td>${pf(g.stats.profitFactor)}</td>
      <td class="${TF.plClass(g.stats.totalPl)}">${money(g.stats.totalPl)}</td>
    </tr>`).join('');
    box.innerHTML = `
      <div class="card">
        ${resultHead('Parameter Optimization — ' + TF.esc(r.strategyName),
          `tuned on first 70% · judged on last 30% (split ${TF.esc(String(r.splitAt).slice(0, 10))})`)}
        <div class="banner ${warn ? 'danger' : 'info'}">${TF.esc(r.verdict)}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Parameters</th><th>In-sample (trades · PF · P/L)</th><th>Out-of-sample (trades · PF · P/L)</th></tr></thead>
          <tbody>
            ${cmpRow('Best found', r.best.params, r.best.inStats, r.best.outStats)}
            ${cmpRow('Your current', r.baseline.params, r.baseline.inStats, r.baseline.outStats)}
          </tbody></table></div>
        <div class="row-inline">
          <button class="btn btn-primary btn-sm" id="btApplyParams">Apply best parameters to ${TF.esc(r.strategyName)}</button>
          <span class="dim small">Writes these values into the strategy's configuration (you can Reset defaults any time).</span>
        </div>
        <canvas id="btOptCanvas" class="equity-canvas" style="margin-top:14px"></canvas>
        <p class="dim small">Equity curve of the best parameters on the unseen 30% only.</p>
      </div>
      <div class="card">
        <div class="card-head"><h2>Top parameter sets (in-sample)</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Parameters</th><th>Trades</th><th>Win %</th><th>PF</th><th>P/L</th></tr></thead>
          <tbody>${gridRows}</tbody></table></div>
      </div>`;
    TF.drawEquityCurve(TF.$('btOptCanvas'), r.best.outCurve);
    wireResultButtons();
    TF.$('btApplyParams').onclick = async () => {
      try {
        TF.state.settings = await TF.api('settings:update', {
          strategy: { params: { [r.strategyId]: r.best.params } }
        });
        TF.strategies.render();
        TF.toast('Parameters applied to ' + r.strategyName, 'success');
      } catch (e) { TF.toast(e.message, 'error'); }
    };
  }

  function renderCompare(results, cfg) {
    const box = TF.$('btResults');
    const rows = results.map((r, i) => {
      const st = r.stats;
      const pf = st.profitFactor === Infinity || st.profitFactor > 1e8 ? '∞'
        : (st.profitFactor ? st.profitFactor.toFixed(2) : '0.00');
      return `<tr class="compare-row${i === 0 && st.count > 0 ? ' best' : ''}" data-idx="${i}">
        <td>${TF.esc(r.strategyName)}${i === 0 && st.count > 0 ? ' 🏆' : ''}</td>
        <td>${st.count}</td>
        <td>${st.count ? st.winRate.toFixed(0) + '%' : '—'}</td>
        <td>${pf}</td>
        <td class="${TF.plClass(st.totalPl)}">${money(st.totalPl)}</td>
        <td class="neg">${st.maxDrawdown ? '-' + money(st.maxDrawdown).replace('-', '') : '—'}</td>
      </tr>`;
    }).join('');
    box.innerHTML = `
      <div class="card">
        ${resultHead('Strategy Comparison',
          `${cfg.days}d · ${cfg.timeframe} · ${cfg.symbols.length} symbols — sorted by profit factor · click a row for detail`)}
        <div class="table-wrap"><table>
          <thead><tr><th>Strategy</th><th>Trades</th><th>Win %</th><th>Profit Factor</th><th>Net P/L</th><th>Max DD</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <p class="dim small">A profit factor above 1.0 means gross wins exceeded gross losses in this window.
          Prefer robust results (many trades, contained drawdown) over one spectacular number.</p>
      </div>
      <div id="btDetail"></div>`;
    wireResultButtons();
    box.querySelectorAll('.compare-row').forEach((row) => {
      row.onclick = () => {
        const r = results[Number(row.dataset.idx)];
        const detail = TF.$('btDetail');
        detail.innerHTML = `<div class="card">
          <div class="card-head"><h2>${TF.esc(r.strategyName)}</h2></div>
          ${statCards(r.stats)}
          <canvas id="btDetailCanvas" class="equity-canvas"></canvas>
        </div>`;
        TF.drawEquityCurve(TF.$('btDetailCanvas'), r.equityCurve);
        detail.scrollIntoView({ behavior: 'smooth' });
      };
    });
  }

  function onEvent(evt) {
    if (evt.type === 'progress') {
      TF.$('btFill').style.width = Math.min(100, evt.pct) + '%';
      TF.$('btNote').textContent = evt.note || '';
    } else if (evt.type === 'done') {
      setRunning(false);
      lastResult = evt.result;
      const r = evt.result;
      if (r.mode === 'optimize') renderOptimize(r);
      else if (r.config.strategyId === 'ALL') renderCompare(r.results, r.config);
      else if (r.results[0]) renderSingle(r.results[0], r.config);
      TF.toast('Backtest complete', 'success');
    } else if (evt.type === 'error') {
      setRunning(false);
      TF.toast('Backtest failed: ' + evt.msg, 'error');
    } else if (evt.type === 'cancelled') {
      setRunning(false);
      TF.toast('Backtest cancelled');
    }
  }

  async function run() {
    const cfg = {
      strategyId: TF.$('btStrategy').value,
      mode: TF.$('btMode').value,
      days: Number(TF.$('btDays').value),
      timeframe: TF.$('btTimeframe').value,
      slippagePct: parseFloat(TF.$('btSlippage').value) || 0,
      startEquity: Number(TF.$('btEquity').value) || 100000
    };
    if (cfg.mode === 'optimize' && cfg.strategyId === 'ALL') {
      TF.toast('Pick a single strategy to optimize (not "Compare all")', 'error');
      return;
    }
    TF.apiQuiet('settings:update', {
      backtest: { days: cfg.days, slippagePct: cfg.slippagePct, startEquity: cfg.startEquity }
    });
    try {
      setRunning(true);
      TF.$('btResults').innerHTML = '';
      await TF.api('backtest:run', cfg);
    } catch (e) {
      setRunning(false);
      TF.toast(e.message, 'error');
    }
  }

  async function init() {
    const strategies = await TF.api('strategies:list');
    const sel = TF.$('btStrategy');
    sel.innerHTML = '<option value="ALL">🏆 Compare all 10 strategies</option>' +
      strategies.map((s) => `<option value="${s.id}">${TF.esc(s.name)}</option>`).join('');
    const bt = TF.state.settings.backtest || {};
    if (bt.days) TF.$('btDays').value = String(bt.days);
    TF.$('btSlippage').value = bt.slippagePct ?? 0.02;
    TF.$('btEquity').value = bt.startEquity ?? 100000;
    TF.$('btTimeframe').value = TF.state.settings.engine.timeframe || '5Min';
    sel.value = TF.state.settings.strategy.active || 'ALL';
    TF.$('btRun').onclick = run;
    TF.$('btCancel').onclick = () => TF.apiQuiet('backtest:cancel');
  }

  function getLastResult() { return lastResult; }

  return { init, onEvent, getLastResult };
})();
