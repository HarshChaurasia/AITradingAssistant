const { applyEntrySlippage, applyExitSlippage, commissionFor, pnlFor } = require('./costs');

/**
 * Bar-by-bar replay of a strategy over historical candles.
 *
 * The rules below all exist to stop the backtest flattering the strategy:
 *   - a signal on bar i is filled at the OPEN of bar i+1, never at bar i's
 *     close, which was not knowable while the bar was forming;
 *   - stops and targets are checked against subsequent highs and lows;
 *   - if one bar contains both the stop and the target, the STOP wins, since
 *     without tick data the true sequence is unknowable;
 *   - a lot smaller than the symbol minimum means the trade is skipped, never
 *     rounded up.
 */

function sizePosition({ balance, riskPct, entry, sl, symbol }) {
  const stopDistance = Math.abs(entry - sl);
  if (stopDistance <= 0) return 0;

  const riskAmount = balance * (riskPct / 100);
  const lossPerLot = stopDistance * symbol.contract_size;
  if (lossPerLot <= 0) return 0;

  const raw = riskAmount / lossPerLot;
  const step = symbol.lot_step || 0.01;

  // Binary floating point makes a distance like 1.1 - 1.09 come out as
  // 0.010000000000000009, which floors one whole step too low and silently
  // under-sizes every position. Absorb that noise before flooring.
  const steps = Math.floor(Number((raw / step).toFixed(8)));
  const rounded = steps * step;

  // Below the broker minimum the trade is refused. Rounding up would silently
  // multiply the intended risk, which on a small account is fatal.
  if (rounded < (symbol.min_lot || 0.01)) return 0;
  if (symbol.max_lot && rounded > symbol.max_lot) return symbol.max_lot;

  return Number(rounded.toFixed(4));
}

function resolveExit({ position, candle, spreadPrice, slippagePrice }) {
  const { side, sl, tp } = position;

  const hitStop = side === 'BUY' ? candle.low <= sl : candle.high >= sl;
  const hitTarget = tp !== null && tp !== undefined
    && (side === 'BUY' ? candle.high >= tp : candle.low <= tp);

  // Pessimistic: when a single bar spans both levels, assume the stop first.
  if (hitStop) {
    return { price: applyExitSlippage({ side, price: sl, spreadPrice, slippagePrice }), reason: 'SL' };
  }
  if (hitTarget) {
    return { price: applyExitSlippage({ side, price: tp, spreadPrice, slippagePrice }), reason: 'TP' };
  }
  return null;
}

function runBacktest({ candles, strategy, params, symbol, options }) {
  const {
    startingBalance = 10000,
    riskPctPerTrade = 1,
    spreadPrice = 0,
    slippagePrice = 0,
    commissionPerLot = 0,
    maxConcurrentPositions = 1,
    // Trading window, as bar indices into `candles`. Indicators always see the
    // FULL series; only signal generation is restricted. Slicing the candles
    // instead would let a walk-forward window warm its indicators up from a
    // truncated history, so the same bar produces a different EMA in-sample
    // and out-of-sample - and the out-of-sample result stops predicting live
    // behaviour, which is the one thing it exists to do.
    tradeFrom = 0,
    tradeTo = candles.length
  } = options || {};

  const mergedParams = { ...strategy.defaultParams, ...(params || {}) };
  const context = strategy.prepare(candles, mergedParams);

  const trades = [];
  const signals = [];
  let open = null;
  let balance = startingBalance;
  let pending = null;

  for (let i = 0; i < tradeTo; i += 1) {
    const candle = candles[i];

    // 1. A fill queued on the previous bar executes at this bar's open.
    if (pending && !open) {
      const entryPrice = applyEntrySlippage({
        side: pending.side, price: candle.open, spreadPrice, slippagePrice
      });
      const lot = sizePosition({
        balance, riskPct: riskPctPerTrade, entry: entryPrice, sl: pending.sl, symbol
      });

      if (lot > 0) {
        open = {
          side: pending.side,
          lot,
          entryTime: candle.open_time,
          entryPrice,
          sl: pending.sl,
          tp: pending.tp,
          reason: pending.reason
        };
      }
      pending = null;
    }

    // 2. An open position may exit on this bar's range.
    if (open) {
      const exit = resolveExit({ position: open, candle, spreadPrice, slippagePrice });
      if (exit) {
        const gross = pnlFor({
          side: open.side,
          entryPrice: open.entryPrice,
          exitPrice: exit.price,
          lot: open.lot,
          contractSize: symbol.contract_size
        });
        // Commission is charged on both legs of the round turn.
        const commission = commissionFor({ lot: open.lot, commissionPerLot }) * 2;
        const pnl = gross - commission;

        balance += pnl;
        trades.push({
          ...open,
          exitTime: candle.open_time,
          exitPrice: exit.price,
          exitReason: exit.reason,
          commission,
          pnl
        });
        open = null;
      }
    }

    // 3. Look for a new signal, to be filled on the next bar.
    if (i >= tradeFrom && !open && !pending && maxConcurrentPositions > 0) {
      const signal = strategy.evaluate(candles, i, mergedParams, context);
      if (signal) {
        signals.push({ ...signal, barTime: candle.open_time, barIndex: i });
        // The final bar of the window has no following bar to fill on.
        if (i < tradeTo - 1) pending = signal;
      }
    }
  }

  // 4. Anything still open closes at the final bar of the trading window.
  if (open && tradeTo > 0) {
    const last = candles[tradeTo - 1];
    const exitPrice = applyExitSlippage({
      side: open.side, price: last.close, spreadPrice, slippagePrice
    });
    const gross = pnlFor({
      side: open.side,
      entryPrice: open.entryPrice,
      exitPrice,
      lot: open.lot,
      contractSize: symbol.contract_size
    });
    const commission = commissionFor({ lot: open.lot, commissionPerLot }) * 2;

    trades.push({
      ...open,
      exitTime: last.open_time,
      exitPrice,
      exitReason: 'END',
      commission,
      pnl: gross - commission
    });
  }

  return { trades, signals };
}

module.exports = { runBacktest, sizePosition };
