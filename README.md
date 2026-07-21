# TradeForge

An automated stock-trading desktop app for Windows. Dark, Apple-style interface. Trades your
watchlist automatically through **your own Alpaca brokerage account**, in **paper (simulated)**
or **live** mode, using one of 10 classic strategies with layered risk controls.

> ⚠️ **Read this first.** Automated trading involves substantial risk of loss — most short-term
> traders lose money, and no strategy in this app has a guaranteed success rate. Run in **paper
> mode for several weeks** before even considering live funds. This software is provided as-is
> and is not financial advice. You are solely responsible for activity in your brokerage account.

## Quick start

1. **Install & run**
   ```
   npm install
   npm start
   ```
2. **Get free Alpaca keys** — create an account at [alpaca.markets](https://alpaca.markets),
   open the dashboard, and generate **paper trading** API keys (Key ID + Secret).
3. **Connect** — in TradeForge: *Settings → Alpaca API Keys → Paper keys → Save → Test connection*.
4. **Pick a strategy** (*Strategies* tab), **choose your stocks** (*Stocks* tab), review
   **risk controls** (*Settings*), then press **▶ Start Engine** on the Dashboard.

The engine scans your enabled symbols on the chosen bar timeframe and places orders when the
active strategy signals. It only trades while it's running and the market is open.

## What's inside

| Tab | Purpose |
|---|---|
| **Dashboard** | Start/stop the engine, equity & day P/L, open positions, live activity log |
| **Charts** | Embedded TradingView charts for every watchlist symbol, with strategy-matched indicators |
| **Strategies** | 10 selectable strategies with editable parameters (one active at a time) |
| **Stocks** | The whitelist of symbols the bot may trade, with per-symbol on/off toggles |
| **History** | Every completed trade: buy price, sell price, P/L $ and %, win rate, CSV export |
| **Settings** | Paper/live mode, API keys, engine timing, risk controls, email reports |

## The 10 strategies

Mean reversion: **Bollinger Band Reversion**, **RSI(2) Mean Reversion**, **VWAP Reversion**,
**Stochastic Reversal** · Breakout: **Opening Range Breakout**, **Bollinger Squeeze Breakout**,
**Donchian Channel Breakout** · Trend/momentum: **EMA 9/21 Crossover**, **MACD Momentum**,
**Supertrend Follower**

All are long-only. Each strategy card explains its logic and its honest historical profile —
mean-reversion styles tend to have high win rates with small wins; breakout/trend styles win
less often but catch larger moves. Test them on paper and judge with your own History tab.

## Safety & risk controls

- **Bracket orders** — every entry carries a broker-side stop-loss and take-profit, so positions
  stay protected even if the app or your PC goes offline.
- **Daily loss limit** — halts trading (and optionally flattens) once the day's loss hits your cap.
- **Position sizing** — fixed $ per trade or % of equity; max open positions; max trades/day.
- **End-of-day flatten** — optionally sells everything N minutes before the close (day traders
  don't hold overnight).
- **PDT protection** — blocks the 4th day trade in 5 business days on accounts under $25k
  (a FINRA rule for margin accounts).
- **Live-mode gate** — live trading requires typing `LIVE` to confirm, shows a red badge, and
  disarms automatically whenever you switch back to paper.
- **Cooldowns** — a re-entry cooldown per symbol prevents churn.

## Email reports

Settings → Email Reports. Works with any SMTP provider. For Gmail: enable 2-Step Verification,
create an **App Password** (Google Account → Security → App passwords), and use
`smtp.gmail.com`, port `587`, TLS off (STARTTLS is automatic). You can enable per-trade emails
(symbol, buy, sell, profit) and/or a daily summary at a set time.

## Where your data lives

Everything stays on this computer (`%APPDATA%/tradeforge`): settings, trade history, and API
keys. Keys are encrypted with Windows account encryption (DPAPI) — they are never sent anywhere
except directly to Alpaca over HTTPS.

## Data feed notes

Market data uses Alpaca's free IEX feed. It's real-time but reflects IEX exchange volume only,
which is a subset of total market volume — fine for testing, but know that paid SIP data is more
complete if you ever get serious.

## Building an installer (for sharing later)

```
npm run dist
```
Produces a Windows NSIS installer in `dist/`. Before distributing: add an app icon
(`build/icon.ico` + `"icon"` field in package.json), consider code-signing (unsigned installers
trigger SmartScreen warnings), and remember anyone you share it with needs their own Alpaca
account and keys.

## Disclaimers

TradeForge is a tool that executes rules you configure; it does not provide investment advice.
Past performance of any strategy — including the historical profiles described in the app — does
not guarantee future results. Markets can gap through stop-losses; losses can exceed your daily
limit. Never trade money you cannot afford to lose.
