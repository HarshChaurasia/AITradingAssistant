const { query } = require('../db/pool');

/**
 * Which combinations have earned the right to trade.
 *
 * Promotion is a property of the COMBINATION, never of the strategy. Measured
 * over a year on this account, smart-money reaches a profit factor of 1.40 on
 * BTCUSD H1 and 0.43 on BTCUSD M5 - the same code, the same instrument, and
 * one of them is an edge while the other is a way to pay the spread. A single
 * `strategies.status` flag cannot say that, so it said the wrong thing for
 * every combination it covered.
 *
 * The parameters are pinned with the promotion. The same strategy with a
 * different stop multiple is a different bet, and promoting the name rather
 * than the numbers would let a later edit inherit evidence it never earned.
 */

/**
 * Record a study, whatever it concluded.
 *
 * Failures are kept deliberately. Knowing that macd-trend on BTCUSD M15 was
 * searched over 83 candidates and died on the holdout is what stops the same
 * search being run again next month and reported as news.
 */
async function recordStudy(result, { note = null } = {}) {
  const [strategy] = await query(
    'SELECT id FROM strategies WHERE name = ? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1',
    [result.strategyName]
  );
  if (!strategy) throw new Error(`strategy ${result.strategyName} is not registered`);

  const winner = result.winner;
  const inserted = await query(
    `INSERT INTO strategy_studies
       (strategy_id, symbol_id, timeframe, started_at, finished_at, iterations, trials,
        best_params, optimise, validate, holdout, robustness,
        validate_passed, holdout_passed, promotable, note)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?,
             CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON),
             ?, ?, ?, ?)`,
    [
      strategy.id,
      result.symbolId,
      result.timeframe,
      result.startedAt || new Date(),
      (result.iterations || []).length,
      result.trials || 0,
      JSON.stringify(winner ? winner.fullParams : null),
      JSON.stringify(winner ? winner.optimise : null),
      JSON.stringify(winner ? winner.validate : null),
      JSON.stringify(winner ? winner.holdout : null),
      JSON.stringify(result.robustness || null),
      result.validatePassed ? 1 : 0,
      result.holdoutPassed ? 1 : 0,
      result.promotable ? 1 : 0,
      note || result.reason || null
    ]
  );

  return { studyId: inserted.insertId, strategyId: strategy.id };
}

/**
 * Promote a combination on the evidence of a study.
 *
 * Refuses a study that did not clear the holdout. That refusal is the whole
 * point of the exercise: every number upstream of the holdout has been
 * selected against, and a search that tries two hundred candidates will find
 * several that clear any threshold by chance. Only the window nothing was
 * chosen on can say otherwise.
 */
async function promoteFromStudy(studyId, { promotedBy = 'system', force = false } = {}) {
  const [study] = await query('SELECT * FROM strategy_studies WHERE id = ?', [studyId]);
  if (!study) throw new Error(`unknown study ${studyId}`);

  if (!study.promotable && !force) {
    const why = study.holdout_passed
      ? 'it did not clear the validate window'
      : 'it did not clear the holdout window - the only data nothing was chosen on';
    throw new Error(`study ${studyId} is not promotable: ${why}`);
  }

  /**
   * Lands at the BACKTEST stage, not in service.
   *
   * The lab searched - up to four hundred candidates - so its holdout was
   * reached after a great deal of selection. A confirmation run follows:
   * these exact parameters, fixed, walked forward across the whole period
   * with no search in it at all. Only that promotes to `enabled`.
   */
  await query(
    `INSERT INTO strategy_promotions
       (strategy_id, symbol_id, timeframe, stage, params, study_id, validate_pf, holdout_pf,
        trials, promoted_at, promoted_by)
     VALUES (?, ?, ?, 'backtest', CAST(? AS JSON), ?, ?, ?, ?, UTC_TIMESTAMP(), ?)
     ON DUPLICATE KEY UPDATE
       stage = 'backtest',
       params = VALUES(params), study_id = VALUES(study_id),
       validate_pf = VALUES(validate_pf), holdout_pf = VALUES(holdout_pf),
       trials = VALUES(trials), promoted_at = VALUES(promoted_at),
       promoted_by = VALUES(promoted_by),
       confirmation_run_id = NULL, demoted_at = NULL, demote_reason = NULL,
       revoked_at = NULL, revoked_note = NULL`,
    [
      study.strategy_id,
      study.symbol_id,
      study.timeframe,
      JSON.stringify(study.best_params),
      study.id,
      study.validate?.profitFactor ?? null,
      study.holdout?.profitFactor ?? null,
      study.trials,
      promotedBy
    ]
  );

  return listPromotions({ strategyId: study.strategy_id });
}

