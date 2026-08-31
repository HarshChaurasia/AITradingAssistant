# How a study runs

What happens between pressing **Run study** and a combination being allowed to
trade, and why each step is shaped the way it is.

The short version: a study searches for parameters on the first half of the
history, scores the winner once on the third quarter and once on the fourth,
and promotes nothing unless both pass. Everything below is an elaboration of
why that ordering is not negotiable.

---

## 1. The problem the design exists to solve

> *"Change the parameters and run it again until it becomes profitable."*

Done directly, that is a machine for manufacturing false confidence. Score two
hundred parameter sets against one out-of-sample window, keep whichever clears
the bar, and roughly ten will clear it **by chance alone** — then fail
identically on real money, because chance does not repeat.

This is not a small effect at the edges. It is the single commonest way an
automated trading system loses money while its dashboard reports success.

The defence is structural rather than statistical: **no number that decided
anything may also be used to judge the thing it decided.**

---

## 2. The three windows

A study takes one year of bars for one symbol and one timeframe, and cuts it
into three consecutive slices. Consecutive, not shuffled — markets have
regimes, and a random split lets a strategy learn from next week to trade this
one.

| Window | Share | May be used for | Never used for |
|---|---|---|---|
| `optimise` | 50% | Ranking candidates, any number of times | Anything that reaches a verdict |
| `validate` | 25% | Scoring the winner. **Once.** | Choosing between candidates |
| `holdout` | 25% | Confirming the winner. **Once, ever.** | Anything at all before that |

If a ranking ever touches `validate`, that window's profit factor stops being
an estimate and becomes *the maximum of N draws* — a different and much larger
quantity. There is no correction that recovers the estimate afterwards. The
only defence is not doing it.

Code: `DEFAULT_SPLIT` in `server/src/backtest/runner.js`.

---

## 3. The search

### 3.1 What may be varied

Each strategy declares a search space in
`server/src/backtest/search-space.js`. Two rules govern every entry:

**Only parameters with a mechanism behind them.** Widening a stop changes how
often price reaches it — that is a reason. Sweeping an RSI period from 13 to 15
because 14 failed is a lottery ticket, and every extra ticket raises the chance
of an accidental winner.

**Bounds a human would defend.** A 0.2× ATR stop sits inside the spread on
every instrument here, so including it only adds a candidate that cannot work
but can still get lucky.

The size of the space *is* the multiple-testing exposure, so nothing may change
it silently. A space is filtered to parameters the strategy actually has: a
search that sets a parameter the strategy ignores reports fifty candidates
while exploring ten.

### 3.2 Iterations

```
iteration 1   the full declared grid          (~150-450 candidates)
iteration 2   neighbours of the best, plus midpoints between them
iteration 3   neighbours of the new best
...
iteration 5   (default)
```

Refinement is what makes iterating cheap: the first pass is broad and the rest
are local, so the trial count grows slowly instead of multiplying. Neighbours
never extend beyond the declared bounds, and midpoints are only invented
between numbers — there is nothing between `true` and `false`.

Candidates already scored are skipped. Re-scoring one would cost time and,
worse, inflate the trial count with trials that were never independent.

Seeds carry the best result seen **anywhere**, not merely in the latest
iteration: a refinement can be worse than what it refined, and silently
accepting that would let the search walk downhill.

### 3.3 How candidates are ranked

Ranking happens on the `optimise` window and nowhere else.

- A candidate below a minimum trade count is **unrankable**, not bad. Three
  winners and no losers is a profit factor of Infinity, and it once sorted to
  the top of a sweep table above a strategy with 300 trades and a real edge.
  The floor is half the verdict threshold, scaled by timeframe.
- Profit factor decides; expectancy breaks ties. Between two strategies that
  win the same proportion of what they lose, the one that makes more per trade
  is the one worth trading.

Code: `rankKey` and `optimiseMinTrades` in `server/src/backtest/optimiser.js`.

---

## 4. The verdict

Once the search finishes, the winner is scored **once** on `validate` and
**once** on `holdout`. Not "scored, adjusted, scored again" — that is the same
leak wearing a hat.

A combination is `promotable` only if **both** pass the thresholds:

| Threshold | Default | Note |
|---|---|---|
| profit factor | ≥ 1.3 | |
| expectancy | > 0 | |
| max drawdown | ≤ 15% | |
| trades | scaled by timeframe | M5 60 … D1 8 |

The trade minimum scales because a flat 50 is unreachable by arithmetic rather
than by merit on slow bars: a year of D1 is about 260 bars, a quarter of that
is 65, and no strategy takes 50 trades in 65 bars. Those runs were previously
reported as failures beside genuinely bad strategies, which hid which was
which.

Code: `MIN_TRADES_BY_TIMEFRAME`, `evaluateThresholds` in `runner.js`.

---

## 5. What a study reports, and how to read it

Four numbers, in this order:

**1. `holdoutPassed`** — the only one that can promote. Everything else has
been selected against.

**2. `trials`** — a pass after 4 candidates and a pass after 400 are different
claims, and the profit factor describes neither. The lab's summary says the
total out loud for this reason.

**3. `robustness`** — do the winner's *neighbours* also work? This is the
question no single metric answers and the one that separates an edge from an
accident. A parameter set that is excellent while everything adjacent is bad is
a spike in noise; the market will not hand back that exact spike. One sitting
in a plateau of decent results is a real effect that happens to peak there.
`robustness.spike === true` says so outright.

