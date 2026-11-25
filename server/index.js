require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const INFO = 'https://api.hyperliquid.xyz/info';
const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const CACHE_FILE = path.join(__dirname, '..', '.cache', 'leaderboard.json');

// Telegram notifications
async function sendTelegram(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
    });
  } catch(e) { console.warn('telegram err:', e.message); }
}
const SIM_FILE = path.join(__dirname, '..', '.cache', 'sim.json');

let leaderboardCache = null;
let leaderboardFetchedAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

async function fetchLeaderboard() {
  const now = Date.now();
  if (leaderboardCache && now - leaderboardFetchedAt < CACHE_TTL) return leaderboardCache;
  // disk cache (any age)
  if (fs.existsSync(CACHE_FILE)) {
    try {
      leaderboardCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      leaderboardFetchedAt = now;
    } catch (e) {}
  }
  // try refresh
  try {
    console.log('Fetching leaderboard from Hyperliquid...');
    const res = await fetch(LEADERBOARD_URL, { signal: AbortSignal.timeout(60000) });
    if (res.ok) {
      const json = await res.json();
      leaderboardCache = json;
      leaderboardFetchedAt = now;
      try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(json));
      } catch (e) { console.warn('cache write failed', e.message); }
      return json;
    }
  } catch (e) { console.warn('leaderboard refresh failed:', e.message); }
  if (leaderboardCache) return leaderboardCache;
  throw new Error('no leaderboard data available');
}

function w(row, name) {
  try {
    const pairs = row.windowPerformances;
    const map = Array.isArray(pairs) ? Object.fromEntries(pairs) : pairs;
    return map[name] || {};
  } catch (e) { return {}; }
}

function num(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n; }

// Compute a "real profitable" score for a leaderboard row
function scoreRow(row) {
  const day = w(row, 'day');
  const week = w(row, 'week');
  const month = w(row, 'month');
  const all = w(row, 'allTime');
  const pnlD = num(day.pnl), pnlW = num(week.pnl), pnlM = num(month.pnl), pnlA = num(all.pnl);
  const roiD = num(day.roi), roiW = num(week.roi), roiM = num(month.roi), roiA = num(all.roi);
  const vlmD = num(day.vlm), vlmW = num(week.vlm), vlmM = num(month.vlm), vlmA = num(all.vlm);
  const av = num(row.accountValue);

  // consistency: how many windows profitable
  const wins = [pnlD, pnlW, pnlM, pnlA].filter(p => p > 0).length;
  // not a one-hit wonder: recent windows positive
  const recentPositive = pnlM > 0 && pnlW > 0;
  // volume sanity: volume should be meaningful relative to account (not wash with zero pnl)
  // efficiency: pnl per volume
  const effM = vlmM > 0 ? pnlM / vlmM : 0;
  // roi stability
  const roiMin = Math.min(roiD, roiW, roiM, roiA);
  // drawdown proxy: if allTime pnl huge but month negative -> declining
  const declining = pnlA > 0 && pnlM < 0;

  // composite score (higher better). Heavily weight consistency and recent profitability.
  let score = 0;
  score += wins * 25;
  if (recentPositive) score += 30;
  score += Math.min(roiM, 200) * 0.5; // cap roi contribution
  score += Math.min(pnlM / 1000, 50); // pnl magnitude (capped)
  score += Math.min(av / 1000, 30); // account size
  score += Math.min(effM, 1) * 30; // efficiency capped
  if (declining) score -= 40;
  // penalize tiny volume (likely noise / one trade)
  if (vlmA < 1000) score -= 20;
  // penalize wash: huge volume but tiny pnl
  if (vlmA > 1e6 && pnlA / vlmA < 0.001) score -= 30;

  return {
    pnl: { day: pnlD, week: pnlW, month: pnlM, allTime: pnlA },
    roi: { day: roiD, week: roiW, month: roiM, allTime: roiA },
    vlm: { day: vlmD, week: vlmW, month: vlmM, allTime: vlmA },
    accountValue: av,
    displayName: row.displayName || null,
    ethAddress: row.ethAddress,
    wins,
    recentPositive,
    declining,
    efficiency: effM,
    score: Math.round(score * 100) / 100,
    style: guessStyle({ pnlD,pnlW,pnlM,pnlA, roiM, vlmD,vlmW,vlmM,vlmA, av, wins }),
  };
}

