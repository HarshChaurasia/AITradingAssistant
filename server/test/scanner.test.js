require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_scanner_test';

// A gold-shaped contract: a 100,000-unit FX contract on a price-100 series
// sizes every lot below min_lot, so every setup would be refused and the
// assertions below would pass while proving nothing.
async function addSymbol({ name, enabled = 0, watched = 0 }) {
  const { query } = require('../src/db/pool');
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, watched, currency_profit,
       currency_margin, synced_at)
     VALUES (?, 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, ?, ?, 'USD', 'USD', UTC_TIMESTAMP())`,
    [name, enabled, watched]
  );
  const [row] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', [name]);
  return row.id;
}

async function addCandles(symbolId, { breakout = false, timeframe = 'H1' } = {}) {
  const { query } = require('../src/db/pool');
  const rows = [];
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);

  for (let i = 0; i < 300; i += 1) {
    const close = 100 + i * 0.02 + Math.sin(i / 9) * 1.2;
    rows.push([
      symbolId, timeframe,
      new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      close - 0.02, close + 0.05, close - 0.05, close, 100, 0, 8
    ]);
  }

  if (breakout) {
    // The scanner reads the last CLOSED bar, so the breakout goes second to
    // last with one trailing bar after it.
    const base = 100 + 299 * 0.02 + Math.sin(299 / 9) * 1.2;
    const high = base + 6;
    rows.push([symbolId, timeframe, new Date(start + 300 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      base, high + 0.1, base - 0.05, high, 100, 0, 8]);
    rows.push([symbolId, timeframe, new Date(start + 301 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      high, high + 0.1, high - 0.1, high, 100, 0, 8]);
  }

  await query(
    `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close,
       tick_volume, real_volume, spread) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    rows.flat()
  );
}

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();
  await query("UPDATE strategies SET enabled = 1 WHERE name = 'trend-breakout'");
}

test('the scanner reports a row for every watched symbol, firing or not', async (t) => {
  await seeded(t);
  const quiet = await addSymbol({ name: 'QUIETUSD', watched: 1 });
  const active = await addSymbol({ name: 'MOVEUSD', watched: 1 });
  await addCandles(quiet, { breakout: false });
  await addCandles(active, { breakout: true });

  const { scanWatchlist } = require('../src/scanner');
  const scan = await scanWatchlist({ mode: 'demo', timeframe: 'H1', balance: 100000 });

  assert.equal(scan.rows.length, 2, 'a quiet symbol still gets a row - that is the point');

  const quietRow = scan.rows.find((r) => r.symbol === 'QUIETUSD');
  const activeRow = scan.rows.find((r) => r.symbol === 'MOVEUSD');

  const quietTrend = quietRow.strategies.find((s) => s.strategy === 'trend-breakout');
  assert.equal(quietTrend.firing, false);
  assert.match(quietTrend.reason, /no setup/i, 'a non-firing row must say why');
  assert.ok(quietTrend.checks.length > 0);

  const activeTrend = activeRow.strategies.find((s) => s.strategy === 'trend-breakout');
  assert.equal(activeTrend.firing, true);
  assert.equal(activeTrend.side, 'BUY');
});

test('a watched but untradeable symbol is shown, and says it cannot trade', async (t) => {
  await seeded(t);
  const watchedOnly = await addSymbol({ name: 'LOOKUSD', enabled: 0, watched: 1 });
  await addCandles(watchedOnly, { breakout: true });

  const { scanWatchlist } = require('../src/scanner');
  const scan = await scanWatchlist({ mode: 'demo', timeframe: 'H1', balance: 100000 });

  const row = scan.rows.find((r) => r.symbol === 'LOOKUSD');
  assert.equal(row.tradeable, false);

  const entry = row.strategies.find((s) => s.strategy === 'trend-breakout');
  assert.equal(entry.firing, true, 'the setup is real');
  assert.equal(entry.risk.allowed, true, 'and risk would allow it');
  assert.equal(entry.wouldTrade, false, 'but it still must not trade');
  assert.match(entry.blockedBy, /watched but not enabled/i);
});

