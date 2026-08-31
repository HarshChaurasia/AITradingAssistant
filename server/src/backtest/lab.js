const { query } = require('../db/pool');
const { optimiseStrategy } = require('./optimiser');
const { recordStudy } = require('../strategies/promotions');
const { searchSpaceFor } = require('./search-space');

/**
 * The research loop, run over a whole grid.
 *
 * One study answers "can this strategy be tuned to work on this symbol and
 * this timeframe". The point of running the grid is that the answer is
 * different for every cell, and only the grid shows which cells those are -
 * measured here, smart-money is worth trading on BTCUSD H1 and worthless on
 * BTCUSD M5, and no property of "smart-money" can tell you that.
 *
 * Sequential on purpose. Each study loads its own candle series and scores a
 * few hundred candidates against it; running several at once turns a
 * CPU-bound job into a memory-bound one and makes the progress meaningless.
 */

// A lab run is minutes long, so it publishes a snapshot rather than blocking a
// request - the same shape as the scanner and the backfill, for the same
// reason.
function createLabJob() {
  let running = false;
  let progress = null;
  let last = null;
  let cancelled = false;

  return {
    isRunning: () => running,
    snapshot: () => ({ running, progress, last }),
    cancel() {
      if (running) cancelled = true;
      return { cancelling: running };
    },
    async start(config = {}) {
      if (running) return { started: false, reason: 'a study is already running' };
      running = true;
      cancelled = false;
      progress = { done: 0, total: 0, phase: 'starting', cell: null, trials: 0 };

      try {
        last = await runLab({
          ...config,
          isCancelled: () => cancelled,
          onProgress: (p) => { progress = { ...progress, ...p }; }
        });
        return { started: true };
      } finally {
        running = false;
        progress = null;
      }
    }
  };
}

async function runLab({
  strategyNames = null,
  symbolIds = null,
  timeframes = ['M15', 'M30', 'H1', 'H4'],
  iterations = 5,
  options = {},
  onProgress = null,
  isCancelled = () => false,
  logger = console
} = {}) {
  const strategies = strategyNames && strategyNames.length
    ? strategyNames
    : (await query('SELECT name FROM strategies WHERE enabled = 1 AND superseded_at IS NULL'))
      .map((r) => r.name);

  // A strategy with nothing to vary cannot be studied, and saying so up front
  // beats reporting it as a failure once per cell.
  const searchable = strategies.filter((name) => searchSpaceFor(name) !== null);
  const skipped = strategies.filter((name) => !searchable.includes(name));

  const symbols = symbolIds && symbolIds.length
    ? symbolIds
    : (await query('SELECT id FROM symbols WHERE enabled = 1')).map((r) => r.id);

  const total = searchable.length * symbols.length * timeframes.length;
  const results = [];
  let done = 0;

  for (const strategyName of searchable) {
    for (const symbolId of symbols) {
      for (const timeframe of timeframes) {
        if (isCancelled()) {
          return { total, completed: done, cancelled: true, skipped, results };
        }

        if (onProgress) {
          onProgress({ done, total, phase: 'studying', cell: `${strategyName} ${timeframe}` });
        }

        const startedAt = new Date();
        try {
          const result = await optimiseStrategy({
            strategyName,
            symbolId,
            timeframe,
            iterations,
            options,
            onProgress: (p) => onProgress && onProgress({ done, total, phase: 'studying', cell: `${strategyName} ${timeframe}`, trials: p.trials })
          });

          const { studyId } = await recordStudy({ ...result, startedAt });
          results.push({
            studyId,
            strategyName,
            symbolId,
            symbol: result.symbol,
            timeframe,
            trials: result.trials,
            promotable: result.promotable,
            validatePassed: result.validatePassed,
            holdoutPassed: result.holdoutPassed,
            robustness: result.robustness,
            winner: result.winner
              ? {
                params: result.winner.params,
                optimise: result.winner.optimise.profitFactor,
                validate: result.winner.validate.profitFactor,
                holdout: result.winner.holdout.profitFactor,
                trades: result.winner.validate.trades
              }
              : null,
            reason: result.reason || null
          });
        } catch (error) {
          // A cell with no stored history must not cost the operator the
          // other forty-seven.
          logger.error(`study failed for ${strategyName} ${timeframe}: ${error.message}`);
          results.push({ strategyName, symbolId, timeframe, error: error.message });
        }

        done += 1;
      }
    }
  }

  const studied = results.filter((r) => !r.error);
  const promotable = studied.filter((r) => r.promotable);
  const trials = studied.reduce((n, r) => n + (r.trials || 0), 0);

  return {
    total,
    completed: done,
    cancelled: false,
    skipped,
    studied: studied.length,
    errored: results.length - studied.length,
    promotable: promotable.length,
    trials,
    /**
     * What a reader has to know before believing any of this.
     *
     * Thousands of candidates were scored. At that scale several will clear
     * any threshold by chance alone, which is why the holdout window exists
     * and why this number sits beside the count of passes rather than
     * somewhere further down the page.
     */
    note: `${trials} parameter sets were scored across ${studied.length} combinations. `
      + `${promotable.length} cleared BOTH the validate and holdout windows. `
      + 'At this many trials some candidates clear any single threshold by chance, '
      + 'which is what the holdout is there to catch.',
    results
  };
}

module.exports = { runLab, createLabJob };
