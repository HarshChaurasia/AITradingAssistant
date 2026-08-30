require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_siggen_test';

async function seeded(t, { status = 'demo' } = {}) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();

  await query('UPDATE strategies SET enabled = 1, status = ? WHERE name = ?', [status, 'trend-breakout']);
  await query('UPDATE strategies SET enabled = 0 WHERE name = ?', ['mean-reversion']);

  // A gold-shaped contract: with a 100,000 unit FX contract an ATR stop on a
  // price-100 series sizes below min_lot, every trade is correctly refused,
  // and the assertions below would pass while proving nothing.
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, currency_profit, currency_margin, synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, 'USD', 'USD', UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);

  // A rising series with tight bars, so a Donchian breakout actually occurs.
  const rows = [];
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < 300; i += 1) {
    const close = 100 + i * 0.02 + Math.sin(i / 9) * 1.2;
    rows.push([
      sym.id, 'H1',
      new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      close - 0.02, close + 0.05, close - 0.05, close, 100, 0, 8
    ]);
  }
  // The generator evaluates the LAST CLOSED bar, i.e. the second to last. End
  // the series with a decisive breakout there, then one trailing bar. Without
  // this the strategy never fires and every assertion below passes vacuously.
  const lastClose = 100 + 299 * 0.02 + Math.sin(299 / 9) * 1.2;
  const breakout = lastClose + 6;
  rows.push([
    sym.id, 'H1', new Date(start + 300 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
    lastClose, breakout + 0.1, lastClose - 0.05, breakout, 100, 0, 8
  ]);
  rows.push([
    sym.id, 'H1', new Date(start + 301 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
    breakout, breakout + 0.1, breakout - 0.1, breakout, 100, 0, 8
  ]);

  await query(
    `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close,
       tick_volume, real_volume, spread) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    rows.flat()
  );

  return sym.id;
}

test('generateSignals creates signals from the newest bar only', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  const result = await generateSignals({ mode: 'demo' });
  assert.ok(result.evaluated > 0, 'at least one enabled strategy/symbol pair was evaluated');

  const signals = await query('SELECT * FROM signals');
  assert.equal(signals.length, 1, 'the breakout on the last closed bar produces exactly one signal');
  assert.equal(result.created, 1);
  for (const s of signals) {
    assert.equal(s.mode, 'demo');
    assert.ok(s.sl !== null, 'every stored signal carries a stop');
    assert.ok(s.decision, 'the risk decision is stored alongside');
  }
});

test('running twice does not duplicate a signal for the same bar', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  await generateSignals({ mode: 'demo' });
  const first = (await query('SELECT COUNT(*) AS n FROM signals'))[0].n;

  await generateSignals({ mode: 'demo' });
  const second = (await query('SELECT COUNT(*) AS n FROM signals'))[0].n;

  assert.equal(second, first, 'the dedupe key prevents a second signal for the same bar');
});

test('a disabled strategy produces nothing', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  await query('UPDATE strategies SET enabled = 0');
  const result = await generateSignals({ mode: 'demo' });

  assert.equal(result.evaluated, 0);
  assert.equal((await query('SELECT COUNT(*) AS n FROM signals'))[0].n, 0);
});

test('a disabled symbol produces nothing', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  await query('UPDATE symbols SET enabled = 0');
  const result = await generateSignals({ mode: 'demo' });

  assert.equal(result.evaluated, 0);
});

test('with auto-trade off, a green signal waits for a click', async (t) => {
  await seeded(t, { status: 'live' });
  const { generateSignals } = require('../src/signals/generator');
  const { saveOperationsSettings } = require('../src/settings/operations');
  const { query } = require('../src/db/pool');

  // The default. Handing over the trigger is an explicit choice, so until the
  // operator makes it every signal queues - in demo exactly as in live.
  await saveOperationsSettings({ autoTradeEnabled: false });
  await generateSignals({ mode: 'demo' });

  const signals = await query("SELECT * FROM signals WHERE mode = 'demo' AND status <> 'rejected'");
  assert.ok(signals.length > 0, 'the fixture must produce a demo candidate');
  for (const s of signals) {
    assert.equal(s.status, 'new');
    assert.equal(s.auto_approved, 0);
  }
});

test('with auto-trade on, demo signals are approved and live ones still are not', async (t) => {
  await seeded(t, { status: 'live' });
  const { generateSignals } = require('../src/signals/generator');
  const { saveOperationsSettings } = require('../src/settings/operations');
  const { query } = require('../src/db/pool');

  // autoTradeLive is a second, separate switch. Turning on auto-trading must
  // never reach a real account as a side effect.
  await saveOperationsSettings({ autoTradeEnabled: true, autoTradeLive: false });

  await generateSignals({ mode: 'demo' });
  const demoSignals = await query("SELECT * FROM signals WHERE mode = 'demo'");

  await query('DELETE FROM signals');
  await generateSignals({ mode: 'live' });
  const liveSignals = await query("SELECT * FROM signals WHERE mode = 'live'");

  assert.ok(demoSignals.length > 0, 'the fixture must produce a demo candidate');
  assert.ok(liveSignals.length > 0, 'the fixture must produce a live candidate');

  for (const s of demoSignals.filter((x) => x.status !== 'rejected')) {
    assert.equal(s.auto_approved, 1, 'demo runs hands-off so the demo period measures the system');
  }
  for (const s of liveSignals.filter((x) => x.status !== 'rejected')) {
    assert.equal(s.status, 'new', 'live needs its own switch before it can auto-approve');
    assert.equal(s.auto_approved, 0);
  }
});

test('autoTradeLive is what lets a live signal approve itself', async (t) => {
  await seeded(t, { status: 'live' });
  const { generateSignals } = require('../src/signals/generator');
  const { saveOperationsSettings } = require('../src/settings/operations');
  const { query } = require('../src/db/pool');

  await saveOperationsSettings({ autoTradeEnabled: true, autoTradeLive: true });
  await generateSignals({ mode: 'live' });

  const signals = await query("SELECT * FROM signals WHERE mode = 'live' AND status <> 'rejected'");
  assert.ok(signals.length > 0);
  for (const s of signals) assert.equal(s.auto_approved, 1);
});

test('a signal denied by risk is stored as rejected with its reasons', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { tripKillSwitch } = require('../src/risk/state');
  const { query } = require('../src/db/pool');

  await tripKillSwitch({ mode: 'demo', reason: 'test halt' });
  await generateSignals({ mode: 'demo' });

  const signals = await query('SELECT * FROM signals');
  assert.ok(signals.length > 0, 'the fixture must produce a candidate to reject');
  for (const s of signals) {
    assert.equal(s.status, 'rejected');
    assert.ok(JSON.stringify(s.decision).includes('kill switch'), 'the denial reason is recorded');
  }
});

test('approveSignal and rejectSignal move a signal out of the queue', async (t) => {
  await seeded(t, { status: 'live' });
  const { generateSignals } = require('../src/signals/generator');
  const { listSignals, approveSignal, rejectSignal } = require('../src/signals/store');
  const { query } = require('../src/db/pool');

  await generateSignals({ mode: 'live' });
  let pending = await listSignals({ mode: 'live', status: 'new' });
  if (pending.length === 0) {
    // The fixture produced no live candidate; insert one directly so the
    // approval path is still covered.
    const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");
    const [sym] = await query("SELECT id FROM symbols WHERE broker_symbol = 'XAUUSD'");
    await query(
      `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
         side, entry, sl, tp, status)
       VALUES (?, ?, 'H1', 'live', UTC_TIMESTAMP(), '2026-02-01 00:00:00', 'BUY', 100, 99, 102, 'new')`,
      [st.id, sym.id]
    );
    pending = await listSignals({ mode: 'live', status: 'new' });
  }

  assert.ok(pending.length > 0);

  const approved = await approveSignal(pending[0].id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decided_by, 'user');
  assert.ok(approved.decided_at);

  const rejected = await rejectSignal(pending[0].id, 'not convinced');
  assert.equal(rejected.status, 'rejected');
  assert.match(JSON.stringify(rejected.decision), /not convinced/);
});

test('expireStaleSignals ages out untouched signals', async (t) => {
  await seeded(t, { status: 'live' });
  const { expireStaleSignals, listSignals } = require('../src/signals/store');
  const { query } = require('../src/db/pool');

  const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");
  const [sym] = await query("SELECT id FROM symbols WHERE broker_symbol = 'XAUUSD'");
  await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, status)
     VALUES (?, ?, 'H1', 'live', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR),
             '2026-02-01 00:00:00', 'BUY', 100, 99, 102, 'new')`,
    [st.id, sym.id]
  );

  const expired = await expireStaleSignals({ olderThanMinutes: 60, mode: 'live' });
  assert.ok(expired >= 1);
  assert.equal((await listSignals({ mode: 'live', status: 'new' })).length, 0);
});
