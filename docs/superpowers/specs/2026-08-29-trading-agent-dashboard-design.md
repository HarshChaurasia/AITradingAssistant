# Trading Agent Dashboard — Design

Date: 2026-08-29
Status: Approved for phase 1

## 1. Purpose

A local-first trading system that ingests market data from an MT5 broker account,
screens symbols with deterministic strategies, validates those strategies by
backtest, sizes positions through a risk engine, and executes on MT5 — first on
demo, then on a small live account.

The system exists to answer one question honestly: **does this strategy have an
edge after costs?** Every design decision below serves that question. Features
that make the dashboard look impressive but weaken the answer are out of scope.

### Success criteria

1. Candles in MySQL match the broker's own prices for every traded symbol.
2. A strategy can be backtested, and the backtest models spread, commission and
   slippage.
3. The identical strategy code runs in backtest, demo and live.
4. No order can reach the broker without a stop loss and a passed risk check.
5. A two-week demo run produces a trade journal that can be compared directly
   against the backtest for the same period.

### Explicit non-goals for v1

- No tick-level data or sub-minute timeframes.
- No websockets; the UI polls.
- No multi-user support; one operator.
- No LLM in the signal path.
- No portfolio optimisation, hedging, or basket strategies.

## 2. Operating plan this serves

| Phase | Duration | Capital | Gate to advance |
| --- | --- | --- | --- |
| Backtest | — | none | Strategy clears thresholds on out-of-sample data |
| Demo | 2 weeks | none | Live results track backtest expectancy; no risk breaches |
| Live small | 2 weeks | $100 | Positive expectancy, max DD within limits |
| Live scaled | ongoing | +$1,000 | Operator decision after review |

## 3. Environment

Verified on the development machine 2026-08-29:

- Node v22.20.0, npm 10.9.3
- Python 3.12.10
- MetaTrader 5 terminal at `C:\Program Files\MetaTrader 5\terminal64.exe`
- Docker 29.6.1, Compose v5.2.0
- MySQL 8.4.11 running as a Compose service, verified reachable from Node

### Database in development

`docker-compose.yml` defines two development-only services:

- `mysql` (`mysql:8.4`) on port 3306, server timezone forced to UTC, utf8mb4
  character set, data persisted in the `mysql_data` named volume, with a
  healthcheck.
- `adminer` (`adminer:5`) on port 8080 for inspecting tables by hand.

Compose reads credentials from the root `.env`; `server/.env` carries the same
values for the application. Both are git-ignored, with `.env.example` files
committed alongside them.

The application depends only on the `DB_*` connection settings, never on Docker.
Pointing `server/.env` at Hostinger's MySQL is the entire production change.

Broker account (demo): AxiCorp Financial Services Pty Ltd, server `Axi-US50-Demo`.
Credentials live only in `server/.env`, which is git-ignored. `server/.env.example`
documents the keys with empty values.

## 4. Topology

Four processes:

```
client/  React + Vite        :5173   dashboard, approval queue, backtest views
   |  /api proxy
server/  Node + Express      :3001   ingest, strategies, backtest, risk, execution
   |  HTTP on 127.0.0.1 only         <-> MySQL 8 :3306
bridge/  Python + Flask      :8000   wraps the MetaTrader5 package
   |
MetaTrader 5 terminal (Windows)
```

### Why the bridge is Python

MetaQuotes publishes the MT5 programmatic API as a Python package only; there is
no Node binding and no public cloud REST API for MT5. The bridge is therefore the
single non-Node component. It is kept deliberately thin — transport and
serialisation only, no trading logic — so that all strategy, risk and state logic
stays in one testable Node codebase.

The bridge binds to `127.0.0.1` and requires a shared token header (`BRIDGE_TOKEN`)
on every request. It is never exposed to a network interface.

### Deployment path

Hostinger supports Node, React and MySQL but cannot run the MT5 terminal. When the
system is deployed, `client`, `server` and MySQL move to Hostinger while the bridge
stays on a Windows machine, reached over a tunnel. Until then everything runs
locally. No code change is required for this split because the server reaches the
bridge only through `BRIDGE_URL`.

## 5. Data model (MySQL 8, InnoDB, utf8mb4)

