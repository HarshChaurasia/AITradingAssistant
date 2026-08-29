const test = require('node:test');
const assert = require('node:assert/strict');

const { runBacktest } = require('../src/backtest/engine');

// Two symbol shapes, because lot sizing depends on contract size and these
// tests use two very different price scales. Using an FX contract (100,000
// units) with a price-100 instrument makes every risk-based lot round to zero,
// and the trade is then correctly skipped - which would silently gut the tests.
const IDX = { contract_size: 100, tick_size: 0.01, digits: 2, min_lot: 0.01, lot_step: 0.01, max_lot: 100 };
const FX = { contract_size: 100000, tick_size: 0.00001, digits: 5, min_lot: 0.01, lot_step: 0.01, max_lot: 100 };
const SYMBOL = IDX;

const OPTIONS = {
  startingBalance: 10000,
  riskPctPerTrade: 1,
  spreadPrice: 0,
  slippagePrice: 0,
  commissionPerLot: 0,
  maxConcurrentPositions: 1
};

function bar(time, open, high, low, close) {
  return { open_time: time, open, high, low, close };
}

// A strategy that fires once, on a bar we choose, with fixed levels.
function fixedSignalStrategy({ atBar, side, sl, tp }) {
  return {
    name: 'test-fixture',
    version: '1.0.0',
    defaultParams: {},
    prepare: () => ({}),
    evaluate: (candles, index) =>
      index === atBar
        ? { side, entry: candles[index].close, sl, tp, reason: 'fixture', features: {} }
        : null
  };
}

test('a long is filled at the next bar open, not the signal bar close', () => {
  const candles = [
    bar('2026-01-01T00:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T01:00:00.000Z', 105, 106, 104, 105), // gap up: fill here
    bar('2026-01-01T02:00:00.000Z', 105, 120, 104, 119)  // hits target
  ];
  const strategy = fixedSignalStrategy({ atBar: 0, side: 'BUY', sl: 95, tp: 110 });

  const { trades } = runBacktest({ candles, strategy, params: {}, symbol: SYMBOL, options: OPTIONS });

  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryPrice, 105, 'filled at the next bar open, not at 100');
  assert.equal(trades[0].exitReason, 'TP');
  assert.equal(trades[0].exitPrice, 110);
});

test('a stop loss is taken when the bar low reaches it', () => {
  const candles = [
    bar('2026-01-01T00:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T01:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T02:00:00.000Z', 100, 100, 90, 92)
  ];
  const strategy = fixedSignalStrategy({ atBar: 0, side: 'BUY', sl: 95, tp: 130 });

  const { trades } = runBacktest({ candles, strategy, params: {}, symbol: SYMBOL, options: OPTIONS });

  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, 'SL');
  assert.equal(trades[0].exitPrice, 95);
  assert.ok(trades[0].pnl < 0);
});

test('when one bar spans both stop and target, the stop wins', () => {
  const candles = [
    bar('2026-01-01T00:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T01:00:00.000Z', 100, 101, 99, 100),
    // This bar touches both 95 and 110; without tick data the pessimistic
    // reading is the only honest one.
    bar('2026-01-01T02:00:00.000Z', 100, 115, 90, 112)
  ];
  const strategy = fixedSignalStrategy({ atBar: 0, side: 'BUY', sl: 95, tp: 110 });

  const { trades } = runBacktest({ candles, strategy, params: {}, symbol: SYMBOL, options: OPTIONS });

  assert.equal(trades[0].exitReason, 'SL');
});

test('a short profits when price falls to its target', () => {
  const candles = [
    bar('2026-01-01T00:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T01:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T02:00:00.000Z', 100, 100, 85, 86)
  ];
  const strategy = fixedSignalStrategy({ atBar: 0, side: 'SELL', sl: 105, tp: 90 });

  const { trades } = runBacktest({ candles, strategy, params: {}, symbol: SYMBOL, options: OPTIONS });

  assert.equal(trades[0].exitReason, 'TP');
  assert.equal(trades[0].exitPrice, 90);
  assert.ok(trades[0].pnl > 0, 'a short gains when price falls');
});

test('a position still open at the end is closed at the last close', () => {
  const candles = [
    bar('2026-01-01T00:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T01:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T02:00:00.000Z', 100, 102, 99, 101)
  ];
  const strategy = fixedSignalStrategy({ atBar: 0, side: 'BUY', sl: 50, tp: 200 });

  const { trades } = runBacktest({ candles, strategy, params: {}, symbol: SYMBOL, options: OPTIONS });

  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, 'END');
  assert.equal(trades[0].exitPrice, 101);
});

