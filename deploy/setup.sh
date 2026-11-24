#!/bin/bash
set -e
echo "=== Hyperliquid Copy-Trading Platform - VPS Setup ==="

# Install Node.js 20+ if missing
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Install pm2 for process management
npm install -g pm2

# Install deps
cd /opt/hyper
npm install --production

# Setup .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo ">>> Edit /opt/hyper/.env with your HL_AGENT_KEY and HL_ACCOUNT <<<"
fi

# Start with pm2
pm2 start server/index.js --name hyper-platform
pm2 save
pm2 startup

echo "=== Done. Platform running on port 3000 ==="
echo "Open http://YOUR_VPS_IP:3000"