async function revokePromotion(id, { note = null } = {}) {
  await query(
    'UPDATE strategy_promotions SET revoked_at = UTC_TIMESTAMP(), revoked_note = ? WHERE id = ?',
    [note, Number(id)]
  );
  return listPromotions({ includeRevoked: true });
}

async function listPromotions({ strategyId = null, includeRevoked = false, stage = null } = {}) {
  const where = [];
  const params = [];
  if (!includeRevoked) where.push('p.revoked_at IS NULL');
  if (stage) { where.push('p.stage = ?'); params.push(stage); }
  if (strategyId) { where.push('p.strategy_id = ?'); params.push(strategyId); }

  return query(
    `SELECT p.*, st.name AS strategy_name, sym.broker_symbol AS symbol
       FROM strategy_promotions p
       JOIN strategies st ON st.id = p.strategy_id
       JOIN symbols sym   ON sym.id = p.symbol_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.promoted_at DESC`,
    params
  );
}

/**
 * The promoted set, shaped for a hot path.
 *
 * The risk engine asks this question for every signal on every tick, so it
 * gets a Set of keys rather than a query per signal.
 */
async function loadPromotedKeys() {
  const rows = await query(
    `SELECT strategy_id, symbol_id, timeframe FROM strategy_promotions
      WHERE stage = 'enabled' AND revoked_at IS NULL`
  );
  return new Set(rows.map((r) => `${r.strategy_id}|${r.symbol_id}|${r.timeframe}`));
}

/**
 * The parameters each promoted combination earned its promotion with.
 *
 * The signal generator reads strategy parameters from the strategies table,
 * which holds the shipped defaults. A promotion is evidence about a specific
 * set of NUMBERS - measured here, macd-trend clears its holdout on XAUUSD H1
 * with a 5.25 ATR target and fails at the shipped 3.0 - so trading the
 * default while citing the promoted result would attach a backtest's
 * confidence to a bet it never covered.
 */
async function loadPromotedParams() {
  const rows = await query(
    `SELECT strategy_id, symbol_id, timeframe, params
       FROM strategy_promotions
      WHERE stage = 'enabled' AND revoked_at IS NULL`
  );
  return new Map(
    rows.map((r) => [`${r.strategy_id}|${r.symbol_id}|${r.timeframe}`, r.params])
  );
}

/**
 * The timeframes that promoted combinations actually trade on.
 *
 * The scheduler syncs candles and sets signal expiry per timeframe, so a
 * timeframe it does not know about would have signals generated against stale
 * bars that then never expire. This used to be derived from scope rows; those
 * are gone, and a promotion is now the only thing that says a timeframe
 * matters.
 */
async function promotedTimeframes() {
  const rows = await query(
    `SELECT DISTINCT timeframe FROM strategy_promotions
      WHERE stage = 'enabled' AND revoked_at IS NULL`
  );
  return rows.map((r) => r.timeframe);
}

function isPromoted(promoted, { strategyId, symbolId, timeframe }) {
  if (!promoted || promoted.size === 0) return false;
  return promoted.has(`${strategyId}|${symbolId}|${timeframe}`);
}

async function listStudies({ limit = 100, promotableOnly = false } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  return query(
    `SELECT s.*, st.name AS strategy_name, sym.broker_symbol AS symbol,
            EXISTS (
              SELECT 1 FROM strategy_promotions p
               WHERE p.study_id = s.id AND p.revoked_at IS NULL
            ) AS promoted
       FROM strategy_studies s
       JOIN strategies st ON st.id = s.strategy_id
       JOIN symbols sym   ON sym.id = s.symbol_id
      ${promotableOnly ? 'WHERE s.promotable = 1' : ''}
      ORDER BY s.id DESC
      LIMIT ${safeLimit}`
  );
}

module.exports = {
  recordStudy,
  promoteFromStudy,
  revokePromotion,
  listPromotions,
  listStudies,
  loadPromotedKeys,
  loadPromotedParams,
  promotedTimeframes,
  isPromoted
};