test('costs make an otherwise break-even trade a loser', () => {
  const candles = [
    bar('2026-01-01T00:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T01:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T02:00:00.000Z', 100, 101, 99, 100)
  ];
  const strategy = fixedSignalStrategy({ atBar: 0, side: 'BUY', sl: 50, tp: 200 });

  const free = runBacktest({ candles, strategy, params: {}, symbol: SYMBOL, options: OPTIONS });
  const costly = runBacktest({
    candles, strategy, params: {}, symbol: SYMBOL,
    options: { ...OPTIONS, spreadPrice: 0.5, slippagePrice: 0.1, commissionPerLot: 7 }
  });

  assert.equal(free.trades[0].pnl, 0, 'flat price with no costs is break-even');
  assert.ok(costly.trades[0].pnl < 0, 'the same trade loses money once costs apply');
});

test('a second signal is ignored while a position is open', () => {
  const candles = Array.from({ length: 6 }, (_, i) =>
    bar(`2026-01-01T0${i}:00:00.000Z`, 100, 101, 99, 100)
  );
  const strategy = {
    name: 'always', version: '1.0.0', defaultParams: {},
    prepare: () => ({}),
    evaluate: (c, i) => ({ side: 'BUY', entry: c[i].close, sl: 50, tp: 200, reason: 'x', features: {} })
  };

  const { trades } = runBacktest({ candles, strategy, params: {}, symbol: SYMBOL, options: OPTIONS });
  assert.equal(trades.length, 1, 'only one concurrent position is allowed');
});

test('lot size is derived from risk and rounded down to the lot step', () => {
  const candles = [
    bar('2026-01-01T00:00:00.000Z', 1.1, 1.11, 1.09, 1.1),
    bar('2026-01-01T01:00:00.000Z', 1.1, 1.11, 1.09, 1.1),
    bar('2026-01-01T02:00:00.000Z', 1.1, 1.11, 1.05, 1.06)
  ];
  // Risking 1% of 10,000 = $100 over a 0.01 stop distance on a 100,000
  // contract: 100 / (0.01 * 100000) = 0.1 lots.
  const strategy = fixedSignalStrategy({ atBar: 0, side: 'BUY', sl: 1.09, tp: 1.2 });

  const { trades } = runBacktest({ candles, strategy, params: {}, symbol: FX, options: OPTIONS });
  assert.equal(trades[0].lot, 0.1);
});

test('a trade whose risk implies less than the minimum lot is skipped', () => {
  const candles = [
    bar('2026-01-01T00:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T01:00:00.000Z', 100, 101, 99, 100),
    bar('2026-01-01T02:00:00.000Z', 100, 101, 99, 100)
  ];
  // A stop 50 points wide on a tiny balance cannot be traded at 0.01 lots
  // without exceeding the risk budget. Rounding up would blow the account.
  const strategy = fixedSignalStrategy({ atBar: 0, side: 'BUY', sl: 50, tp: 200 });

  const { trades } = runBacktest({
    candles, strategy, params: {}, symbol: SYMBOL,
    options: { ...OPTIONS, startingBalance: 100, riskPctPerTrade: 1 }
  });

  assert.equal(trades.length, 0, 'the trade is refused, never rounded up to the minimum');
});

test('the trading window restricts signals but not indicator history', () => {
  const candles = Array.from({ length: 20 }, (_, i) =>
    bar(`2026-01-0${1 + Math.floor(i / 10)}T${String(i % 10).padStart(2, '0')}:00:00.000Z`, 100, 101, 99, 100)
  );
  // A strategy that reports how many bars of history it can see, and only
  // signals on bar 12.
  let seenLength = 0;
  const strategy = {
    name: 'window-probe', version: '1.0.0', defaultParams: {},
    prepare: (c) => { seenLength = c.length; return {}; },
    evaluate: (c, i) =>
      i === 12 ? { side: 'BUY', entry: c[i].close, sl: 50, tp: 200, reason: 'probe', features: {} } : null
  };

  const { trades, signals } = runBacktest({
    candles, strategy, params: {}, symbol: SYMBOL,
    options: { ...OPTIONS, tradeFrom: 10, tradeTo: 18 }
  });

  assert.equal(seenLength, 20, 'indicators must see the full series, not the window');
  assert.equal(signals.length, 1);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryTime, candles[13].open_time, 'filled on the bar after the signal');
  assert.equal(trades[0].exitReason, 'END');
  assert.equal(trades[0].exitTime, candles[17].open_time, 'force-closed at the window edge, not the series end');
});

test('signals before the trading window are ignored', () => {
  const candles = Array.from({ length: 10 }, (_, i) =>
    bar(`2026-01-01T0${i}:00:00.000Z`, 100, 101, 99, 100)
  );
  const strategy = {
    name: 'always', version: '1.0.0', defaultParams: {},
    prepare: () => ({}),
    evaluate: (c, i) => ({ side: 'BUY', entry: c[i].close, sl: 50, tp: 200, reason: 'x', features: {} })
  };

  const { signals } = runBacktest({
    candles, strategy, params: {}, symbol: SYMBOL,
    options: { ...OPTIONS, tradeFrom: 5, tradeTo: 10 }
  });

  assert.ok(signals.length > 0);
  assert.ok(signals.every((s) => s.barIndex >= 5), 'no signal may originate before tradeFrom');
});
