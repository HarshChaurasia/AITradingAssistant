const test = require('node:test');
const assert = require('node:assert/strict');

const { strategies } = require('../src/strategies/registry');

/**
 * explain() exists so the scanner can say WHY a signal did or did not fire.
 *
 * The danger it introduces is drift: explain() and evaluate() quietly
 * disagreeing, so the dashboard tells the operator one thing while the system
 * does another. These tests exist to make that impossible to ship.
 */

// A series with trends both ways, pullbacks, and genuine breakouts, so both
// strategies actually fire somewhere across it.
function varietySeries(length = 900) {
  const candles = [];
  for (let i = 0; i < length; i += 1) {
    const drift = i < length / 2 ? i * 0.05 : (length - i) * 0.05;
    const wave = Math.sin(i / 7) * 1.5 + Math.sin(i / 23) * 3;
    const close = 100 + drift + wave;
    candles.push({
      open: close - 0.03,
      high: close + 0.08,
      low: close - 0.08,
      close
    });
  }
  return candles;
}

// Every registered strategy, so a newly added one cannot skip the agreement
// check by simply not being listed here.
for (const strategy of strategies) {
  test(`${strategy.name}: explain agrees with evaluate on every bar`, () => {
    const candles = varietySeries();
    const params = strategy.defaultParams;
    const context = strategy.prepare(candles, params);

    let firedCount = 0;

    for (let i = 0; i < candles.length; i += 1) {
      const signal = strategy.evaluate(candles, i, params, context);
      const explained = strategy.explain(candles, i, params, context);

      assert.equal(
        explained.firing, signal !== null,
        `bar ${i}: explain says firing=${explained.firing} but evaluate returned ${signal ? signal.side : 'null'}`
      );

      if (signal) {
        firedCount += 1;
        assert.equal(explained.side, signal.side, `bar ${i}: sides disagree`);
      } else {
        assert.equal(explained.side, null, `bar ${i}: explain named a side while evaluate declined`);
      }
    }

    assert.ok(firedCount > 0, 'the fixture must make this strategy fire somewhere, or the test proves nothing');
  });

  test(`${strategy.name}: explain always gives a reason and named checks`, () => {
    const candles = varietySeries(300);
    const params = strategy.defaultParams;
    const context = strategy.prepare(candles, params);

    for (const i of [0, 5, 150, 299]) {
      const explained = strategy.explain(candles, i, params, context);

      assert.equal(typeof explained.reason, 'string');
      assert.ok(explained.reason.length > 0, `bar ${i}: an empty reason explains nothing`);
      assert.ok(Array.isArray(explained.checks), `bar ${i}: checks must be an array`);

      for (const check of explained.checks) {
        assert.equal(typeof check.name, 'string');
        assert.equal(typeof check.passed, 'boolean');
        assert.equal(typeof check.detail, 'string');
      }
    }
  });

  test(`${strategy.name}: explain says so plainly before there is enough history`, () => {
    const candles = varietySeries(300);
    const params = strategy.defaultParams;
    const context = strategy.prepare(candles, params);

    const early = strategy.explain(candles, 2, params, context);
    assert.equal(early.firing, false);
    assert.match(early.reason, /history|warm|insufficient/i);
  });

  test(`${strategy.name}: explain is pure`, () => {
    const candles = varietySeries(300);
    const params = strategy.defaultParams;
    const context = strategy.prepare(candles, params);

    assert.deepEqual(
      strategy.explain(candles, 250, params, context),
      strategy.explain(candles, 250, params, context)
    );
  });

  test(`${strategy.name}: a firing bar reports every check as passed`, () => {
    const candles = varietySeries();
    const params = strategy.defaultParams;
    const context = strategy.prepare(candles, params);

    let checked = 0;
    for (let i = 0; i < candles.length; i += 1) {
      const explained = strategy.explain(candles, i, params, context);
      if (!explained.firing) continue;
      checked += 1;
      assert.ok(
        explained.checks.every((c) => c.passed),
        `bar ${i} fires, so no condition may be reported as failed`
      );
    }
    assert.ok(checked > 0);
  });
}
