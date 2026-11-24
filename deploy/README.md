# VPS Deployment Guide

## Prerequisites
- Ubuntu 22.04+ VPS (1GB RAM minimum)
- Node.js 20+
- Your Hyperliquid agent key & account address

## Steps

1. **Upload code to VPS:**
   ```bash
   scp -r /path/to/hyper user@vps:/opt/hyper
   ```

2. **Run setup:**
   ```bash
   ssh user@vps
   cd /opt/hyper
   bash deploy/setup.sh
   ```

3. **Configure .env:**
   ```bash
   nano /opt/hyper/.env
   # Set HL_AGENT_KEY, HL_ACCOUNT, HL_TESTNET=0
   ```

4. **Restart:**
   ```bash
   pm2 restart hyper-platform
   ```

5. **Open firewall:**
   ```bash
   ufw allow 3000
   ```

6. **Access:** http://YOUR_VPS_IP:3000

## For copy trading on mainnet:
- Set `HL_TESTNET=0` in .env
- Fund your account with $300-500+ USDC
- Open the platform → Live & Mirror tab → paste the 7 recommended wallets → Start mirror

## Process management
- Status: `pm2 status`
- Logs: `pm2 logs hyper-platform`
- Restart: `pm2 restart hyper-platform`
- Stop: `pm2 stop hyper-platform`