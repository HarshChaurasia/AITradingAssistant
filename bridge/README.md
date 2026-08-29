# MT5 Bridge

Read-only sidecar exposing MetaTrader 5 market data to the Node server.

## Why this is Python

MetaQuotes ships the MT5 programmatic API as a Python package only. There is no
Node binding and no public cloud REST API for MT5. This process is deliberately
thin: transport and serialisation, no trading logic.

## Prerequisites

- MetaTrader 5 terminal installed and **running**, logged in to the account in
  `server/.env`.
- **Algo Trading enabled** in the terminal: Tools → Options → Expert Advisors →
  "Allow algorithmic trading". Without it, `initialize()` returns
  `-6 Authorization failed`.
- The terminal must be the **broker's own build** for the account's server. A
  MetaQuotes-generic terminal cannot reach `Axi-US50-Demo`, because a broker's
  servers ship with that broker's installer. Symptom: `-10005 IPC timeout`.
- Python 3.12, 64-bit (must match the terminal's architecture).

## Setup

    python -m venv venv
    ./venv/Scripts/python.exe -m pip install -r requirements.txt

## Run

    ./venv/Scripts/python.exe app.py

Listens on `127.0.0.1:8000`. Every route requires the header
`X-Bridge-Token: <BRIDGE_TOKEN from server/.env>`.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Terminal state, logged-in account, broker UTC offset |
| `GET /account` | Balance, equity, free margin, leverage |
| `GET /symbols` | Full contract specification for every broker symbol |
| `GET /candles?symbol=&timeframe=&count=` | OHLCV bars |

## Write endpoints and their guards

`POST /order`, `POST /close`, `GET /positions` and `GET /deals` exist from
phase 4. Three independent guards stand in front of every write:

| Guard | Default | Effect |
| --- | --- | --- |
| `MT5_ALLOW_TRADING` | `false` | The bridge is read-only until this is `true` |
| `MT5_ALLOW_LIVE` | `false` | A REAL account is refused; a demo account is fine |
| stop loss required | always | An order with no `sl` is rejected with 400 |

They overlap deliberately. This is the boundary where software starts
spending money, and a single check is one bug away from being no check. The
account-type guard fails closed: if the account type cannot be read, it is
treated as real and refused.

## Broker time

MT5 returns bar times in the **broker's** timezone as a Unix timestamp. Axi runs
UTC+2/UTC+3 with DST. Responses include `server_utc_offset_seconds`; the Node
side subtracts it so everything in MySQL is true UTC. Never store the raw value.

## Why the connection happens at startup

`mt5.initialize()` **holds the Python GIL** for the entire call. A failed
connect blocks for roughly 65 seconds and freezes the whole process while it
does - a background thread is no escape, which was measured directly: a 1Hz
heartbeat thread recorded zero ticks during the call.

So the bridge connects once, before it starts serving. Request handlers only
read the cached connection state, which keeps every route fast whether or not
MT5 is reachable. When disconnected, data routes return `503` immediately with
the reason.

`POST /reconnect` retries. It blocks the whole process by design, so it is an
explicit operator action, never something the dashboard polls.

The bridge therefore takes up to ~70 seconds to start when MT5 is unreachable.
That is the connect timeout, not a hang.

| MT5 error | Meaning |
| --- | --- |
| `-6 Authorization failed` | Algo Trading disabled, or the terminal has never logged in |
| `-10005 IPC timeout` | The terminal cannot reach that trade server — usually the wrong broker's terminal build |
