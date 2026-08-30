# Agent trajectories

The brief asks for representative trajectories that are easy to follow from the
agent's instructions to its final result, showing what the agent did, how its
tools responded, the feedback that shaped its next step, and any retries or
human checkpoints.

Every case in every run writes one. Nothing is sampled or curated.

    eval/results/trajectories/agent/<case-id>.json
    eval/results/trajectories/baseline/<case-id>.json

Written by `saveTrajectories()` in `eval/run.js`. Thirty-two files per full
run, one per case per arm.

## What a file contains

```
{
  "caseId":  "cost-trap-1",
  "mode":    "agent",
  "model":   "claude-opus-5",
  "verdict": "NO_EDGE",          // what the agent concluded
  "truth":   "NO_EDGE",          // the ground-truth label, for scoring only
  "trajectory": [ ... ]          // every step, in order
}
```

The steps carry a `role` saying what kind of event each was:

| `role` | What it is |
| --- | --- |
| `user` | The task as given, verbatim |
| `assistant` | A model turn: its reasoning text and any tool calls, plus `stop_reason` |
| `tool` | One tool call - `name`, the exact `input`, and the full `output` the tool returned |
| `verifier` | A verdict submission and the verifier's decision on it |
| `system` | A refusal or other terminal event |

The agent's instructions are not repeated in every file - they are identical
across all cases by design. Read them once, verbatim, in
[AGENT-DESIGN.md](AGENT-DESIGN.md), or in `SYSTEM_PROMPT` in
`eval/agent/validator.js`.

## How to read one

Follow the `tool` entries in order. They are the agent's actual reasoning made
concrete - the questions it chose to ask, and the numbers it got back. A
trajectory worth reading closely on any `cost-trap` case shows the shape the
whole system was built around:

1. `describe_case` - notices what the cost model is
2. `run_backtest` at `costModel: "zero"` - looks profitable
3. `run_backtest` at the real cost model - is not
4. `submit_verdict` - `NO_EDGE`

Step 3 is the entire difference between this and a confident wrong answer.

## Verifier entries are the interesting ones

A `verifier` entry records a verdict the agent tried to submit and what the
verifier decided:

```
{ "role": "verifier",
  "verdict": "EDGE",
  "check": { "supported": false, "reason": "The verdict is EDGE, but no
             out-of-sample run at the real cost model is profitable over at
             least 20 trades..." } }
```

When `supported` is `false`, the reason is returned to the agent and it gets
one revision. Both the rejected attempt and what the agent did next stay in the
file. Those are the most informative trajectories in the set: they show the
verifier doing the job it exists for, and they are the source of the failure
mode reported in `IMPROVEMENT-CHANGELOG.md`.

To find them after a run:

    grep -l '"supported": false' eval/results/trajectories/agent/*.json

## The human checkpoint

The agent has no authority to act. Its final `submit_verdict` is the end of its
trajectory - the verdict goes to a person, who decides what to do with it. The
trading system's own approval gates are described in
[GROUND-RULES.md](GROUND-RULES.md) rule 4.

## Baseline trajectories

Two entries: the prompt as sent, and the answer as returned. There is nothing
in between, which is the point of the comparison - it has no way to measure
anything, so there is no measurement to record.
