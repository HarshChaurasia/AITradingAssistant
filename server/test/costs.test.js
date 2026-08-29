const test = require('node:test');
const assert = require('node:assert/strict');

const { applyEntrySlippage, applyExitSlippage, commissionFor, pnlFor } = require('../src/backtest/costs');

test('a buy enters at the ask plus slippage', () => {
  const filled = applyEntrySlippage({ side: 'BUY', price: 100, spreadPrice: 0.2, slippagePrice: 0.05 });
  assert.equal(Number(filled.toFixed(10)), 100.25);
});

test('a sell enters at the bid minus slippage', () => {
  const filled = applyEntrySlippage({ side: 'SELL', price: 100, spreadPrice: 0.2, slippagePrice: 0.05 });
  assert.equal(Number(filled.toFixed(10)), 99.75);
});

test('exits pay the spread in the opposite direction', () => {
  // Closing a long means selling: worse price, so downward.
  assert.equal(
    Number(applyExitSlippage({ side: 'BUY', price: 100, spreadPrice: 0.2, slippagePrice: 0.05 }).toFixed(10)),
    99.75
  );
  // Closing a short means buying: upward.
  assert.equal(
    Number(applyExitSlippage({ side: 'SELL', price: 100, spreadPrice: 0.2, slippagePrice: 0.05 }).toFixed(10)),
    100.25
  );
});

test('costs are never favourable to the trader', () => {
  const buyIn = applyEntrySlippage({ side: 'BUY', price: 50, spreadPrice: 1, slippagePrice: 1 });
  const buyOut = applyExitSlippage({ side: 'BUY', price: 50, spreadPrice: 1, slippagePrice: 1 });
  assert.ok(buyIn > 50, 'a buy never fills below the quoted price');
  assert.ok(buyOut < 50, 'closing a long never fills above the quoted price');
});

test('commission scales with lot size', () => {
  assert.equal(commissionFor({ lot: 0.5, commissionPerLot: 7 }), 3.5);
  assert.equal(commissionFor({ lot: 0, commissionPerLot: 7 }), 0);
});

test('pnl accounts for direction, lot and contract size', () => {
  // Long 0.1 lots of a 100,000-unit contract, up 10 points.
  assert.equal(
    Number(pnlFor({ side: 'BUY', entryPrice: 1.1, exitPrice: 1.101, lot: 0.1, contractSize: 100000 }).toFixed(6)),
    10
  );
  // The same move against a short.
  assert.equal(
    Number(pnlFor({ side: 'SELL', entryPrice: 1.1, exitPrice: 1.101, lot: 0.1, contractSize: 100000 }).toFixed(6)),
    -10
  );
});

test('zero spread and zero slippage leave the price untouched', () => {
  assert.equal(applyEntrySlippage({ side: 'BUY', price: 1.2345, spreadPrice: 0, slippagePrice: 0 }), 1.2345);
});
