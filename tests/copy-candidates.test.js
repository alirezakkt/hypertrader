const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCandidate } = require('../server/copy-candidates');

const day = 86400000;
const now = Date.now();
const fills = Array.from({ length: 6 }, (_, i) => {
  const opening = { coin: 'ETH', oid: i * 2, time: now - (i + 1) * day,
    side: 'B', startPosition: '0', dir: 'Open Long', px: '100', sz: '100' };
  const closing = { ...opening, oid: opening.oid + 1, time: opening.time + 1000,
    side: 'A', startPosition: '100', dir: 'Close Long', px: '100.70' };
  return [opening, closing];
}).flat();

const standard = { initialEquity: 10000, maxPositionPct: 0.05, maxDrawdownPct: 0.05,
  sizeDecimals: new Map([['ETH', 3]]) };
function evaluate(fills, scale, at = now, overrides = {}) {
  return evaluateCandidate(fills, { ...standard, scale, ...overrides }, at);
}

test('models observed entries and exits at the selected scale after costs', () => {
  const result = evaluate(fills, 0.001, now);
  assert.equal(result.closedOrders, 6);
  assert.equal(result.activeDays, 6);
  assert.equal(result.modeledNetPnl, 0.31);
});

test('excludes subminimum entries, unobserved positions, stale samples and fragmented orders', () => {
  assert.equal(evaluate(fills, 0.0009, now), null);
  assert.equal(evaluate(fills.filter(f => f.side === 'A'), 1, now), null);
  assert.equal(evaluate(fills, 1, now + 8 * day), null);
  assert.equal(evaluate(fills.map(f => ({ ...f, oid: 0 })), 1, now), null);
});

test('excludes samples whose apparent edge disappears after costs or one winning order', () => {
  assert.equal(evaluate(fills.map(f => ({ ...f, px: '100' })), 1, now), null);
  const oneWinner = fills.map(f => ({ ...f, px: f.oid === 1 ? '115' : '100' }));
  assert.equal(evaluate(oneWinner, 1, now), null);
});

test('uses destination listings, precision and cumulative capacity before the order minimum', () => {
  assert.equal(evaluate(fills, 0.001, now, { sizeDecimals: new Map() }), null);
  assert.equal(evaluate(fills, 0.001, now, { sizeDecimals: new Map([['ETH', 0]]) }), null);
  assert.equal(evaluate(fills, 0.001, now, { initialEquity: 200 }), null);
  const clipped = evaluate(fills, 1, now, { initialEquity: 1000 });
  assert.equal(clipped.sizedEntries, 6);
  assert.ok(clipped.modeledRealizedPnl < 2);
});

test('counts a repeated source fill only once', () => {
  const identified = fills.map((f, tid) => ({ ...f, tid }));
  assert.deepEqual(evaluate([...identified, ...identified], 0.001), evaluate(identified, 0.001));
});

test('checks drawdown at an observed price even when no new order can fit', () => {
  const first = fills.find(f => f.oid === 10);
  const dip = { ...first, time: first.time + 300, startPosition: '100', sz: '0.00001', px: '50' };
  const full = [...fills, dip];
  assert.ok(evaluate(full, 1, now, { initialEquity: 1000 }));
  assert.equal(evaluate(full, 1, now, { initialEquity: 1000, maxDrawdownPct: 0.01 }), null);
});
