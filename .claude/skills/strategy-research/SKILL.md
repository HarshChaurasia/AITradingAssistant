---
name: strategy-research
description: Use when adding a trading strategy, tuning one that fails its backtest, deciding whether a strategy may trade demo or live, or running the parameter lab. Covers the add-optimise-validate-holdout-promote loop and the anti-overfitting rules that make its verdicts mean anything.
---

# Strategy Research

The loop that turns an idea into a strategy allowed to trade: **add → study →
validate → holdout → promote**. Every step exists to stop one specific way of
fooling ourselves, and skipping any of them produces a number that looks like
evidence and is not.

## The rule everything else serves

**A backtest result is only worth what the data behind it was never allowed to
influence.**

Search two hundred parameter sets against a window and keep whichever passes,
and roughly ten will pass by chance alone — then fail identically on real
money, because chance does not repeat. This is not a small effect. It is the
single commonest way an automated trading system loses money while its
dashboard reports success.

So the history is cut three ways, and each window has exactly one job:

| Window | Share | May be used for | Never used for |
|---|---|---|---|
| `optimise` | 50% | Ranking candidates. Any number of times. | Anything that reaches a verdict |
| `validate` | 25% | Scoring the winner. **Once.** | Choosing between candidates |
| `holdout` | 25% | Confirming the winner. **Once, ever.** | Anything at all before that |

If a ranking ever touches `validate`, that window's number stops being an
estimate and becomes the maximum of N draws — a different and much larger
quantity. There is no way to correct for this after the fact. The only defence
is not doing it.

## Running the loop

```bash
# One combination, five refinement iterations
node -e "require('dotenv').config({path:'server/.env'});
  require('./server/src/backtest/optimiser').optimiseStrategy({
    strategyName: 'smart-money', symbolId: 13171, timeframe: 'H1',
    iterations: 5, options: { from: '2025-08-31', startingBalance: 133765 }
  }).then(r => console.log(JSON.stringify(r, null, 2)))"
```

Or the whole grid, from the dashboard: **Backtests → Strategy Lab → Run
study**. `POST /api/lab/studies` starts it, `GET /api/lab/studies` polls it.

A grid study of 11 strategies × 5 symbols × 4 timeframes scores tens of
thousands of parameter sets and takes minutes. That is the intended cost.

## Reading a study

Four numbers decide, and they are read in this order:

1. **`holdoutPassed`** — the only one that can promote. Everything else has
   been selected against.
2. **`trials`** — a pass after 4 candidates and a pass after 400 are different
   claims. The profit factor describes neither.
3. **`robustness.median`** vs the winner's profit factor — do the winner's
   *neighbours* also work? A parameter set that is excellent while everything
   adjacent is bad is a spike in noise; the market will not hand back that
   exact spike. `robustness.spike === true` says so outright.
4. **The three profit factors side by side.** The shape that matters:

```
optimise  PF 1.17  trades 180
validate  PF 1.33  trades  87   PASS
holdout   PF 0.76  trades  90   fail     <- measured, macd-trend BTCUSD M15
```

That combination passes validation and falls apart on data nothing chose it
for. Under a two-window scheme it would have been promoted and lost money. It
is the reason the third window exists.

## Promotion

```bash
POST /api/lab/studies/:id/promote
```

Refused unless the study cleared **both** validate and holdout. Do not reach
for `force: true` to get past that — the refusal is the feature.

Promotion is recorded per **strategy + symbol + timeframe**, with the winning
parameters pinned. Measured on this account, smart-money reaches a profit
factor of 1.40 on BTCUSD H1 and 0.43 on BTCUSD M5: the same code, the same
instrument, one edge and one way to pay the spread. No per-strategy flag can
say that, so it says the wrong thing about one of them whichever way it is
set.

Enforcement is a separate switch, `requirePromotedCombination` in risk
settings, off by default. Turning it on with an empty promotion table halts
every trade on the account — correct, and a terrible surprise. Turn it on once
something is promoted.

## Adding a strategy

1. Write `server/src/strategies/<name>.js` against the existing contract —
   `prepare`, `evaluate(candles, index, params, context)`, optional `explain`.
   The agreement test replays every registered strategy over every bar and
   pins the contract; a new one joins it automatically.
2. Register it in `registry.js`.
3. Declare a search space in `backtest/search-space.js`. **Only parameters
   with a mechanism behind them.** Widening a stop changes how often price
   reaches it — that is a reason. Sweeping an RSI period from 13 to 15 because
   14 failed is a lottery ticket, and every extra ticket raises the chance of
   an accidental winner.
4. Study it across the grid. Expect it to fail. Nine of the eleven strategies
   here have never cleared a holdout.

## What a failure means

Failure is the normal outcome and it is information. Measured over a year on
real broker spreads, pooled across four symbols and four timeframes, **every**
strategy in this repo sits below break-even (best: trend-breakout, 0.96).

When a study fails, in order of what is actually worth doing:

- **Check the costs first.** Commission at $7/lot took a pooled profit factor
  from 0.78 to 0.62 on data where the account pays no commission at all. A
  wrong cost does not merely shift results, it changes which candidate wins.
- **Check the trade count.** `minTradesFor` scales with timeframe because a
  flat 50 is unreachable on D1 by arithmetic rather than by merit.
- **Check whether the whole neighbourhood failed** or only the winner. A
  strategy whose entire parameter surface is under 1.0 does not have a tuning
  problem.
- **Then stop.** Do not keep searching a strategy that has failed a wide
  search. Each additional search raises the chance of an accidental pass, and
  the honest report of "this does not work" is worth more than a tuned number
  that will not survive contact with money.

## Anti-patterns

| Thought | Why it is wrong |
|---|---|
| "It nearly passed — one more parameter tweak" | Every extra trial raises the chance of an accidental pass. The near-miss is the answer. |
| "The holdout failed but validate was strong, promote it" | Validate chose the winner. Only the holdout did not. |
| "Let me re-split the data and try again" | Re-splitting until a split passes is the same leak with extra steps. |
| "It passed, so it works" | It passed *once*, on one window, after N trials. Report N. |
| "Use one spread for the whole sweep" | 0.0002 is right for EURUSD and effectively zero against BTCUSD's $12. Measured: it flatters BTCUSD from 0.78 to 0.85. |
| "Promote the strategy" | Promote the combination. The same code is an edge on one timeframe and noise on another. |
