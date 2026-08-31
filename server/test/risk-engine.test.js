require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_riskengine_test';

// Checked a moment ago and open. These tests are not exercising market hours
// - the market-hours tests do that - so the fixtures say so plainly rather
// than leaving the market_open gate to refuse everything.
const OPEN_NOW = () => ({
  trade_mode: 4,
  market_open: 1,
  market_reason: 'open (test fixture)',
  market_checked_at: new Date()
});

const SYMBOL = {
  id: 1, broker_symbol: 'EURUSD', contract_size: 100000,
  min_lot: 0.01, lot_step: 0.01, max_lot: 500,
  currency_profit: 'USD', currency_margin: 'EUR',
  ...OPEN_NOW()
};

const GOOD_SIGNAL = { side: 'BUY', entry: 1.1000, sl: 1.0900, tp: 1.1200, symbol_id: 1 };

async function migrated(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });
}

function check(decision, name) {
  const found = decision.checks.find((c) => c.name === name);
  assert.ok(found, `expected a check named ${name}`);
  return found;
}

test('a sound signal passes every gate and gets a lot', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo',
    balance: 10000, openPositions: 0
  });

  assert.equal(d.allowed, true, d.denialReasons.join('; '));
  assert.equal(d.lot, 0.1);
  assert.deepEqual(d.denialReasons, []);
  assert.ok(d.checks.length >= 7, 'every gate is reported');
  assert.ok(d.checks.every((c) => c.passed));
});

test('a signal without a stop loss is denied, and that gate is not configurable', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, sl: null }, symbol: SYMBOL, mode: 'demo',
    balance: 10000, openPositions: 0
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'stop_loss_present').passed, false);
  assert.equal(d.lot, 0);
});

test('a tripped kill switch denies everything', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { tripKillSwitch } = require('../src/risk/state');

  await tripKillSwitch({ mode: 'demo', reason: 'manual halt' });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'kill_switch').passed, false);
  assert.match(check(d, 'kill_switch').detail, /manual halt/);
});

test('a kill switch on one mode does not block the other', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { tripKillSwitch } = require('../src/risk/state');

  await tripKillSwitch({ mode: 'live', reason: 'live halted' });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });
  assert.equal(check(d, 'kill_switch').passed, true);
});

test('breaching the daily loss cap denies further trades', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { recordTradeResult } = require('../src/risk/state');

  // 5% of 10,000 is 500. Lose 600 in one trade.
  await recordTradeResult({ mode: 'demo', pnl: -600 });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'daily_loss_cap').passed, false);
});

test('a profitable day does not trip the loss cap', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { recordTradeResult } = require('../src/risk/state');

  await recordTradeResult({ mode: 'demo', pnl: 900 });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });
  assert.equal(check(d, 'daily_loss_cap').passed, true);
});

test('the concurrent position cap is enforced', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const ok = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 1
  });
  assert.equal(check(ok, 'max_concurrent_positions').passed, true);

  const denied = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 2
  });
  assert.equal(denied.allowed, false);
  assert.equal(check(denied, 'max_concurrent_positions').passed, false);
});

test('a high-impact news event inside the blackout window denies the trade', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { query } = require('../src/db/pool');

  const now = new Date('2026-06-01T12:00:00Z');
  // Ten minutes away, inside the default fifteen minute window.
  await query(
    `INSERT INTO news_events (event_time, currency, title, source, impact)
     VALUES ('2026-06-01 12:10:00', 'USD', 'FOMC rate decision', 'test', 'HIGH')`
  );

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0, now
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'news_blackout').passed, false);
  assert.match(check(d, 'news_blackout').detail, /FOMC/);
});

test('news outside the window, or of low impact, does not block', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { query } = require('../src/db/pool');

  const now = new Date('2026-06-01T12:00:00Z');
  await query(
    `INSERT INTO news_events (event_time, currency, title, source, impact) VALUES
      ('2026-06-01 14:00:00', 'USD', 'Far away high impact', 'test', 'HIGH'),
      ('2026-06-01 12:05:00', 'USD', 'Nearby but low impact', 'test', 'LOW'),
      ('2026-06-01 12:05:00', 'JPY', 'Nearby high impact, wrong currency', 'test', 'HIGH')`
  );

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0, now
  });
  assert.equal(check(d, 'news_blackout').passed, true);
});

