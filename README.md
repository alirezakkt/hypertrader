# 🚀 HyperTrader

> Find real profitable traders on Hyperliquid. Filter by consistency, drawdown, and edge. Copy-trade on testnet or mainnet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/alirezakkt/hypertrader?style=social)](https://github.com/alirezakkt/hypertrader)

## What is HyperTrader?

HyperTrader is an open-source platform that helps you discover **real** profitable traders on [Hyperliquid](https://hyperliquid.xyz) — not just lucky gamblers or HFT bots. It combines the public leaderboard with on-chain account state and fill history, then filters out noise.

**Key features:**
- 🔍 **Smart trader discovery** — filters by consistency, drawdown, win rate, and style (directional vs HFT/market-maker)
- 📊 **Deep analytics** — per-trader positions, fills, win rate, profit factor, max drawdown, Sharpe ratio, equity curve
- 📡 **Live tracking** — stream trader fills in real-time via WebSocket
- 🤖 **Copy trading** — mirror open positions on testnet or mainnet with risk controls
- 🧪 **Paper trading simulator** — $10K virtual account with real fees, slippage (from L2 book), funding rates, and liquidation
- 📱 **Telegram alerts** — get notified on every open/close/liquidation
- 🌐 **Web dashboard** — clean, responsive UI

## Screenshots

> Run the platform locally (`npm start` → http://localhost:3000) to see the full UI.

The dashboard includes:
- **Leaderboard** — sortable table with score, style, PnL, ROI, account, volume, wins
- **Trader Detail** — positions, fills, win rate, profit factor, max drawdown, Sharpe, equity curve, per-coin breakdown
- **Live Tracker** — real-time WebSocket fill stream
- **Simulation** — paper trading with equity curve, metrics, trade log

## Quick Start

### Prerequisites
- Node.js 20+
- npm

### Install & Run

```bash
git clone https://github.com/alirezakkt/hypertrader.git
cd hypertrader
npm install
cp .env.example .env
# Edit .env with your settings
npm start
```

Open http://localhost:3000

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `HL_TESTNET` | Use testnet (1) or mainnet (0) | `1` |
| `HL_AGENT_KEY` | Hyperliquid agent private key | — |
| `HL_ACCOUNT` | Your main wallet address | — |
| `HL_SIZE_SCALE` | Copy-trade size scale factor | `0.001` |
| `HL_MAX_POSITION_PCT` | Max position as % of account | `0.05` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (optional) | — |
| `TELEGRAM_CHAT_ID` | Telegram chat ID (optional) | — |

## How "Real Profitable" is Defined

From `stats-data.hyperliquid.xyz/Mainnet/leaderboard` (46k+ wallets):

- ✅ Profitable in recent windows (month + week) — not a single lucky bet
- ✅ Minimum trading volume (all-time) — excludes dust accounts
- ✅ ROI within sane bounds — excludes noise
- ✅ Not declining (all-time PnL positive but month negative)
- ✅ Consistency score: count of profitable windows
- ✅ Style classification: directional / swing / scalper / HFT / market_maker / mixed
- ✅ Risk-adjusted: max drawdown, win rate, profit factor, Sharpe ratio

## Architecture

```
hypertrader/
├── server/index.js          # Express API + WebSocket + simulator
├── public/index.html        # React dashboard (single-file, no build)
├── scripts/mirror.py        # Python copy-trade executor (Hyperliquid SDK)
├── config/recommended.json  # Auto-updated list of top wallets
├── deploy/                  # VPS deployment scripts
└── .env.example             # Environment template
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/leaderboard` | Filtered, scored trader list |
| `GET /api/trader/:address` | Trader detail (positions, fills, metrics) |
| `GET /api/live?addresses=...` | SSE stream of live fills |
| `GET /api/sim/status` | Simulator state + metrics |
| `POST /api/sim/start` | Start simulator |
| `POST /api/sim/stop` | Stop simulator |
| `POST /api/sim/reset` | Reset simulator |
| `POST /api/mirror/start` | Start copy-trading |
| `POST /api/mirror/stop` | Stop copy-trading |
| `GET /api/health` | Health check |

## VPS Deployment

```bash
# On your VPS
git clone https://github.com/alirezakkt/hypertrader.git /opt/hyper
cd /opt/hyper
bash deploy/setup.sh
nano .env  # configure
pm2 restart hyper-platform
```

See [deploy/README.md](deploy/README.md) for full instructions.

## Tech Stack

- **Backend:** Node.js, Express, WebSocket (ws)
- **Frontend:** React 18 (CDN), Tailwind CSS, no build step
- **Copy-trading:** Python, hyperliquid-python-sdk
- **Data:** Hyperliquid public API + leaderboard

## Contributing

Contributions are welcome! Please open an issue or PR.

## Disclaimer

This is not financial advice. Trading perpetual futures involves substantial risk of loss. Past performance does not indicate future results. Use at your own risk.

## License

MIT
