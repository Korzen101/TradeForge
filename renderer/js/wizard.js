// First-run setup wizard: Alpaca account -> paper keys -> starting strategy
// -> honest checklist. Re-runnable from Settings.
TF.wizard = (() => {
  let step = 0;
  let strategies = [];
  const LAST = 3;

  function renderDots() {
    TF.$('wizDots').innerHTML = Array.from({ length: LAST + 1 }, (_, i) =>
      `<span class="wiz-dot${i === step ? ' active' : ''}"></span>`).join('');
  }

  function show() {
    document.querySelectorAll('#wizardModal .wiz-step').forEach((el) =>
      el.classList.toggle('hidden', Number(el.dataset.step) !== step));
    TF.$('wizBack').classList.toggle('hidden', step === 0);
    TF.$('wizNext').textContent = step === LAST ? 'Finish' : 'Next';
    renderDots();
  }

  async function finish() {
    TF.state.settings = await TF.api('settings:update', { wizardDone: true });
    TF.$('wizardModal').classList.add('hidden');
  }

  async function next() {
    if (step === 2) {
      const id = TF.$('wizStrategy').value;
      if (id && id !== TF.state.settings.strategy.active) {
        TF.state.settings = await TF.api('settings:update', { strategy: { active: id } });
        TF.strategies.render();
      }
    }
    if (step === LAST) { await finish(); TF.toast('Setup complete — happy (paper) trading! 📈', 'success'); return; }
    step++;
    show();
  }

  async function testKeys() {
    const key = TF.$('wizKey').value.trim();
    const secret = TF.$('wizSecret').value.trim();
    const st = TF.$('wizKeyStatus');
    if (!key || !secret) { st.textContent = 'enter both fields'; st.style.color = 'var(--yellow)'; return; }
    st.textContent = 'testing…';
    st.style.color = 'var(--text-3)';
    try {
      await TF.api('secrets:set', { field: 'paperKey', value: key });
      await TF.api('secrets:set', { field: 'paperSecret', value: secret });
      const r = await TF.api('conn:test', { mode: 'paper' });
      st.textContent = `✓ connected — ${r.status}, equity $${Number(r.equity).toLocaleString()}`;
      st.style.color = 'var(--green)';
      TF.state.settings = await TF.api('settings:get');
      TF.settingsView.fillForm();
    } catch (e) {
      st.textContent = '✗ ' + e.message;
      st.style.color = 'var(--red)';
    }
  }

  async function open() {
    step = 0;
    if (!strategies.length) strategies = await TF.api('strategies:list');
    const sel = TF.$('wizStrategy');
    sel.innerHTML = strategies.map((s) =>
      `<option value="${s.id}">${TF.esc(s.name)} — ${TF.esc(s.category)}</option>`).join('');
    sel.value = TF.state.settings.strategy.active || strategies[0].id;
    const blurb = () => {
      const s = strategies.find((x) => x.id === sel.value);
      TF.$('wizStratBlurb').textContent = s ? s.blurb + ' ' + s.profile : '';
    };
    sel.onchange = blurb;
    blurb();
    TF.$('wizardModal').classList.remove('hidden');
    show();
  }

  function init() {
    TF.$('wizNext').onclick = () => next().catch((e) => TF.toast(e.message, 'error'));
    TF.$('wizBack').onclick = () => { if (step > 0) { step--; show(); } };
    TF.$('wizSkip').onclick = () => finish().catch((e) => TF.toast(e.message, 'error'));
    TF.$('wizTestKeys').onclick = testKeys;
    TF.$('wizAlpacaLink').onclick = () => TF.api('app:openExternal', { url: 'https://alpaca.markets' });
  }

  return { init, open };
})();