function guessStyle(x) {
  const { pnlM, vlmM, vlmA, av, wins, roiM } = x;
  const tphProxy = vlmM / Math.max(av,1);
  if (vlmA > 1e8 && (pnlM/Math.max(vlmM,1)) < 0.005) return 'market_maker';
  if (tphProxy > 50) return 'hft';
  if (tphProxy > 15) return 'scalper';
  if (wins >= 3 && roiM > 0.2) return 'directional';
  if (wins >= 2) return 'swing';
  return 'mixed';
}

app.get('/api/leaderboard', async (req, res) => {
  try {
    const data = await fetchLeaderboard();
    const rows = data.leaderboardRows || [];
    const window = req.query.window || 'month';
    const sortBy = req.query.sortBy || 'score';
    const minPnl = parseFloat(req.query.minPnl || '0');
    const minVolume = parseFloat(req.query.minVolume || '0');
    const minAccount = parseFloat(req.query.minAccount || '0');
    const minWins = parseInt(req.query.minWins || '2');
    const minRoi = parseFloat(req.query.minRoi || '0');
    const onlyReal = req.query.onlyReal !== 'false';
    const limit = Math.min(parseInt(req.query.limit || '100'), 500);
    const offset = parseInt(req.query.offset || '0');

    let scored = rows.map(scoreRow);

    // filter
    scored = scored.filter(s => {
      const pnlW = s.pnl[window] ?? s.pnl.month;
      if (pnlW < minPnl) return false;
      if (s.vlm.allTime < minVolume) return false;
      if (s.accountValue < minAccount) return false;
      if (s.wins < minWins) return false;
      if (s.roi[window] < minRoi) return false;
      if (onlyReal) {
        if (!s.recentPositive) return false;
        if (s.declining) return false;
        if (s.vlm.allTime < 10000) return false; // meaningful volume
        // require activity in the selected window (avoid stale one-shot pnl)
        const wv = s.vlm[window] ?? 0;
        if (window !== 'allTime' && wv < 1000) return false;
        // exclude absurd roi (likely dust accounts / noise)
        if (Math.abs(s.roi[window]) > 20) return false;
      }
      return true;
    });

    // sort
    const sortKey = (s) => {
      switch (sortBy) {
        case 'pnl': return s.pnl[window];
        case 'roi': return s.roi[window];
        case 'volume': return s.vlm[window];
        case 'account': return s.accountValue;
        case 'score':
        default: return s.score;
      }
    };
    scored.sort((a, b) => sortKey(b) - sortKey(a));

    const total = scored.length;
    const page = scored.slice(offset, offset + limit);

    res.json({ total, count: page.length, offset, limit, window, traders: page });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trader/:address', async (req, res) => {
  const addr = req.params.address;
  try {
    const [stateRes, fillsRes] = await Promise.all([
      fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'clearinghouseState', user: addr }) }),
      fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'userFills', user: addr }) }),
    ]);
    const state = await stateRes.json();
    const fills = await fillsRes.json();

    // compute metrics from fills
    const metrics = computeFillMetrics(Array.isArray(fills) ? fills : []);
    const positions = (state && state.assetPositions ? state.assetPositions : []).map(p => p.position);

    res.json({
      address: addr,
      accountValue: (state && state.marginSummary) ? state.marginSummary.accountValue : null,
      marginSummary: (state && state.marginSummary) ? state.marginSummary : null,
      positions,
      fillsCount: Array.isArray(fills) ? fills.length : 0,
      fills: Array.isArray(fills) ? fills.slice(0, 200) : [],
      metrics,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

function computeFillMetrics(fills) {
  if (!Array.isArray(fills) || fills.length === 0) {
    return { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0, profitFactor: 0, maxWin: 0, maxLoss: 0, totalFees: 0, coins: {} };
  }
  let wins = 0, losses = 0, totalPnl = 0, totalFees = 0, grossWin = 0, grossLoss = 0;
  const maxWin = { v: -Infinity }, maxLoss = { v: Infinity };
  const coins = {};
  for (const f of fills) {
    const pnl = parseFloat(f.closedPnl || 0);
    const fee = parseFloat(f.fee || 0);
    totalPnl += pnl;
    totalFees += fee;
    if (pnl > 0) { wins++; grossWin += pnl; if (pnl > maxWin.v) maxWin.v = pnl; }
    else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); if (pnl < maxLoss.v) maxLoss.v = pnl; }
    const c = f.coin;
    if (!coins[c]) coins[c] = { trades: 0, pnl: 0, volume: 0 };
    coins[c].trades++;
    coins[c].pnl += pnl;
    coins[c].volume += parseFloat(f.px) * parseFloat(f.sz);
  }
  const trades = fills.length;
  const winRate = trades > 0 ? (wins / (wins + losses || 1)) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  const sorted = [...fills].sort((a,b)=> (a.time||0)-(b.time||0));
  let cum = 0, peak = 0, maxDD = 0, maxDDPct = 0;
  const equity = [];
  for (const f of sorted) {
    cum += parseFloat(f.closedPnl || 0) - parseFloat(f.fee || 0);
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0 && dd/peak > maxDDPct) maxDDPct = dd/peak;
    equity.push({ t: f.time, v: Math.round(cum*100)/100 });
  }

  return {
    trades,
    wins,
    losses,
    winRate: Math.round(winRate * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round((totalPnl / trades) * 100) / 100,
    profitFactor: isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 999,
    maxWin: maxWin.v === -Infinity ? 0 : Math.round(maxWin.v * 100) / 100,
    maxLoss: maxLoss.v === Infinity ? 0 : Math.round(maxLoss.v * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    netPnl: Math.round((totalPnl - totalFees) * 100) / 100,
    maxDrawdown: Math.round(maxDD*100)/100,
    maxDrawdownPct: Math.round(maxDDPct*10000)/100,
    equityCurve: equity.slice(-200),
    coins,
    // style classification
    style: classifyStyle(fills, { trades, wins, losses, totalPnl, totalFees, coins }),
  };
}

function classifyStyle(fills, m) {
  if (!fills || fills.length === 0) return 'unknown';
  const times = fills.map(f => f.time).sort((a,b)=>a-b);
  const spanH = Math.max((times[times.length-1]-times[0])/3600000, 1/60);
  const tph = fills.length / spanH;
  const distinctCoins = Object.keys(m.coins).length;
  const longOpens = fills.filter(f => /open long/i.test(f.dir||'')).length;
  const shortOpens = fills.filter(f => /open short/i.test(f.dir||'')).length;
  const imbalance = (longOpens+shortOpens)>0 ? Math.abs(longOpens-shortOpens)/(longOpens+shortOpens) : 1;
  const feeRatio = m.totalPnl !== 0 ? Math.abs(m.totalFees / m.totalPnl) : 999;
  if (tph > 30 && distinctCoins >= 5) return 'hft';
  if (tph > 15 && feeRatio > 0.25) return 'scalper';
  if (imbalance < 0.25 && distinctCoins >= 4) return 'market_maker';
  if (distinctCoins <= 4 && tph < 8) return 'directional';
  if (distinctCoins <= 6) return 'swing';
  return 'mixed';
}

app.get('/api/meta', async (req, res) => {
  try {
    const r = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Live tracking (SSE) ----
app.get('/api/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  const addrs = (req.query.addresses || '').split(',').map(s=>s.trim()).filter(Boolean);
  const WebSocket = require('ws');
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  ws.on('open', () => {
    addrs.forEach(a => ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'userFills', user: a } })));
    res.write('event: status\ndata: connected\n\n');
  });
  ws.on('message', (data) => {
    res.write('data: ' + data.toString() + '\n\n');
  });
  ws.on('error', (e) => { res.write('event: error\ndata: ' + (e.message||e) + '\n\n'); });
  req.on('close', () => { try { ws.close(); } catch(e){} });
});

