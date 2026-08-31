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
const microBreakout = require('./micro-breakout');
const stretchFade = require('./stretch-fade');

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
  // Scalps. Held for minutes, closed on a time stop whether or not price has
  // reached a level, and restricted to timeframes where the spread leaves room
  // to work - measured, not assumed.
  microBreakout,
  stretchFade,
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
      `INSERT INTO strategies (name, version, kind, params, status, enabled, created_at)
       VALUES (?, ?, ?, CAST(? AS JSON), 'draft', 0, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE params = VALUES(params), kind = VALUES(kind)`,
      [s.name, s.version, s.kind || 'swing', JSON.stringify(s.defaultParams)]
    );
  }
  // Retire older versions of anything shipped here.
  //
  // Bumping a version writes a NEW row, and the previous one would otherwise
  // stay enabled - running today's code against yesterday's stored parameters,
  // because mergeParams lets the stored values win. The row itself stays:
  // every signal and backtest run it produced points at that id, and that
  // history is the only record of what the parameters were at the time.
  for (const s of strategies) {
    await query(
      `UPDATE strategies SET enabled = 0, superseded_at = UTC_TIMESTAMP()
        WHERE name = ? AND version <> ? AND superseded_at IS NULL`,
      [s.name, s.version]
    );
  }

  return listStrategies();
}

/**
 * The strategies currently shipped.
 *
 * Superseded versions are excluded: two rows named trend-breakout in a
 * dropdown is an invitation to run the wrong one. Analytics groups by NAME
 * rather than id, so a strategy's record survives its own retuning.
 */
async function listStrategies() {
  return query('SELECT * FROM strategies WHERE superseded_at IS NULL ORDER BY name');
}

module.exports = { strategies, getStrategy, mergeParams, registerStrategies, listStrategies };
