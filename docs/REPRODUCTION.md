# Reproduction guide

Written for someone starting from a clean machine with no broker account, no
MetaTrader terminal and no market data.

The graded result - the agent-versus-baseline comparison - needs **Node 22+ and
one Anthropic API key**. Nothing else. The price series are generated from
fixed seeds inside the repo, so the eval set is identical on every machine.

The live trading system (MT5 bridge, MySQL, dashboard) is a separate concern
and is **not** required to reproduce anything below. Its setup is in the main
[README](../README.md).

## 1. Install

    git clone <this repo>
    cd Trading
    npm install

Node 22 or newer. Check with `node --version`.

## 2. Check the harness without spending anything

    npm run eval:test

Twelve tests. No API key, no database, no network. They cover the tool layer,
the verifier's evidence rules, the retry path and the guarantee that nothing
the agent can see carries the ground-truth label.

Expected: `# pass 12`, `# fail 0`.

## 3. Re-prove the eval set's ground truth

    npm run eval:cases

Regenerates all sixteen price series from their seeds, runs the backtests, and
checks each case still demonstrably exhibits the property its label claims.

Expected: a sixteen-row table ending in

    All 16 cases support their ground-truth label (4 EDGE, 12 NO_EDGE).

Runtime: about 30 seconds. If any row says `NO`, the set is not safe to grade
against and `npm run eval:seeds` rebuilds it.

## 4. Run the comparison

Put an API key in `server/.env`:

    ANTHROPIC_API_KEY=sk-ant-...

Then:

    npm run eval

That runs both arms - the single-prompt baseline and the agent - over the same
sixteen cases with the same model, and writes:

| Path | What it holds |
| --- | --- |
| `eval/results/latest.md` | The comparison table and per-case verdicts |
| `eval/results/latest.json` | The same, machine-readable |
| `eval/results/trajectories/agent/*.json` | Every agent run: tool calls, tool responses, verifier decisions |
| `eval/results/trajectories/baseline/*.json` | Every baseline prompt and answer |

Useful flags:

    npm run eval -- --mode agent          # one arm only
    npm run eval -- --cases cost-trap     # one case type (4 cases)
    npm run eval -- --model claude-sonnet-5

Both arms always get the same cases, the same question and the same model. The
only difference is the thing being measured.

## Versions, runtime and cost

| | |
| --- | --- |
| Node | 22.20.0 |
| Model | `claude-opus-5` (default; override with `--model`) |
| Concurrency | 4 cases at a time |
| Runtime, full run | see `eval/results/latest.md` |
| Cost, full run | reported per arm in `eval/results/latest.md` |

Cost is computed from Anthropic list prices and the token counts the API
returns, not estimated.

## What to expect

The agent should be right substantially more often than the baseline, and the
gap should be largest on the cases where the honest answer is unprofitable -
those are the ones you cannot reach without measuring. Read
`eval/results/latest.md` for the run you just did rather than trusting a number
quoted in any document, including this one.
