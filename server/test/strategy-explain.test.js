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

// A series with trends both ways, pullbacks, and genuine breakouts, so every
// strategy actually fires somewhere across it.
//
// Three things beyond the closes have to vary, each added because the
// vacuous-fixture guard below caught a strategy that could never fire:
//
//   BAR RANGE   - the scalps key off a bar much larger than the recent
//                 average, and uniformly sized bars never produce one.
//   TICK VOLUME - volume-thrust reads participation, and a constant volume
//                 column is never two times its own average.
//   open_time   - session-breakout reads the clock. Without real timestamps
//                 it cannot find a session at all, and the whole strategy
//                 would be tested vacuously.
//
// The bars are 15 minutes apart from a midnight UTC start, so 07:00 - the
// default session hour - falls on bar 28 of each day and recurs every 96.
function varietySeries(length = 900) {
  const candles = [];
  const start = Date.UTC(2026, 0, 5, 0, 0, 0);

  for (let i = 0; i < length; i += 1) {
    const drift = i < length / 2 ? i * 0.05 : (length - i) * 0.05;
    const wave = Math.sin(i / 7) * 1.5 + Math.sin(i / 23) * 3;
    const close = 100 + drift + wave;

    // Every eleventh bar is a burst: several times the usual range, and
    // closing at its extreme, which is what a momentum bar looks like.
    const burst = i % 11 === 0;
    const half = burst ? 0.9 : 0.08;
    const direction = Math.sin(i / 7) >= 0 ? 1 : -1;

    // A burst bar carries the volume to match - participation and range move
    // together in real data, and a fixture where they did not would let a
    // volume strategy pass on a series it could never trade.
    const baseVolume = 400 + Math.round(Math.sin(i / 31) * 120);

    // A burst bar opens at one end and closes near the other, with small
    // wicks - a decisive bar, which is what a momentum strategy is looking
    // for. Giving it a large range but a mid-range close would produce a bar
    // that LOOKS violent and that volume-thrust correctly refuses, so the
    // fixture would test nothing.
    const body = burst ? half * 2.6 : 0.03;
    const wick = burst ? half * 0.25 : half;
    const open = burst ? close - direction * body : close - 0.03;

    candles.push({
      open_time: new Date(start + i * 15 * 60000).toISOString(),
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      tick_volume: burst ? baseVolume * 4 : baseVolume
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
