// App bootstrap: navigation, live push events, first-run disclaimer.
(() => {
  TF.showView = (name) => {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    const view = TF.$('view-' + name);
    const nav = document.querySelector(`.nav-item[data-view="${name}"]`);
    if (view) view.classList.add('active');
    if (nav) nav.classList.add('active');
    if (name === 'charts' && TF.charts.onShow) TF.charts.onShow();
    if (name === 'history' && TF.history.onShow) TF.history.onShow();
    if (name === 'stocks' && TF.stocks.onShow) TF.stocks.onShow();
    if (name === 'scanner' && TF.scanner.onShow) TF.scanner.onShow();
    if (name === 'news' && TF.news.onShow) TF.news.onShow();
  };

  function wireNav() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.onclick = () => TF.showView(btn.dataset.view);
    });
  }

  function wirePush() {
    window.tf.onPush(({ channel, data }) => {
      switch (channel) {
        case 'log': TF.dashboard.pushLog(data); break;
        case 'status': TF.dashboard.renderStatus(data); break;
        case 'account': TF.dashboard.renderAccount(data); break;
        case 'positions': TF.dashboard.renderPositions(data); break;
        case 'trade':
          if (data.kind === 'close' && data.trade) {
            const t = data.trade;
            TF.toast(`${t.pl >= 0 ? '✅' : '🔻'} ${t.symbol} closed: ${TF.money(t.pl)}`,
              t.pl >= 0 ? 'success' : 'error');
          }
          TF.dashboard.refreshToday();
          TF.history.refresh();
          break;
        case 'bt': TF.backtest.onEvent(data); break;
        case 'update': TF.settingsView.onUpdateEvent(data); break;
        case 'signals': TF.dashboard.renderSignals(data); break;
        case 'tick': TF.dashboard.onTick(data); break;
      }
    });
  }

  function maybeShowWizard() {
    const st = TF.state.settings;
    if (!st.wizardDone && !st.secrets.paperKey.set) TF.wizard.open();
  }

  function maybeShowDisclaimer() {
    if (TF.state.settings.acknowledgedRisk) { maybeShowWizard(); return; }
    const modal = TF.$('disclaimerModal');
    modal.classList.remove('hidden');
    const check = TF.$('ackCheck');
    const btn = TF.$('ackBtn');
    check.onchange = () => { btn.disabled = !check.checked; };
    btn.onclick = async () => {
      TF.state.settings = await TF.api('settings:update', { acknowledgedRisk: true });
      modal.classList.add('hidden');
      maybeShowWizard();
    };
  }

  async function boot() {
    try {
      TF.state.settings = await TF.api('settings:get');
    } catch (e) {
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;">Failed to start: ' +
        TF.esc(e.message) + '</div>';
      return;
    }
    wireNav();
    wirePush();

    TF.apiQuiet('app:version').then((v) => {
      if (v) { TF.$('appVersion').textContent = 'v' + v; TF.$('aboutVersion').textContent = 'v' + v; }
    });

    await TF.strategies.init();
    TF.settingsView.init();
    TF.stocks.init();
    TF.charts.init();
    TF.history.init();
    await TF.backtest.init();
    TF.scanner.init();
    TF.news.init();
    TF.wizard.init();
    await TF.dashboard.init();

    maybeShowDisclaimer();
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
