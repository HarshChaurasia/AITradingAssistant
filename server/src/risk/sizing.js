/**
 * Position sizing, shared verbatim by the backtest engine and the live risk
 * engine. If these ever diverge, a backtest stops predicting live behaviour
 * and the demo period proves nothing.
 */

function roundToStep(value, step) {
  const safeStep = step || 0.01;
  // Binary floating point makes a stop distance like 1.1 - 1.09 come out as
  // 0.010000000000000009, which floors one whole step too low and silently
  // under-sizes every position. Absorb that noise before flooring.
  const steps = Math.floor(Number((value / safeStep).toFixed(8)));
  return Number((steps * safeStep).toFixed(8));
}

function sizePosition({ balance, riskPct, entry, sl, symbol }) {
  const base = { lot: 0, riskAmount: 0, stopDistance: 0, rejected: true, reason: '' };

  if (sl === null || sl === undefined || !Number.isFinite(Number(sl))) {
    return { ...base, reason: 'no stop loss on the signal' };
  }

  const stopDistance = Math.abs(Number(entry) - Number(sl));
  if (!(stopDistance > 0)) {
    return { ...base, reason: 'stop distance is zero' };
  }

  const riskAmount = Number(balance) * (Number(riskPct) / 100);
  if (!(riskAmount > 0)) {
    return { ...base, stopDistance, reason: 'risk budget is zero' };
  }

  const lossPerLot = stopDistance * Number(symbol.contract_size);
  if (!(lossPerLot > 0)) {
    return { ...base, stopDistance, riskAmount, reason: 'contract size is zero' };
  }

  const minLot = Number(symbol.min_lot) || 0.01;
  const maxLot = Number(symbol.max_lot) || Infinity;
  const raw = riskAmount / lossPerLot;
  const lot = roundToStep(raw, Number(symbol.lot_step) || 0.01);

  if (lot < minLot) {
    // Rounding up here would silently multiply the intended risk. On a small
    // account that is the single fastest way to lose it.
    const riskAtMin = minLot * lossPerLot;
    return {
      ...base,
      stopDistance,
      riskAmount,
      reason:
        `sized lot ${lot} is below the broker minimum ${minLot}; ` +
        `trading ${minLot} would risk ${riskAtMin.toFixed(2)} ` +
        `(${((riskAtMin / balance) * 100).toFixed(2)}% of balance) against a ${riskPct}% cap`
    };
  }

  return {
    lot: Math.min(lot, maxLot),
    riskAmount,
    stopDistance,
    rejected: false,
    reason: ''
  };
}

module.exports = { sizePosition, roundToStep };
