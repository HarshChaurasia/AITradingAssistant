# Agent design

Which design choices were made, what each was meant to fix, and where each one
lives in the code. The brief asks which choices helped the agent reach the goal
reliably; this is that answer, with file references.

## The shape of the problem

The question - *does this strategy have an edge after costs?* - is not a
knowledge question. No amount of reasoning about a price chart answers it,
because the answer depends on measurements that have to be taken: an
out-of-sample replay, with a broker's costs charged, over enough trades to be
more than luck.

That single observation drove every decision below. The agent is not built to
know more. It is built so that it **cannot answer without having measured**.

## Choice 1 - tools over the existing engine, not a new one

`eval/lib/backtest.js` calls `server/src/backtest/engine.js` - the same engine
the live system trades on - rather than a simpler replay written for the eval.

**Why.** The engine's honesty rules are the reason a number means anything: a
signal on bar *i* fills at the open of bar *i+1*, never at bar *i*'s close; when
one bar spans both the stop and the target the stop is assumed to hit first;
position sizing is the same module the live risk engine uses. A second engine
written for the eval would quietly disagree with the one that trades, and the
agent's evidence would stop describing the user's actual system.

**Effect.** The agent's evidence and the operator's are the same artefact. A
verdict can be re-derived by hand from the dashboard.

## Choice 2 - a tool surface shaped like the reasoning, not like the API

Four tools in `eval/agent/tools.js`:

| Tool | What it exists for |
| --- | --- |
| `describe_case` | The instrument, the windows, and **the cost model that will be charged** |
| `describe_strategy` | Entry rules in words, so the agent reasons about a rule rather than a name |
| `run_backtest` | One replay: choose the window, and choose whether costs are charged |
| `sweep_parameter` | The same backtest across several values of one parameter |

Two details carry most of the weight.

`run_backtest` exposes **`costModel: 'zero'`** as a first-class option. That
looks like a way to cheat, and it is the opposite: it lets the agent ask "is
this profitable only because I did not pay for it?" - the exact question the
cost trap turns on. A tool surface that hid zero-cost runs would have hidden
the discriminating experiment.

`sweep_parameter` is capped at eight values per call. Without a cap, one call
could run hundreds of backtests and bury the signal in output.

## Choice 3 - verification in code, not a second opinion

`eval/agent/verifier.js` gates every verdict. It enforces three rules:

1. You ran an out-of-sample backtest.
2. You ran one at the case's **real** cost model, not at zero cost.
3. If you are claiming `EDGE`, that cost-charged run actually made money over
   at least 20 trades.

**Why code and not a critic model.** A second model can be argued round by a
confident first one, adds a failure mode of its own, and costs a call per case.
Code cannot be persuaded. It is also auditable: a judge can read thirty lines
and know exactly what standard was applied.

**What it deliberately does not do.** It never says which verdict is correct
and never sees the ground-truth label. A run clearing the bar by a hair still
leaves the judgement with the agent - is +0.4% over 21 trades an edge, or
noise? On rejection the agent gets one revision, and the trajectory records
both attempts, so the report can separate *wrong* from *wrong and unevidenced*.

## Choice 4 - the ledger

Every backtest the agent runs is recorded in `tools.ledger`. The verifier reads
that ledger, not the agent's description of what it did.

**Why.** An agent asserting "I checked out-of-sample with costs" is a claim.
The ledger is a record. The difference matters exactly when the agent is
wrong - which is when the verifier needs to work.

## Choice 5 - instructions that teach method, never the answer

The system prompt names four principles a careful person would apply. It never
mentions the archetypes the eval set contains - no talk of cost traps, no
mention of overfitting as a category to look for. A prompt listing the four
things being tested would measure whether the agent can read a hint.

## The agent's instructions, verbatim

From `eval/agent/validator.js`:

> You are validating a trading strategy for someone deciding whether to risk
> real money on it.
>
> Answer one question: does this strategy have an edge on this instrument after
> costs?
>
> What that means in practice:
>
> - An in-sample result is a description of bars the strategy was already
>   looked at on. It is evidence about the past, not about the future. A result
>   out-of-sample is the one that predicts anything.
> - Costs are not a detail. Spread, slippage and commission are charged on every
>   round turn, and a strategy that captures less than it pays is a losing
>   strategy no matter how often it is right about direction.
> - A result that depends on an exact parameter value is usually a coincidence.
>   If neighbouring values fall apart, you found a lucky setting, not an edge.
> - A handful of trades tells you very little, however good it looks.
>
> Use the tools to measure whatever you need. When the evidence supports a
> conclusion, call submit_verdict.
>
> Say EDGE only if you would tell this person their money is more likely to
> grow than shrink. If the honest answer is that it will not, say NO_EDGE -
> that is a useful answer, not a failure.

The last paragraph is doing real work. Without it, a model asked to evaluate a
strategy tends to look for something positive to say, and twelve of the sixteen
correct answers on this set are negative.

## The baseline it is compared against

`eval/baseline.js` - one direct prompt with basic instructions, as the brief
describes. Same question, same case, same strategy rules, same cost model, same
model, and a 200-point price series. What it lacks is the ability to measure.

The baseline is given the best version of the simple approach, not a
weakened one: a downsampled series conveys the shape of 3000 bars better than
3000 raw OHLC rows would, so this is a fair comparison rather than a favourable
one.

## What was deliberately not built

- **No multi-agent orchestration.** One agent, one loop. The problem is a
  measurement problem, not a division-of-labour problem, and splitting it would
  have added components without adding evidence.
- **No memory across cases.** Each case is independent by design; carrying
  state between them would let case 9 be answered from case 3 rather than from
  measurement, which is the one thing this system exists to prevent.
- **No LLM in the live trading path.** The commentary endpoint in
  `server/src/ai/commentary.js` is advisory and is never parsed into a
  decision. A non-deterministic strategy cannot be backtested, and a strategy
  that cannot be backtested cannot be validated by anything here.
