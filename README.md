# Trading Agent Dashboard

A local-first trading system, and an agent that answers the one question the
system exists for: **does this strategy have an edge after costs?**

## Who has this problem

A retail trader with a strategy and a broker account. They have a rule that
looks good on a chart and they are about to fund it.

## The bottleneck

Deciding whether a strategy is worth real money is not a charting problem, it
is an evidence problem, and almost every way of getting it wrong looks like
success at the time:

- **In-sample results describe the past.** Parameters chosen by looking at a
  stretch of history will always flatter themselves on that same stretch.
- **Costs are not a rounding error.** Spread, slippage and commission are
  charged on every round turn. A strategy can be right about direction and
  still drain the account, and the equity curve looks fine right up until it is
  measured with costs charged.
- **A good number at one setting is usually luck.** If a 20-bar channel wins
  and 18 and 22 lose, what was found was a coincidence.

Getting this wrong is expensive and slow: the trader funds the account, trades
for two months, and learns the answer from their balance. Getting it right by
hand means a careful walk-forward split, a cost model, and a parameter
sensitivity check - per strategy, per instrument, every time.

## What is here

| | |
| --- | --- |
| `eval/agent/` | The validation agent: measures through the backtest engine and must clear a verifier before it may answer |
| `eval/` | Sixteen synthetic cases whose correct answer is known by construction, plus the baseline it is compared against |
| `server/`, `client/`, `bridge/` | The trading system itself: MT5 ingestion, backtests, risk gates, execution, dashboard |

**Results, reproduction and the improvement changelog:**

- [docs/REPRODUCTION.md](docs/REPRODUCTION.md) - run it from a clean machine
- [IMPROVEMENT-CHANGELOG.md](IMPROVEMENT-CHANGELOG.md) - how the solution got better, and what was removed
- `eval/results/latest.md` - the most recent measured comparison

The graded result needs Node and one API key. It does **not** need MetaTrader,
a broker account or MySQL - the price series are generated from fixed seeds
inside the repo.

## The trading system

It ingests MT5 market data, validates strategies by backtest, gates every trade
through a risk engine, and executes on MetaTrader 5.

## Requirements

- Node 22+
- Python 3.12, 64-bit (for the MT5 bridge)
- Docker (development MySQL) or any MySQL 8
- MetaTrader 5 terminal, from your broker's own installer

## Setup

    npm install
    cp .env.example .env                 # Docker MySQL credentials
    cp server/.env.example server/.env   # app config and MT5 credentials
    docker compose up -d
    npm --prefix server run migrate
    npm --prefix server run create-user -- operator "a-long-passphrase"

    python -m venv bridge/venv
    ./bridge/venv/Scripts/python.exe -m pip install -r bridge/requirements.txt

## Running

    npm run bridge     # needs the MT5 terminal open and logged in
    npm run dev        # API on :3001, dashboard on :5173

## Safety defaults

All of these are **off** until you turn them on:

| Flag | Effect |
| --- | --- |
| `MT5_ALLOW_TRADING` | The bridge is read-only |
| `MT5_ALLOW_LIVE` | A real account is refused |
| `EXECUTION_ENABLED` | The scheduler never sends orders |
| `SCHEDULER_ENABLED` | No background loop runs |

And three rules that are not configurable at all: **every order carries a stop
loss**, **a position smaller than the broker minimum is refused rather than
rounded up**, and **the kill switch only ever resets by hand**.

## How it fits together

| Layer | What it does |
| --- | --- |
| `bridge/` | Thin Python sidecar wrapping the MT5 API. Transport only, no trading logic. |
| `server/src/market/` | Symbol specs and candles, normalised from broker time to UTC |
| `server/src/strategies/` | Pure `evaluate()` functions, shared by backtest and live |
| `server/src/backtest/` | Bar-by-bar replay with spread, slippage and commission |
| `server/src/risk/` | Position sizing and seven gates, any of which can veto |
| `server/src/signals/` | Live signal generation and the approval queue |
| `server/src/execution/` | Order placement and broker reconciliation |
| `client/` | Markets, Backtests, Signals, Risk and Execution views |

## Documentation

- `docs/superpowers/specs/` — the design and why each decision was made
- `docs/superpowers/plans/` — the implementation plans, phase by phase
- `docs/DEPLOYMENT.md` — Hostinger deployment and the pre-flight checklist
- `bridge/README.md` — the MT5 bridge, its guards, and broker-time handling

## Testing

    npm run eval:test           # agent harness, offline and free
    npm run eval:cases          # re-proves the eval set's ground truth
    npm --prefix server test    # trading system; needs the Docker MySQL running
    npm run build