// ---- Mirror control ----
const { spawn } = require('child_process');
let mirrorProc = null;
app.get('/api/mirror/status', (req, res) => {
  res.json({ running: !!mirrorProc, pid: mirrorProc ? mirrorProc.pid : null });
});
app.post('/api/mirror/start', (req, res) => {
  if (mirrorProc) return res.json({ ok: false, msg: 'already running' });
  const addresses = (req.body && req.body.addresses) || [];
  const scale = (req.body && req.body.scale) || process.env.HL_SIZE_SCALE || '0.01';
  const agentKey = (req.body && req.body.agentKey) || process.env.HL_AGENT_KEY;
  const account = (req.body && req.body.account) || process.env.HL_ACCOUNT;
  const testnet = (req.body && req.body.testnet) !== undefined ? req.body.testnet : (process.env.HL_TESTNET !== '0');
  if (!agentKey || !account) return res.json({ ok: false, msg: 'missing agentKey/account' });
  const env = Object.assign({}, process.env, {
    HL_TRACK: addresses.join(','),
    HL_SIZE_SCALE: String(scale),
    HL_AGENT_KEY: agentKey,
    HL_ACCOUNT: account,
    HL_TESTNET: testnet ? '1' : '0',
  });
  mirrorProc = spawn('python3', [path.join(__dirname, '..', 'scripts', 'mirror.py')], { env, stdio: ['ignore','pipe','pipe'] });
  mirrorProc.stdout.on('data', d => console.log('[mirror]', d.toString().trim()));
  mirrorProc.stderr.on('data', d => console.error('[mirror]', d.toString().trim()));
  mirrorProc.on('exit', () => { mirrorProc = null; });
  res.json({ ok: true, pid: mirrorProc.pid });
});
app.post('/api/mirror/stop', (req, res) => {
  if (mirrorProc) { mirrorProc.kill(); mirrorProc = null; }
  res.json({ ok: true });
});


