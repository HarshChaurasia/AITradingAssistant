const { query } = require('../db/pool');

const trendBreakout = require('./trend-breakout');
const meanReversion = require('./mean-reversion');

const strategies = [trendBreakout, meanReversion];

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
