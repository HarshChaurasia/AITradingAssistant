const test = require('node:test');
const assert = require('node:assert/strict');

const strategy = require('../src/strategies/mean-reversion');

// An uptrend (so the trend filter allows longs) with a sharp dip at the end
// that drives RSI into oversold territory.
function uptrendWithDip() {
  const candles = [];
  for (let i = 0; i < 120; i += 1) {
    const base = 100 + i * 0.2;
    candles.push({ open: base, high: base + 0.3, low: base - 0.3, close: base });
  }
  let price = candles[candles.length - 1].close;
  for (let i = 0; i < 10; i += 1) {
    price -= 1.5;
    candles.push({ open: price + 1.5, high: price + 1.6, low: price - 0.2, close: price });
  }
  return candles;
}

test('the strategy exposes the required contract', () => {
  assert.equal(strategy.name, 'mean-reversion');
  assert.equal(typeof strategy.version, 'string');
  assert.equal(typeof strategy.prepare, 'function');
  assert.equal(typeof strategy.evaluate, 'function');
});

test('an oversold dip inside an uptrend produces a BUY', () => {
  const candles = uptrendWithDip();
  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);

  let signal = null;
  for (let i = candles.length - 10; i < candles.length; i += 1) {
    signal = strategy.evaluate(candles, i, params, ctx) || signal;
  }

  assert.ok(signal, 'expected a mean-reversion long during the dip');
  assert.equal(signal.side, 'BUY');
  assert.ok(signal.sl < signal.entry);
  assert.ok(signal.tp > signal.entry);
  assert.ok(signal.features.rsi <= params.oversold);
});

test('evaluate is pure', () => {
  const candles = uptrendWithDip();
  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);
  const i = candles.length - 1;
  assert.deepEqual(
    strategy.evaluate(candles, i, params, ctx),
    strategy.evaluate(candles, i, params, ctx)
  );
});

test('an oversold dip in a downtrend is refused by the trend filter', () => {
  const candles = [];
  for (let i = 0; i < 120; i += 1) {
    const base = 200 - i * 0.4;
    candles.push({ open: base, high: base + 0.3, low: base - 0.3, close: base });
  }
  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);

  // Price is below its own trend average throughout, so no long may be taken.
  for (let i = 0; i < candles.length; i += 1) {
    const signal = strategy.evaluate(candles, i, params, ctx);
    assert.notEqual(signal?.side, 'BUY', `unexpected counter-trend long at bar ${i}`);
  }
});

test('evaluate returns null before there is enough history', () => {
  const candles = uptrendWithDip().slice(0, 10);
  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);
  assert.equal(strategy.evaluate(candles, 9, params, ctx), null);
});
