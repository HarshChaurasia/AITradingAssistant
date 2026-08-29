const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMetrics } = require('../src/backtest/metrics');

test('an empty trade list produces a zeroed, safe result', () => {
  const m = computeMetrics([], { startingBalance: 100 });
  assert.equal(m.trades, 0);
  assert.equal(m.netProfit, 0);
  assert.equal(m.profitFactor, 0);
  assert.equal(m.winRatePct, 0);
  assert.equal(m.maxDrawdown, 0);
  assert.deepEqual(m.equityCurve, [100]);
});

test('basic counts and profit factor', () => {
  const m = computeMetrics([{ pnl: 10 }, { pnl: -5 }, { pnl: 20 }, { pnl: -5 }], { startingBalance: 100 });
  assert.equal(m.trades, 4);
  assert.equal(m.wins, 2);
  assert.equal(m.losses, 2);
  assert.equal(m.winRatePct, 50);
  assert.equal(m.grossProfit, 30);
  assert.equal(m.grossLoss, 10);
  assert.equal(m.netProfit, 20);
  assert.equal(m.profitFactor, 3);
  assert.equal(m.expectancy, 5);
  assert.equal(m.averageWin, 15);
  assert.equal(m.averageLoss, 5);
});

test('profit factor is Infinity when nothing loses', () => {
  const m = computeMetrics([{ pnl: 5 }, { pnl: 5 }], { startingBalance: 100 });
  assert.equal(m.profitFactor, Infinity);
});

test('max drawdown is peak-to-trough, not the worst single trade', () => {
  // 100 -> 150 -> 130 -> 110 -> 200. The worst single trade is -20, but the
  // peak-to-trough decline from 150 to 110 is 40.
  const m = computeMetrics([{ pnl: 50 }, { pnl: -20 }, { pnl: -20 }, { pnl: 90 }], { startingBalance: 100 });
  assert.equal(m.maxDrawdown, 40);
  assert.equal(Number(m.maxDrawdownPct.toFixed(4)), Number(((40 / 150) * 100).toFixed(4)));
});

test('the equity curve starts at the opening balance and tracks every trade', () => {
  const m = computeMetrics([{ pnl: 10 }, { pnl: -4 }], { startingBalance: 100 });
  assert.deepEqual(m.equityCurve, [100, 110, 106]);
});

test('sharpe is zero when every trade returns the same amount', () => {
  const m = computeMetrics([{ pnl: 5 }, { pnl: 5 }, { pnl: 5 }], { startingBalance: 100 });
  assert.equal(m.sharpe, 0, 'no dispersion means no risk-adjusted signal');
});

test('a strategy with a higher mean and the same spread scores a higher sharpe', () => {
  const low = computeMetrics([{ pnl: 1 }, { pnl: -1 }, { pnl: 1 }, { pnl: -1 }], { startingBalance: 100 });
  const high = computeMetrics([{ pnl: 3 }, { pnl: 1 }, { pnl: 3 }, { pnl: 1 }], { startingBalance: 100 });
  assert.ok(high.sharpe > low.sharpe);
});
