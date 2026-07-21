// Shared helpers (loaded first; defines the TF namespace).
window.TF = { state: { settings: null, positions: [], account: null, status: null } };

TF.$ = (id) => document.getElementById(id);

TF.money = (v, digits = 2) => {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  });
};

TF.pct = (v, digits = 2) => {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(digits) + '%';
};

TF.plClass = (v) => (Number(v) >= 0 ? 'pos' : 'neg');

TF.timeShort = (iso) => {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

TF.dateTimeShort = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

TF.timeAgo = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const d = Math.floor(hr / 24);
  return d === 1 ? 'yesterday' : d + 'd ago';
};

TF.esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

TF.toast = (msg, kind = '') => {
  const box = document.createElement('div');
  box.className = 'toast ' + kind;
  box.textContent = msg;
  TF.$('toasts').appendChild(box);
  setTimeout(() => box.remove(), 4200);
};

// Info modal: title, optional intro paragraph, and rows of
// { name, body, rec } where rec is the recommended value.
TF.infoModal = (title, intro, items) => {
  TF.$('infoTitle').textContent = title;
  const parts = [];
  if (intro) parts.push('<p class="info-intro">' + TF.esc(intro) + '</p>');
  for (const it of items) {
    parts.push(
      '<div class="info-row"><h4>' + TF.esc(it.name) +
      (it.rec !== undefined && it.rec !== null && it.rec !== ''
        ? '<span class="rec-chip">rec ' + TF.esc(it.rec) + '</span>' : '') +
      (it.badge ? '<span class="badge ' + TF.esc(it.badge.cls) + '">' + TF.esc(it.badge.text) + '</span>' : '') +
      '</h4><p>' + TF.esc(it.body) + '</p></div>');
  }
  TF.$('infoContent').innerHTML = parts.join('');
  const modal = TF.$('infoModal');
  modal.classList.remove('hidden');
  TF.$('infoClose').onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
};

// Cumulative P/L line chart on a canvas. points = [{ y }] in order.
TF.drawEquityCurve = (canvas, points) => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const hgt = canvas.clientHeight || 180;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const x = canvas.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, hgt);
  const css = getComputedStyle(document.documentElement);
  const green = css.getPropertyValue('--green').trim() || '#30d158';
  const red = css.getPropertyValue('--red').trim() || '#ff453a';
  const dim = 'rgba(255,255,255,0.25)';
  if (!points || points.length < 2) {
    x.fillStyle = dim;
    x.font = '12px sans-serif';
    x.textAlign = 'center';
    x.fillText('Not enough closed trades to draw a curve', w / 2, hgt / 2);
    return;
  }
  const pad = { l: 46, r: 10, t: 10, b: 18 };
  const ys = points.map((p) => p.y);
  let min = Math.min(0, ...ys), max = Math.max(0, ...ys);
  if (max === min) max = min + 1;
  const px = (i) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
  const py = (v) => pad.t + (1 - (v - min) / (max - min)) * (hgt - pad.t - pad.b);
  // zero line + labels
  x.strokeStyle = 'rgba(255,255,255,0.12)';
  x.lineWidth = 1;
  x.beginPath(); x.moveTo(pad.l, py(0)); x.lineTo(w - pad.r, py(0)); x.stroke();
  x.fillStyle = dim;
  x.font = '10px sans-serif';
  x.textAlign = 'left';
  x.fillText('$0', 4, py(0) + 3);
  x.fillText(TF.money(max, 0), 4, py(max) + 8);
  x.fillText(TF.money(min, 0), 4, py(min) - 2);
  // curve
  const last = ys[ys.length - 1];
  const color = last >= 0 ? green : red;
  x.beginPath();
  points.forEach((p, i) => (i === 0 ? x.moveTo(px(i), py(p.y)) : x.lineTo(px(i), py(p.y))));
  x.strokeStyle = color;
  x.lineWidth = 2;
  x.lineJoin = 'round';
  x.stroke();
  // gradient fill to zero line
  const grad = x.createLinearGradient(0, pad.t, 0, hgt - pad.b);
  grad.addColorStop(0, color + '44');
  grad.addColorStop(1, color + '00');
  x.lineTo(px(points.length - 1), py(0));
  x.lineTo(px(0), py(0));
  x.closePath();
  x.fillStyle = grad;
  x.fill();
};

// Generic confirm modal; returns a Promise<boolean>.
TF.confirm = (title, body) => new Promise((resolve) => {
  TF.$('confirmTitle').textContent = title;
  TF.$('confirmBody').textContent = body;
  const modal = TF.$('confirmModal');
  modal.classList.remove('hidden');
  const done = (val) => {
    modal.classList.add('hidden');
    TF.$('confirmOk').onclick = null;
    TF.$('confirmCancel').onclick = null;
    resolve(val);
  };
  TF.$('confirmOk').onclick = () => done(true);
  TF.$('confirmCancel').onclick = () => done(false);
});
