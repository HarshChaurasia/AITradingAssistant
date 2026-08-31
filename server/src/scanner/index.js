const { query } = require('../db/pool');
const { countOpenPositions } = require('../signals/generator');
const { evaluateSymbolTimeframe } = require('./evaluate');
const { loadOperationsSettings } = require('../settings/operations');

/**
 * A live read of what every watched strategy/symbol pair currently sees.
 *
 * This is display only. It reads `watched` symbols, which is deliberately a
 * different flag from `enabled`: a symbol can be examined here without ever
 * becoming tradeable. Nothing is persisted, so a scanner row can never be
 * mistaken for a signal the system acted on.
 */

/**
 * Backtest evidence, indexed for O(1) lookup during a scan.
 *
 * Only the newest run per combination counts. An older failure is the history
 * of parameters that have since changed, not a second opinion on the current
 * ones.
 */
async function loadEvidence() {
  const rows = await query(
    `SELECT r.passed, r.timeframe, s.name AS strategy, sym.broker_symbol AS symbol,
            COUNT(*) OVER (PARTITION BY r.strategy_id, r.symbol_id, r.timeframe) AS runs
       FROM backtest_runs r
       JOIN strategies s ON s.id = r.strategy_id
       JOIN symbols sym  ON sym.id = r.symbol_id
       JOIN (SELECT strategy_id, symbol_id, timeframe, MAX(id) AS newest
               FROM backtest_runs GROUP BY strategy_id, symbol_id, timeframe) latest
         ON latest.newest = r.id`
  );

  const index = new Map();
  for (const row of rows) {
    index.set(`${row.strategy}|${row.symbol}|${row.timeframe}`, {
      passed: row.passed === 1,
      runs: Number(row.runs)
    });
  }
  return (strategy, symbol, timeframe) => index.get(`${strategy}|${symbol}|${timeframe}`) || null;
}

async function scanWatchlist({
  mode = 'demo',
  timeframe = null,
  balance = Number(process.env.ACCOUNT_BALANCE_HINT || 10000),
  now = new Date()
} = {}) {
  const settings = await loadOperationsSettings();
  const activeTimeframe = timeframe || settings.tradedTimeframes[0];

  const strategyRows = await query('SELECT * FROM strategies WHERE superseded_at IS NULL ORDER BY name');
  const symbols = await query(
    'SELECT * FROM symbols WHERE watched = 1 OR enabled = 1 ORDER BY broker_symbol'
  );

  const openPositions = await countOpenPositions(mode);
  const evidenceFor = await loadEvidence();
  const rows = [];

  for (const symbol of symbols) {
    rows.push(await evaluateSymbolTimeframe({
      symbol, timeframe: activeTimeframe, strategyRows, mode, balance, openPositions, evidenceFor, now
    }));
  }

  return {
    at: new Date().toISOString(),
    mode,
    timeframe: activeTimeframe,
    // Which timeframes the scheduler actually acts on. Reporting them lets the
    // UI avoid claiming a setup on any other will be taken automatically.
    tradedTimeframes: settings.tradedTimeframes,
    balance,
    rows
  };
}

module.exports = { scanWatchlist, loadEvidence };