test('a firing setup on a tradeable symbol reports the risk gates and a lot', async (t) => {
  await seeded(t);
  const tradeable = await addSymbol({ name: 'GOUSD', enabled: 1, watched: 1 });
  await addCandles(tradeable, { breakout: true });

  const { scanWatchlist } = require('../src/scanner');
  const scan = await scanWatchlist({ mode: 'demo', timeframe: 'H1', balance: 100000 });

  const entry = scan.rows[0].strategies.find((s) => s.strategy === 'trend-breakout');
  assert.equal(entry.firing, true);
  assert.ok(entry.risk.checks.length >= 7, 'every risk gate is reported');
  assert.ok(entry.risk.lot > 0);
  assert.equal(entry.wouldTrade, true);
  assert.ok(entry.levels.sl < entry.levels.entry);
});

test('a risk rejection is surfaced with the gate that caused it', async (t) => {
  await seeded(t);
  const tradeable = await addSymbol({ name: 'HALTUSD', enabled: 1, watched: 1 });
  await addCandles(tradeable, { breakout: true });

  const { tripKillSwitch } = require('../src/risk/state');
  await tripKillSwitch({ mode: 'demo', reason: 'scanner test halt' });

  const { scanWatchlist } = require('../src/scanner');
  const scan = await scanWatchlist({ mode: 'demo', timeframe: 'H1', balance: 100000 });

  const entry = scan.rows[0].strategies.find((s) => s.strategy === 'trend-breakout');
  assert.equal(entry.firing, true, 'the strategy still sees the setup');
  assert.equal(entry.risk.allowed, false, 'but risk vetoes it');
  assert.equal(entry.wouldTrade, false);
  assert.match(entry.blockedBy, /kill switch/i);
});

test('a symbol with no candles says so instead of vanishing', async (t) => {
  await seeded(t);
  await addSymbol({ name: 'EMPTYUSD', watched: 1 });

  const { scanWatchlist } = require('../src/scanner');
  const scan = await scanWatchlist({ mode: 'demo', timeframe: 'H1', balance: 100000 });

  const row = scan.rows.find((r) => r.symbol === 'EMPTYUSD');
  assert.ok(row, 'the symbol must still appear');
  assert.match(row.note, /no H1 candles/i);
  assert.deepEqual(row.strategies, []);
});

test('unwatched, untradeable symbols are not scanned', async (t) => {
  await seeded(t);
  const ignored = await addSymbol({ name: 'IGNOREUSD', enabled: 0, watched: 0 });
  await addCandles(ignored, { breakout: true });

  const { scanWatchlist } = require('../src/scanner');
  const scan = await scanWatchlist({ mode: 'demo', timeframe: 'H1', balance: 100000 });

  assert.equal(scan.rows.length, 0, '12,000 unwatched symbols must not be evaluated');
});

test('the scanner reports disabled strategies too, so a quiet screen is explicable', async (t) => {
  await seeded(t);
  const { query } = require('../src/db/pool');
  await query('UPDATE strategies SET enabled = 0');

  const symbolId = await addSymbol({ name: 'BOTHUSD', enabled: 1, watched: 1 });
  await addCandles(symbolId, { breakout: true });

  const { scanWatchlist } = require('../src/scanner');
  const scan = await scanWatchlist({ mode: 'demo', timeframe: 'H1', balance: 100000 });

  const { strategies } = require('../src/strategies/registry');
  const entries = scan.rows[0].strategies;
  assert.equal(entries.length, strategies.length, 'every shipped strategy is shown');
  assert.ok(entries.every((e) => e.strategyEnabled === false),
    'their enabled state is visible, so an empty Signals page is explicable');
});

test('the scanner persists nothing', async (t) => {
  await seeded(t);
  const symbolId = await addSymbol({ name: 'PUREUSD', enabled: 1, watched: 1 });
  await addCandles(symbolId, { breakout: true });

  const { scanWatchlist } = require('../src/scanner');
  const { query } = require('../src/db/pool');

  await scanWatchlist({ mode: 'demo', timeframe: 'H1', balance: 100000 });

  assert.equal((await query('SELECT COUNT(*) AS n FROM signals'))[0].n, 0,
    'a scanner row must never be mistaken for a signal the system acted on');
  assert.equal((await query('SELECT COUNT(*) AS n FROM trades'))[0].n, 0);
});
