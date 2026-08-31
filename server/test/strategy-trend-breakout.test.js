const test = require('node:test');
const assert = require('node:assert/strict');

const strategy = require('../src/strategies/trend-breakout');

// Build a series that rises steadily, then breaks out hard.
//
// 260 bars, not 60: the regime filter is a 200-bar EMA, so a shorter series
// never warms up and the strategy correctly declines to say anything. A
// fixture that stops short would be testing the warm-up guard while claiming
// to test the breakout.
function risingThenBreakout() {
  const candles = [];
  for (let i = 0; i < 260; i += 1) {
    const base = 100 + i * 0.1;
    candles.push({ open: base, high: base + 0.2, low: base - 0.2, close: base });
  }
  const last = candles[candles.length - 1].close;
  candles.push({ open: last, high: last + 5, low: last - 0.1, close: last + 4 });
  return candles;
}

test('the strategy exposes the required contract', () => {
  assert.equal(typeof strategy.name, 'string');
  assert.equal(typeof strategy.version, 'string');
  assert.equal(typeof strategy.prepare, 'function');
  assert.equal(typeof strategy.evaluate, 'function');
  assert.equal(typeof strategy.defaultParams, 'object');
});

test('evaluate is pure: the same inputs give the same output', () => {
  const candles = risingThenBreakout();
  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);
  const i = candles.length - 1;

  const a = strategy.evaluate(candles, i, params, ctx);
  const b = strategy.evaluate(candles, i, params, ctx);
  assert.deepEqual(a, b);
});

test('a breakout above the channel in an uptrend produces a BUY', () => {
  const candles = risingThenBreakout();
  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);
  const signal = strategy.evaluate(candles, candles.length - 1, params, ctx);

  assert.ok(signal, 'expected a signal on the breakout bar');
  assert.equal(signal.side, 'BUY');
  assert.equal(signal.entry, candles[candles.length - 1].close);
  assert.ok(signal.sl < signal.entry, 'a long stop sits below entry');
  assert.ok(signal.tp > signal.entry, 'a long target sits above entry');
  assert.ok(signal.features.atr > 0);
});

test('no signal while price sits inside the channel', () => {
  const candles = [];
  for (let i = 0; i < 280; i += 1) {
    const base = 100 + Math.sin(i / 5) * 0.5;
    candles.push({ open: base, high: base + 0.1, low: base - 0.1, close: base });
  }
  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);

  for (let i = 0; i < candles.length; i += 1) {
    assert.equal(strategy.evaluate(candles, i, params, ctx), null, `unexpected signal at bar ${i}`);
  }
});

test('a downtrend breakdown produces a SELL with an inverted stop', () => {
  const candles = [];
  for (let i = 0; i < 260; i += 1) {
    const base = 100 - i * 0.1;
    candles.push({ open: base, high: base + 0.2, low: base - 0.2, close: base });
  }
  const last = candles[candles.length - 1].close;
  candles.push({ open: last, high: last + 0.1, low: last - 5, close: last - 4 });

  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);
  const signal = strategy.evaluate(candles, candles.length - 1, params, ctx);

  assert.ok(signal, 'expected a signal on the breakdown bar');
  assert.equal(signal.side, 'SELL');
  assert.ok(signal.sl > signal.entry, 'a short stop sits above entry');
  assert.ok(signal.tp < signal.entry, 'a short target sits below entry');
});

test('evaluate returns null before there is enough history', () => {
  const candles = risingThenBreakout().slice(0, 5);
  const params = strategy.defaultParams;
  const ctx = strategy.prepare(candles, params);
  assert.equal(strategy.evaluate(candles, 4, params, ctx), null);
});