test('live mode requires a promoted strategy; demo does not', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const draftInDemo = await assessSignal({
    signal: { ...GOOD_SIGNAL, strategy_status: 'draft' }, symbol: SYMBOL,
    mode: 'demo', balance: 10000, openPositions: 0
  });
  assert.equal(check(draftInDemo, 'strategy_promoted').passed, true);

  const draftInLive = await assessSignal({
    signal: { ...GOOD_SIGNAL, strategy_status: 'draft' }, symbol: SYMBOL,
    mode: 'live', balance: 10000, openPositions: 0
  });
  assert.equal(draftInLive.allowed, false);
  assert.equal(check(draftInLive, 'strategy_promoted').passed, false);

  const liveInLive = await assessSignal({
    signal: { ...GOOD_SIGNAL, strategy_status: 'live' }, symbol: SYMBOL,
    mode: 'live', balance: 10000, openPositions: 0
  });
  assert.equal(check(liveInLive, 'strategy_promoted').passed, true);
});

test('a 100 dollar account on a 22 pip stop is denied on size', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  // The measured real case: the broker minimum lot would risk 2.2% against a
  // 1% cap, so no trade is possible.
  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, sl: 1.09777 }, symbol: SYMBOL,
    mode: 'demo', balance: 100, openPositions: 0
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'position_size').passed, false);
  assert.match(check(d, 'position_size').detail, /below the broker minimum/i);
});

test('every gate is evaluated even when several fail at once', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { tripKillSwitch } = require('../src/risk/state');
  await tripKillSwitch({ mode: 'demo', reason: 'halted' });

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, sl: null }, symbol: SYMBOL,
    mode: 'demo', balance: 10000, openPositions: 99
  });

  assert.equal(d.allowed, false);
  assert.ok(d.denialReasons.length >= 3, 'all failures are reported, not just the first');
  const names = d.checks.map((c) => c.name);
  for (const gate of ['stop_loss_present', 'kill_switch', 'daily_loss_cap',
    'max_concurrent_positions', 'news_blackout', 'strategy_promoted', 'position_size']) {
    assert.ok(names.includes(gate), `missing gate: ${gate}`);
  }
});

test('the real ETHUSD case passes: 1% risk on a wide-enough stop is not over-exposed', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  // Taken from live data. This LOOKS alarming - 147 lots - and is in fact
  // fine: 363k notional is 2.7x equity, needs 725 of margin at 1:500, and the
  // 9.06 stop is 7.2x the 1.25 spread. Pinned so a future tightening of the
  // cap cannot quietly start rejecting sound trades.
  const crypto = {
    id: 2, broker_symbol: 'ETHUSD', contract_size: 1,
    min_lot: 0.1, lot_step: 0.1, max_lot: 1000,
    currency_profit: 'USD', currency_margin: 'USD',
    ...OPEN_NOW()
  };
  const signal = { side: 'BUY', entry: 2457, sl: 2447.94, tp: 2470, symbol_id: 2 };

  const d = await assessSignal({
    signal, symbol: crypto, mode: 'demo', balance: 133765, openPositions: 0
  });

  const gate = d.checks.find((c) => c.name === 'notional_exposure');
  assert.ok(gate, 'the exposure gate must be reported');
  assert.equal(gate.passed, true, `2.7x equity is within the 5x cap: ${gate.detail}`);
  assert.equal(d.allowed, true, d.denialReasons.join('; '));
  assert.equal(d.lot, 147.6);
});

test('a stop so tight it implies an over-leveraged position IS refused', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const crypto = {
    id: 2, broker_symbol: 'ETHUSD', contract_size: 1,
    min_lot: 0.1, lot_step: 0.1, max_lot: 100000,
    currency_profit: 'USD', currency_margin: 'USD',
    ...OPEN_NOW()
  };
  // A one-dollar stop on a 2457 instrument. The risk is still 1%, but it
  // demands 1337 lots - about 3.3m of notional on 133k of equity, 24x.
  // Risk percentage alone cannot catch this; the exposure gate can.
  const razorThin = { side: 'BUY', entry: 2457, sl: 2456, tp: 2470, symbol_id: 2 };

  const d = await assessSignal({
    signal: razorThin, symbol: crypto, mode: 'demo', balance: 133765, openPositions: 0
  });

  const gate = d.checks.find((c) => c.name === 'notional_exposure');
  assert.equal(gate.passed, false, `a 24x position must be refused: ${gate.detail}`);
  assert.equal(d.allowed, false);
  assert.equal(d.lot, 0);
});

test('a normally sized position passes the exposure gate', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });

  const gate = d.checks.find((c) => c.name === 'notional_exposure');
  assert.equal(gate.passed, true, `0.1 lots of EURUSD is 11k notional on 10k equity: ${gate.detail}`);
  assert.equal(d.allowed, true, d.denialReasons.join('; '));
});

test('the exposure cap is configurable', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { saveRiskSettings } = require('../src/risk/settings');

  await saveRiskSettings({ maxNotionalMultiple: 0.5 });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });

  assert.equal(d.checks.find((c) => c.name === 'notional_exposure').passed, false,
    'a 0.5x cap must reject what a 5x cap allowed');
});

