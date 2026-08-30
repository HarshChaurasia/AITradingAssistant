const { query } = require('../db/pool');

const trendBreakout = require('./trend-breakout');
const meanReversion = require('./mean-reversion');
const macdTrend = require('./macd-trend');
const bollingerSqueeze = require('./bollinger-squeeze');
const superTrendFlip = require('./supertrend');
const maCrossover = require('./ma-crossover');
const smartMoney = require('./smart-money');
const liquiditySweep = require('./liquidity-sweep');
const rsiDivergence = require('./rsi-divergence');

const strategies = [
  trendBreakout,
  meanReversion,
  macdTrend,
  bollingerSqueeze,
  superTrendFlip,
  // Market structure: a break of structure followed by a retrace into the
  // imbalance the move left behind.
  smartMoney,
  // The mirror image of trend-breakout: it buys the FAILURE of a break. Added
  // deliberately - the existing book all fires long together, and correlated
  // agreement is what turned one adverse move into seven simultaneous losers.
  liquiditySweep,
  // Buys exhaustion rather than strength, which is a different family again.
  rsiDivergence,
  // A deliberate baseline. If a more elaborate strategy cannot beat the oldest
  // trend rule there is, the elaboration is not earning its complexity.
  maCrossover
];

function getStrategy(name) {
  const found = strategies.find((s) => s.name === name);
  if (!found) {
    throw new Error(`unknown strategy: ${name} (available: ${strategies.map((s) => s.name).join(', ')})`);
  }
  return found;
}

function mergeParams(strategy, overrides) {
  return { ...strategy.defaultParams, ...(overrides || {}) };
}

/**
 * Upsert each shipped strategy into the strategies table.
 * status is intentionally not updated: promotion draft -> backtested -> demo
 * -> live is a deliberate act, never a side effect of a server restart.
 */
async function registerStrategies() {
  for (const s of strategies) {
    await query(
      `INSERT INTO strategies (name, version, params, status, enabled, created_at)
       VALUES (?, ?, CAST(? AS JSON), 'draft', 0, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE params = VALUES(params)`,
      [s.name, s.version, JSON.stringify(s.defaultParams)]
    );
  }
  return query('SELECT * FROM strategies ORDER BY name');
}

async function listStrategies() {
  return query('SELECT * FROM strategies ORDER BY name');
}

module.exports = { strategies, getStrategy, mergeParams, registerStrategies, listStrategies };
