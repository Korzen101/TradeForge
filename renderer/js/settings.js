// Settings view: mode switching (with live-trading confirmation), API keys,
// engine/risk/email configuration.
TF.settingsView = (() => {
  function s() { return TF.state.settings; }

  function fillForm() {
    const st = s();
    // Mode segmented control
    document.querySelectorAll('#modeSeg .seg').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === st.mode));
    TF.$('modeNote').textContent = st.mode === 'live'
      ? '⚠ LIVE mode — the engine trades real money while running.'
      : "Paper mode uses Alpaca's simulator — real market data, fake money.";
    const badge = TF.$('modeBadge');
    badge.textContent = st.mode.toUpperCase();
    badge.className = 'mode-badge ' + st.mode;

    // Key placeholders reflect saved state
    TF.$('paperKey').placeholder = st.secrets.paperKey.set ? `saved (…${st.secrets.paperKey.last4})` : 'PK...';
    TF.$('paperSecret').placeholder = st.secrets.paperSecret.set ? 'saved ••••' : 'Secret';
    TF.$('liveKey').placeholder = st.secrets.liveKey.set ? `saved (…${st.secrets.liveKey.last4})` : 'AK...';
    TF.$('liveSecret').placeholder = st.secrets.liveSecret.set ? 'saved ••••' : 'Secret';
    if (!st.encryptionAvailable) {
      TF.$('keyStorageNote').textContent =
        '⚠ OS encryption unavailable — keys will be stored obfuscated but not encrypted.';
    }

    // Keys that no longer decrypt (Windows encryption context changed)
    const kw = TF.$('keysWarn');
    if (st.unreadableSecrets && st.unreadableSecrets.length) {
      kw.textContent = '⚠ Stored credentials could not be decrypted (' + st.unreadableSecrets.join(', ') +
        '). Windows changed its encryption context — this can follow certain OS or profile changes. ' +
        'Please re-enter and save the affected keys below; the technical log has details.';
      kw.classList.remove('hidden');
    } else {
      kw.classList.add('hidden');
    }

    // Engine
    TF.$('setTimeframe').value = st.engine.timeframe;
    TF.$('setPollSec').value = st.engine.pollSec;
    TF.$('setMarketHours').checked = st.engine.marketHoursOnly;
    TF.$('setFlattenMin').value = st.engine.flattenBeforeCloseMin;
    const sch = st.engine.schedule || {};
    TF.$('setSchedEnabled').checked = !!sch.enabled;
    TF.$('setSchedStart').value = sch.start || '09:30';
    TF.$('setSchedEnd').value = sch.end || '16:00';

    // Risk
    TF.$('setSizingMode').value = st.risk.sizingMode;
    TF.$('setPositionValue').value = st.risk.positionValue;
    TF.$('setPctEquity').value = st.risk.pctEquity;
    TF.$('setRiskPerTrade').value = st.risk.riskPerTrade;
    TF.$('setEntryType').value = st.risk.entryOrderType || 'limit';
    TF.$('setLimitBuffer').value = st.risk.limitBufferPct ?? 0.15;
    TF.$('setMaxVolPct').value = st.risk.maxVolumePct ?? 0.5;
    TF.$('setExitStyle').value = st.risk.exitStyle;
    TF.$('setTrailPercent').value = st.risk.trailPercent;
    TF.$('setMaxHold').value = st.risk.maxHoldMin;
    TF.$('setAvoidEarnings').checked = st.risk.avoidEarnings;
    TF.$('setMaxPos').value = st.risk.maxOpenPositions;
    TF.$('setMaxTrades').value = st.risk.maxTradesPerDay;
    TF.$('setDailyLoss').value = st.risk.dailyLossLimit;
    TF.$('setHaltAction').value = st.risk.haltAction;
    TF.$('setStopLoss').value = st.risk.stopLossPct;
    TF.$('setTakeProfit').value = st.risk.takeProfitPct;
    TF.$('setCooldown').value = st.risk.cooldownMin;
    TF.$('setPdt').checked = st.risk.respectPDT;

    // Application
    TF.$('setTrayMode').checked = st.app.trayMode;
    TF.$('setLaunchAtLogin').checked = !!st.app.launchAtLogin;
    TF.$('ntEnabled').checked = st.notifications.enabled;
    TF.$('ntTradeClosed').checked = st.notifications.onTradeClosed;
    TF.$('ntTradeOpened').checked = st.notifications.onTradeOpened;
    TF.$('ntHalt').checked = st.notifications.onHalt;
    TF.$('ntError').checked = st.notifications.onError;

    // Updates
    TF.$('upAuto').checked = st.updates.auto;
    TF.$('upFeedUrl').value = st.updates.feedUrl;

    // Email
    TF.$('emEnabled').checked = st.email.enabled;
    TF.$('emHost').value = st.email.host;
    TF.$('emPort').value = st.email.port;
    TF.$('emSecure').checked = st.email.secure;
    TF.$('emUser').value = st.email.user;
    TF.$('emPass').placeholder = st.secrets.emailPass.set ? 'saved ••••' : '••••••••';
    TF.$('emFrom').value = st.email.from;
    TF.$('emTo').value = st.email.to;
    TF.$('emPerTrade').checked = st.email.perTrade;
    TF.$('emDaily').checked = st.email.dailySummary;
    TF.$('emTime').value = st.email.summaryTime;
  }

  async function saveEngineRisk() {
    TF.state.settings = await TF.api('settings:update', {
      engine: {
        timeframe: TF.$('setTimeframe').value,
        pollSec: Number(TF.$('setPollSec').value) || 30,
        marketHoursOnly: TF.$('setMarketHours').checked,
        flattenBeforeCloseMin: Number(TF.$('setFlattenMin').value) || 0,
        schedule: {
          enabled: TF.$('setSchedEnabled').checked,
          start: /^\d{1,2}:\d{2}$/.test(TF.$('setSchedStart').value.trim()) ? TF.$('setSchedStart').value.trim() : '09:30',
          end: /^\d{1,2}:\d{2}$/.test(TF.$('setSchedEnd').value.trim()) ? TF.$('setSchedEnd').value.trim() : '16:00'
        }
      },
      risk: {
        sizingMode: TF.$('setSizingMode').value,
        positionValue: Number(TF.$('setPositionValue').value) || 100,
        pctEquity: Number(TF.$('setPctEquity').value) || 5,
        riskPerTrade: Number(TF.$('setRiskPerTrade').value) || 50,
        entryOrderType: TF.$('setEntryType').value,
        limitBufferPct: Number(TF.$('setLimitBuffer').value) || 0.15,
        maxVolumePct: Number(TF.$('setMaxVolPct').value) || 0,
        exitStyle: TF.$('setExitStyle').value,
        trailPercent: Number(TF.$('setTrailPercent').value) || 1.5,
        maxHoldMin: Number(TF.$('setMaxHold').value) || 0,
        avoidEarnings: TF.$('setAvoidEarnings').checked,
        maxOpenPositions: Number(TF.$('setMaxPos').value) || 1,
        maxTradesPerDay: Number(TF.$('setMaxTrades').value) || 1,
        dailyLossLimit: Number(TF.$('setDailyLoss').value) || 0,
        haltAction: TF.$('setHaltAction').value,
        stopLossPct: Number(TF.$('setStopLoss').value) || 1,
        takeProfitPct: Number(TF.$('setTakeProfit').value) || 2,
        cooldownMin: Number(TF.$('setCooldown').value) || 0,
        respectPDT: TF.$('setPdt').checked
      },
      notifications: {
        enabled: TF.$('ntEnabled').checked,
        onTradeClosed: TF.$('ntTradeClosed').checked,
        onTradeOpened: TF.$('ntTradeOpened').checked,
        onHalt: TF.$('ntHalt').checked,
        onError: TF.$('ntError').checked
      },
      app: {
        trayMode: TF.$('setTrayMode').checked,
        launchAtLogin: TF.$('setLaunchAtLogin').checked
      }
    });
  }

  async function switchMode(mode) {
    if (mode === s().mode) return;
    if (mode === 'live') {
      // Require typed confirmation
      const modal = TF.$('liveModal');
      const input = TF.$('liveConfirmInput');
      const okBtn = TF.$('liveConfirmBtn');
      input.value = '';
      okBtn.disabled = true;
      modal.classList.remove('hidden');
      input.focus();
      input.oninput = () => { okBtn.disabled = input.value.trim() !== 'LIVE'; };
      TF.$('liveCancelBtn').onclick = () => { modal.classList.add('hidden'); fillForm(); };
      okBtn.onclick = async () => {
        modal.classList.add('hidden');
        TF.state.settings = await TF.api('settings:update', { mode: 'live', liveArmed: true });
        TF.toast('LIVE mode enabled — real money at risk. Live keeps its own settings.', 'error');
        refreshAllViews();
      };
    } else {
      TF.state.settings = await TF.api('settings:update', { mode: 'paper', liveArmed: false });
      TF.toast('Switched to paper mode (its own settings restored)', 'success');
      refreshAllViews();
    }
  }

  // A mode switch swaps in that mode's profile — every view must re-read it.
  function refreshAllViews() {
    fillForm();
    TF.strategies.render();
    TF.stocks.render();
    TF.charts.renderChips();
    TF.history.refresh();
  }

  async function saveKeys(prefix) {
    const keyEl = TF.$(prefix + 'Key');
    const secEl = TF.$(prefix + 'Secret');
    const key = keyEl.value.trim();
    const secret = secEl.value.trim();
    if (!key && !secret) { TF.toast('Enter a key and secret first'); return; }
    if (key) await TF.api('secrets:set', { field: prefix + 'Key', value: key });
    if (secret) await TF.api('secrets:set', { field: prefix + 'Secret', value: secret });
    TF.state.settings = await TF.api('settings:get');
    keyEl.value = ''; secEl.value = '';
    fillForm();
    TF.toast('Keys saved (encrypted on this computer)', 'success');
  }

  async function testConn(mode, statusElId) {
    const el = TF.$(statusElId);
    el.textContent = 'testing…';
    el.style.color = 'var(--text-3)';
    try {
      const r = await TF.api('conn:test', { mode });
      el.textContent = `✓ ${r.status} · acct …${String(r.accountNumber).slice(-4)} · equity $${Number(r.equity).toLocaleString()}`;
      el.style.color = 'var(--green)';
    } catch (e) {
      el.textContent = '✗ ' + e.message;
      el.style.color = 'var(--red)';
    }
  }

  async function saveEmail() {
    const pass = TF.$('emPass').value.trim();
    if (pass) await TF.api('secrets:set', { field: 'emailPass', value: pass });
    TF.state.settings = await TF.api('settings:update', {
      email: {
        enabled: TF.$('emEnabled').checked,
        host: TF.$('emHost').value.trim(),
        port: Number(TF.$('emPort').value) || 587,
        secure: TF.$('emSecure').checked,
        user: TF.$('emUser').value.trim(),
        from: TF.$('emFrom').value.trim(),
        to: TF.$('emTo').value.trim(),
        perTrade: TF.$('emPerTrade').checked,
        dailySummary: TF.$('emDaily').checked,
        summaryTime: TF.$('emTime').value.trim() || '16:15'
      }
    });
    TF.$('emPass').value = '';
    fillForm();
    TF.toast('Email settings saved', 'success');
  }

  function wireInfoButtons() {
    TF.$('infoEngine').onclick = () => TF.infoModal(
      'Engine settings',
      'These control how the trading engine watches the market. The recommended values suit most day-trading setups on liquid US stocks.',
      [
        { name: 'Bar timeframe', rec: '5 minutes', body: 'The candle size every strategy analyzes. 1-minute bars react fastest but are noisy and trigger many more trades; 15-minute bars are smoother but slow to react. 5 minutes is the common day-trading middle ground.' },
        { name: 'Scan every (seconds)', rec: '30', body: 'How often the engine re-downloads data and re-checks signals. Faster scanning does not create more opportunity — new information only arrives when a bar completes — it just polls the broker more.' },
        { name: 'Trade market hours only', rec: 'on', body: 'Restricts trading to the regular US session (9:30–16:00 ET). Pre-market and after-hours trading is thin, spreads are wide, and the protective bracket orders this app relies on do not operate there.' },
        { name: 'Flatten positions before close', rec: '10 minutes', body: 'Sells everything N minutes before the closing bell so nothing is held overnight. Overnight news can gap a stock far beyond your stop-loss before the market even opens — day traders go home flat. Set 0 only if you deliberately want to hold positions overnight.' },
        { name: 'Daily schedule', rec: '09:30–16:00 ET', body: 'Automatically starts the engine at the start time and stops it at the end time, every weekday (times are Eastern — market time). The app must be running for this to fire, so pair it with tray mode. Manual control always wins: stop the engine yourself and it stays stopped until the next day. If live mode is armed, a schedule will trade real money unattended — think hard before combining those.' }
      ]);

    TF.$('infoRisk').onclick = () => TF.infoModal(
      'Risk controls',
      'These are the guardrails around every trade the bot takes. They matter more than the strategy choice — keep them tight, especially at the start.',
      [
        { name: 'Position sizing & $ per trade', rec: '$1,000 fixed', body: 'How much money each trade uses. Fixed $ is predictable; % of equity scales with the account. Whichever you pick, keep any single position small relative to the account (roughly 5% or less) so one bad trade cannot do real damage.' },
        { name: 'Max open positions', rec: '3', body: 'Cap on simultaneous holdings. More positions spread risk across symbols, but they can all fall together in a market-wide drop, and each consumes buying power.' },
        { name: 'Max trades per day', rec: '8', body: 'Hard cap on entries per day. This is the brake that stops a strategy from churning endlessly in choppy conditions, where each round trip quietly bleeds slippage.' },
        { name: 'Daily loss limit', rec: '$300 (≈1–2% of account)', body: 'The circuit breaker — the single most important setting here. Once the account is down this much on the day (realized and unrealized combined), the engine stops entering trades until tomorrow. Professionals treat a daily stop as non-negotiable.' },
        { name: 'When loss limit hits', rec: 'sell everything & halt', body: 'Whether hitting the limit also liquidates open positions, or just blocks new buys while existing positions ride. Selling everything guarantees the day cannot get much worse; holding lets winners recover but risks deeper losses.' },
        { name: 'Risk-based sizing & Risk $ per trade', rec: '$50', body: 'Sizes each position so that hitting the stop loses a constant dollar amount. A tight 1% stop on $50 risk buys a $5,000 position; a wide 3% stop buys ~$1,667. This is how professionals size — volatile setups automatically get smaller.' },
        { name: 'Entry order type & limit buffer', rec: 'limit, 0.15%', body: 'Market orders always fill but at whatever price the market offers — on fast or thin names that can be far worse than you expected. A marketable limit bids slightly above the current ask (the buffer), so it fills immediately in normal conditions but can never fill worse than your cap. Unfilled entries are cancelled automatically after 5 minutes rather than chasing.' },
        { name: 'Max position vs avg daily volume', rec: '0.5%', body: 'Caps your position at a small fraction of what the stock typically trades in a day. Being a large part of a thin stock\'s volume means you move the price against yourself going in AND coming out. Mostly irrelevant for large caps; exactly the guard you want for Scanner finds.' },
        { name: 'Exit style', rec: 'fixed bracket', body: 'Fixed bracket places stop-loss AND take-profit at the broker the moment you buy — fully protected, but winners are capped. Trailing stop follows the price up and only sells on a pullback — winners can run, but there is no profit target and the stop attaches a few seconds after the fill rather than instantly.' },
        { name: 'Trailing stop %', rec: '1.5%', body: 'How far below the highest price since entry the trailing stop follows. Tighter locks in gains sooner but gets shaken out by normal wiggles; wider tolerates noise but gives more back at the turn.' },
        { name: 'Time exit', rec: 'off (0)', body: 'Closes any position still open after this many minutes, win or lose. Day traders use time stops to avoid "dead money" — if the move you bought for has not happened within your window, the idea was probably wrong.' },
        { name: 'Skip earnings days', rec: 'on', body: 'Stocks reporting earnings today can gap several percent in seconds — straight through your stop. This checks a public earnings calendar each morning and skips those symbols. If the calendar cannot be fetched, trading continues without the filter (a note appears in the technical log).' },
        { name: 'Stop-loss % per trade', rec: '1.0%', body: 'Every buy is a bracket order carrying a stop this far below entry, held at the broker. It caps the damage of any single trade even if this app, or your whole PC, goes offline. Note: a fast gap can fill slightly past the stop price.' },
        { name: 'Take-profit % per trade', rec: '2.0%', body: 'The companion order that banks gains. At 2% profit against a 1% stop (2:1 reward-to-risk), a strategy can be right only half the time and still come out ahead.' },
        { name: 'Re-entry cooldown', rec: '15 minutes', body: 'After trading a symbol, its new signals are ignored for this long. Stops the bot from repeatedly buying a stock that keeps triggering while it falls.' },
        { name: 'PDT protection', rec: 'on (under $25k)', body: 'US regulators flag margin accounts under $25,000 that make 4 or more day trades within 5 business days as "pattern day traders," and brokers then restrict them for 90 days. This setting refuses the 4th day trade so you never trip the flag.' }
      ]);
  }

  function init() {
    fillForm();
    wireInfoButtons();

    document.querySelectorAll('#modeSeg .seg').forEach((b) => {
      b.onclick = () => switchMode(b.dataset.mode);
    });

    // Auto-save engine/risk/app fields on change
    ['setTimeframe', 'setPollSec', 'setMarketHours', 'setFlattenMin',
     'setSchedEnabled', 'setSchedStart', 'setSchedEnd', 'setSizingMode',
     'setPositionValue', 'setPctEquity', 'setRiskPerTrade', 'setExitStyle', 'setTrailPercent',
     'setMaxHold', 'setAvoidEarnings', 'setMaxPos', 'setMaxTrades', 'setDailyLoss',
     'setHaltAction', 'setStopLoss', 'setTakeProfit', 'setCooldown', 'setPdt',
     'setEntryType', 'setLimitBuffer', 'setMaxVolPct', 'setLaunchAtLogin',
     'setTrayMode', 'ntEnabled', 'ntTradeClosed', 'ntTradeOpened', 'ntHalt', 'ntError'
    ].forEach((id) => {
      TF.$(id).addEventListener('change', async () => {
        await saveEngineRisk();
        TF.toast('Settings saved', 'success');
      });
    });

    TF.$('btnSavePaperKeys').onclick = () => saveKeys('paper');
    TF.$('btnSaveLiveKeys').onclick = () => saveKeys('live');
    TF.$('btnTestPaper').onclick = () => testConn('paper', 'paperConnStatus');
    TF.$('btnTestLive').onclick = () => testConn('live', 'liveConnStatus');

    TF.$('btnSaveEmail').onclick = saveEmail;
    TF.$('btnTestEmail').onclick = async () => {
      try {
        await saveEmail();
        await TF.api('email:test');
        TF.toast('Test email sent — check your inbox', 'success');
      } catch (e) { TF.toast(e.message, 'error'); }
    };
    TF.$('btnSummaryNow').onclick = async () => {
      try {
        const n = await TF.api('email:summaryNow');
        TF.toast(`Summary sent (${n} trades today)`, 'success');
      } catch (e) { TF.toast(e.message, 'error'); }
    };

    TF.$('btnOpenData').onclick = () => TF.api('app:openData');
    TF.$('btnOpenLogs').onclick = () => TF.api('app:openLogs');
    TF.$('btnRunWizard').onclick = () => TF.wizard.open();
    TF.$('btnExportSettings').onclick = async () => {
      try {
        const r = await TF.api('settings:exportFile');
        if (r.exported) TF.toast('Settings exported to ' + r.path, 'success');
      } catch (e) { TF.toast(e.message, 'error'); }
    };
    TF.$('btnImportSettings').onclick = async () => {
      if (!await TF.confirm('Import settings?',
        'Replaces your configuration (strategy, engine, risk, watchlist, email options, mode profiles) with the file\'s contents. API keys are untouched, and the app reloads in paper mode.')) return;
      try {
        const r = await TF.api('settings:importFile');
        if (r.imported) location.reload();
      } catch (e) { TF.toast(e.message, 'error'); }
    };
    TF.$('btnSupportBundle').onclick = async () => {
      try {
        const r = await TF.api('support:bundle');
        if (r.saved) TF.toast('Support bundle saved to ' + r.path, 'success');
      } catch (e) { TF.toast(e.message, 'error'); }
    };
    TF.$('btnResetSettings').onclick = async () => {
      if (await TF.confirm('Reset all settings?',
        'Every setting returns to its recommended default — trading mode, engine, risk controls, email options, watchlist, and strategy choice. Your API keys and trade history are kept.')) {
        try {
          await TF.api('settings:reset');
          location.reload();
        } catch (e) { TF.toast(e.message, 'error'); }
      }
    };
    TF.$('btnClearTrades').onclick = async () => {
      if (await TF.confirm('Clear trade history?',
        'This permanently deletes the local trade log (broker records are unaffected).')) {
        await TF.api('trades:clear');
        TF.toast('Trade history cleared');
        TF.history.refresh();
      }
    };

    // Updates
    TF.$('upSave').onclick = async () => {
      TF.state.settings = await TF.api('settings:update', {
        updates: { auto: TF.$('upAuto').checked, feedUrl: TF.$('upFeedUrl').value.trim() }
      });
      TF.toast('Update settings saved', 'success');
    };
    TF.$('upCheck').onclick = async () => {
      TF.$('upStatus').textContent = 'checking…';
      try {
        await TF.api('settings:update', {
          updates: { auto: TF.$('upAuto').checked, feedUrl: TF.$('upFeedUrl').value.trim() }
        });
        await TF.api('update:check');
      } catch (e) {
        TF.$('upStatus').textContent = e.message;
      }
    };
    TF.$('upInstall').onclick = () => TF.apiQuiet('update:install');

    // Readiness report
    TF.$('btnReadiness').onclick = async () => {
      try {
        const r = await TF.api('readiness:get');
        const passed = r.checks.filter((c) => c.pass).length;
        const verdict = passed === r.checks.length
          ? 'All checks pass. The data supports trying live — start with the smallest sizes you would be comfortable losing.'
          : `${passed}/${r.checks.length} checks pass. Keep paper trading — going live now would be betting on hope rather than data.`;
        TF.infoModal('Am I ready for live trading?',
          `Based on your last ${r.window}. ${verdict}`,
          r.checks.map((c) => ({
            name: c.name,
            body: c.detail,
            badge: { text: c.pass ? 'PASS' : 'NOT YET', cls: c.pass ? 'pass' : 'fail' }
          })));
      } catch (e) { TF.toast(e.message, 'error'); }
    };

    // External links
    document.querySelectorAll('[data-ext]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        TF.api('app:openExternal', { url: a.getAttribute('data-ext') });
      };
    });
  }

  // Live updater status pushed from the main process.
  function onUpdateEvent(s) {
    const el = TF.$('upStatus');
    const install = TF.$('upInstall');
    if (!el) return;
    if (s.state === 'checking') el.textContent = 'checking…';
    else if (s.state === 'uptodate') el.textContent = `✓ up to date (v${s.current || ''})`;
    else if (s.state === 'available') el.textContent = `⬇ v${s.version} available — downloading…`;
    else if (s.state === 'downloading') el.textContent = `⬇ downloading ${s.pct || 0}%`;
    else if (s.state === 'downloaded') {
      el.textContent = `✓ v${s.version} ready to install`;
      install.classList.remove('hidden');
      TF.toast(`Update v${s.version} downloaded — install from Settings → Updates`, 'success');
    } else if (s.state === 'error') el.textContent = '✗ ' + s.msg;
  }

  return { init, fillForm, onUpdateEvent };
})();
