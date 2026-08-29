const { query } = require('../db/pool');
const { getCandles } = require('../market/candles');
const { getStrategy, mergeParams } = require('../strategies/registry');
const { assessSignal } = require('../risk/engine');
const { countOpenPositions } = require('../signals/generator');

/**
 * A live read of what every watched strategy/symbol pair currently sees.
 *
 * This is display only. It reads `watched` symbols, which is deliberately a
 * different flag from `enabled`: a symbol can be examined here without ever
 * becoming tradeable. Nothing is persisted, so a scanner row can never be
 * mistaken for a signal the system acted on.
 *
 * Like the generator, it evaluates the last CLOSED bar. Reading the forming
 * bar would show a setup that can still evaporate before the bar ends.
 */

const HISTORY_BARS = 500;

async function scanWatchlist({
  mode = 'demo',
  timeframe = process.env.STRATEGY_TIMEFRAME || 'H1',
  balance = Number(process.env.ACCOUNT_BALANCE_HINT || 10000),
  now = new Date()
} = {}) {
  const strategies = await query('SELECT * FROM strategies ORDER BY name');
  const symbols = await query(
    'SELECT * FROM symbols WHERE watched = 1 OR enabled = 1 ORDER BY broker_symbol'
  );

  const openPositions = await countOpenPositions(mode);
  const rows = [];

  for (const symbol of symbols) {
    const candles = await getCandles({ symbolId: symbol.id, timeframe, limit: HISTORY_BARS });

    if (candles.length < 2) {
      rows.push({
        symbolId: symbol.id,
        symbol: symbol.broker_symbol,
        tradeable: symbol.enabled === 1,
        // The symbol's own precision. Formatting EURUSD to 2dp renders 1.16
        // for every price it will ever have, which tells the operator nothing.
        digits: symbol.digits,
        timeframe,
        price: null,
        barTime: null,
        strategies: [],
        note: `no ${timeframe} candles stored - backfill this symbol first`
      });
      continue;
    }

    const index = candles.length - 2;
    const bar = candles[index];

    const perStrategy = [];
    for (const strategyRow of strategies) {
      let strategy;
      try {
        strategy = getStrategy(strategyRow.name);
      } catch {
        continue; // Registered in the database but no longer shipped in code.
      }
      if (typeof strategy.explain !== 'function') continue;

      const params = mergeParams(strategy, strategyRow.params);
      const context = strategy.prepare(candles, params);
      const explained = strategy.explain(candles, index, params, context);

      const entry = {
        strategy: strategy.name,
        status: strategyRow.status,
        strategyEnabled: strategyRow.enabled === 1,
        firing: explained.firing,
        side: explained.side,
        reason: explained.reason,
        checks: explained.checks,
        features: explained.features,
        risk: null
      };

      // Only a firing setup has levels to size, so only then is there anything
      // for the risk engine to judge.
      if (explained.firing) {
        const signal = strategy.evaluate(candles, index, params, context);
        if (signal) {
          const decision = await assessSignal({
            signal: { ...signal, symbol_id: symbol.id, strategy_status: strategyRow.status },
            symbol,
            mode,
            balance,
            openPositions,
            now
          });
          entry.levels = { entry: signal.entry, sl: signal.sl, tp: signal.tp };
          entry.risk = {
            allowed: decision.allowed,
            lot: decision.lot,
            riskAmount: decision.riskAmount,
            checks: decision.checks,
            denialReasons: decision.denialReasons
          };
          // A watched-but-not-tradeable symbol is the commonest reason a
          // perfectly good setup goes nowhere. Say so plainly rather than
          // leaving the operator to infer it.
          entry.wouldTrade = decision.allowed && symbol.enabled === 1;
          if (decision.allowed && symbol.enabled !== 1) {
            entry.blockedBy = 'symbol is watched but not enabled for trading';
          } else if (!decision.allowed) {
            entry.blockedBy = decision.denialReasons[0];
          }
        }
      }

      perStrategy.push(entry);
    }

    rows.push({
      symbolId: symbol.id,
      symbol: symbol.broker_symbol,
      tradeable: symbol.enabled === 1,
      digits: symbol.digits,
      timeframe,
      price: bar.close,
      barTime: bar.open_time,
      strategies: perStrategy,
      note: null
    });
  }

  return {
    at: new Date().toISOString(),
    mode,
    timeframe,
    // The scheduler evaluates exactly one timeframe. Reporting it lets the UI
    // avoid claiming a setup on any other will be taken automatically.
    tradedTimeframe: process.env.STRATEGY_TIMEFRAME || 'H1',
    balance,
    rows
  };
}

module.exports = { scanWatchlist };
