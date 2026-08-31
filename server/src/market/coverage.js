const { query } = require('../db/pool');
const { syncCandles, barsForMonths, TIMEFRAMES } = require('./candles');

/**
 * What history is actually stored, per symbol and timeframe.
 *
 * Every backtest verdict rests on this and nothing surfaced it. A run that
 * reported "only 20 trades, 50 required" was usually not a strategy that
 * rarely fires - it was three weeks of M5 being asked a question that needs a
 * year. Showing the coverage turns that from a mystery into a glance.
 */

// Bars a real instrument produces in a month, allowing for weekends. Used to
// judge whether stored history spans what it claims: 1,000 M5 bars is three
// days, and calling that "6 months of data" because the oldest row is six
// months old would be worse than saying nothing.
// A year, not six months. The walk-forward split judges on the last 30% of
// the window, so six months of history leaves six WEEKS to be judged on - and
// the commonest backtest failure by far was "only N trades, 50 required".
// A year gives the out-of-sample half enough bars to mean something.
const DEFAULT_MONTHS = 12;

// The bar of green in the coverage grid. Matches DEFAULT_MONTHS so the grid
// and the button cannot disagree about what "enough" is.
const SUFFICIENT_MONTHS = DEFAULT_MONTHS;

const BARS_PER_MONTH = {
  M1: 30240, M5: 6048, M15: 2016, M30: 1008, H1: 504, H4: 126, D1: 22
};

async function coverage({ timeframes = TIMEFRAMES } = {}) {
  const symbols = await query(
    'SELECT id, broker_symbol, enabled, watched FROM symbols WHERE enabled = 1 OR watched = 1 ORDER BY broker_symbol'
  );

  const rows = await query(
    `SELECT c.symbol_id, c.timeframe, COUNT(*) AS bars,
            MIN(c.open_time) AS first_bar, MAX(c.open_time) AS last_bar
       FROM candles c
      GROUP BY c.symbol_id, c.timeframe`
  );

  const index = new Map(rows.map((r) => [`${r.symbol_id}|${r.timeframe}`, r]));

  return {
    timeframes,
    symbols: symbols.map((symbol) => ({
      symbolId: symbol.id,
      symbol: symbol.broker_symbol,
      tradeable: symbol.enabled === 1,
      coverage: timeframes.map((timeframe) => {
        const row = index.get(`${symbol.id}|${timeframe}`);
        if (!row) {
          return { timeframe, bars: 0, firstBar: null, lastBar: null, months: 0, sufficient: false };
        }

        const bars = Number(row.bars);
        // Measured in BARS rather than in calendar span: a gap-ridden series
        // whose oldest row is a year old still cannot answer a year's
        // question, and the bar count is what the backtest actually consumes.
        const months = Number((bars / (BARS_PER_MONTH[timeframe] || 500)).toFixed(1));

        return {
          timeframe,
          bars,
          firstBar: row.first_bar,
          lastBar: row.last_bar,
          months,
          sufficient: months >= SUFFICIENT_MONTHS
        };
      })
    }))
  };
}

/**
 * Backfill every enabled symbol across every timeframe.
 *
 * Strictly sequential. Concurrent history requests to a single MT5 terminal
 * are how the bridge stops answering, and this asks for tens of thousands of
 * bars per combination - a year of M5 alone is about 105,000.
 *
 * `onProgress` is called before each request so a caller can publish where it
 * has got to; the whole job takes minutes, and a button that appears to hang
 * for that long is indistinguishable from a broken one.
 */
async function backfillAll(bridge, {
  months = DEFAULT_MONTHS,
  timeframes = TIMEFRAMES,
  onProgress = null,
  logger = console
} = {}) {
  const symbols = await query(
    'SELECT id, broker_symbol FROM symbols WHERE enabled = 1 OR watched = 1 ORDER BY broker_symbol'
  );

  const total = symbols.length * timeframes.length;
  const results = [];
  let done = 0;

  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      if (onProgress) {
        onProgress({ done, total, symbol: symbol.broker_symbol, timeframe, phase: 'fetching' });
      }

      const bars = barsForMonths(timeframe, months);
      try {
        const result = await syncCandles(bridge, {
          symbolId: symbol.id,
          brokerSymbol: symbol.broker_symbol,
          timeframe,
          count: bars
        });
        results.push({
          symbol: symbol.broker_symbol, timeframe, requested: bars, ...result, ok: true
        });
      } catch (error) {
        // One failed combination must not cost the rest their history. A
        // closed market simply has nothing new to give.
        logger.error(`backfill failed for ${symbol.broker_symbol} ${timeframe}: ${error.message}`);
        results.push({
          symbol: symbol.broker_symbol, timeframe, requested: bars, ok: false, error: error.message
        });
      }

      done += 1;
      if (onProgress) {
        onProgress({ done, total, symbol: symbol.broker_symbol, timeframe, phase: 'stored' });
      }
    }
  }

  return {
    months,
    combinations: total,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    storedBars: results.reduce((n, r) => n + (r.stored || 0), 0),
    results
  };
}

/**
 * A backfill runs for minutes, so it runs in the background and publishes a
 * snapshot - the same shape as the scanner, and for the same reason.
 */
function createBackfillJob() {
  let running = false;
  let progress = null;
  let last = null;

  return {
    isRunning: () => running,
    snapshot: () => ({ running, progress, last }),
    async start(bridge, { months = DEFAULT_MONTHS, timeframes = TIMEFRAMES, logger = console } = {}) {
      if (running) return { started: false, reason: 'a backfill is already running' };
      running = true;
      progress = { done: 0, total: 0, symbol: null, timeframe: null, phase: 'starting' };

      try {
        last = await backfillAll(bridge, {
          months,
          timeframes,
          logger,
          onProgress: (p) => { progress = p; }
        });
        return { started: true };
      } finally {
        running = false;
        progress = null;
      }
    }
  };
}

module.exports = {
  coverage, backfillAll, createBackfillJob,
  BARS_PER_MONTH, DEFAULT_MONTHS, SUFFICIENT_MONTHS
};
