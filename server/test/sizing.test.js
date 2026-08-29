const test = require('node:test');
const assert = require('node:assert/strict');

const { sizePosition, roundToStep } = require('../src/risk/sizing');

const FX = { contract_size: 100000, min_lot: 0.01, lot_step: 0.01, max_lot: 500 };
const GOLD = { contract_size: 100, min_lot: 0.01, lot_step: 0.01, max_lot: 100 };

test('roundToStep floors to the step and absorbs float noise', () => {
  assert.equal(roundToStep(0.0999999999, 0.01), 0.09);
  // 1.1 - 1.09 is 0.010000000000000009 in binary floating point; without
  // absorbing that, this floors one whole step low.
  assert.equal(roundToStep(100 / ((1.1 - 1.09) * 100000), 0.01), 0.1);
  assert.equal(roundToStep(0.005, 0.01), 0);
});

test('lot follows risk, stop distance and contract size', () => {
  // 1% of 10,000 = $100 risk. Stop 0.0100 wide on a 100,000 contract loses
  // $1,000 per lot, so 0.1 lots.
  const r = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.09, symbol: FX });
  assert.equal(r.rejected, false);
  assert.equal(r.lot, 0.1);
  assert.equal(r.riskAmount, 100);
  assert.equal(Number(r.stopDistance.toFixed(5)), 0.01);
});

test('halving risk halves the lot', () => {
  const full = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.09, symbol: FX });
  const half = sizePosition({ balance: 10000, riskPct: 0.5, entry: 1.10, sl: 1.09, symbol: FX });
  assert.equal(half.lot, Number((full.lot / 2).toFixed(4)));
});

test('a lot below the broker minimum is REFUSED, never rounded up', () => {
  // The real case: $100 account, EURUSD, a 22 pip ATR stop. The minimum lot
  // would risk $2.23, i.e. 2.2% of the account against a 1% cap.
  const r = sizePosition({ balance: 100, riskPct: 1, entry: 1.1000, sl: 1.09777, symbol: FX });
  assert.equal(r.rejected, true);
  assert.equal(r.lot, 0);
  assert.match(r.reason, /below the broker minimum/i);
});

test('a lot above the broker maximum is capped, not rejected', () => {
  const r = sizePosition({ balance: 100000000, riskPct: 1, entry: 1.10, sl: 1.09, symbol: FX });
  assert.equal(r.rejected, false);
  assert.equal(r.lot, FX.max_lot);
});

test('a zero-width stop is rejected rather than dividing by zero', () => {
  const r = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.10, symbol: FX });
  assert.equal(r.rejected, true);
  assert.match(r.reason, /stop distance/i);
});

test('a missing stop loss is rejected outright', () => {
  for (const sl of [null, undefined, NaN]) {
    const r = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl, symbol: FX });
    assert.equal(r.rejected, true, `sl ${sl} must be rejected`);
    assert.match(r.reason, /stop loss/i);
  }
});

test('contract size changes the lot for the same price move', () => {
  const fx = sizePosition({ balance: 10000, riskPct: 1, entry: 100, sl: 99, symbol: FX });
  const gold = sizePosition({ balance: 10000, riskPct: 1, entry: 100, sl: 99, symbol: GOLD });
  assert.ok(gold.lot > fx.lot, 'a smaller contract permits a larger lot for the same risk');
});

test('the direction of the stop does not change the size', () => {
  const long = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.09, symbol: FX });
  const short = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.11, symbol: FX });
  assert.equal(long.lot, short.lot);
});
