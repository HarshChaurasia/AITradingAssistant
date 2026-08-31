const { query } = require('../db/pool');
const { getCandles } = require('../market/candles');
const { atr } = require('../indicators');

/**
 * Can a scalp on this symbol and timeframe pay for its own spread?
 *
 * A scalp targets a fraction of a bar's range. If the round-trip cost is a
 * large fraction of that range, no parameter set makes it work - the strategy
 * is being asked to out-trade its own commission. This measures the ratio
 * directly rather than leaving it to be discovered a hundred losing trades
 * later.
 *
 * Measured on this account when it was written:
 *
 *   BTCUSD  M1  1.9x   M5  10.8x
 *   ETHUSD  M1  0.8x   M5   4.2x
 *   XAUUSD  M1  1.9x   M5   4.5x
 *   EURUSD  M1  0.4x   M5   1.0x
 *
 * On EURUSD M1 the spread is two and a half times the ENTIRE median bar. That
 * is not a strategy problem and no amount of tuning addresses it.
 */

// A scalp typically targets 1-1.5 ATR and gives back the spread twice. Below
// about 4x the trade is mostly cost; below 8x there is little margin for the
// slippage a fast fill actually gets.
const VIABLE_RATIO = 8;
const MARGINAL_RATIO = 4;

function verdictFor(ratio) {
  if (ratio === null) return 'unknown';
  if (ratio >= VIABLE_RATIO) return 'viable';
  if (ratio >= MARGINAL_RATIO) return 'marginal';
  return 'not viable';
}

async function measure({ symbol, timeframe, bars = 3000 }) {
  const candles = await getCandles({ symbolId: symbol.id, timeframe, limit: bars });
  const spread = Number(symbol.spread_points) * Number(symbol.point);

  if (candles.length < 100 || !(spread > 0)) {
    return {
      symbolId: symbol.id,
      symbol: symbol.broker_symbol,
      timeframe,
      bars: candles.length,
      medianAtr: null,
      spread: spread || null,
      ratio: null,
      verdict: 'unknown',
      detail: candles.length < 100
        ? `only ${candles.length} bars stored - backfill before judging this`
        : 'the broker reports no spread for this symbol'
    };
  }

  // The median, not the mean: a handful of violent bars would otherwise make a
  // quiet instrument look tradeable.
  const values = atr(candles, 14).filter((v) => v !== null).sort((a, b) => a - b);
  const medianAtr = values[Math.floor(values.length / 2)];
  const ratio = Number((medianAtr / spread).toFixed(2));

  return {
    symbolId: symbol.id,
    symbol: symbol.broker_symbol,
    timeframe,
    bars: candles.length,
    medianAtr: Number(medianAtr.toFixed(8)),
    spread,
    ratio,
    verdict: verdictFor(ratio),
    detail: ratio >= VIABLE_RATIO
      ? `the median bar is ${ratio}x the spread, so a scalp has room to work`
      : ratio >= MARGINAL_RATIO
        ? `the median bar is only ${ratio}x the spread - a scalp keeps little after costs`
        : `the median bar is ${ratio}x the spread, so most of any move is the spread itself`
  };
}

/**
 * The whole grid, for the scalping screen.
 */
async function scalpViability({ timeframes = ['M1', 'M5', 'M15', 'M30'] } = {}) {
  const symbols = await query(
    'SELECT * FROM symbols WHERE enabled = 1 OR watched = 1 ORDER BY broker_symbol'
  );

  const rows = [];
  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      rows.push(await measure({ symbol, timeframe }));
    }
  }

  return {
    thresholds: { viable: VIABLE_RATIO, marginal: MARGINAL_RATIO },
    rows
  };
}

module.exports = { scalpViability, measure, verdictFor, VIABLE_RATIO, MARGINAL_RATIO };
