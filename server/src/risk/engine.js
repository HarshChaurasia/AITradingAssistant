const { query } = require('../db/pool');
const { sizePosition } = require('./sizing');
const { loadRiskSettings } = require('./settings');
const { getState, currentTradingDay } = require('./state');
const { marketStatus } = require('../market/market-hours');
const { eventsNear } = require('../news/calendar');
const { TIMEFRAME_MINUTES } = require('../settings/operations');

/**
 * Runs every risk gate over a candidate signal.
 *
 * All gates are evaluated even after one fails. A decision that short-circuits
 * hides the other problems, and when something goes wrong unattended the full
 * picture is what makes it diagnosable.
 */

/**
 * How far a high-impact event reaches, for the timeframe being traded.
 *
 * A flat fifteen minutes treated an M5 scalp and an H4 swing identically,
 * which is wrong in both directions: too wide for one, far too narrow for the
 * other. A signal on a four-hour bar is a claim about the next several hours,
 * so an event inside that horizon is squarely its problem.
 */
function blackoutMinutesFor(timeframe, settings) {
  const barMinutes = TIMEFRAME_MINUTES[timeframe] || 60;
  const scaled = barMinutes * settings.newsBlackoutBarFraction;
  return Math.min(
    Math.max(scaled, settings.newsBlackoutMinutes),
    settings.newsBlackoutMaxMinutes
  );
}

async function newsConflict({ symbol, now, blackoutMinutes, minImpact = 'HIGH' }) {
  const currencies = [symbol.currency_profit, symbol.currency_margin].filter(Boolean);
  if (currencies.length === 0) return null;

  const rows = await eventsNear({
    currencies, at: now, withinMinutes: blackoutMinutes, minImpact
  });
  return rows[0] || null;
}

/**
 * Open positions in one instrument, counted from the journal.
 *
 * Counted per symbol rather than per strategy on purpose: the account's
 * exposure does not care which strategy had the idea.
 */
async function openPositionsForSymbol({ symbolId, mode }) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM trades
      WHERE mode = ? AND symbol_id = ? AND status IN ('OPEN', 'PENDING')`,
    [mode, symbolId]
  );
  return Number(rows[0].n);
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

  // 5. High impact news near the entry, scaled to the timeframe.
  //
  // Worth knowing when reading this: until the calendar ingest was added this
  // gate had never blocked a single trade, because news_events was empty. It
  // reported "no high impact news" for every signal ever assessed, which was
  // true only in the sense that an empty table contains no events.
  const timeframe = signal.timeframe || null;
  const blackoutMinutes = blackoutMinutesFor(timeframe, settings);
  const news = await newsConflict({
    symbol, now, blackoutMinutes, minImpact: settings.newsBlackoutMinImpact
  });
  add('news_blackout', !news,
    news
      ? `${news.title} (${news.currency}) at ${new Date(news.event_time).toISOString().slice(11, 16)} UTC, within the ${Math.round(blackoutMinutes)}-minute window for ${timeframe || 'this timeframe'}`
      : `no ${settings.newsBlackoutMinImpact.toLowerCase()}-impact event within ${Math.round(blackoutMinutes)} minutes${timeframe ? ` (scaled to ${timeframe})` : ''}`);

  // 6. Promotion. Live capital demands a strategy that finished validation.
  const promoted = mode !== 'live' || signal.strategy_status === 'live';
  add('strategy_promoted', promoted,
    mode === 'live'
      ? `strategy status is ${signal.strategy_status || 'unknown'}, live requires 'live'`
      : `${mode} mode does not require promotion`);

  // 7. Is the market actually open?
  //
  // A signal on a shut market is not merely useless - the broker rejects the
  // order, the rejection looks like a bug, and on a Monday morning it can fill
  // at a gap nobody sized for. The broker decides; there is no hardcoded
  // weekend rule, because BTCUSD trades straight through it and several
  // instruments close early on Friday.
  //
  // Backtests are exempt: they replay history, where "is the market open now"
  // is not a question that has a meaning.
  if (mode === 'backtest') {
    add('market_open', true, 'backtests replay history; market hours do not apply');
  } else {
    const market = marketStatus({ symbol, now });
    add('market_open', market.open, market.reason);
  }

  // 8. How much of this one instrument is already open?
  //
  // Six strategies over five timeframes read the same candles, so a real move
  // fires most of them at once and they arrive as near-identical orders
  // seconds apart. Without this gate that is one idea expressed five times,
  // at five times the risk, on a single instrument.
  const perSymbolLimit = settings.maxPositionsPerSymbol;
  const sameSymbolOpen = mode === 'backtest'
    ? 0
    : await openPositionsForSymbol({ symbolId: symbol.id, mode });
  const symbolAtCap = sameSymbolOpen >= perSymbolLimit;
  add('positions_per_symbol', !symbolAtCap,
    `${sameSymbolOpen} open on ${symbol.broker_symbol}, limit ${perSymbolLimit}`);

  // 9. Position size.
  const sized = hasStop
    ? sizePosition({ balance, riskPct: settings.riskPctPerTrade, entry: signal.entry, sl: signal.sl, symbol })
    : { lot: 0, riskAmount: 0, stopDistance: 0, rejected: true, reason: 'no stop loss on the signal' };
  add('position_size', !sized.rejected,
    sized.rejected ? sized.reason : `${sized.lot} lots risking ${sized.riskAmount.toFixed(2)}`);

  // 10. Notional exposure. Risk percentage alone does not bound position size:
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

module.exports = { assessSignal, blackoutMinutesFor };