// ---- Paper trading simulator ----
const SCALE_SIM = 0.001;
let sim = { running:false, ws:null, tracked:[], scale:SCALE_SIM, cash:10000, positions:{}, trades:[], equity:[], mids:{}, cumulativeVolume:0, leverage:3, fundingRates:{} };
// load persisted sim
try {
  if (fs.existsSync(SIM_FILE)) {
    const saved = JSON.parse(fs.readFileSync(SIM_FILE,'utf8'));
    sim.cash = saved.cash ?? sim.cash;
    sim.positions = saved.positions ?? sim.positions;
    sim.trades = saved.trades ?? sim.trades;
    sim.equity = saved.equity ?? sim.equity;
    sim.tracked = saved.tracked ?? sim.tracked;
    sim.scale = saved.scale ?? sim.scale;
    sim.cumulativeVolume = saved.cumulativeVolume ?? sim.cumulativeVolume;
    sim.leverage = saved.leverage ?? sim.leverage;
  }
} catch(e) {}
function simReset() {
  if (sim.ws) try { sim.ws.close(); } catch(e){}
  sim = { running:false, ws:null, tracked:[], scale:SCALE_SIM, cash:10000, positions:{}, trades:[], equity:[], mids:{}, cumulativeVolume:0, leverage:3, fundingRates:{} };
  try { if (fs.existsSync(SIM_FILE)) fs.unlinkSync(SIM_FILE); } catch(e){}
}
app.post('/api/sim/start', (req,res) => {
  if (sim.running) return res.json({ok:false,msg:'already running'});
  const addresses = (req.body && req.body.addresses) || [];
  const scale = parseFloat((req.body && req.body.scale) || SCALE_SIM);
  sim.startTime = Date.now();
  sim.tracked = addresses; sim.scale = scale; sim.running = true;
  const WebSocket = require('ws');
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  sim.ws = ws;
  ws.on('open', () => { addresses.forEach(a=>ws.send(JSON.stringify({method:'subscribe',subscription:{type:'userFills',user:a}}))); });
  ws.on('message', async (raw) => {
    let data; try { data=JSON.parse(raw.toString()); } catch(e){return;}
    if (data.channel !== 'userFills') return;
    const d = data.data || {};
    const user = d.user;
    const fills = d.fills || (Array.isArray(d)?d:[]);
    for (const f of fills) {
      if ((f.time || 0) <= (sim.startTime || 0)) continue;
      f._trader = user;
      await processSimFill(f, sim);
    }
  });
  ws.on('close', () => {
    console.log('[sim] ws closed, reconnecting...');
    setTimeout(() => {
      if (!sim.running) { sim.running = true; }
      try {
        const w2 = new WebSocket('wss://api.hyperliquid.xyz/ws');
        sim.ws = w2;
        w2.on('open', () => { console.log('[sim] ws reopened'); sim.tracked.forEach(a=>w2.send(JSON.stringify({method:'subscribe',subscription:{type:'userFills',user:a}}))); });
        w2.on('message', async (raw) => {
          let data; try { data=JSON.parse(raw.toString()); } catch(e){return;}
          if (data.channel !== 'userFills') return;
          const d = data.data || {};
          const user = d.user;
          const fills = d.fills || (Array.isArray(d)?d:[]);
          for (const f of fills) {
            if ((f.time || 0) <= (sim.startTime || 0)) continue;
            f._trader = user;
            await processSimFill(f, sim);
          }
        });
        w2.on('close', () => { console.log('[sim] ws closed again'); });
        w2.on('error', (e) => { console.log('[sim] ws err', e.message); });
      } catch(e) { console.log('[sim] reconnect err', e.message); }
    }, 3000);
  });
  // mid price refresher
  const seen = new Set();
  // seed with CURRENT open positions from clearinghouseState (not historical fills)
  (async () => {
    // fetch mids first
    try {
      const mr = await fetch('https://api.hyperliquid.xyz/info', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'allMids'}) });
      sim.mids = await mr.json();
    } catch(e) {}
    for (const addr of addresses) {
      try {
        const r = await fetch('https://api.hyperliquid.xyz/info', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'clearinghouseState', user: addr}) });
        const st = await r.json();
        const positions = (st && st.assetPositions) ? st.assetPositions : [];
        for (const p of positions) {
          const pos = p.position;
          const coin = pos.coin;
          const sz = parseFloat(pos.szi);
          const mid = parseFloat((sim.mids||{})[coin] || pos.entryPx);
          if (!sim.positions[coin]) sim.positions[coin] = { size: 0, entry: 0 };
          sim.positions[coin].size += sz * sim.scale;
          if (sim.positions[coin].entry === 0) sim.positions[coin].entry = mid;
          else sim.positions[coin].entry = (sim.positions[coin].entry + mid) / 2;
        }
      } catch(e) { console.warn('seed err:', e.message); }
    }
    console.log('[sim] seeded current positions from', addresses.length, 'wallets. Only new fills will be tracked.');
  })();

  if (!sim.fundingRates) sim.fundingRates = {};
  const midIv = setInterval(async () => {
    if (!sim.running) { clearInterval(midIv); return; }
    try {
      const r = await fetch('https://api.hyperliquid.xyz/info', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'allMids'}) });
      sim.mids = await r.json();
    } catch(e){}
    // funding rates + accrual
    try {
      const r2 = await fetch('https://api.hyperliquid.xyz/info', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'metaAndAssetCtxs'}) });
      const d2 = await r2.json();
      const meta = d2[0], ctxs = d2[1];
      (meta.universe || []).forEach((a,i) => {
        const ctx = ctxs[i] || {};
        sim.fundingRates[a.name] = parseFloat(ctx.funding || 0);
      });
      // accrue funding (rate is per hour; 5s interval -> /720)
      for (const [coin,pos] of Object.entries(sim.positions)) {
        if (!pos.size) continue;
        const rate = sim.fundingRates[coin] || 0;
        const mid = parseFloat((sim.mids||{})[coin] || pos.entry);
        const payment = pos.size * mid * rate / 720;
        sim.cash -= payment;
        // liquidation check: if unrealized loss > 80% of notional, liquidate
        const notional = Math.abs(pos.size) * mid;
        const upnl = (mid - pos.entry) * pos.size;
        const lev = sim.leverage || 3;
        const liqThreshold = notional / lev; // liquidate when loss exceeds 1/leverage of notional
        if (upnl < -0.95 * liqThreshold && notional > 0) {
          sim.cash += upnl; // realize loss
          sim.trades.push({ t: Date.now(), coin, side: pos.size>0?'sell':'buy', type:'liquidation', sz: Math.abs(pos.size), px: mid, pnl: Math.round(upnl*100)/100, trader: 'sim' });
          sendTelegram('🚨 <b>LIQUIDATION</b> ' + coin + '\\nLoss: ' + upnl.toFixed(4));
          pos.size = 0; pos.entry = 0;
        }
      }
    } catch(e){}
  }, 5000);
  // polling fallback to catch fills the WS misses
  const pollIv = setInterval(async () => {
    if (!sim.running) { clearInterval(pollIv); return; }
    for (const addr of sim.tracked) {
      try {
        const r = await fetch('https://api.hyperliquid.xyz/info', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'userFills', user: addr}) });
        const fills = await r.json();
        if (!Array.isArray(fills)) continue;
        for (const f of fills) {
          if ((f.time || 0) <= (sim.startTime || 0)) continue; // only new fills
          const key = addr + ':' + (f.tid || f.oid || f.time);
          if (seen.has(key)) continue;
          seen.add(key);
          f._trader = addr;
          await processSimFill(f, sim);
        }
      } catch(e) {}
    }
  }, 30000);
  sim._pollIv = pollIv;
  sim._midIv = midIv;
  res.json({ok:true});
});
app.post('/api/sim/stop', (req,res) => {
  sim.running = false;
  if (sim.ws) try { sim.ws.close(); } catch(e){}
  if (sim._midIv) clearInterval(sim._midIv);
  if (sim._pollIv) clearInterval(sim._pollIv);
  res.json({ok:true});
});
app.post('/api/sim/reset', (req,res) => { simReset(); res.json({ok:true}); });
app.get('/api/sim/status', (req,res) => {
  // compute unrealized
  let unreal = 0;
  for (const [coin,pos] of Object.entries(sim.positions)) {
    const mid = parseFloat(sim.mids[coin]||pos.entry||0);
    unreal += (mid - pos.entry) * pos.size;
  }
  const equity = sim.cash + unreal;
  // metrics
  let grossWin=0, grossLoss=0, wins=0, losses=0;
  const rets=[];
  let cum=0, peak=0, maxDD=0;
  const sorted=[...sim.trades].sort((a,b)=>a.t-b.t);
  for (const t of sorted) {
    if (t.type!=='close') continue;
    const p = (t.pnl||0);
    if (p>0){wins++;grossWin+=p;} else if(p<0){losses++;grossLoss+=Math.abs(p);}
    cum += p;
    if (cum>peak) peak=cum;
    const dd = peak-cum;
    if (dd>maxDD) maxDD=dd;
    rets.push(p);
  }
  const pf = grossLoss>0 ? grossWin/grossLoss : (grossWin>0?999:0);
  const wr = (wins+losses)>0 ? wins/(wins+losses)*100 : 0;
  // sharpe
  let sharpe=0;
  if (rets.length>1) {
    const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
    const varr = rets.reduce((a,b)=>a+(b-mean)**2,0)/rets.length;
    const std = Math.sqrt(varr);
    sharpe = std>0 ? (mean/std)*Math.sqrt(rets.length) : 0;
  }
  res.json({
    running: sim.running,
    tracked: sim.tracked,
    scale: sim.scale,
    startTime: sim.startTime,
    cash: Math.round(sim.cash*100)/100,
    equity: Math.round(equity*100)/100,
    unrealized: Math.round(unreal*100)/100,
    positions: sim.positions,
    trades: sim.trades.slice(-100).reverse(),
    equityHistory: sim.equity.slice(-200),
    mids: sim.mids,
    metrics: {
      trades: sim.trades.length,
      closes: wins+losses,
      wins, losses,
      winRate: Math.round(wr*100)/100,
      profitFactor: Math.round(pf*100)/100,
      maxDrawdown: Math.round(maxDD*100)/100,
      sharpe: Math.round(sharpe*100)/100,
      grossWin: Math.round(grossWin*100)/100,
      grossLoss: Math.round(grossLoss*100)/100,
      netPnl: Math.round((sim.cash-10000)*100)/100,
    }
  });
});

