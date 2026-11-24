# Hyperliquid Real Profitable Traders

A platform that surfaces **real** profitable traders on Hyperliquid by combining the public leaderboard with on-chain account state and fill history, then filtering out noise (one-hit wonders, dust accounts, wash-trading, declining performance).

## Run

```bash
npm install
npm start
# open http://localhost:3000
```

## How "real profitable" is defined

From `stats-data.hyperliquid.xyz/Mainnet/leaderboard` (46k+ wallets, day/week/month/allTime pnl, roi, volume, account value):

- Profitable in the recent windows (month + week) — not a single lucky bet
- Minimum trading volume (all-time) and minimum window volume — excludes dust
- ROI within sane bounds — excludes noise accounts
- Not declining (all-time pnl positive but month negative)
- Consistency score: count of profitable windows (min 2 by default)
- Composite score combining consistency, recent PnL, ROI, account size, efficiency

Per-trader detail pulls `clearinghouseState` (positions, margin) and `userFills` (last 2000) and computes win rate, profit factor, net PnL after fees, and per-coin breakdown.

## API

- `GET /api/leaderboard?window=month&sortBy=score&minPnl=0&minVolume=10000&minAccount=1000&minWins=2&minRoi=0&onlyReal=true&limit=100&offset=0`
- `GET /api/trader/:address`
- `GET /api/meta`
