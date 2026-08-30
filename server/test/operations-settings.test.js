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
  assert.deepEqual(settings.tradedTimeframes, ['H4']);
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

  assert.deepEqual(normalise({ tradedTimeframes: ['H7'] }).tradedTimeframes, ['H4']);
  assert.deepEqual(normalise({ tradedTimeframes: ['H1', 'nope'] }).tradedTimeframes, ['H1']);
  assert.deepEqual(normalise({ scanTimeframes: ['H1', 'nope'] }).scanTimeframes, ['H1']);
  assert.deepEqual(
    normalise({ scanTimeframes: [] }).scanTimeframes,
    ['H1', 'H4', 'D1'],
    'an empty list would silently disable the scan'
  );
  assert.deepEqual(
    normalise({ tradedTimeframes: [] }).tradedTimeframes,
    ['H4'],
    'an empty list would silently stop the loop trading'
  );
});

test('a traded timeframe stored as a bare string still reads as a list', () => {
  // The setting was a single string before it became a list. A value saved
  // then must not read back as "no timeframes" and quietly stop the loop.
  const { normalise } = require('../src/settings/operations');
  assert.deepEqual(normalise({ tradedTimeframes: 'H1' }).tradedTimeframes, ['H1']);
});

test('several traded timeframes are kept, in the order chosen', () => {
  const { normalise } = require('../src/settings/operations');
  assert.deepEqual(
    normalise({ tradedTimeframes: ['M15', 'H1', 'H4'] }).tradedTimeframes,
    ['M15', 'H1', 'H4']
  );
});

test('expiry scales to the bar, with a floor and a ceiling', () => {
  const { normalise, expiryMinutesFor } = require('../src/settings/operations');
  const settings = normalise({});

  // Ten percent of an H4 bar. A signal is priced at its bar's close, so the
  // longer it sits the further price has drifted from what was judged.
  assert.equal(expiryMinutesFor('H4', settings), 24);
  assert.equal(expiryMinutesFor('D1', settings), 144);

  // The floor: the scheduler ticks once a minute, so 10% of an M15 bar - 90
  // seconds - would expire before the loop could act on it.
  assert.equal(expiryMinutesFor('M15', settings), 5);
  assert.equal(expiryMinutesFor('M5', settings), 5);

  // The ceiling is the bar itself: past that the next bar has closed and the
  // strategy has had a fresh say.
  const generous = normalise({ signalExpiryPct: 100, signalExpiryMinMinutes: 600 });
  assert.equal(expiryMinutesFor('M15', generous), 15);
});

test('fixed mode ignores the timeframe entirely', () => {
  const { normalise, expiryMinutesFor } = require('../src/settings/operations');
  const settings = normalise({ signalExpiryMode: 'fixed', signalExpiryMinutes: 45 });

  assert.equal(expiryMinutesFor('M5', settings), 45);
  assert.equal(expiryMinutesFor('D1', settings), 45);
});

test('checkbox strings from a form body are read as booleans', () => {
  const { normalise } = require('../src/settings/operations');
  assert.equal(normalise({ autoTradeEnabled: 'true' }).autoTradeEnabled, true);
  assert.equal(normalise({ autoTradeEnabled: 'false' }).autoTradeEnabled, false);
});