function saveSim() {
  try {
    fs.mkdirSync(path.dirname(SIM_FILE), { recursive: true });
    fs.writeFileSync(SIM_FILE, JSON.stringify({ cash:sim.cash, positions:sim.positions, trades:sim.trades.slice(-500), equity:sim.equity.slice(-500), tracked:sim.tracked, scale:sim.scale, running:sim.running, cumulativeVolume:sim.cumulativeVolume, leverage:sim.leverage }));
  } catch(e) {}
}
async function processSimFill(f, sim) {
  const coin = f.coin;
  const isBuy = f.side === 'B';
  const sz = parseFloat(f.sz) * sim.scale;
  const px = parseFloat(f.px);
  const dir = (f.dir || '').toLowerCase();
  const isOpen = dir.includes('open');
  const isClose = dir.includes('close');
  if (!isOpen && !isClose) return;
  if (!sim.positions[coin]) sim.positions[coin] = { size:0, entry:0 };
  const pos = sim.positions[coin];
  const cumVol = sim.cumulativeVolume || 0;
  // fee tier based on cumulative volume
  let feeRate = 0.00045;
  if (cumVol >= 25e6) feeRate = 0.00035;
  else if (cumVol >= 5e6) feeRate = 0.00040;
  const lev = sim.leverage || 3;
  // slippage from L2 book depth
  let slipPx = px;
  try {
    const bookRes = await fetch('https://api.hyperliquid.xyz/info', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'l2Book', coin}) });
    const book = await bookRes.json();
    const levels = book.levels || [[],[]];
    const sideLevels = isBuy ? levels[1] : levels[0]; // asks for buy, bids for sell
    let remaining = sz;
    let cost = 0;
    for (const lvl of sideLevels) {
      const p = parseFloat(lvl.px);
      const s = parseFloat(lvl.sz);
      const take = Math.min(remaining, s);
      cost += take * p;
      remaining -= take;
      if (remaining <= 0) break;
    }
    if (remaining <= 0 && sz > 0) slipPx = cost / sz;
    else slipPx = isBuy ? px * 1.001 : px * 0.999;
  } catch(e) { slipPx = isBuy ? px * 1.001 : px * 0.999; }
  const fee = sz * slipPx * feeRate;
  // margin check
  if (isOpen) {
    const notional = sz * slipPx;
    const marginNeeded = notional / (sim.leverage || 3);
    const usedMargin = Object.values(sim.positions).reduce((a,p)=>a+Math.abs(p.size)*(sim.mids[p.coin]||p.entry||0)/(sim.leverage||3),0);
    if (sim.cash < marginNeeded * 0.5) {
      // insufficient margin, skip
      return;
    }
  }
  if (isOpen) {
    if (pos.size === 0) pos.entry = slipPx;
    else if ((pos.size > 0) === isBuy) {
      pos.entry = (pos.entry*Math.abs(pos.size) + slipPx*sz) / (Math.abs(pos.size)+sz);
    }
    pos.size += isBuy ? sz : -sz;
    sim.cash -= fee;
    sim.cumulativeVolume = (sim.cumulativeVolume||0) + sz * slipPx;
    sim.trades.push({ t:f.time, coin, side: isBuy?'buy':'sell', type:'open', sz, px: slipPx, fee:Math.round(fee*1e6)/1e6, trader:f._trader });
    sendTelegram('📈 <b>OPEN</b> ' + (isBuy?'LONG':'SHORT') + ' ' + coin + '\\nSize: ' + sz.toFixed(4) + ' @ ' + slipPx.toFixed(4) + '\\nTrader: ' + (f._trader||'').slice(0,10) + '...');
  } else if (isClose) {
    const closeQty = isBuy ? sz : -sz;
    const qty = Math.min(Math.abs(closeQty), Math.abs(pos.size));
    if (qty <= 0) return; // no position to close, skip
    const exitPx = isBuy ? px * (1 - slip) : px * (1 + slip);
    const pnl = pos.size > 0 ? (exitPx - pos.entry)*qty : (pos.entry - exitPx)*qty;
    const closeFee = qty * exitPx * feeRate;
    sim.cash += pnl - closeFee;
    sim.cumulativeVolume = (sim.cumulativeVolume||0) + qty * exitPx;
    pos.size -= pos.size > 0 ? qty : -qty;
    if (Math.abs(pos.size) < 1e-9) { pos.size = 0; pos.entry = 0; }
    sim.trades.push({ t:f.time, coin, side: isBuy?'buy':'sell', type:'close', sz:qty, px: exitPx, pnl:Math.round((pnl-closeFee)*100)/100, fee:Math.round(closeFee*1e6)/1e6, trader:f._trader });
    const pnlStr = (pnl-closeFee) >= 0 ? '✅' : '❌';
    sendTelegram(pnlStr + ' <b>CLOSE</b> ' + coin + '\\n' + (isBuy?'Buy':'Sell') + ' ' + qty.toFixed(4) + ' @ ' + exitPx.toFixed(4) + '\\nPnL: ' + (pnl-closeFee).toFixed(4) + ' | Fee: ' + closeFee.toFixed(4));
  }
  sim.equity.push({ t: Date.now(), cash: Math.round(sim.cash*100)/100 });
  if (sim.equity.length > 500) sim.equity.shift();
  saveSim();
}


