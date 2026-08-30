# Evaluation method

**Written and committed before the comparison was run.** The success bar below
was fixed while the result was still unknown, so it could not be adjusted
afterwards to fit whatever came out. `git log docs/EVALUATION.md` timestamps
this against `eval/results/latest.json`.

## The decision being measured

The user is a retail trader holding a strategy and deciding whether to fund it.
Their decision is binary: trade it, or don't. So the task given to both the
baseline and the agent is binary and identical:

> Does this strategy have an edge on this instrument after costs?
> Answer `EDGE` or `NO_EDGE`.

## Primary metric

**Verdict accuracy** over sixteen cases whose correct answer is fixed by
construction and re-proved on every run by `npm run eval:cases`.

Accuracy alone is not sufficient, because the two ways of being wrong are not
equally expensive to the user, so two secondary metrics carry real weight:

| Metric | Definition | Why it matters |
| --- | --- | --- |
| **False-edge rate** | Of the 12 NO_EDGE cases, the share called `EDGE` | The error that costs money. The trader funds a dead strategy and learns from their balance two months later. Plain accuracy hides this. |
| **Missed-edge rate** | Of the 4 EDGE cases, the share called `NO_EDGE` | The error that costs opportunity. Cheap by comparison, but a system that says "no" to everything is worthless and would otherwise score 75% on this set. |
| **Cost per case** | USD, from list prices and returned token counts | An improvement nobody can afford to run is not one. |

The asymmetry is deliberate and matches the user's real exposure: being told to
skip a good strategy costs a missed opportunity; being told to fund a bad one
costs the account.

## What a good final result looks like

Fixed in advance. For the agent to be worth putting in front of the intended
user, all three must hold:

1. **Accuracy at least 80%** - 13 of 16 or better.
2. **False-edge rate at most 10%** - at most 1 of the 12 NO_EDGE cases. It
   should almost never tell someone to fund a strategy that will lose.
3. **Missed-edge rate at most 25%** - at most 1 of the 4 EDGE cases. This
   exists to stop condition 2 being satisfied by refusing everything.

A result that clears 1 and 2 but fails 3 is a pessimist, not a validator, and
should be reported as such.

No prediction is recorded here for the baseline. It gets the same cases, the
same question and the same model, and whatever it scores is the comparison.

## The eval set

Sixteen cases, four archetypes, all synthetic and generated from fixed seeds.

| Archetype | Cases | Truth | What it tests |
| --- | --- | --- | --- |
| `planted-momentum` | 4 | EDGE | Can it recognise a real edge? Returns 11.6%-79.5% out-of-sample after costs. |
| `random-walk` | 4 | NO_EDGE | Can it decline to find structure in noise? |
| `cost-trap` | 4 | NO_EDGE | Direction is genuinely predictable; the move is smaller than the round-turn cost. |
| `overfit-trap` | 4 | NO_EDGE | 147%-221% in-sample, nothing out-of-sample. |

Why synthetic: on real candles, "does this have an edge" has no ground truth -
that is exactly why the question is worth asking, and exactly why nothing can
be graded on it. The generator decides the answer first and draws prices
consistent with it. See `IMPROVEMENT-CHANGELOG.md` for what it took to make
those labels trustworthy.

Note the shape of the set: the *most impressive-looking* cases are the ones
where the right answer is "no". The overfit traps show the highest in-sample
returns of anything in the set, several times higher than the genuine edges.
Nothing can be read off the headline number.

## The challenging case

**`cost-trap`** is the designated hard case, and it was the hardest to build.

The strategy is genuinely right about direction. Out-of-sample with no costs
charged it returns **+7.1% to +18.9%**. Charged at the instrument's real
spread, slippage and commission, the same trades return **-3.9% to -12.0%**.
Every honest-looking signal is there: a positive expectancy, a real pattern,
an equity curve that rises. The only thing separating it from a fundable
strategy is a cost model.

What it revealed, before any model was involved: a case is only a test if the
system under test will actually act on it. The first three constructions of
this trap produced **zero trades**. Designing the price shape and assuming the
strategy would trade it was backwards - the case has to be built against the
entry conditions. That is in the changelog as a removed experiment.

`overfit-trap-1` and `overfit-trap-4` are the borderline cases in the other
direction: out-of-sample they return **-1.16%** and **-1.61%**, near enough to
flat that the verdict rests on judgement rather than an obvious sign. The
verifier deliberately does not resolve these - it only requires that the
measurement was taken.

## Running it

    npm run eval:cases      # re-prove the labels
    npm run eval            # both arms, same cases, same model

Full commands, versions and expected output: [REPRODUCTION.md](REPRODUCTION.md).
