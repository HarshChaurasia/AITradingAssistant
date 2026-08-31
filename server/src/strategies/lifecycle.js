const { query } = require('../db/pool');
const { executeRun, evaluateThresholds } = require('../backtest/runner');
const { alertLifecycle } = require('../alerts/events');

/**
 * The stages a combination moves through before it may trade, and back out
 * again when it stops working.
 *
 *   research -> backtest -> enabled
 *      ^                       |
 *      +------- demoted -------+
 *
 * Everything here is keyed on the COMBINATION - strategy, symbol, timeframe -
 * because that is the unit the evidence is about. Measured over a year on
 * this account, smart-money reaches a profit factor of 1.40 on BTCUSD H1 and
 * 0.43 on BTCUSD M5: a per-strategy stage would be wrong about one of them
 * whichever way it was set. A strategy therefore accumulates enabled
 * combinations one at a time, as each earns its own evidence.
 *
 * `strategies.enabled` is DERIVED from this and never set by hand. It answers
 * "does this strategy have anything to trade at all", which is a display
 * question; the combination gate answers the one that matters.
 */

const STAGES = ['research', 'backtest', 'enabled', 'demoted'];

/**
 * Live performance below which a combination goes back to research.
 *
 * A profit factor under 1.0 is losing money, not merely underperforming - a
 * deliberately low bar, because the live sample is small and demoting on
 * "worse than the backtest" would discard working strategies constantly. The
 * minimum trade count matters more than the threshold: a genuine 55%-win
 * strategy produces losing ten-trade runs often, and demoting on those would
 * mean nothing ever survived long enough to be judged.
 */
const DEMOTE_BELOW_PF = 1.0;
const DEMOTE_MIN_TRADES = 20;