app.get('/api/health', (req,res) => {
  res.json({ ok:true, uptime: process.uptime(), simRunning: sim.running, mirrorRunning: !!mirrorProc, time: new Date().toISOString() });
});

// Refresh recommended wallets from live leaderboard
async function refreshRecommended() {
  try {
    const lbRes = await fetch('https://api.hyperliquid.xyz/info'.replace('/info','') + 'stats-data.hyperliquid.xyz/Mainnet/leaderboard'.replace('stats-data.hyperliquid.xyz/Mainnet/leaderboard','stats-data.hyperliquid.xyz/Mainnet/leaderboard'));
  } catch(e) {}
  try {
    const r = await fetch('http://localhost:' + (process.env.PORT||3000) + '/api/leaderboard?limit=100&onlyReal=true&sortBy=score');
    const lb = await r.json();
    const rows = lb.traders || [];
    const out = [];
    for (const t of rows) {
      try {
        const dRes = await fetch('http://localhost:' + (process.env.PORT||3000) + '/api/trader/' + t.ethAddress);
        const d = await dRes.json();
        const m = d.metrics || {};
        if ((m.trades||0) < 10) continue;
        if ((m.netPnl||0) <= 0) continue;
        if ((m.winRate||0) < 40) continue;
        if ((m.maxDrawdownPct||999) > 25) continue;
        out.push(t.ethAddress);
        if (out.length >= 25) break;
      } catch(e) {}
    }
    if (out.length >= 5) {
      const cfg = { wallets: out, scale: 0.001, maxLeverage: 3, maxPositionPct: 0.05, dailyLossLimitPct: 0.02, maxDrawdownPct: 0.05 };
      const fs2 = require('fs');
      const path2 = require('path');
      fs2.writeFileSync(path2.join(__dirname,'..','config','recommended.json'), JSON.stringify(cfg, null, 2));
      console.log('[refresh] updated recommended wallets:', out.length);
    }
  } catch(e) { console.warn('[refresh] failed:', e.message); }
}
app.post('/api/recommended/refresh', async (req,res) => {
  await refreshRecommended();
  res.json({ ok: true });
});

