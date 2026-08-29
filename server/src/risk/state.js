const { query } = require('../db/pool');
const { loadRiskSettings } = require('./settings');
const { alertKillSwitch } = require('../alerts/events');

function currentTradingDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function getState(mode, day = currentTradingDay()) {
  await query(
    `INSERT INTO risk_state (trading_day, mode, updated_at)
     VALUES (?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
    [day, mode]
  );
  const rows = await query(
    'SELECT * FROM risk_state WHERE trading_day = ? AND mode = ?',
    [day, mode]
  );
  return rows[0];
}

async function recordTradeResult({ mode, pnl, day = currentTradingDay() }) {
  const settings = await loadRiskSettings();
  const state = await getState(mode, day);

  const isLoss = Number(pnl) < 0;
  const consecutive = isLoss ? state.consecutive_losses + 1 : 0;
  const shouldTrip = consecutive >= settings.consecutiveLossLimit;

  await query(
    `UPDATE risk_state
        SET realized_pnl = realized_pnl + ?,
            trades_count = trades_count + 1,
            consecutive_losses = ?,
            kill_switch = CASE WHEN ? THEN 1 ELSE kill_switch END,
            kill_switch_reason = CASE WHEN ? THEN ? ELSE kill_switch_reason END,
            updated_at = UTC_TIMESTAMP()
      WHERE trading_day = ? AND mode = ?`,
    [
      Number(pnl),
      consecutive,
      shouldTrip ? 1 : 0,
      shouldTrip ? 1 : 0,
      `${consecutive} consecutive losses reached the limit of ${settings.consecutiveLossLimit}`,
      day,
      mode
    ]
  );

  // Fire and forget: the caller is in the trading path and must not wait on,
  // or be broken by, a notification.
  if (shouldTrip && state.kill_switch !== 1) {
    const reason = `${consecutive} consecutive losses reached the limit of ${settings.consecutiveLossLimit}`;
    alertKillSwitch({ mode, reason }).catch(() => {});
  }

  return getState(mode, day);
}

async function tripKillSwitch({ mode, reason, day = currentTradingDay() }) {
  await getState(mode, day);
  await query(
    `UPDATE risk_state
        SET kill_switch = 1, kill_switch_reason = ?, updated_at = UTC_TIMESTAMP()
      WHERE trading_day = ? AND mode = ?`,
    [reason, day, mode]
  );
  alertKillSwitch({ mode, reason }).catch(() => {});
  return getState(mode, day);
}

/**
 * Manual only. The switch trips by itself but never clears by itself: an
 * automatic reset would let a broken strategy resume unsupervised, which is
 * precisely the failure the switch exists to prevent.
 */
async function resetKillSwitch({ mode, day = currentTradingDay() }) {
  await getState(mode, day);
  await query(
    `UPDATE risk_state
        SET kill_switch = 0, kill_switch_reason = NULL,
            consecutive_losses = 0, updated_at = UTC_TIMESTAMP()
      WHERE trading_day = ? AND mode = ?`,
    [day, mode]
  );
  return getState(mode, day);
}

module.exports = { getState, recordTradeResult, tripKillSwitch, resetKillSwitch, currentTradingDay };