Measured on the `optimise` window, where every candidate was already scored —
reaching into `validate` for it would leak the window the verdict depends on.

**4. The three profit factors side by side.** The shape that matters:

```
optimise  PF 1.17  trades 180
validate  PF 1.33  trades  87   PASS
holdout   PF 0.76  trades  90   fail    <- macd-trend BTCUSD M15, measured
```

That combination passes validation and falls apart on data nothing chose it
for. Under a two-window scheme it would have been promoted and lost money. It
is the reason the third window exists.

---

## 6. Costs, which decide more than the parameters do

Every study charges the **per-symbol broker spread**, read from the symbol
itself. One number cannot serve a grid: 0.0002 is about right for EURUSD and
effectively zero against BTCUSD's twelve dollars, so a single spread silently
flatters whichever instruments are priced in larger units — measured, BTCUSD
reads 0.85 on a forced 0.0002 and 0.78 on its own spread.

Commission is **zero**, because this account pays the spread and nothing else.
At $7/lot the same pooled profit factor fell from 0.78 to 0.62 — a cost that is
not being charged should not be deciding which strategies pass.

A wrong cost does not merely shift every result. It changes **which candidate
wins**, which is worse, because the study then optimises for a market that does
not exist.

---

## 7. After the study: the lifecycle

```
research ──lab clears validate+holdout──▶ backtest ──confirmation──▶ enabled
   ▲                                                                    │
   └────── demoted: live PF < 1.0 over at least 20 closed trades ───────┘
```

Promotion lands at **backtest**, not in service. The confirmation run that
follows is *not* a repeat of the study: the study searched, so its holdout was
reached after heavy selection, while confirmation runs **one fixed parameter
set across the whole period with no search at all**. It catches what the study
structurally cannot — a winner that only worked in the quarter it landed on.

It must be judged on the full period. The first implementation took the run's
own verdict, which comes from its validate window — the same slice the study
had already scored — so the step ran and proved nothing. It was caught only
because the numbers came back identical: 1.54 on 29 trades, to the decimal.
Judged honestly, the same two combinations read **1.74 over 120 trades** and
**1.82 over 140**.

### Re-running the backtest for something already trading

**Strategies → Enabled → Re-run backtest**, or
`POST /api/lab/promotions/:id/confirm` with `{"force": true}`.

The ordinary confirmation path deliberately does nothing for a combination
already in service - a scheduler that re-backtested every live combination
every minute would spend its life doing it. `force` is the explicit ask.

It runs exactly the same thing a first confirmation runs: the pinned
parameters, fixed, over the last year, with no search. **A failed re-check
demotes**, which is the point rather than a side effect - the evidence behind a
promotion was gathered on history that ends where the live period begins, and a
year later it describes a different market. A combination that no longer passes
should not be trading, whoever pressed the button.

Nothing appears in the **Backtest** tab once it has been promoted; that queue
holds only combinations awaiting their first confirmation.

Promotion is per **strategy + symbol + timeframe**, with the parameters pinned.
The signal generator trades the promoted numbers, not the shipped defaults —
macd-trend clears its holdout on XAUUSD H1 with a 5.25 ATR target and fails at
the shipped 3.0, so trading the default while citing the promoted result would
attach a backtest's confidence to a bet it never covered.

---

## 8. Cost and scale

| Scope | Combinations | Parameter sets | Wall clock |
|---|---|---|---|
| One strategy, one symbol, one timeframe | 1 | ~100–450 | 1–30s |
| Full grid, 5 symbols, M5–H4 | 325 | ~116,000 | ~30 min |

Sequential on purpose. Each study loads its own candle series and scores
hundreds of candidates against it; running several at once turns a CPU-bound
job into a memory-bound one and makes the progress meaningless.

Studies are recorded whatever they conclude, failures included. Knowing that
macd-trend on BTCUSD M15 was searched over 83 candidates and died on the
holdout is what stops the same search being run next month and reported as
news.

---

## 9. What a failure means

Failure is the normal outcome. Measured over a year on real broker spreads,
pooled across four symbols and four timeframes, **every strategy in this repo
sits below break-even** — best 0.96. The first full grid produced **2
promotable combinations out of 325**, which is close to what chance yields at
this bar.

When a study fails, in order of what is worth doing:

1. **Check the costs.** A wrong spread or a commission the account does not pay
   changes which candidate wins, not just the final number.
2. **Check the trade count.** A failure on trades is a statement about the
   clock, not the strategy.
3. **Check whether the whole neighbourhood failed** or only the winner. A
   strategy whose entire parameter surface sits under 1.0 does not have a
   tuning problem.
4. **Then stop.** Each additional search raises the chance of an accidental
   pass. An honest "this does not work" is worth more than a tuned number that
   will not survive contact with money.

---

## Where the code lives

| File | Responsibility |
|---|---|
| `server/src/backtest/search-space.js` | What may be varied, and between what bounds |
| `server/src/backtest/optimiser.js` | The search, the ranking, the two scored windows |
| `server/src/backtest/lab.js` | Running the grid, recording studies |
| `server/src/backtest/runner.js` | Windows, thresholds, a single backtest |
| `server/src/strategies/promotions.js` | Studies, promotions, pinned parameters |
| `server/src/strategies/lifecycle.js` | Stages, confirmation, demotion |
| `.claude/skills/strategy-research/SKILL.md` | The working loop and its anti-patterns |
