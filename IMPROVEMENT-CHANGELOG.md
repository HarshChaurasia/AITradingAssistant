# Improvement changelog

How this solution evolved, what each change was trying to fix, and what the
evidence said. Experiments that were removed are included, because what they
taught is part of the result.

Every number below was measured by a command in this repo. Nothing is
estimated. Where a result is not yet measured it says so.

---

## Part 1 - Building an instrument that can tell right from wrong

Before the agent could be graded, the eval set had to be trustworthy. These
four entries are about the measuring instrument, not the solution, and they
consumed most of the build. That turned out to be the right allocation: three
of the four found a real defect that would have corrupted the headline number.

### Baseline for the instrument: assume the generator's intent is the label

**What and why.** Sixteen synthetic price series across four archetypes - a
real edge, a random walk, an edge too small to survive costs, and one present
only in-sample. The generator knows what it drew, so its intent was taken as
ground truth.

**Evidence.** `node eval/verify-cases.js` measured every case against the
property its label claimed. **6 of 16 failed.**

- All four `cost-trap` cases produced **0 trades** - the strategy never fired
  on that series at all, so the case tested nothing.
- `overfit-trap` seeds 1 and 4 paid **+4.35%** and **+12.93%** out-of-sample.
  Both were labelled NO_EDGE. An agent that measured correctly and answered
  "no edge" would have been marked **wrong**.

**Decision.** Kept the verifier permanently and rebuilt the generator around
it. **Learning:** an unverified label does not fail loudly - it silently
converts a correct answer into a scored error, and the whole comparison becomes
noise wearing a percentage sign.

### Iteration 1 - cost trap as a mean-reverting oscillation - REMOVED

**What and why.** The trap needed a series that is genuinely predictable but
whose move is smaller than the round-turn cost. A mean-reverting wiggle on a
slowly wandering level looked like the natural construction, paired with the
`mean-reversion` strategy.

**Evidence.** **0 trades** at every setting tried - wiggle sigma 0.00002 to
0.0002, reversion 0.005 to 0.05. Instrumenting the entry conditions explained
it: RSI reached oversold **85 times**, but *never* while price was above the
trend EMA. The strategy is "buy the dip in an uptrend", not pure reversion, so
a series oscillating around a flat level can never trigger it. A second attempt
using a sine oscillation on a trending level also produced **0 trades**.

**Decision.** Removed both. The trap became a *weak* momentum drift - the same
generator as the real edge with drift reduced from 0.00008 to 0.00005, priced
against a wider spread.

**Learning:** a test case has to be one the system under test will actually
act on. Designing the price *shape* and assuming the strategy would trade it
was backwards; the case has to be designed against the entry conditions. This
cost more time than any other single mistake in the build.

### Iteration 2 - the planted edge was too obvious

**What and why.** With the generator fixed, all sixteen labels held. But the
EDGE cases were returning **336% to 613%** out-of-sample.

**Evidence.** At that magnitude the answer is visible by inspection. A baseline
with no tools could separate EDGE from NO_EDGE on the shape of the price series
alone, which would measure nothing about whether the agent can *validate* a
strategy.

**Decision.** Cut drift from 0.00028 to 0.00008 and capped the label band at
[8%, 80%]. Result: EDGE cases now return **11.6% to 79.5%** out-of-sample,
while the `overfit-trap` cases show **147% to 221% in-sample**.

**Learning:** in-sample magnitude now anti-correlates with the right answer -
the most impressive-looking cases are the ones where the answer is "no". An
eval whose answer is legible without the tool cannot measure the tool.

### Iteration 3 - seeds are searched, not chosen

**What and why.** Individual seeds still failed their property by luck.
Hand-picking passing seeds would be cherry-picking.

**Evidence.** `eval/find-seeds.js` scans seeds in order and keeps the first
four per archetype whose property is *measurably* true, recording them in
`eval/case-seeds.json`. `verify-cases.js` re-proves all sixteen on every run.

**Decision.** Kept. The search is in the repo, the criteria are shared with the
verifier in `eval/lib/truth-checks.js` so the two cannot drift apart, and the
whole set regenerates with one command.

**Learning:** "we picked seeds that worked" is only honest if the criterion is
written down, applied mechanically, and re-checked. Then it is case
construction rather than cherry-picking.

---

## Part 2 - The solution

> **Not yet measured.** These runs need an `ANTHROPIC_API_KEY` in
> `server/.env`. The commands are `npm run eval -- --mode baseline` and
> `npm run eval`. Results land in `eval/results/latest.md` and this section
> will be filled from that file - no number will be written here that was not
> produced by a run.

| Stage | What and why | Evidence | Decision |
| --- | --- | --- | --- |
| Baseline | One direct prompt: the strategy rules, the cost model and a 200-point price series, asked for a verdict. No tools, no way to measure. | pending | pending |
| Iteration 4 | Give the model the backtest engine as tools - run a window, charge or waive costs, sweep a parameter. | pending | pending |
| Iteration 5 | Add the verifier: a verdict must rest on an out-of-sample run at the real cost model, and an EDGE claim on one that actually made money over 20+ trades. | pending | pending |
| Final | pending | pending | pending |

The primary metric is **verdict accuracy** over the sixteen cases. Two
secondary metrics carry equal weight in the report:

- **False-edge rate** - how often a dead strategy is called tradeable. This is
  the error that costs the user money, and plain accuracy hides it.
- **Cost per case** - an improvement nobody can afford to run is not one.

---

## Main failure mode

> Pending the run. It will be written from what actually goes wrong in
> `eval/results/trajectories/`, not from what seems likely.

## Hot take

> Pending the run.
