const DAY = 86400000;
const EXECUTION_COST = 0.00095;

// Keep quantities in whole destination lots. Only correct floating-point noise
// near an integer, e.g. a decimal input represented as 2.9999999999999996.
function wholeLots(quantity, lotSize) {
  const lots = quantity / lotSize;
  return Math.floor(lots + Math.min(1e-8, Math.abs(lots) * Number.EPSILON * 2));
}

function evaluateCandidate(fills, profile, now = Date.now()) {
  const { scale, initialEquity, maxPositionPct, maxDrawdownPct, sizeDecimals } = profile;
  const recent = fills.filter(f => f.time >= now - 30 * DAY && f.time <= now &&
    /^(Open |Close |Long > Short$|Short > Long$)/.test(f.dir) &&
    !f.coin.includes(':') && (!f.feeToken || f.feeToken === 'USDC'));
  recent.sort((a, b) => a.time - b.time);
  const positions = new Map(), closes = new Map(), seen = new Set(), days = new Set();
  let entries = 0, sizedEntries = 0, net = 0, unrealized = 0, lastFill = 0;
  let peak = initialEquity, maxDrawdown = 0, worstDrawdownPct = 0;

  function markEquity() {
    const equity = initialEquity + net + unrealized;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    worstDrawdownPct = Math.max(worstDrawdownPct, (peak - equity) / peak);
    return equity;
  }

  for (const f of recent) {
    const before = Number(f.startPosition), size = Number(f.sz), px = Number(f.px);
    if (!Number.isFinite(before) || !(px > 0) || !(size > 0) || !['A', 'B'].includes(f.side)) continue;
    if (f.tid != null) {
      const key = f.coin + ':' + f.tid;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const sign = f.side === 'B' ? 1 : -1;
    const sourceClose = before * sign < 0 ? Math.min(size, Math.abs(before)) : 0;
    const opening = size - sourceClose;
    if (opening > 0) entries++;
    const decimals = sizeDecimals.get(f.coin);
    if (decimals === undefined) continue;
    const step = 10 ** -decimals;
    const pos = positions.get(f.coin) || { lots: 0, entry: 0, mark: px };
    unrealized += (px - pos.mark) * pos.lots * step;
    pos.mark = px;
    markEquity();
    let copied = false;
    if (sourceClose && pos.lots * sign < 0) {
      const lots = Math.min(Math.abs(pos.lots), wholeLots(Math.abs(pos.lots) * (sourceClose / Math.abs(before)), 1));
      if (lots > 0) {
        const qty = lots * step;
        const pnl = (pos.entry - px) * sign * qty;
        const gain = pnl - qty * px * EXECUTION_COST;
        unrealized -= pnl;
        net += gain;
        if (f.oid != null) closes.set(f.oid, (closes.get(f.oid) || 0) + gain);
        pos.lots += lots * sign;
        copied = true;
      }
    }
    if (opening > 0 && pos.lots * sign >= 0) {
      const room = markEquity() * maxPositionPct / (px * 1.02) - Math.abs(pos.lots) * step;
      const lots = wholeLots(Math.min(opening * scale, room), step);
      const qty = lots * step;
      if (lots > 0 && qty * px >= 10) {
        sizedEntries++;
        pos.entry = (pos.entry * Math.abs(pos.lots) + px * lots) / (Math.abs(pos.lots) + lots);
        pos.lots += lots * sign;
        net -= qty * px * EXECUTION_COST;
        copied = true;
      }
    }
    positions.set(f.coin, pos);
    markEquity();
    if (copied) {
      days.add(Math.floor(f.time / DAY));
      lastFill = f.time;
    }
  }

  const returns = [...closes.values()];
  if (!Number.isFinite(net + unrealized) || worstDrawdownPct > maxDrawdownPct) return null;
  if (!entries || sizedEntries < entries / 2 || returns.length < 5 || days.size < 3 || lastFill < now - 7 * DAY) return null;
  const retainedPnl = Math.min(net, net + unrealized) - Math.max(0, ...returns);
  if (returns.filter(p => p > 0).length < 0.30 * returns.length || retainedPnl <= 0) return null;
  const cents = n => Math.round(n * 100) / 100;
  return { entries, sizedEntries, closedOrders: returns.length, activeDays: days.size, lastFill,
    modeledDrawdownUsd: cents(maxDrawdown), modeledRealizedPnl: cents(net),
    retainedPnl: cents(retainedPnl), modeledNetPnl: cents(net + unrealized) };
}

module.exports = { evaluateCandidate };
