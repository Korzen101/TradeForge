// Strategies view: 10 selectable strategy cards with editable parameters.
TF.strategies = (() => {
  let list = [];

  function paramValue(stratId, p) {
    const overrides = (TF.state.settings.strategy.params || {})[stratId] || {};
    return typeof overrides[p.key] === 'number' ? overrides[p.key] : p.def;
  }

  function render() {
    const grid = TF.$('strategyGrid');
    const active = TF.state.settings.strategy.active;
    grid.innerHTML = list.map((s) => `
      <div class="strategy-card has-info${s.id === active ? ' active' : ''}" data-id="${s.id}">
        <div class="strat-top">
          <div class="strat-name">${s.id === active ? '<span class="strat-active-dot"></span>' : ''}${TF.esc(s.name)}</div>
          <span class="strat-cat">${TF.esc(s.category)}</span>
        </div>
        <div class="strat-blurb">${TF.esc(s.blurb)}</div>
        <div class="strat-profile">${TF.esc(s.profile)}</div>
        <details class="strat-config" data-stop>
          <summary>Configure parameters</summary>
          <div class="strat-params">
            ${s.params.map((p) => `
              <label><span>${TF.esc(p.label)} <span class="rec-chip">rec ${p.def}</span></span>
                <input class="input" type="number" data-strat="${s.id}" data-key="${p.key}"
                  value="${paramValue(s.id, p)}" min="${p.min}" max="${p.max}" step="${p.step}" />
              </label>`).join('')}
          </div>
          <div class="row-inline">
            <button class="btn btn-sm btn-primary" data-save="${s.id}">Save parameters</button>
            <button class="btn btn-sm" data-reset="${s.id}">Reset defaults</button>
          </div>
        </details>
        <button class="info-btn" data-info="${s.id}" title="Explain this strategy's parameters">i</button>
      </div>`).join('');

    grid.querySelectorAll('[data-info]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const strat = list.find((x) => x.id === btn.getAttribute('data-info'));
        if (!strat) return;
        TF.infoModal(
          strat.name,
          strat.blurb + ' ' + strat.profile +
          ' The recommended values below are the strategy\'s classic defaults — a sound starting point until your own paper-trading results justify a change.',
          strat.params.map((p) => ({ name: p.label, body: p.help || '', rec: p.def }))
        );
      };
    });

    grid.querySelectorAll('.strategy-card').forEach((card) => {
      card.addEventListener('click', async (e) => {
        if (e.target.closest('[data-stop]')) return; // clicks inside config don't switch
        if (e.target.closest('.info-btn')) return;
        const id = card.dataset.id;
        if (id === TF.state.settings.strategy.active) return;
        TF.state.settings = await TF.api('settings:update', { strategy: { active: id } });
        TF.toast(`Active strategy: ${list.find((x) => x.id === id).name}`, 'success');
        render();
      });
    });

    grid.querySelectorAll('[data-save]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-save');
        const params = {};
        grid.querySelectorAll(`input[data-strat="${id}"]`).forEach((inp) => {
          const v = parseFloat(inp.value);
          if (isFinite(v)) params[inp.dataset.key] = v;
        });
        TF.state.settings = await TF.api('settings:update', { strategy: { params: { [id]: params } } });
        TF.toast('Parameters saved', 'success');
      };
    });

    grid.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-reset');
        const empty = {};
        const strat = list.find((x) => x.id === id);
        for (const p of strat.params) empty[p.key] = p.def;
        TF.state.settings = await TF.api('settings:update', { strategy: { params: { [id]: empty } } });
        TF.toast('Defaults restored', 'success');
        render();
      };
    });
  }

  async function init() {
    list = await TF.api('strategies:list');
    render();
  }

  return { init, render };
})();
