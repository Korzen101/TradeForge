// Email reports via SMTP (nodemailer). The user supplies their own SMTP
// credentials in Settings (e.g. a Gmail app password); stored encrypted.
const nodemailer = require('nodemailer');
const store = require('./store');

function getTransport() {
  const s = store.get().email;
  const pass = store.getSecret('emailPass');
  if (!s.host || !s.user || !pass) {
    const err = new Error('Email is not fully configured (host, username, and password are required)');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 587,
    secure: !!s.secure,
    auth: { user: s.user, pass }
  });
}

function money(v) {
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toFixed(2);
}

function baseWrap(title, inner) {
  return `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#1d1d1f;">
    <h2 style="margin:0 0 4px;font-weight:600;">${title}</h2>
    <p style="margin:0 0 20px;color:#6e6e73;font-size:13px;">TradeForge automated report</p>
    ${inner}
    <p style="margin-top:24px;color:#8e8e93;font-size:11px;border-top:1px solid #e5e5ea;padding-top:12px;">
      Automated trading involves substantial risk of loss. This report is informational only and is not financial advice.
    </p>
  </div>`;
}

function tradeRow(t) {
  const color = t.pl >= 0 ? '#248a3d' : '#d70015';
  return `<tr>
    <td style="padding:8px;border-bottom:1px solid #e5e5ea;">${t.symbol}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e5ea;">${t.strategy}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e5ea;text-align:right;">${t.qty}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e5ea;text-align:right;">${money(t.entryPrice)}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e5ea;text-align:right;">${money(t.exitPrice)}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e5ea;text-align:right;color:${color};font-weight:600;">${money(t.pl)} (${t.plPct >= 0 ? '+' : ''}${t.plPct.toFixed(2)}%)</td>
  </tr>`;
}

const TABLE_HEAD = `<tr style="text-align:left;color:#6e6e73;font-size:12px;">
  <th style="padding:8px;">Symbol</th><th style="padding:8px;">Strategy</th>
  <th style="padding:8px;text-align:right;">Qty</th><th style="padding:8px;text-align:right;">Buy</th>
  <th style="padding:8px;text-align:right;">Sell</th><th style="padding:8px;text-align:right;">P/L</th></tr>`;

async function send(subject, html) {
  const s = store.get().email;
  const to = s.to || s.user;
  const transport = getTransport();
  await transport.sendMail({
    from: s.from || s.user,
    to,
    subject,
    html
  });
}

async function sendTest() {
  await send('TradeForge — test email',
    baseWrap('Test email', '<p>Your TradeForge email settings are working. 🎉</p>'));
}

async function sendTradeClosed(t, mode) {
  const dir = t.pl >= 0 ? 'WIN' : 'LOSS';
  const subject = `TradeForge [${mode.toUpperCase()}] ${dir}: ${t.symbol} ${money(t.pl)}`;
  const inner = `
    <table style="width:100%;border-collapse:collapse;font-size:13px;">${TABLE_HEAD}${tradeRow(t)}</table>
    <p style="color:#6e6e73;font-size:12px;margin-top:12px;">Exit reason: ${t.exitReason || 'n/a'}</p>`;
  await send(subject, baseWrap('Trade closed', inner));
}

async function sendDailySummary(trades, accountSnapshot, mode) {
  const totalPl = trades.reduce((s, t) => s + t.pl, 0);
  const wins = trades.filter((t) => t.pl > 0).length;
  const subject = `TradeForge [${mode.toUpperCase()}] daily summary: ${trades.length} trades, ${money(totalPl)}`;
  const rows = trades.map(tradeRow).join('');
  const acct = accountSnapshot ? `
    <p style="font-size:13px;color:#3a3a3c;margin:16px 0 0;">
      Equity: <b>${money(Number(accountSnapshot.equity))}</b> &nbsp;·&nbsp;
      Day change: <b>${money(Number(accountSnapshot.equity) - Number(accountSnapshot.last_equity))}</b>
    </p>` : '';
  const inner = `
    <p style="font-size:14px;">Trades: <b>${trades.length}</b> &nbsp;·&nbsp; Wins: <b>${wins}</b> &nbsp;·&nbsp;
    Net P/L: <b style="color:${totalPl >= 0 ? '#248a3d' : '#d70015'};">${money(totalPl)}</b></p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">${TABLE_HEAD}${rows}</table>
    ${acct}`;
  await send(subject, baseWrap('Daily trading summary', inner));
}

module.exports = { sendTest, sendTradeClosed, sendDailySummary };