test('a signal on a market the broker reports shut is refused', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const symbol = {
    ...SYMBOL,
    market_open: 0,
    market_reason: 'the broker reports the market closed (Market closed)',
    market_checked_at: new Date()
  };

  const d = await assessSignal({ signal: GOOD_SIGNAL, symbol, mode: 'demo', balance: 10000 });

  const gate = d.checks.find((c) => c.name === 'market_open');
  assert.equal(gate.passed, false);
  assert.match(gate.detail, /market closed/i);
  assert.equal(d.allowed, false);
  assert.equal(d.lot, 0, 'a refused signal is never sized');
});

test('a symbol the broker still accepts is allowed on the same Saturday', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  // BTCUSD on this account trades at the weekend, which is the entire reason
  // the rule cannot be a hardcoded "no trading on Saturday".
  const crypto = {
    id: 3, broker_symbol: 'BTCUSD', contract_size: 1,
    min_lot: 0.01, lot_step: 0.01, max_lot: 100,
    currency_profit: 'USD', currency_margin: 'USD',
    ...OPEN_NOW()
  };
  const signal = { side: 'BUY', entry: 60000, sl: 59000, tp: 62000, symbol_id: 3 };

  const d = await assessSignal({
    signal, symbol: crypto, mode: 'demo', balance: 133765,
    now: new Date('2026-08-29T12:00:00Z') // a Saturday
  });

  assert.equal(d.checks.find((c) => c.name === 'market_open').passed, true);
  assert.equal(d.allowed, true, d.denialReasons.join('; '));
});

test('a symbol whose status was never checked is refused rather than assumed open', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const d = await assessSignal({
    signal: GOOD_SIGNAL,
    symbol: { ...SYMBOL, market_open: null, market_checked_at: null },
    mode: 'demo',
    balance: 10000
  });

  assert.equal(d.allowed, false);
  assert.match(d.denialReasons.join(' '), /never been checked/);
});

test('a stale status refuses even though it last said open', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  // The bridge drops, the row keeps its old "open" flag, and without this the
  // system would trade on an answer from an hour ago.
  const d = await assessSignal({
    signal: GOOD_SIGNAL,
    symbol: { ...SYMBOL, market_open: 1, market_checked_at: new Date(Date.now() - 3600 * 1000) },
    mode: 'demo',
    balance: 10000
  });

  assert.equal(d.allowed, false);
  assert.match(d.denialReasons.join(' '), /old/);
});

test('a backtest is exempt: market hours have no meaning when replaying history', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const d = await assessSignal({
    signal: GOOD_SIGNAL,
    symbol: { ...SYMBOL, market_open: 0, market_checked_at: null },
    mode: 'backtest',
    balance: 10000
  });

  assert.equal(d.checks.find((c) => c.name === 'market_open').passed, true);
});


/**
 * The correlated-exposure gate counts rows in `trades`, so these tests need a
 * real symbols row for the foreign key to hang off. SYMBOL above is a plain
 * object handed straight to the engine; it never touches the database.
 */
async function withOpenPosition(side) {
  const { query } = require('../src/db/pool');
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at, trade_mode,
       market_open, market_reason, market_checked_at)
     VALUES ('EURUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 500, 1,
             UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP())`
  );
  const [row] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['EURUSD']);
  return row.id;
}

/**
 * The gate the account's own history argues hardest for.
 *
 * Of 50 closed trades, 29 arrived in bursts of three or more within ten
 * minutes and lost 20,518 between them - 64% of everything lost. Each obeyed
 * the 1% per-trade cap exactly; they simply were not independent bets.
 */
test('a second position in the same direction on the same symbol is refused', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { query } = require('../src/db/pool');

  const symbolId = await withOpenPosition();
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, 'demo', 'BUY', 0.1, 1.1, 1.09, UTC_TIMESTAMP(), 'OPEN')`,
    [symbolId]
  );

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, symbol_id: symbolId },
    symbol: { ...SYMBOL, id: symbolId }, mode: 'demo', balance: 10000, openPositions: 1
  });

  const gate = check(d, 'correlated_exposure');
  assert.equal(gate.passed, false);
  assert.match(gate.detail, /1 already BUY on EURUSD, limit 1/);
  assert.equal(d.allowed, false);
});

