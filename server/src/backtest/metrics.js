/**
 * Summary statistics for a list of closed trades.
 *
 * Max drawdown is measured peak-to-trough on the running equity curve, not as
 * the worst single trade: the question a drawdown answers is whether the
 * account would have survived the sequence, not any one loss.
 */

function computeMetrics(trades, { startingBalance = 0 } = {}) {
  const equityCurve = [startingBalance];

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    const pnl = trade.pnl;
    if (pnl >= 0) {
      grossProfit += pnl;
      wins += 1;
    } else {
      grossLoss += -pnl;
      losses += 1;
    }

    balance += pnl;
    equityCurve.push(balance);

    if (balance > peak) peak = balance;
    const drawdown = peak - balance;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
    }
  }

  const count = trades.length;
  const netProfit = grossProfit - grossLoss;
  const expectancy = count > 0 ? netProfit / count : 0;

  let sharpe = 0;
  if (count > 1) {
    const mean = expectancy;
    const variance = trades.reduce((acc, t) => acc + (t.pnl - mean) ** 2, 0) / (count - 1);
    const stdDev = Math.sqrt(variance);
    sharpe = stdDev > 0 ? mean / stdDev : 0;
  }

  let profitFactor = 0;
  if (grossLoss > 0) profitFactor = grossProfit / grossLoss;
  else if (grossProfit > 0) profitFactor = Infinity;

  return {
    trades: count,
    wins,
    losses,
    winRatePct: count > 0 ? (wins / count) * 100 : 0,
    grossProfit,
    grossLoss,
    netProfit,
    profitFactor,
    expectancy,
    averageWin: wins > 0 ? grossProfit / wins : 0,
    averageLoss: losses > 0 ? grossLoss / losses : 0,
    maxDrawdown,
    maxDrawdownPct,
    sharpe,
    equityCurve
  };
}

module.exports = { computeMetrics };