Migrations are numbered `.sql` files applied by a small runner that records
applied filenames in a `migrations` table. No ORM — the same SQL runs locally and
on Hostinger. Timestamps are stored in UTC; both the container and the connection
are pinned to UTC so candle times never shift with local time or DST.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `symbols` | Broker contract specification, synced from MT5 | `broker_symbol`, `digits`, `contract_size`, `tick_size`, `tick_value`, `min_lot`, `lot_step`, `max_lot`, `enabled` |
| `candles` | OHLCV history | PK `(symbol_id, timeframe, open_time)`, times stored UTC |
| `strategies` | Registered strategy versions | `name`, `version`, `params` JSON, `status` enum |
| `signals` | Every signal produced | `side`, `entry`, `sl`, `tp`, `confidence`, `features` JSON, `reason`, `mode`, `status` |
| `trades` | Executed positions | `mode`, `broker_ticket`, `lot`, entry/exit, `sl`, `tp`, `pnl`, `commission`, `swap`, `status` |
| `backtest_runs` | One row per backtest | date range, `params` JSON, `metrics` JSON, `passed` |
| `backtest_trades` | Per-trade rows of a run | supports equity curve rendering |
| `risk_state` | Circuit-breaker memory, per day and mode | `realized_pnl`, `trades_count`, `consecutive_losses`, `kill_switch` |
| `news_events` | Economic calendar and headlines | `ts`, `currency`, `impact` |
| `equity_snapshots` | Account balance/equity over time | `mode`, `ts` |
| `audit_log` | Every order, gate rejection, kill-switch trip | `actor`, `action`, `payload` JSON |
| `users` | Single operator login | `username`, `password_hash` (bcrypt) |
| `settings` | Risk parameters, thresholds, kill switch | key/value JSON |

Notes:

- `symbols` is populated from MT5, never hand-typed. Lot sizing reads it. A
  hardcoded lot size is the most common way a small account is destroyed.
- `signals.features` snapshots the indicator values that produced the signal, so
  any past decision can be audited without re-running the strategy.
- `mode` is carried on signals and trades so backtest, demo and live results can
  never be aggregated together by accident.

## 6. Strategy contract

A strategy is a module exporting:

```js
{
  name: string,
  version: string,
  params: object,
  evaluate(candles, ctx) -> signal | null
}
```

`evaluate` is pure: same inputs produce the same output, no I/O, no clock access.
The backtester replays historical bars through it; the live worker feeds it the
most recent bars. **The same function serves all three modes.** If backtest and
live logic ever diverge, the demo period proves nothing — this is the single most
important structural constraint in the system.

Two strategies ship in v1:

- **trend-breakout** — EMA trend filter, Donchian channel breakout entry, ATR-based
  stop and target.
- **mean-reversion** — RSI extreme entry taken only in the direction of a
  higher-timeframe trend filter, ATR-based stop.

## 7. Backtest engine

Bar-by-bar replay through `evaluate`. Models:

- spread (from `symbols`, configurable override)
- commission per lot
- slippage assumption in points
- stop and target checked intrabar using the candle high/low

Metrics per run: profit factor, win rate, max drawdown, expectancy, average
win/loss, trade count, Sharpe.

Walk-forward validation: the date range is split into in-sample and out-of-sample
windows. Parameters may be tuned on in-sample only; the reported verdict comes
from out-of-sample results.

Default pass thresholds, stored in `settings` and editable in the UI:

- profit factor >= 1.3
- max drawdown <= 15%
- trade count >= 50
- out-of-sample expectancy > 0

A strategy that fails cannot be promoted past `backtested`.

## 8. Risk engine

### Position sizing

```
riskAmount   = balance * riskPct
stopDistance = abs(entry - sl)
lot          = riskAmount / (stopDistance / tick_size * tick_value)
lot          = floor(lot / lot_step) * lot_step
```

`lot` is then clamped to `[min_lot, max_lot]`. **If the computed lot is below
`min_lot`, the trade is rejected — never rounded up.** On a $100 account, rounding
up to the broker minimum can turn an intended 1% risk into 20%.

### Gates

Every gate can veto a trade:

- per-trade risk <= 1% of balance (configurable)
- daily realized loss <= 5% — on breach, trading halts until the next session
- max 2 concurrent open positions
- 3 consecutive losses trips the kill switch, which requires manual reset
- high-impact news within +/- 15 minutes on the affected symbol
- **no order without a stop loss — not configurable**

Live mode additionally requires all of: strategy `status = live`, a passed
backtest, a completed demo period, kill switch off, and explicit operator
approval of the individual signal.

