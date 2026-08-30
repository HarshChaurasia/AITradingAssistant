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
  // The timeframes the scheduler generates signals on. More than one is
  // allowed so their results can be compared side by side - but each is a
  // separate stream of trades against the same account, so the concurrent
  // position limit and the daily loss cap are what stop three timeframes
  // becoming three times the risk.
  tradedTimeframes: ['H4'],
  // Timeframes the opportunity scan sweeps. Observation only.
  scanTimeframes: ['H1', 'H4', 'D1'],
  // Telegram when a tradeable setup appears in the scan.
  scannerAlertsEnabled: true,
  // One message per setup per this many minutes. Without it, a setup that
  // persists for a whole session sends a message every scan.
  alertCooldownMinutes: 60,
  // How long a signal stays actionable before the scheduler expires it.
  //
  // 'proportional' scales it to the bar: a signal is priced at its bar's
  // close, and the longer it sits the further price has drifted from the
  // level the strategy actually judged. Ten percent of an H4 bar is 24
  // minutes; of an M15 bar, 90 seconds - so a floor keeps it above a couple
  // of scheduler ticks, or a signal would expire before the loop could act
  // on it.
  signalExpiryMode: 'proportional',
  signalExpiryPct: 10,
  signalExpiryMinMinutes: 5,
  // Used when the mode is 'fixed'.
  signalExpiryMinutes: 60,
  // Bars pulled when a backtest finds nothing stored.
  backfillBars: 2000,
  // How long without a quote before an instrument counts as shut. An open
  // market ticks constantly: measured on this account, BTCUSD was 1 second
  // stale on a Sunday while EURUSD was 38 hours stale. Ten minutes sits far
  // from both.
  staleTickSeconds: 600,
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

const TIMEFRAME_MINUTES = { M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

/**
 * How long a signal on this timeframe stays actionable.
 *
 * A signal is priced at its bar's close. The longer it sits unexecuted the
 * further price has drifted from the level the strategy actually judged, and
 * an hour-old M5 signal is a fiction. Scaling to the bar keeps that drift
 * proportionate - with a floor, because the scheduler only ticks once a
 * minute and a signal that expires between ticks can never be acted on.
 */
function expiryMinutesFor(timeframe, settings) {
  if (settings.signalExpiryMode === 'fixed') return settings.signalExpiryMinutes;

  const barMinutes = TIMEFRAME_MINUTES[timeframe] || 60;
  const proportional = Math.ceil(barMinutes * (settings.signalExpiryPct / 100));
  // Never longer than the bar itself: by then the next bar has closed and the
  // strategy has had a fresh opportunity to say something.
  return Math.min(Math.max(proportional, settings.signalExpiryMinMinutes), barMinutes);
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

  // Accept a bare string for the traded timeframes: that is the shape the
  // setting had before it became a list, and a stored value from then must
  // not read back as "no timeframes" and silently stop the loop trading.
  const rawTraded = typeof merged.tradedTimeframes === 'string'
    ? [merged.tradedTimeframes]
    : merged.tradedTimeframes;
  const tradedTimeframes = Array.isArray(rawTraded)
    ? rawTraded.filter((tf) => TIMEFRAMES.includes(tf))
    : DEFAULTS.tradedTimeframes;

  return {
    autoTradeEnabled: coerceBoolean(merged.autoTradeEnabled, DEFAULTS.autoTradeEnabled),
    autoTradeLive: coerceBoolean(merged.autoTradeLive, DEFAULTS.autoTradeLive),
    tradedTimeframes: tradedTimeframes.length ? tradedTimeframes : DEFAULTS.tradedTimeframes,
    scanTimeframes: scanTimeframes.length ? scanTimeframes : DEFAULTS.scanTimeframes,
    scannerAlertsEnabled: coerceBoolean(merged.scannerAlertsEnabled, DEFAULTS.scannerAlertsEnabled),
    alertCooldownMinutes: coerceInteger(merged.alertCooldownMinutes, DEFAULTS.alertCooldownMinutes, { min: 1, max: 1440 }),
    signalExpiryMode: merged.signalExpiryMode === 'fixed' ? 'fixed' : 'proportional',
    signalExpiryPct: coerceInteger(merged.signalExpiryPct, DEFAULTS.signalExpiryPct, { min: 1, max: 100 }),
    signalExpiryMinMinutes: coerceInteger(merged.signalExpiryMinMinutes, DEFAULTS.signalExpiryMinMinutes, { min: 2, max: 1440 }),
    signalExpiryMinutes: coerceInteger(merged.signalExpiryMinutes, DEFAULTS.signalExpiryMinutes, { min: 5, max: 10080 }),
    backfillBars: coerceInteger(merged.backfillBars, DEFAULTS.backfillBars, { min: 100, max: 20000 }),
    staleTickSeconds: coerceInteger(merged.staleTickSeconds, DEFAULTS.staleTickSeconds, { min: 60, max: 86400 }),
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
  expiryMinutesFor,
  TIMEFRAME_MINUTES,
  DEFAULT_OPERATIONS_SETTINGS: DEFAULTS,
  TIMEFRAMES
};