async function recordEvent({
  strategyId, symbolId, timeframe, fromStage, toStage,
  reason = null, studyId = null, runId = null, actor = 'system'
}) {
  await query(
    `INSERT INTO strategy_lifecycle_events
       (strategy_id, symbol_id, timeframe, from_stage, to_stage, reason,
        study_id, run_id, actor, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [strategyId, symbolId, timeframe, fromStage, toStage, reason, studyId, runId, actor]
  );
}

/**
 * `strategies.enabled` follows the combinations, never the other way round.
 *
 * Setting it by hand is what let a strategy with no passing evidence trade
 * for weeks. Deriving it means the only way to enable something is to produce
 * evidence for it, which is the whole point of the exercise.
 */
async function syncEnabledFlags() {
  const result = await query(
    `UPDATE strategies s
        SET s.enabled = EXISTS (
              SELECT 1 FROM strategy_promotions p
               WHERE p.strategy_id = s.id
                 AND p.stage = 'enabled'
                 AND p.revoked_at IS NULL
            )`
  );
  return { changed: result.changedRows ?? result.affectedRows ?? 0 };
}

/**
 * The confirmation run: the promoted parameters, fixed, over the whole period.
 *
 * This is not a repeat of the lab and it is not ceremony. The lab SEARCHED -
 * up to four hundred candidates - and its holdout is one quarter of a year
 * reached after all that selection. This run has no selection in it at all:
 * one parameter set, walked forward across the full history. It catches the
 * case the lab structurally cannot, which is a winner that only worked in the
 * quarter it happened to land on.
 */
async function confirmCombination(promotionId, {
  bridge = null,
  actor = 'system',
  /**
   * Re-run for a combination that is already trading.
   *
   * Without this there was no way to backtest a promoted combination at all:
   * the check below short-circuited and returned success without running
   * anything. A re-check is the point of the exercise once something is live -
   * the evidence was gathered on history that ends where the live period
   * begins, and a year later it covers a different market.
   *
   * A failed re-check demotes, exactly as a first confirmation would. That is
   * the intended behaviour and worth being deliberate about: a combination
   * that no longer passes on the full year should not be trading, whoever
   * pressed the button.
   */
  force = false,
  // Injected so a test can decide WHICH numbers reach the verdict without
  // needing a year of candles in the scratch database.
  executeRunFn = executeRun
} = {}) {
  const [promotion] = await query(
    `SELECT p.*, st.name AS strategy_name, sym.broker_symbol AS symbol
       FROM strategy_promotions p
       JOIN strategies st ON st.id = p.strategy_id
       JOIN symbols sym   ON sym.id = p.symbol_id
      WHERE p.id = ?`,
    [promotionId]
  );
  if (!promotion) throw new Error(`unknown promotion ${promotionId}`);
  if (promotion.stage === 'enabled' && !force) {
    return { confirmed: true, alreadyEnabled: true, promotionId };
  }

  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);

  const run = await executeRunFn({
    strategyName: promotion.strategy_name,
    symbolId: promotion.symbol_id,
    timeframe: promotion.timeframe,
    params: promotion.params,
    bridge,
    options: {
      from: from.toISOString().slice(0, 10),
      startingBalance: Number(process.env.ACCOUNT_BALANCE_HINT || 10000),
      riskPctPerTrade: 1,
      // The account pays the spread and nothing else. Charging a commission it
      // does not pay would fail combinations on a cost that is not real.
      commissionPerLot: 0
    }
  });

  /**
   * Judged on the WHOLE period, not on a sub-window.
   *
   * executeRun's own `passed` comes from its validate window - the same slice
   * the lab already scored - so using it would have made this step re-measure
   * the very thing it exists to be independent of. Caught by the numbers
   * being identical: the first confirmation reported a profit factor of 1.54
   * on 29 trades, exactly the lab's validate figure.
   *
   * With the parameters fixed there is no selection to protect against, so
   * every bar of the year is legitimately usable - and it is a far stronger
   * test, roughly four times the sample.
   */
  const metrics = run.metrics;
  const verdict = evaluateThresholds(metrics, run.thresholds, promotion.timeframe);

  if (verdict.passed) {
    await query(
      `UPDATE strategy_promotions
          SET stage = 'enabled', confirmation_run_id = ?, promoted_at = UTC_TIMESTAMP(),
              demoted_at = NULL, demote_reason = NULL
        WHERE id = ?`,
      [run.runId, promotionId]
    );
    await recordEvent({
      strategyId: promotion.strategy_id,
      symbolId: promotion.symbol_id,
      timeframe: promotion.timeframe,
      fromStage: promotion.stage,
      toStage: 'enabled',
      reason: `${promotion.stage === 'enabled' ? 're-check' : 'confirmation'} passed: profit factor ${Number(metrics.profitFactor).toFixed(2)} over ${metrics.trades} trades across the whole period, with no parameter search`,
      studyId: promotion.study_id,
      runId: run.runId,
      actor
    });
    await syncEnabledFlags();

    alertLifecycle({
      stage: 'enabled',
      strategy: promotion.strategy_name,
      symbol: promotion.symbol,
      timeframe: promotion.timeframe,
      detail: `confirmation profit factor ${Number(metrics.profitFactor).toFixed(2)} over ${metrics.trades} trades on the full year, after ${promotion.trials} parameter sets were tried`,
      params: promotion.params
    }).catch(() => {});

    return { confirmed: true, promotionId, runId: run.runId, metrics };
  }

  // Back to research. A combination that cannot survive its own parameters
  // over the whole period has not earned a place, and leaving it at
  // "backtest" would let it sit there looking like progress.
  await query(
    `UPDATE strategy_promotions
        SET stage = 'demoted', confirmation_run_id = ?, demoted_at = UTC_TIMESTAMP(),
            demote_reason = ?
      WHERE id = ?`,
    [
      run.runId,
      `${promotion.stage === 'enabled' ? 're-check' : 'confirmation'} failed: `
        + `${verdict.failures[0] || 'thresholds not met'}`,
      promotionId
    ]
  );
  await recordEvent({
    strategyId: promotion.strategy_id,
    symbolId: promotion.symbol_id,
    timeframe: promotion.timeframe,
    fromStage: promotion.stage,
    toStage: 'research',
    reason: `confirmation failed: ${verdict.failures.join('; ')}`,
    studyId: promotion.study_id,
    runId: run.runId,
    actor
  });
  await syncEnabledFlags();

  return { confirmed: false, promotionId, runId: run.runId, failures: verdict.failures, metrics };
}

/**
 * Confirm everything waiting at the backtest stage.
 *
 * Sequential, because each confirmation is a full walk-forward over a year of
 * bars and running several at once only makes them all slower.
 */
async function confirmPending({ bridge = null, logger = console, executeRunFn = executeRun } = {}) {
  const pending = await query(
    "SELECT id FROM strategy_promotions WHERE stage = 'backtest' AND revoked_at IS NULL"
  );

  const results = [];
  for (const row of pending) {
    try {
      results.push(await confirmCombination(row.id, { bridge, executeRunFn }));
    } catch (error) {
      logger.error(`confirmation failed for promotion ${row.id}: ${error.message}`);
      results.push({ promotionId: row.id, error: error.message });
    }
  }

  return {
    pending: pending.length,
    enabled: results.filter((r) => r.confirmed).length,
    rejected: results.filter((r) => r.confirmed === false).length,
    results
  };
}

/**
 * Live results per enabled combination, and demotion when they turn bad.
 *
 * The threshold is deliberately generous and the sample requirement is not.
 * A profit factor below 1.0 means the combination is losing money; requiring
 * twenty closed trades first is what stops a normal losing streak - which a
 * genuine 55%-win strategy produces regularly - from throwing away a working
 * edge. Getting that balance wrong in either direction is expensive, and the
 * cheap mistake is waiting too long.
 */
async function reviewLivePerformance({
  mode = 'demo',
  minTrades = DEMOTE_MIN_TRADES,
  belowPf = DEMOTE_BELOW_PF,
  logger = console
} = {}) {
  const rows = await query(
    `SELECT p.id, p.strategy_id, p.symbol_id, p.timeframe, p.holdout_pf,
            st.name AS strategy_name, sym.broker_symbol AS symbol,
            COUNT(t.id) AS trades,
            COALESCE(SUM(CASE WHEN t.pnl > 0 THEN t.pnl ELSE 0 END), 0) AS gross_win,
            COALESCE(SUM(CASE WHEN t.pnl < 0 THEN -t.pnl ELSE 0 END), 0) AS gross_loss
       FROM strategy_promotions p
       JOIN strategies st ON st.id = p.strategy_id
       JOIN symbols sym   ON sym.id = p.symbol_id
       LEFT JOIN signals sig ON sig.strategy_id = p.strategy_id
                            AND sig.symbol_id = p.symbol_id
                            AND sig.timeframe = p.timeframe
                            AND sig.mode = ?
       LEFT JOIN trades t ON t.signal_id = sig.id AND t.status = 'CLOSED'
      WHERE p.stage = 'enabled' AND p.revoked_at IS NULL
      GROUP BY p.id`,
    [mode]
  );

  const demoted = [];

  for (const row of rows) {
    const trades = Number(row.trades);
    const grossLoss = Number(row.gross_loss);
    const grossWin = Number(row.gross_win);
    // No losses yet is not an infinite profit factor, it is an unfinished
    // sample; storing Infinity here would make every comparison downstream
    // meaningless.
    const pf = grossLoss > 0 ? grossWin / grossLoss : null;

    await query(
      'UPDATE strategy_promotions SET live_trades = ?, live_pf = ? WHERE id = ?',
      [trades, pf, row.id]
    );

    if (trades < minTrades || pf === null || pf >= belowPf) continue;

    const reason = `live profit factor ${pf.toFixed(2)} over ${trades} closed trades, below ${belowPf}`
      + (row.holdout_pf ? ` (backtest holdout was ${Number(row.holdout_pf).toFixed(2)})` : '');

    await query(
      `UPDATE strategy_promotions
          SET stage = 'demoted', demoted_at = UTC_TIMESTAMP(), demote_reason = ?
        WHERE id = ?`,
      [reason, row.id]
    );
    await recordEvent({
      strategyId: row.strategy_id,
      symbolId: row.symbol_id,
      timeframe: row.timeframe,
      fromStage: 'enabled',
      toStage: 'demoted',
      reason
    });

    logger.error(`demoted ${row.strategy_name} ${row.symbol} ${row.timeframe}: ${reason}`);
    demoted.push({
      strategy: row.strategy_name, symbol: row.symbol, timeframe: row.timeframe, pf, trades
    });

    alertLifecycle({
      stage: 'demoted',
      strategy: row.strategy_name,
      symbol: row.symbol,
      timeframe: row.timeframe,
      detail: reason
    }).catch(() => {});
  }

  if (demoted.length > 0) await syncEnabledFlags();
  return { reviewed: rows.length, demoted };
}

/**
 * Every combination and where it stands, including the ones still in research.
 *
 * Research has no row of its own - it is the absence of one - so it is
 * reconstructed here rather than stored. A table listing every combination
 * that has never done anything would be mostly a list of things that did not
 * happen: 214 of the 216 studied so far.
 */
async function listLifecycle() {
  const promotions = await query(
    `SELECT p.*, st.name AS strategy_name, sym.broker_symbol AS symbol
       FROM strategy_promotions p
       JOIN strategies st ON st.id = p.strategy_id
       JOIN symbols sym   ON sym.id = p.symbol_id
      ORDER BY FIELD(p.stage, 'enabled', 'backtest', 'demoted'), p.promoted_at DESC`
  );

  const events = await query(
    `SELECT e.*, st.name AS strategy_name, sym.broker_symbol AS symbol
       FROM strategy_lifecycle_events e
       JOIN strategies st ON st.id = e.strategy_id
       JOIN symbols sym   ON sym.id = e.symbol_id
      ORDER BY e.id DESC
      LIMIT 100`
  );

  const counts = promotions.reduce((acc, p) => {
    const key = p.revoked_at ? 'revoked' : p.stage;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return { stages: STAGES, counts, promotions, events };
}

module.exports = {
  STAGES,
  DEMOTE_BELOW_PF,
  DEMOTE_MIN_TRADES,
  confirmCombination,
  confirmPending,
  reviewLivePerformance,
  syncEnabledFlags,
  listLifecycle,
  recordEvent
};
