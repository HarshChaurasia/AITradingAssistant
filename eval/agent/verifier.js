/**
 * The gate between a claim and an answer.
 *
 * The agent may believe whatever it likes; it may only SUBMIT a verdict the
 * measurements it actually took will support. This is deliberately not a
 * second opinion from another model - it is code, so it cannot be talked
 * round, and it never sees the ground-truth label, so it cannot leak the
 * answer.
 *
 * The standard is the one a person reviewing a strategy would insist on:
 *
 *   1. You looked out-of-sample. An in-sample result is a description of the
 *      past, not a prediction.
 *   2. You paid the broker. A result measured at zero cost is not tradeable.
 *   3. If you are claiming an edge, the cost-charged out-of-sample run is
 *      actually profitable, over enough trades to be more than a handful of
 *      lucky ones.
 *
 * Note what it does NOT do: it never says which verdict is right. A run that
 * clears the bar by a hair still leaves the judgement - is +0.4% over 21
 * trades an edge, or noise? - entirely with the agent.
 */

const MIN_TRADES = 20;

function verify({ verdict, ledger, costModel }) {
  const outOfSample = ledger.filter((r) => r.window === 'out_of_sample');
  const paid = outOfSample.filter((r) => r.costModel === costModel);

  if (outOfSample.length === 0) {
    return {
      supported: false,
      reason:
        'No out-of-sample backtest was run. An in-sample result describes bars '
        + 'the parameters were chosen on, so it cannot support a verdict about '
        + 'future behaviour. Run the out_of_sample window and resubmit.'
    };
  }

  if (paid.length === 0) {
    return {
      supported: false,
      reason:
        `No out-of-sample backtest was run at the case's own cost model `
        + `('${costModel}'). A result measured without spread, slippage and `
        + 'commission is not a result that can be traded. Re-run it with costs '
        + 'charged and resubmit.'
    };
  }

  if (verdict === 'EDGE') {
    const profitable = paid.filter((r) => r.netProfit > 0 && r.trades >= MIN_TRADES);
    if (profitable.length === 0) {
      const best = paid.reduce((a, b) => (b.netProfit > a.netProfit ? b : a));
      return {
        supported: false,
        reason:
          'The verdict is EDGE, but no out-of-sample run at the real cost model '
          + `is profitable over at least ${MIN_TRADES} trades. The best one `
          + `returned ${best.returnPct}% over ${best.trades} trades. Either `
          + 'produce a run that clears that bar, or the honest answer is NO_EDGE.'
      };
    }
    return {
      supported: true,
      reason:
        `Supported by ${profitable.length} out-of-sample run(s) at the real `
        + `cost model, best ${Math.max(...profitable.map((r) => r.returnPct))}%.`
    };
  }

  return {
    supported: true,
    reason: `Supported by ${paid.length} out-of-sample run(s) at the real cost model.`
  };
}

module.exports = { verify, MIN_TRADES };
