const path = require('path');

const { runBacktest } = require('../../server/src/backtest/engine');
const { computeMetrics } = require('../../server/src/backtest/metrics');
const { COSTS, SYMBOL, getCase, candlesFor, windowFor } = require('../cases');

/**
 * The eval's single entry point into the existing backtest engine.
 *
 * It deliberately reuses server/src/backtest verbatim rather than
 * reimplementing a simpler replay: the next-bar fill, the stop-before-target
 * rule and the shared position sizing are the reason a result here means
 * anything, and a second engine written for the eval would quietly disagree
 * with the one the system actually trades on.
 *
 * Strategies are required by path rather than through the registry, because
 * the registry opens a MySQL pool. Nothing in this eval touches a database.
 */

const STARTING_BALANCE = 10000;
const RISK_PCT = 1;

function loadStrategy(name) {
  const allowed = [
    'trend-breakout', 'mean-reversion', 'macd-trend',
    'bollinger-squeeze', 'supertrend', 'ma-crossover'
  ];
  if (!allowed.includes(name)) {
    throw new Error(`unknown strategy: ${name} (available: ${allowed.join(', ')})`);
  }
  return require(path.join(__dirname, '..', '..', 'server', 'src', 'strategies', name));
}

/**
 * Run one backtest over a case.
 *
 * `costModel` defaults to the case's own model. Passing 'zero' is what lets a
 * caller ask "is this profitable only because I did not charge for it?" -
 * which is the whole cost-trap question.
 */
function backtestSeries({ candles, strategyName, params = {}, window = 'out_of_sample', costs }) {
  const strategy = loadStrategy(strategyName);
  const { tradeFrom, tradeTo } = windowFor(window);

  const { trades } = runBacktest({
    candles,
    strategy,
    params,
    symbol: SYMBOL,
    options: {
      startingBalance: STARTING_BALANCE,
      riskPctPerTrade: RISK_PCT,
      maxConcurrentPositions: 1,
      tradeFrom,
      tradeTo,
      ...costs
    }
  });

  const metrics = computeMetrics(trades, { startingBalance: STARTING_BALANCE });

  return {
    window,
    params: { ...strategy.defaultParams, ...params },
    trades: metrics.trades,
    netProfit: round(metrics.netProfit),
    returnPct: round((metrics.netProfit / STARTING_BALANCE) * 100),
    winRatePct: round(metrics.winRatePct),
    profitFactor: Number.isFinite(metrics.profitFactor) ? round(metrics.profitFactor) : null,
    expectancy: round(metrics.expectancy),
    maxDrawdownPct: round(metrics.maxDrawdownPct),
    sharpe: round(metrics.sharpe, 4)
  };
}

/**
 * Run one backtest over a case.
 *
 * `costModel` defaults to the case's own model. Passing 'zero' is what lets a
 * caller ask "is this profitable only because I did not charge for it?" -
 * which is the whole cost-trap question.
 */
function backtestCase({ caseId, strategyName, params = {}, window = 'out_of_sample', costModel = null }) {
  const testCase = getCase(caseId);
  const costs = COSTS[costModel || testCase.costs];
  if (!costs) throw new Error(`unknown cost model: ${costModel}`);

  return {
    caseId,
    strategy: strategyName || testCase.strategy,
    costModel: costModel || testCase.costs,
    ...backtestSeries({
      candles: candlesFor(caseId),
      strategyName: strategyName || testCase.strategy,
      params,
      window,
      costs
    })
  };
}

function round(n, dp = 2) {
  return Number.isFinite(n) ? Number(n.toFixed(dp)) : 0;
}

module.exports = { backtestCase, backtestSeries, loadStrategy, STARTING_BALANCE, RISK_PCT };
