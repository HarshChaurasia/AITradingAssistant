# Submission index

micro1 Agentic Workflows Hackathon. Everything the brief asks for, and where it
is.

## What this is

A retail trader is about to fund a strategy that looks good on a chart.
Deciding whether it is actually worth money requires measurements most people
skip: an out-of-sample replay, with a broker's real costs charged, over enough
trades to be more than luck.

This is an agent that will not answer the question without having taken those
measurements - and a way to prove it is right more often than a direct prompt.

## The four deliverables

### 1. Complete solution code and improvement changelog

| | |
| --- | --- |
| Intended user and their bottleneck | [README.md](README.md) |
| Improvement changelog | [IMPROVEMENT-CHANGELOG.md](IMPROVEMENT-CHANGELOG.md) |
| The agent, its tools and its verifier | `eval/agent/` |
| The agent's instructions, verbatim | [docs/AGENT-DESIGN.md](docs/AGENT-DESIGN.md) |
| The baseline | `eval/baseline.js` |
| The eval set and its ground truth | `eval/cases.js`, `eval/lib/generators.js` |
| The trading system the agent measures through | `server/`, `client/`, `bridge/` |

### 2. Reproduction guide

[docs/REPRODUCTION.md](docs/REPRODUCTION.md) - written for a clean machine.
Needs Node 22 and one API key. **No broker account, no MetaTrader, no
database.** Two of the three verification commands need no key and no network.

### 3. Solution video

Shot list and script: [docs/VIDEO-SCRIPT.md](docs/VIDEO-SCRIPT.md).

### 4. Agent trajectories

`eval/results/trajectories/` - one file per case per arm, every run, nothing
curated. How to read them: [docs/TRAJECTORIES.md](docs/TRAJECTORIES.md).

## Supporting documents

| | |
| --- | --- |
| [docs/EVALUATION.md](docs/EVALUATION.md) | The metric, and the success bar - **committed before the run** |
| [docs/AGENT-DESIGN.md](docs/AGENT-DESIGN.md) | Every design choice, why it was made, and where it lives |
| [docs/GROUND-RULES.md](docs/GROUND-RULES.md) | All ten ground rules, each answered with checkable evidence |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deploying the live trading system (not needed for the result) |

## Verify it in three commands

    npm install
    npm run eval:test     # 12 tests, offline, free - the harness itself
    npm run eval:cases    # re-proves all 16 ground-truth labels
    npm run eval          # the comparison; needs an API key

## Judging criteria, answered

| Criterion | Where |
| --- | --- |
| Problem & user value | [README.md](README.md) - who has this, what it costs them |
| Agent solution & engineering | [docs/AGENT-DESIGN.md](docs/AGENT-DESIGN.md) - five choices, each with a reason and a file |
| End to end quality | `npm run eval` produces a verdict with its evidence; the trading system it measures through is real, tested and gated |
| Measured improvement | [docs/EVALUATION.md](docs/EVALUATION.md) for the method, `eval/results/latest.md` for the result, [IMPROVEMENT-CHANGELOG.md](IMPROVEMENT-CHANGELOG.md) for how it got there |
| Reproducibility | [docs/REPRODUCTION.md](docs/REPRODUCTION.md) - one key, no broker, fixed seeds |
| Hot take | Close of [IMPROVEMENT-CHANGELOG.md](IMPROVEMENT-CHANGELOG.md) |

## Two things worth knowing before you read further

**The eval set is synthetic, deliberately.** On real market data, "does this
strategy have an edge" has no ground truth - that is exactly why the question is
worth asking and exactly why an agent cannot be graded on it. The generator
decides the answer first and draws prices consistent with it.

**The labels are proved, not assumed.** `verify-cases.js` re-measures every case
against the property its label claims, on every run. When it was first written
it failed 6 of 16 - including two cases that would have marked a *correct*
agent wrong. That check is why the headline number means anything.
