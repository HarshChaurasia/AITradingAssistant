# Deployment

## What runs where

Hostinger runs Node, React and MySQL but **cannot run the MetaTrader 5
terminal**, which is a Windows desktop application. The system therefore
splits:

| Component | Location |
| --- | --- |
| `client/` static build | Hostinger |
| `server/` Node API | Hostinger |
| MySQL | Hostinger |
| `bridge/` + MT5 terminal | A Windows machine you control |

The server reaches the bridge only through `BRIDGE_URL`, so this split needs
no code change.

## Before you deploy

Work through all of it. Several items are the difference between a private
dashboard and one a stranger can trade with.

- [ ] `AUTH_ENABLED=true`. Never deploy with it false.
- [ ] An operator account exists: `npm --prefix server run create-user -- <name> <password>`.
- [ ] `COOKIE_SECURE=true` once the site is behind HTTPS.
- [ ] `BRIDGE_TOKEN` regenerated for production, not the development value.
- [ ] `MT5_ALLOW_LIVE=false` unless you have deliberately decided to go live.
- [ ] `EXECUTION_ENABLED` and `SCHEDULER_ENABLED` set consciously, not by accident.
- [ ] `server/.env` is not in the deployment bundle if the host exposes the app
      directory; use the host's environment variable panel instead.
- [ ] The bridge is **not** reachable from the internet. It binds to
      `127.0.0.1`; reach it over an SSH tunnel or a private network, never a
      port forward.

## Database

Create a MySQL database in the Hostinger panel, then set `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASSWORD` and `DB_NAME`, and run:

    npm --prefix server run migrate

The migration runner is idempotent, so it is safe to run on every deploy.

Timestamps are handled in UTC throughout: the pool sets `timezone: 'Z'` and
every write goes through `UTC_TIMESTAMP()` or a UTC-formatted string, so a host
whose MySQL runs on local time does not corrupt candle times.

## Build and start

    npm install
    npm run build            # emits client/dist
    npm --prefix server start

Point the host's Node entry at `server/src/index.js`. Serve `client/dist` as
static files, either from the host's static configuration or by adding
`express.static` in front of the API.

## Connecting the bridge

On the Windows machine with MT5:

    npm run bridge

Then open a reverse tunnel so the Hostinger server can reach it:

    ssh -R 8000:127.0.0.1:8000 <user>@<hostinger-host>

and set `BRIDGE_URL=http://127.0.0.1:8000` on the server. If the tunnel drops,
the dashboard keeps working and every bridge call fails fast with a clear
message — the bridge outage path is already handled and tested.

## Operating during the demo period

- Watch **Risk** for the kill switch and the daily loss tally.
- Watch **Execution** for open positions and the journal.
- Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to be told about a
  kill switch trip, a fill, or a rejected order without watching the screen.
- Compare the demo journal against a backtest over the same dates. That
  comparison is the entire point of the demo period: if live expectancy and
  backtest expectancy disagree sharply, something in the execution path
  differs from the simulation and must be found before real money.

## Going live

Only after the demo period produces results that match the backtest:

1. Set `MT5_ALLOW_LIVE=true` on the bridge.
2. Point `MT5_LOGIN`, `MT5_PASSWORD` and `MT5_SERVER` at the live account.
3. Set `TRADING_MODE=live`.
4. Promote the strategy: `UPDATE strategies SET status = 'live' WHERE name = ...`.
5. Leave live signals requiring manual approval for at least the first week.

**Check position sizing before step 1, not after.** On a small account the
broker's minimum lot can exceed the risk cap, in which case the engine refuses
every trade — correctly. Measured on this system: EURUSD H1 with a 2×ATR stop
risks about $2.23 at the 0.01 minimum lot, which is 2.2% of a $100 account and
therefore refused under a 1% cap. Use **Risk → assess** to dry-run a
representative signal at your intended balance and confirm it is tradeable at
all before funding anything.

## Running unattended for a two-week demo

Nothing here is optional if the run is meant to survive a night, let alone a
fortnight. Each item below corresponds to a way the run was measured to fail.

### Process supervision

    npx pm2 start ecosystem.config.cjs   # API + MT5 bridge, with auto-restart
    npx pm2 save                         # snapshot for resurrect
    npx pm2 status
    npx pm2 logs trading-bridge --lines 50

`ecosystem.config.cjs` deliberately excludes the Vite dev client. Vite is a
development tool; serve `client/dist` instead.

The bridge's `min_uptime` is 120s because it blocks for roughly 70 seconds
connecting to MT5 before it serves. A shorter value reads a slow start as a
crash loop.

### Surviving a reboot

PM2's `pm2 startup` is Linux-only. On Windows, a `trading-agent.cmd` in the
user's Startup folder runs `pm2 resurrect` at logon:

    %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\trading-agent.cmd

MySQL needs nothing: Compose declares `restart: unless-stopped`, so Docker
brings it back by itself.

**The MT5 terminal does not restart itself.** It must be running and logged in
before the bridge can attach, so after a reboot open MT5 first and confirm
AutoTrading is on.

### Sleep

    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0

Measured on this machine: standby was set to 5 minutes, which would have ended
the run within the first hour. Revert afterwards with a non-zero value.

### The broker link drops, and used to stay dropped

`mt5.initialize()` holds the Python GIL for the whole attempt, so the bridge
cannot retry from inside a request handler without freezing every other route.
Reconnection is therefore driven from the scheduler tick, which is already
non-overlapping: each cycle checks bridge health, retries once when it is
down, and skips the cycle rather than trading against a broker it cannot
reach. Telegram is alerted once per outage and once on recovery - not once a
minute for two weeks.

### What to watch

- `npx pm2 status` - `restarts` climbing means something is crash-looping.
- The scheduler's `lastRun` (Risk view, or `GET /api/scheduler`) carries
  `bridgeDown` and `diskFreeGb`.
- Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, or nothing will reach
  you while you sleep.

### Housekeeping over 14 days

- Disk: an alert fires below `LOW_DISK_ALERT_GB` (default 5).
- `SESSION_TTL_HOURS` defaults to 720, so the dashboard login outlasts the
  demo. At the old 7-day default it expired mid-run.
- Equity snapshots accumulate one row per tick per mode - roughly 20k rows a
  fortnight, which is negligible.
