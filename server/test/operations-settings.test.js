require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_opsettings_test';

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });
}

test('the defaults never auto-trade', async (t) => {
  await seeded(t);
  const { loadOperationsSettings } = require('../src/settings/operations');
  const settings = await loadOperationsSettings();

  // Handing the trigger over is a decision an operator makes explicitly. A
  // fresh install that trades on its own is a fresh install nobody chose.
  assert.equal(settings.autoTradeEnabled, false);
  assert.equal(settings.autoTradeLive, false);
  assert.equal(settings.tradedTimeframe, 'H4');
});

test('a partial patch leaves the other settings alone', async (t) => {
  await seeded(t);
  const { loadOperationsSettings, saveOperationsSettings } = require('../src/settings/operations');

  await saveOperationsSettings({ autoTradeEnabled: true });
  const after = await loadOperationsSettings();

  assert.equal(after.autoTradeEnabled, true);
  assert.equal(after.alertCooldownMinutes, 60, 'untouched settings keep their value');
});

test('an unknown key is dropped rather than stored', async (t) => {
  await seeded(t);
  const { saveOperationsSettings } = require('../src/settings/operations');

  // A typo'd key that persists reads back as a setting the operator believes
  // is in force, and nothing will ever consult it.
  const saved = await saveOperationsSettings({ autoTradeEnabledd: true, riskPctPerTrade: 99 });
  assert.equal(saved.autoTradeEnabledd, undefined);
  assert.equal(saved.riskPctPerTrade, undefined);
  assert.equal(saved.autoTradeEnabled, false);
});

test('out-of-range numbers are clamped, not accepted', () => {
  const { normalise } = require('../src/settings/operations');

  assert.equal(normalise({ alertCooldownMinutes: -5 }).alertCooldownMinutes, 1);
  assert.equal(normalise({ alertCooldownMinutes: 99999 }).alertCooldownMinutes, 1440);
  assert.equal(normalise({ backfillBars: 1 }).backfillBars, 100);
});

test('a nonsense timeframe falls back rather than reaching the scheduler', () => {
  const { normalise } = require('../src/settings/operations');

  assert.equal(normalise({ tradedTimeframe: 'H7' }).tradedTimeframe, 'H4');
  assert.deepEqual(normalise({ scanTimeframes: ['H1', 'nope'] }).scanTimeframes, ['H1']);
  assert.deepEqual(
    normalise({ scanTimeframes: [] }).scanTimeframes,
    ['H1', 'H4', 'D1'],
    'an empty list would silently disable the scan'
  );
});

test('checkbox strings from a form body are read as booleans', () => {
  const { normalise } = require('../src/settings/operations');
  assert.equal(normalise({ autoTradeEnabled: 'true' }).autoTradeEnabled, true);
  assert.equal(normalise({ autoTradeEnabled: 'false' }).autoTradeEnabled, false);
});