### Reconciliation

A loop polls open positions and account state from the bridge every 30 seconds and
reconciles them against `trades`. The server never acts on its own cached view of
the account. On restart, state is rebuilt from the broker, not from memory.

## 9. Autonomy model

- **Demo mode**: fully automatic. Signals that pass the risk engine execute without
  human input, so the two-week demo measures the system rather than the operator.
- **Live mode**: every signal enters an approval queue and waits for a click. The
  risk engine still applies; approval cannot override a failed gate.

## 10. AI layer

Deferred to phase 5 and strictly advisory. An LLM produces plain-English commentary
on market state and flags news conflicts for display beside a signal. It cannot
alter a signal's side, entry, stop, target, or size. Rationale: an LLM in the signal
path makes the strategy non-deterministic and therefore unbacktestable, which
defeats the system's stated purpose.

## 11. Frontend

React Router pages:

- **Overview** — account state, equity curve, open positions, risk status, kill switch
- **Markets** — candlestick chart per symbol, screener/filter table
- **Signals** — live signals and the live-mode approval queue
- **Backtests** — configure and launch runs, view metrics and equity curves
- **Trades** — journal with mode filter
- **Risk & Settings** — risk parameters, pass thresholds, symbol enable/disable

Charting: `lightweight-charts` for OHLC, `recharts` for equity and metrics. The UI
polls every 5 seconds; no websockets in v1, which keeps the Hostinger deployment
simple.

All `/api` routes except `/api/health` sit behind session authentication with a
single bcrypt-hashed operator account. A dashboard that can place real orders must
not be reachable without a login.

## 12. Testing

- Unit tests for every indicator against hand-computed fixtures.
- Unit tests for position sizing, including the below-`min_lot` rejection case and
  each risk gate.
- Backtest engine tested against a synthetic price series with a known outcome.
- Bridge client tested against a stub server so server tests need no MT5 terminal.

Risk sizing and the backtester are the two places where a silent arithmetic error
costs real money. They are tested first.

## 13. Build phases

Each phase ends in something observable.

1. **Foundations** — migrations and runner, Python bridge, symbol spec sync,
   candle backfill and incremental sync, real candlestick chart in the UI.
   *Proves broker data is flowing.*
2. **Edge** — indicators with tests, the two strategies, backtest engine, backtest
   UI with equity curves. *Proves whether anything works before capital moves.*
3. **Gating** — risk engine with tests, live signal generation, scheduler,
   approval queue. *Proves the brakes work.*
4. **Execution** — order placement, reconciliation, trade journal. *Starts the
   two-week demo.*
5. **Hardening** — authentication, Telegram alerts, LLM commentary, Hostinger
   deployment. *Precedes the $100 live phase.*

## 13b. Execution verification

Recorded 2026-08-29 against MetaQuotes-Demo account 111853214.

Verified with the market closed (Saturday), so no fill was possible:

- Guard state: `trading_enabled: true`, `live_allowed: false`,
  `account_is_real: false`.
- An order with no stop loss is refused with `400 no_stop_loss`.
- An order with `sl: 0` is refused the same way.
- An order without the bridge token is refused with `401`.
- A negative lot is refused with `400`.
- A well-formed order reaches the broker's matching engine and is refused with
  `retcode 10018 Market closed`. Account balance and equity unchanged.
- Reconciliation against the real account returns zero positions and records a
  genuine equity snapshot of 100000.00.

Two bugs were found and fixed by this exercise:

1. `type_filling` was hardcoded to IOC, which this broker refuses with
   `retcode 10030 Unsupported filling mode`. The filling mode is now read from
   the symbol's advertised bitmask. This would have broken the very first
   live order.
2. The bridge blocked for ~65 seconds on a failed connect because MT5 holds
   the Python GIL for the whole call (see the bridge README).

**Outstanding:** one real round trip - order, reconcile, close - on an open
market. That is the last check before the demo period starts.

## 14. Known issue in the existing scaffold

`server/package.json` and `client/package.json` each declare
`"trading-agent-dashboard": "file:.."` — a dependency on the workspace root that
contains them. This is removed in phase 1.

The current `server/src/index.js` serves six hardcoded arrays and
`client/src/App.jsx` renders them. Both are replaced as their real data sources
come online; the dashboard's panel layout is retained as the UI target.
