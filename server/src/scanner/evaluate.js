const { getCandles } = require('../market/candles');
const { getStrategy, mergeParams } = require('../strategies/registry');
const { assessSignal } = require('../risk/engine');

/**
 * Evaluate every strategy against one symbol on one timeframe.
 *
 * This is the single place that turns stored candles into "what does the
 * system see right now". Both the watchlist view and the opportunity scan go
 * through it, so the two can never drift into disagreeing about the same bar.
 *
 * Like the generator, it reads the last CLOSED bar. The forming bar shows
 * setups that can still evaporate before the bar ends.
 */

const HISTORY_BARS = 500;

/**
 * A transparent 0-100 score for ranking setups against each other.
 *
 * Deliberately not a black box: every component is returned alongside the
 * total so the operator can see what earned the number. It ranks candidates
 * within a scan - it is NOT a probability, and a high score never overrides a
 * risk gate.
 */
function scoreSetup({ explained, decision, levels, backtestEvidence }) {
  const components = [];

  const checks = explained.checks || [];
  const conditionRatio = checks.length ? checks.filter((c) => c.passed).length / checks.length : 1;
  components.push({ name: 'strategy conditions', weight: 35, ratio: conditionRatio });

  const gates = decision?.checks || [];
  const gateRatio = gates.length ? gates.filter((c) => c.passed).length / gates.length : 0;
  components.push({ name: 'risk gates', weight: 30, ratio: gateRatio });

  // Reward-to-risk, capped at 3R. Beyond that the extra distance is usually
  // an artefact of a very tight stop rather than a better trade.
  let rr = 0;
  if (levels && Number.isFinite(levels.tp)) {
    const risk = Math.abs(levels.entry - levels.sl);
    const reward = Math.abs(levels.tp - levels.entry);
    rr = risk > 0 ? Math.min(reward / risk, 3) / 3 : 0;
  }
  components.push({ name: 'reward vs risk', weight: 20, ratio: rr });

  // Evidence that this exact strategy/symbol/timeframe has ever passed a
  // walk-forward test. An untested combination scores zero here rather than
  // being penalised into oblivion - it is unproven, not disproven.
  const evidence = backtestEvidence?.passed ? 1 : (backtestEvidence?.runs ? 0.25 : 0);
  components.push({ name: 'backtest evidence', weight: 15, ratio: evidence });

  const total = components.reduce((sum, c) => sum + c.weight * c.ratio, 0);
  return { score: Math.round(total), components };
}

async function evaluateSymbolTimeframe({
  symbol,
  timeframe,
  strategyRows,
  mode = 'demo',
  balance = 10000,
  openPositions = 0,
  evidenceFor = () => null,
  now = new Date()
}) {
  const candles = await getCandles({ symbolId: symbol.id, timeframe, limit: HISTORY_BARS });

  if (candles.length < 2) {
    return {
      symbolId: symbol.id,
      symbol: symbol.broker_symbol,
      tradeable: symbol.enabled === 1,
      digits: symbol.digits,
      timeframe,
      price: null,
      barTime: null,
      strategies: [],
      note: `no ${timeframe} candles stored - backfill this symbol first`
    };
  }

  const index = candles.length - 2;
  const bar = candles[index];
  const perStrategy = [];

  for (const strategyRow of strategyRows) {
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
      risk: null,
      score: 0,
      scoreComponents: []
    };

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
        entry.wouldTrade = decision.allowed && symbol.enabled === 1;
        if (decision.allowed && symbol.enabled !== 1) {
          entry.blockedBy = 'symbol is watched but not enabled for trading';
        } else if (!decision.allowed) {
          entry.blockedBy = decision.denialReasons[0];
        }

        const evidence = evidenceFor(strategy.name, symbol.broker_symbol, timeframe);
        entry.evidence = evidence;
        const scored = scoreSetup({ explained, decision, levels: entry.levels, backtestEvidence: evidence });
        entry.score = scored.score;
        entry.scoreComponents = scored.components;
      }
    }

    perStrategy.push(entry);
  }

  return {
    symbolId: symbol.id,
    symbol: symbol.broker_symbol,
    tradeable: symbol.enabled === 1,
    digits: symbol.digits,
    timeframe,
    price: bar.close,
    barTime: bar.open_time,
    bars: candles.length,
    strategies: perStrategy,
    note: null
  };
}

module.exports = { evaluateSymbolTimeframe, scoreSetup, HISTORY_BARS };