test('a hedge is not correlated exposure', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { query } = require('../src/db/pool');

  // Short EURUSD already open. Going long is a different statement from
  // going long five times, so the gate counts direction, not instrument.
  const symbolId = await withOpenPosition();
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, 'demo', 'SELL', 0.1, 1.1, 1.11, UTC_TIMESTAMP(), 'OPEN')`,
    [symbolId]
  );

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, symbol_id: symbolId },
    symbol: { ...SYMBOL, id: symbolId }, mode: 'demo', balance: 10000, openPositions: 1
  });

  assert.equal(check(d, 'correlated_exposure').passed, true);
  assert.equal(d.allowed, true, d.denialReasons.join('; '));
});

test('the correlated exposure limit is configurable', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { saveRiskSettings } = require('../src/risk/settings');
  const { query } = require('../src/db/pool');

  await saveRiskSettings({ maxSameDirectionPerSymbol: 3 });
  const symbolId = await withOpenPosition();
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, 'demo', 'BUY', 0.1, 1.1, 1.09, UTC_TIMESTAMP(), 'OPEN')`,
    [symbolId]
  );

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, symbol_id: symbolId },
    symbol: { ...SYMBOL, id: symbolId }, mode: 'demo', balance: 10000, openPositions: 1
  });

  assert.equal(check(d, 'correlated_exposure').passed, true,
    'an operator who wants three of the same idea may have them');
});

test('a backtest is exempt: it has no live positions to be correlated with', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { query } = require('../src/db/pool');

  const symbolId = await withOpenPosition();
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, 'backtest', 'BUY', 0.1, 1.1, 1.09, UTC_TIMESTAMP(), 'OPEN')`,
    [symbolId]
  );

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, symbol_id: symbolId },
    symbol: { ...SYMBOL, id: symbolId }, mode: 'backtest', balance: 10000, openPositions: 0
  });

  assert.equal(check(d, 'correlated_exposure').passed, true);
});

/**
 * The promotion gate.
 *
 * Promotion is a property of the COMBINATION. Measured over a year, the same
 * strategy reaches a profit factor of 1.40 on BTCUSD H1 and 0.43 on BTCUSD M5
 * - one is an edge, the other is a way to pay the spread, and a per-strategy
 * flag says the wrong thing about one of them whichever way it is set.
 */
test('promotion per combination is not enforced by default', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });

  const gate = check(d, 'promoted_combination');
  assert.equal(gate.passed, true);
  assert.match(gate.detail, /not being enforced/);
  assert.equal(d.allowed, true, d.denialReasons.join('; '));
});

test('with enforcement on, an unpromoted combination is refused', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { saveRiskSettings } = require('../src/risk/settings');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');

  await registerStrategies();
  await saveRiskSettings({ requirePromotedCombination: true });

  const symbolId = await withOpenPosition();
  const [strategy] = await query('SELECT id FROM strategies LIMIT 1');

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, symbol_id: symbolId, strategy_id: strategy.id, timeframe: 'H1' },
    symbol: { ...SYMBOL, id: symbolId }, mode: 'demo', balance: 10000, openPositions: 0
  });

  const gate = check(d, 'promoted_combination');
  assert.equal(gate.passed, false);
  assert.match(gate.detail, /no passing backtest .* EURUSD H1/);
  assert.equal(d.allowed, false);
});

test('a promoted combination trades, and only on the timeframe it was promoted for', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { saveRiskSettings } = require('../src/risk/settings');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  const { recordStudy, promoteFromStudy } = require('../src/strategies/promotions');

  await registerStrategies();
  await saveRiskSettings({ requirePromotedCombination: true });

  const symbolId = await withOpenPosition();
  const [strategy] = await query('SELECT id, name FROM strategies LIMIT 1');

  const { studyId } = await recordStudy({
    strategyName: strategy.name,
    symbolId,
    timeframe: 'H1',
    trials: 216,
    iterations: [],
    winner: {
      fullParams: { atrStopMultiple: 2.75 },
      optimise: { profitFactor: 1.37, trades: 111 },
      validate: { profitFactor: 1.41, trades: 62 },
      holdout: { profitFactor: 1.35, trades: 58 }
    },
    validatePassed: true,
    holdoutPassed: true,
    promotable: true
  });
  await promoteFromStudy(studyId);

  const signal = {
    ...GOOD_SIGNAL, symbol_id: symbolId, strategy_id: strategy.id, timeframe: 'H1'
  };
  const allowed = await assessSignal({
    signal, symbol: { ...SYMBOL, id: symbolId }, mode: 'demo', balance: 10000, openPositions: 0
  });
  assert.equal(check(allowed, 'promoted_combination').passed, true);

  // The evidence was gathered on H1 and says nothing whatever about M5.
  const other = await assessSignal({
    signal: { ...signal, timeframe: 'M5' },
    symbol: { ...SYMBOL, id: symbolId }, mode: 'demo', balance: 10000, openPositions: 0
  });
  assert.equal(check(other, 'promoted_combination').passed, false);
});

test('a backtest is never gated on promotion - that is how promotion is earned', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { saveRiskSettings } = require('../src/risk/settings');

  await saveRiskSettings({ requirePromotedCombination: true });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'backtest', balance: 10000, openPositions: 0
  });

  assert.equal(check(d, 'promoted_combination').passed, true);
});
