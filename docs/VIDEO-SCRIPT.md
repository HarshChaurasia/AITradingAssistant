# Solution video - shot list

Five minutes maximum. The brief asks for five beats in order: the problem and
the simple baseline, one realistic execution start to finish, the final
comparison, a brief pass over the changelog, and the change that contributed
most alongside one experiment that was removed.

Timings below add to 4:45, leaving room to breathe. Record the terminal at a
readable font size; the numbers on screen are the point.

---

### 0:00-0:40 - The problem

**On screen:** the dashboard's Backtests view, one strategy with a rising
equity curve.

**Say:** A retail trader has a rule that looks good and is about to fund it.
Deciding whether it is worth real money is not a charting problem, it is an
evidence problem - and every way of getting it wrong looks like success at the
time. In-sample results describe the past. Costs are charged on every round
turn, so a strategy can be right about direction and still drain the account. A
good number at one parameter setting is usually a coincidence.

Getting it wrong is slow and expensive: you fund the account and learn the
answer from your balance two months later.

### 0:40-1:15 - The baseline

**On screen:** `eval/baseline.js`, then the prompt it builds.

**Say:** The obvious first attempt: describe the strategy, the cost model and
the price history to a capable model, and ask. One prompt, no tools. It has the
information. What it cannot do is measure.

### 1:15-1:45 - The eval set, and why it is synthetic

**On screen:** `npm run eval:cases`, the sixteen-row table, ending in *All 16
cases support their ground-truth label*.

**Say:** On real candles, "does this have an edge" has no ground truth - which
is why it is worth asking, and why nothing can be graded on it. So the
generator decides the answer first and draws prices to match. Sixteen cases: a
real edge, pure noise, an edge too small to survive costs, and one that exists
only in-sample.

Point at the numbers: the overfit traps return 147 to 221 percent in-sample.
The genuine edges return nine to twenty. **The most impressive-looking cases are
the ones where the right answer is no.**

### 1:45-3:00 - One realistic execution

**On screen:** `npm run eval -- --cases cost-trap-1 --mode agent`, live.

**Say, following the tool calls as they appear:** It describes the case and
notices the cost model. It runs the backtest with no costs charged - profitable.
It runs the same trades with the broker's spread, slippage and commission -
negative. It submits NO_EDGE.

That third call is the whole system. The strategy is genuinely right about
direction; the move is just smaller than the cost of capturing it.

**Then open the trajectory file** and show the `verifier` entry.

### 3:00-3:45 - The comparison

**On screen:** `eval/results/latest.md`.

**Say:** Same sixteen cases, same question, same model for both arms. Read the
accuracy row, then the false-edge row - the share of dead strategies called
tradeable, the error that actually costs money. Note the cost per case.

Mention that the success bar in `docs/EVALUATION.md` was committed *before* the
run, and the git timestamps prove it.

### 3:45-4:20 - The changelog, and the biggest contributor

**On screen:** `IMPROVEMENT-CHANGELOG.md`.

**Say:** Then the single change that mattered most, with its number from the
results table.

### 4:20-4:45 - The experiment that was removed, and the hot take

**Say:** The cost trap was first built as a mean-reverting oscillation. It
produced zero trades at every setting tried. Instrumenting it showed why: RSI
reached oversold eighty-five times, but never while price was above the trend
EMA - the strategy is "buy the dip in an uptrend", not pure reversion, so a
series oscillating around a flat level can never trigger it. Three
constructions, zero trades.

The lesson, and it applies well beyond trading: **a test case is only a test if
the system under test will actually act on it.** I designed the input's shape
and assumed the system would engage with it. The case has to be built against
the trigger conditions, not the appearance.

Close with the hot take from the changelog.

---

## Before recording

    npm run eval:test     # 12 pass
    npm run eval:cases    # 16 labels hold
    npm run eval          # produces latest.md and the trajectories

Have `eval/results/latest.md` and one `cost-trap` trajectory open in tabs. Do
not re-run the full eval on camera - it takes minutes and costs money; run the
single case live and show the finished table.
