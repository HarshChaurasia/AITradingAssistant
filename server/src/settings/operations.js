const { query } = require('../db/pool');

/**
 * Operational settings: the switches an operator turns without a redeploy.
 *
 * Risk limits live in risk/settings.js and stay there - those are the numbers
 * that decide how much money a mistake costs, and they have their own audit
 * story. This file is the "how does the loop behave" half: what it evaluates,
 * whether it acts on its own, and what it tells you about.
 *
 * Every value is read fresh on each scheduler tick, so a change in the
 * dashboard takes effect within a minute without restarting anything.
 */

const SETTING_KEY = 'operations';

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

const DEFAULTS = {
  // The moment a signal passes every risk gate, send the order. Off by
  // default: an operator has to choose to hand over the trigger.
  autoTradeEnabled: false,
  // Auto-trading on a live account is a second, separate decision. The
  // bridge's MT5_ALLOW_LIVE guard still applies on top of this.
  autoTradeLive: false,
  // The timeframe the scheduler generates signals on. Trading a timeframe the
  // backtest never covered is running an unvalidated strategy.
  tradedTimeframe: 'H4',
  // Timeframes the opportunity scan sweeps. Observation only.
  scanTimeframes: ['H1', 'H4', 'D1'],
  // Telegram when a tradeable setup appears in the scan.
  scannerAlertsEnabled: true,
  // One message per setup per this many minutes. Without it, a setup that
  // persists for a whole session sends a message every scan.
  alertCooldownMinutes: 60,
  // How long a signal stays actionable before the scheduler expires it.
  signalExpiryMinutes: 60,
  // Bars pulled when a backtest finds nothing stored.
  backfillBars: 2000,
  // Where the risk engine's account size comes from. 'broker' asks MT5 and
  // falls back to the hint if the terminal is unreachable.
  balanceSource: 'broker'
};

function coerceBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function coerceInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function coerceTimeframe(value, fallback) {
  return TIMEFRAMES.includes(value) ? value : fallback;
}

/**
 * Unknown keys are dropped rather than stored.
 *
 * A typo'd key that persists reads back as a setting the operator believes is
 * in force, and nothing in the system will ever consult it.
 */
function normalise(raw = {}) {
  const merged = { ...DEFAULTS, ...raw };

  const scanTimeframes = Array.isArray(merged.scanTimeframes)
    ? merged.scanTimeframes.filter((tf) => TIMEFRAMES.includes(tf))
    : DEFAULTS.scanTimeframes;

  return {
    autoTradeEnabled: coerceBoolean(merged.autoTradeEnabled, DEFAULTS.autoTradeEnabled),
    autoTradeLive: coerceBoolean(merged.autoTradeLive, DEFAULTS.autoTradeLive),
    tradedTimeframe: coerceTimeframe(merged.tradedTimeframe, DEFAULTS.tradedTimeframe),
    scanTimeframes: scanTimeframes.length ? scanTimeframes : DEFAULTS.scanTimeframes,
    scannerAlertsEnabled: coerceBoolean(merged.scannerAlertsEnabled, DEFAULTS.scannerAlertsEnabled),
    alertCooldownMinutes: coerceInteger(merged.alertCooldownMinutes, DEFAULTS.alertCooldownMinutes, { min: 1, max: 1440 }),
    signalExpiryMinutes: coerceInteger(merged.signalExpiryMinutes, DEFAULTS.signalExpiryMinutes, { min: 5, max: 10080 }),
    backfillBars: coerceInteger(merged.backfillBars, DEFAULTS.backfillBars, { min: 100, max: 20000 }),
    balanceSource: merged.balanceSource === 'hint' ? 'hint' : 'broker'
  };
}

async function loadOperationsSettings() {
  const rows = await query('SELECT setting_value FROM settings WHERE setting_key = ?', [SETTING_KEY]);
  return normalise(rows.length ? rows[0].setting_value : {});
}

async function saveOperationsSettings(patch) {
  const merged = normalise({ ...(await loadOperationsSettings()), ...(patch || {}) });
  await query(
    `INSERT INTO settings (setting_key, setting_value, updated_at)
     VALUES (?, CAST(? AS JSON), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = UTC_TIMESTAMP()`,
    [SETTING_KEY, JSON.stringify(merged)]
  );
  return merged;
}

module.exports = {
  loadOperationsSettings,
  saveOperationsSettings,
  normalise,
  DEFAULT_OPERATIONS_SETTINGS: DEFAULTS,
  TIMEFRAMES
};
