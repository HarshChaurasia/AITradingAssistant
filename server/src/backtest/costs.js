/**
 * Every cost here moves the fill against the trader, always. A backtest that
 * fills at the mid price will show an edge that does not exist at a broker.
 *
 * Candle prices are treated as bid. A buy therefore crosses the full spread;
 * a sell is already at the bid and only pays slippage.
 */

function applyEntrySlippage({ side, price, spreadPrice = 0, slippagePrice = 0 }) {
  return side === 'BUY' ? price + spreadPrice + slippagePrice : price - slippagePrice - spreadPrice;
}

function applyExitSlippage({ side, price, spreadPrice = 0, slippagePrice = 0 }) {
  // Closing a long is a sell, and vice versa, so the adjustment inverts.
  return side === 'BUY' ? price - spreadPrice - slippagePrice : price + slippagePrice + spreadPrice;
}

function commissionFor({ lot, commissionPerLot = 0 }) {
  return lot * commissionPerLot;
}

function pnlFor({ side, entryPrice, exitPrice, lot, contractSize }) {
  const direction = side === 'BUY' ? 1 : -1;
  return (exitPrice - entryPrice) * direction * lot * contractSize;
}

module.exports = { applyEntrySlippage, applyExitSlippage, commissionFor, pnlFor };
