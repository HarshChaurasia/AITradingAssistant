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
