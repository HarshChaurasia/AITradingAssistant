require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { replay } = require('../src/signals/missed');

function bar(open, high, low, close, minute) {
  return {
    open_time: `2026-03-01T${String(minute).padStart(2, '0')}:00:00.000Z`,
    open, high, low, close
  };
}

const LONG = { side: 'BUY', entry: 100, sl: 98, tp: 104 };
const SHORT = { side: 'SELL', entry: 100, sl: 102, tp: 96 };

test('a long that reaches its target is graded as a costly refusal', () => {
  const result = replay({
    signal: LONG,
    futureCandles: [bar(100, 101, 99.5, 100.5, 1), bar(100.5, 104.2, 100, 104, 2)],
    horizonBars: 20
  });

  assert.equal(result.outcome, 'tp');
  assert.equal(result.barsExamined, 2);
  assert.equal(result.rMultiple, 2, '4 points of reward against 2 points of risk is 2R');
});

test('a long that hits its stop first is graded as a correct refusal', () => {
  const result = replay({
    signal: LONG,
    futureCandles: [bar(100, 100.5, 97.5, 98, 1)],
    horizonBars: 20
  });

  assert.equal(result.outcome, 'sl');
  assert.equal(result.rMultiple, -1);
});

test('a bar spanning both levels is scored as the stop, never the target', () => {
  // The pessimistic rule the backtest engine uses. Assuming the good fill
  // would turn every volatile bar into a fictional winner, and the whole
  // point of this screen is to find out whether refusals were right.
  const result = replay({
    signal: LONG,
    futureCandles: [bar(100, 105, 97, 101, 1)],
    horizonBars: 20
  });

  assert.equal(result.outcome, 'sl');
});

test('a short is graded on the mirrored levels', () => {
  const hitTarget = replay({
    signal: SHORT,
    futureCandles: [bar(100, 100.2, 95.5, 96, 1)],
    horizonBars: 20
  });
  assert.equal(hitTarget.outcome, 'tp');
  assert.equal(hitTarget.rMultiple, 2);

  const hitStop = replay({
    signal: SHORT,
    futureCandles: [bar(100, 102.5, 99.8, 102, 1)],
    horizonBars: 20
  });
  assert.equal(hitStop.outcome, 'sl');
});

test('too few bars is reported as no_data, not as a verdict', () => {
  // A grade issued before the market has answered is worse than no grade:
  // it would drag the accuracy figure toward whatever today happens to look
  // like.
  const result = replay({
    signal: LONG,
    futureCandles: [bar(100, 100.5, 99.8, 100.2, 1)],
    horizonBars: 20
  });

  assert.equal(result.outcome, 'no_data');
  assert.equal(result.resolvedAt, null);
});

test('an empty future is no_data rather than a crash', () => {
  const result = replay({ signal: LONG, futureCandles: [], horizonBars: 20 });
  assert.equal(result.outcome, 'no_data');
  assert.equal(result.barsExamined, 0);
});

test('a full horizon with neither level reached resolves as open', () => {
  const drift = Array.from({ length: 20 }, (_, i) => bar(100, 100.6, 99.4, 100.3, i + 1));
  const result = replay({ signal: LONG, futureCandles: drift, horizonBars: 20 });

  assert.equal(result.outcome, 'open');
  assert.equal(result.barsExamined, 20);
  assert.equal(result.rMultiple, 0.15, 'marked to the last close, not to a level');
});

test('the horizon is a hard limit, so a late winner is not counted', () => {
  const quiet = Array.from({ length: 5 }, (_, i) => bar(100, 100.5, 99.5, 100, i + 1));
  const late = bar(100, 106, 100, 105, 6);

  const result = replay({ signal: LONG, futureCandles: [...quiet, late], horizonBars: 5 });
  assert.equal(result.outcome, 'open', 'a target reached after the horizon is not a win');
});

test('a signal with no target can still be graded on its stop', () => {
  const result = replay({
    signal: { side: 'BUY', entry: 100, sl: 98, tp: null },
    futureCandles: [bar(100, 101, 97, 98, 1)],
    horizonBars: 20
  });

  assert.equal(result.outcome, 'sl');
});

/**
 * Grouping. The messages carry the numbers for their own bar, so grouping by
 * text produced one bucket per signal - thirty-one rows saying the same thing
 * about the same gate, which is a list wearing a summary's clothes.
 */
test('the failing gate is read from the decision, not from its message', () => {
  const { blockedByGate } = require('../src/signals/missed');

  const decision = {
    checks: [
      { name: 'stop_loss_present', passed: true, detail: 'stop at 1.16' },
      { name: 'notional_exposure', passed: false, detail: '1147806 notional against a cap of 668825' },
      { name: 'position_size', passed: false, detail: '9.9 lots risking 1337.65' }
    ]
  };

  const result = blockedByGate(decision);
  assert.equal(result.gate, 'notional_exposure', 'the first failing gate is the one to name');
  assert.deepEqual(result.gates, ['notional_exposure', 'position_size']);
  assert.match(result.message, /1147806 notional/);
});

test('a decision where every gate passed names no gate', () => {
  const { blockedByGate } = require('../src/signals/missed');

  assert.equal(blockedByGate({ checks: [{ name: 'kill_switch', passed: true }] }).gate, null);
  assert.equal(blockedByGate(null).gate, null);
});

test('two readings of one gate collapse to a single shape', () => {
  const { messageShape } = require('../src/signals/missed');

  const a = messageShape('1147806 notional against a cap of 668825 (5x equity)');
  const b = messageShape('4906606 notional against a cap of 668825 (5x equity)');

  assert.equal(a, b, 'the numbers are what differ; the statement is the same');
  assert.equal(messageShape(null), null);
});