// serve frontend
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub));
app.get(/.*/, (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).end();
  res.sendFile(path.join(pub, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Server running on http://localhost:' + PORT);
  // auto-refresh recommended wallets after 60s
  setTimeout(() => { refreshRecommended().catch(()=>{}); }, 60000);
  // 6-hour summary (opens, closes, profit)
  let lastSummaryTime = Date.now();
  setInterval(() => {
    if (!sim.running) return;
    let unreal = 0;
    for (const [c, p] of Object.entries(sim.positions)) {
      const mid = parseFloat((sim.mids || {})[c] || p.entry || 0);
      unreal += (mid - p.entry) * p.size;
    }
    const eq = sim.cash + unreal;
    const recentCloses = sim.trades.filter(t => t.type === 'close' && t.t >= lastSummaryTime);
    const recentOpens = sim.trades.filter(t => t.type === 'open' && t.t >= lastSummaryTime);
    const realizedPnl = recentCloses.reduce((a, t) => a + (t.pnl || 0), 0);
    let msg = '📊 <b>6-Hour Summary</b>\\n';
    msg += 'Equity: $' + eq.toFixed(2) + ' | Cash: $' + sim.cash.toFixed(2) + '\\n';
    msg += 'Unrealized: $' + unreal.toFixed(2) + ' | Realized: $' + realizedPnl.toFixed(2) + '\\n';
    msg += 'Open positions: ' + Object.keys(sim.positions).length + ' | Total trades: ' + sim.trades.length + '\\n';
    if (recentOpens.length > 0) {
      msg += '\\n📈 <b>Opens (' + recentOpens.length + '):</b>\\n';
      recentOpens.slice(-10).forEach(t => { msg += '  ' + t.coin + ' ' + t.side + ' ' + Number(t.sz).toFixed(4) + ' @ ' + Number(t.px).toFixed(4) + '\\n'; });
    }
    if (recentCloses.length > 0) {
      msg += '\\n📉 <b>Closes (' + recentCloses.length + '):</b>\\n';
      recentCloses.slice(-10).forEach(t => { msg += '  ' + t.coin + ' ' + t.side + ' PnL: ' + (t.pnl >= 0 ? '+' : '') + Number(t.pnl).toFixed(4) + '\\n'; });
    }
    if (recentOpens.length === 0 && recentCloses.length === 0) {
      msg += '\\nNo new trades in this period.';
    }
    sendTelegram(msg);
    lastSummaryTime = Date.now();
  }, 6 * 60 * 60 * 1000); // 6 hours
  // auto-start sim with recommended wallets via internal call
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'..','config','recommended.json'),'utf8'));
    if (cfg.wallets && cfg.wallets.length) {
      const http = require('http');
      const body = JSON.stringify({ addresses: cfg.wallets, scale: cfg.scale || 0.001 });
      const req = http.request({ hostname:'localhost', port:PORT, path:'/api/sim/start', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, (res)=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>console.log('[auto] sim start:', d)); });
      req.on('error', e=>console.warn('[auto] sim start err:', e.message));
      req.write(body); req.end();
    }
  } catch(e) { console.warn('auto-start sim failed:', e.message); }
});
