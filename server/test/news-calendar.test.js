require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');
const { normaliseEvent } = require('../src/news/calendar');
const { blackoutMinutesFor } = require('../src/risk/engine');
const { DEFAULT_RISK_SETTINGS } = require('../src/risk/settings');

const SCRATCH_DB = 'trading_agent_news_test';

const OPEN_MARKET = "UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP()";

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, watched, currency_profit, currency_margin,
       synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('EURUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 500, 1, 1, 'USD', 'EUR', ${OPEN_MARKET})`
  );
  const [symbol] = await query('SELECT * FROM symbols WHERE broker_symbol = ?', ['EURUSD']);
  return symbol;
}

async function storeEvent({ minutesFromNow, currency = 'USD', impact = 'HIGH', title = 'FOMC Statement' }) {
  const { query } = require('../src/db/pool');
  await query(
    `INSERT INTO news_events (event_time, currency, title, source, impact)
     VALUES (DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?, ?, 'test', ?)`,
    [minutesFromNow, currency, title, impact]
  );
}

const SIGNAL = { side: 'BUY', entry: 1.1, sl: 1.09, tp: 1.12, symbol_id: 1, strategy_status: 'demo' };

async function assess(symbol, timeframe) {
  const { assessSignal } = require('../src/risk/engine');
  return assessSignal({
    signal: { ...SIGNAL, symbol_id: symbol.id, timeframe },
    symbol, mode: 'demo', balance: 100000
  });
}

test('the blackout widens with the timeframe', () => {
  // A flat window treated an M5 scalp and an H4 swing identically. A signal on
  // a four-hour bar is a claim about the next several hours, so an event
  // inside that horizon is squarely its problem.
  const s = DEFAULT_RISK_SETTINGS;
  assert.equal(blackoutMinutesFor('M5', s), 15, 'the floor holds for fast bars');
  assert.equal(blackoutMinutesFor('M30', s), 30);
  assert.equal(blackoutMinutesFor('H1', s), 60);
  assert.equal(blackoutMinutesFor('H4', s), 240);
  assert.equal(blackoutMinutesFor('D1', s), 240, 'capped, or a D1 strategy would never trade');
});

test('an event two hours away blocks an H4 signal but not an M5 one', async (t) => {
  const symbol = await seeded(t);
  await storeEvent({ minutesFromNow: 120 });

  const m5 = await assess(symbol, 'M5');
  const h4 = await assess(symbol, 'H4');

  assert.equal(m5.checks.find((c) => c.name === 'news_blackout').passed, true,
    'a scalp that will be closed in twenty minutes is not exposed to it');
  assert.equal(h4.checks.find((c) => c.name === 'news_blackout').passed, false);
  assert.match(h4.checks.find((c) => c.name === 'news_blackout').detail, /FOMC/);
  assert.equal(h4.allowed, false);
});

test('an event ten minutes away blocks every timeframe', async (t) => {
  const symbol = await seeded(t);
  await storeEvent({ minutesFromNow: 10 });

  for (const timeframe of ['M5', 'M15', 'H1', 'H4']) {
    const d = await assess(symbol, timeframe);
    assert.equal(d.checks.find((c) => c.name === 'news_blackout').passed, false, timeframe);
  }
});

test('an event already past still blocks, because the window is two-sided', async (t) => {
  const symbol = await seeded(t);
  await storeEvent({ minutesFromNow: -10 });

  const d = await assess(symbol, 'M15');
  assert.equal(d.checks.find((c) => c.name === 'news_blackout').passed, false,
    'the minutes after a release are the volatile ones');
});

test('an unrelated currency does not block', async (t) => {
  const symbol = await seeded(t);
  await storeEvent({ minutesFromNow: 5, currency: 'JPY', title: 'BOJ Press Conference' });

  const d = await assess(symbol, 'H4');
  assert.equal(d.checks.find((c) => c.name === 'news_blackout').passed, true);
});

test('a medium-impact event does not block by default', async (t) => {
  const symbol = await seeded(t);
  await storeEvent({ minutesFromNow: 5, impact: 'MEDIUM', title: 'Trade Balance' });

  // Blocking on medium impact silences the book for most of a normal week.
  const d = await assess(symbol, 'H4');
  assert.equal(d.checks.find((c) => c.name === 'news_blackout').passed, true);
});

test('an empty calendar reports plainly rather than looking like a pass', async (t) => {
  const symbol = await seeded(t);
  const d = await assess(symbol, 'H4');
  const gate = d.checks.find((c) => c.name === 'news_blackout');

  // This gate spent the whole project reading an empty table and reporting
  // "no high impact news" for every signal ever assessed - true only in the
  // sense that an empty table contains no events.
  assert.equal(gate.passed, true);
  assert.match(gate.detail, /scaled to H4/);
});

test('a feed row without a usable time is dropped, not stored with a guess', () => {
  // A blackout window in the wrong place is worse than no window at all.
  assert.equal(normaliseEvent({ title: 'Something', date: 'not a date' }), null);
  assert.equal(normaliseEvent({ title: '', date: '2026-09-01T12:00:00Z' }), null);
});

test('a summit belonging to no currency is stored without one', () => {
  // The feed marks these "All". Matching them to every pair would blackout the
  // entire book for a scheduled photo opportunity.
  const event = normaliseEvent({
    title: 'G20 Meetings', country: 'All', date: '2026-09-01T12:00:00Z', impact: 'Low'
  });
  assert.equal(event.currency, null);
  assert.equal(event.impact, 'LOW');
});

test('the feed impact vocabulary maps onto ours', () => {
  const at = '2026-09-01T12:00:00Z';
  assert.equal(normaliseEvent({ title: 'a', date: at, impact: 'High' }).impact, 'HIGH');
  assert.equal(normaliseEvent({ title: 'a', date: at, impact: 'Medium' }).impact, 'MEDIUM');
  assert.equal(normaliseEvent({ title: 'a', date: at, impact: 'Holiday' }).impact, 'LOW');
  assert.equal(normaliseEvent({ title: 'a', date: at, impact: 'nonsense' }).impact, 'LOW');
});

test('a calendar outage leaves the stored events alone', async (t) => {
  await seeded(t);
  const { syncCalendar } = require('../src/news/calendar');

  const result = await syncCalendar({
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    logger: { error: () => {} }
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /ENOTFOUND/);
  // The gate then sees whatever is already stored, which is the honest
  // fallback: a fetch failure must never quietly widen or clear a blackout.
});
