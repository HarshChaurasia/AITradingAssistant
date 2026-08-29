const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_riskstate_test';

async function migrated(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });
}

test('getState creates one row per day and mode, then reuses it', async (t) => {
  await migrated(t);
  const { getState, currentTradingDay } = require('../src/risk/state');
  const { query } = require('../src/db/pool');

  const day = currentTradingDay();
  const first = await getState('demo', day);
  assert.equal(Number(first.realized_pnl), 0);
  assert.equal(first.consecutive_losses, 0);
  assert.equal(first.kill_switch, 0);

  await getState('demo', day);
  const rows = await query('SELECT COUNT(*) AS n FROM risk_state WHERE mode = ?', ['demo']);
  assert.equal(rows[0].n, 1, 'no duplicate row for the same day and mode');

  // A different mode is tracked separately: demo losses must never halt live.
  await getState('live', day);
  const all = await query('SELECT COUNT(*) AS n FROM risk_state');
  assert.equal(all[0].n, 2);
});

test('recordTradeResult accumulates pnl and counts trades', async (t) => {
  await migrated(t);
  const { recordTradeResult, currentTradingDay } = require('../src/risk/state');
  const day = currentTradingDay();

  await recordTradeResult({ mode: 'demo', pnl: 5, day });
  const s = await recordTradeResult({ mode: 'demo', pnl: -2, day });

  assert.equal(Number(s.realized_pnl), 3);
  assert.equal(s.trades_count, 2);
});

test('a win resets the consecutive loss counter', async (t) => {
  await migrated(t);
  const { recordTradeResult, currentTradingDay } = require('../src/risk/state');
  const day = currentTradingDay();

  await recordTradeResult({ mode: 'demo', pnl: -1, day });
  let s = await recordTradeResult({ mode: 'demo', pnl: -1, day });
  assert.equal(s.consecutive_losses, 2);

  s = await recordTradeResult({ mode: 'demo', pnl: 3, day });
  assert.equal(s.consecutive_losses, 0, 'a winner clears the streak');
});

test('the configured number of consecutive losses trips the kill switch', async (t) => {
  await migrated(t);
  const { recordTradeResult, currentTradingDay } = require('../src/risk/state');
  const day = currentTradingDay();

  await recordTradeResult({ mode: 'demo', pnl: -1, day });
  await recordTradeResult({ mode: 'demo', pnl: -1, day });
  const s = await recordTradeResult({ mode: 'demo', pnl: -1, day });

  assert.equal(s.kill_switch, 1, 'three consecutive losses trips the switch');
  assert.match(s.kill_switch_reason, /consecutive/i);
});

test('the kill switch does not reset itself on a later win', async (t) => {
  await migrated(t);
  const { recordTradeResult, getState, resetKillSwitch, currentTradingDay } = require('../src/risk/state');
  const day = currentTradingDay();

  for (let i = 0; i < 3; i += 1) await recordTradeResult({ mode: 'demo', pnl: -1, day });
  await recordTradeResult({ mode: 'demo', pnl: 10, day });

  let s = await getState('demo', day);
  assert.equal(s.kill_switch, 1, 'only a human may clear it');

  s = await resetKillSwitch({ mode: 'demo', day });
  assert.equal(s.kill_switch, 0);
  assert.equal(s.consecutive_losses, 0, 'a manual reset also clears the streak');
});

test('tripKillSwitch records the reason it was tripped', async (t) => {
  await migrated(t);
  const { tripKillSwitch, currentTradingDay } = require('../src/risk/state');

  const s = await tripKillSwitch({ mode: 'live', reason: 'daily loss cap breached', day: currentTradingDay() });
  assert.equal(s.kill_switch, 1);
  assert.equal(s.kill_switch_reason, 'daily loss cap breached');
});

test('risk settings load defaults and accept a partial patch', async (t) => {
  await migrated(t);
  const { loadRiskSettings, saveRiskSettings } = require('../src/risk/settings');

  const defaults = await loadRiskSettings();
  assert.equal(defaults.riskPctPerTrade, 1.0);
  assert.equal(defaults.dailyLossCapPct, 5.0);
  assert.equal(defaults.maxConcurrentPositions, 2);
  assert.equal(defaults.consecutiveLossLimit, 3);

  const updated = await saveRiskSettings({ riskPctPerTrade: 0.5 });
  assert.equal(updated.riskPctPerTrade, 0.5);
  assert.equal(updated.dailyLossCapPct, 5.0, 'untouched keys survive a partial patch');

  assert.equal((await loadRiskSettings()).riskPctPerTrade, 0.5, 'the change persists');
});

test('currentTradingDay is a UTC calendar date', async (t) => {
  await migrated(t);
  const { currentTradingDay } = require('../src/risk/state');
  assert.match(currentTradingDay(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(currentTradingDay(new Date('2026-03-15T23:30:00Z')), '2026-03-15');
  assert.equal(currentTradingDay(new Date('2026-03-16T00:30:00Z')), '2026-03-16');
});
