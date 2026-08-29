const { query } = require('../db/pool');
const { sizePosition } = require('./sizing');
const { loadRiskSettings } = require('./settings');
const { getState, currentTradingDay } = require('./state');

/**
 * Runs every risk gate over a candidate signal.
 *
 * All gates are evaluated even after one fails. A decision that short-circuits
 * hides the other problems, and when something goes wrong unattended the full
 * picture is what makes it diagnosable.
 */

async function newsConflict({ symbol, now, blackoutMinutes }) {
  const currencies = [symbol.currency_profit, symbol.currency_margin].filter(Boolean);
  if (currencies.length === 0) return null;

  const windowMs = blackoutMinutes * 60 * 1000;
  const from = new Date(now.getTime() - windowMs);
  const to = new Date(now.getTime() + windowMs);

  const rows = await query(
    `SELECT title, currency, event_time
       FROM news_events
      WHERE impact = 'HIGH'
        AND event_time BETWEEN ? AND ?
        AND currency IN (${currencies.map(() => '?').join(',')})
      ORDER BY event_time
      LIMIT 1`,
    [
      from.toISOString().slice(0, 19).replace('T', ' '),
      to.toISOString().slice(0, 19).replace('T', ' '),
      ...currencies
    ]
  );
  return rows[0] || null;
}

async function assessSignal({ signal, symbol, mode, balance, openPositions = 0, now = new Date() }) {
  const settings = await loadRiskSettings();
  const day = currentTradingDay(now);
  const state = await getState(mode, day);

  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });

  // 1. Stop loss. Not configurable, and checked before anything else.
  const hasStop = signal.sl !== null && signal.sl !== undefined && Number.isFinite(Number(signal.sl));
  add('stop_loss_present', hasStop,
    hasStop ? `stop at ${signal.sl}` : 'the signal carries no stop loss');

  // 2. Kill switch, per mode.
  const killed = state.kill_switch === 1;
  add('kill_switch', !killed,
    killed ? `kill switch is on: ${state.kill_switch_reason}` : 'kill switch is off');

  // 3. Daily realized loss against the cap.
  const realized = Number(state.realized_pnl);
  const capAmount = balance * (settings.dailyLossCapPct / 100);
  const capBreached = realized < 0 && Math.abs(realized) >= capAmount;
  add('daily_loss_cap', !capBreached,
    `realized ${realized.toFixed(2)} against a cap of ${capAmount.toFixed(2)} ` +
    `(${settings.dailyLossCapPct}% of ${balance})`);

  // 4. Concurrent positions.
  const atCap = openPositions >= settings.maxConcurrentPositions;
  add('max_concurrent_positions', !atCap,
    `${openPositions} open, limit ${settings.maxConcurrentPositions}`);

  // 5. High impact news near the entry.
  const news = await newsConflict({ symbol, now, blackoutMinutes: settings.newsBlackoutMinutes });
  add('news_blackout', !news,
    news
      ? `${news.title} (${news.currency}) within ${settings.newsBlackoutMinutes} minutes`
      : `no high impact news within ${settings.newsBlackoutMinutes} minutes`);

  // 6. Promotion. Live capital demands a strategy that finished validation.
  const promoted = mode !== 'live' || signal.strategy_status === 'live';
  add('strategy_promoted', promoted,
    mode === 'live'
      ? `strategy status is ${signal.strategy_status || 'unknown'}, live requires 'live'`
      : `${mode} mode does not require promotion`);

  // 7. Position size.
  const sized = hasStop
    ? sizePosition({ balance, riskPct: settings.riskPctPerTrade, entry: signal.entry, sl: signal.sl, symbol })
    : { lot: 0, riskAmount: 0, stopDistance: 0, rejected: true, reason: 'no stop loss on the signal' };
  add('position_size', !sized.rejected,
    sized.rejected ? sized.reason : `${sized.lot} lots risking ${sized.riskAmount.toFixed(2)}`);

  // 8. Notional exposure. Risk percentage alone does not bound position size:
  // the tighter the stop, the larger the position for the same 1% risk. This
  // caps what that can grow into.
  const notional = sized.rejected ? 0 : sized.lot * Number(symbol.contract_size) * Number(signal.entry);
  const notionalCap = balance * settings.maxNotionalMultiple;
  const overExposed = notional > notionalCap;
  add('notional_exposure', !overExposed,
    `${notional.toFixed(0)} notional against a cap of ${notionalCap.toFixed(0)} ` +
    `(${settings.maxNotionalMultiple}x equity)`);

  const denialReasons = checks.filter((c) => !c.passed).map((c) => c.detail);

  return {
    allowed: denialReasons.length === 0,
    lot: denialReasons.length === 0 ? sized.lot : 0,
    riskAmount: sized.riskAmount,
    stopDistance: sized.stopDistance,
    checks,
    denialReasons
  };
}

module.exports = { assessSignal };
