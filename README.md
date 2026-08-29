# Trading Agent Dashboard

A local-first trading system: ingests MT5 market data, validates strategies by
backtest, gates every trade through a risk engine, and executes on MetaTrader 5.

It exists to answer one question honestly: **does this strategy have an edge
after costs?**

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

    npm --prefix server test    # needs the Docker MySQL running
    npm run build
