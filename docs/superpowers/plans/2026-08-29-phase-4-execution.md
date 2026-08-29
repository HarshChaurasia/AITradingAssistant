# Phase 4: Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn approved signals into real MT5 orders on the demo account, reconcile positions from the broker rather than from memory, and journal every trade — so the two-week demo produces evidence that can be compared against the backtest.

**Architecture:** The Python bridge gains write endpoints, guarded so it physically cannot trade a live account without an explicit opt-in. A Node execution manager takes an approved signal, re-runs the risk engine immediately before sending (state may have changed since approval), places the order with a stop loss attached, and records the trade. A reconciler polls the broker every 30 seconds, closing out trades the broker has closed and feeding results back into the risk state so the kill switch reacts to reality.

**Tech Stack:** Node 22 (built-in `node:test`), Express 4, mysql2, MySQL 8.4, Python 3.12 + Flask 3 + MetaTrader5, React 18 + Vite.

**Spec:** `docs/superpowers/specs/2026-08-29-trading-agent-dashboard-design.md`

## Global Constraints

This is the first phase where code can move money. Every constraint below is a safety property, not a preference.

- **The bridge refuses to trade unless `MT5_ALLOW_TRADING=true`.** Default false. A bridge started without it is read-only, exactly as in phases 1–3.
- **The bridge refuses a live account unless `MT5_ALLOW_LIVE=true`.** Default false. It checks `account_info().trade_mode` and rejects a real account outright, so a mistyped login cannot reach real money.
- **Every order carries a stop loss.** The bridge rejects an order request with no `sl` field, independently of the Node-side gate. Two independent checks, because this is the one that cannot be allowed to fail.
- **The risk engine runs again immediately before sending.** Approval is not a licence: the kill switch may have tripped, the daily loss cap may have been hit, or another position may have opened since.
- **A trade row is written before the order is sent**, then updated with the broker ticket. An order that succeeds while the app crashes must not become an untracked position.
- **Reconciliation is the source of truth.** Open positions come from the broker every cycle. The app never trusts its own cached view of the account.
- Node >= 22, built-in `node:test`. No new dependencies.
- All timestamps UTC. CommonJS in `server/`, ES modules in `client/`.
- Every SQL change is a new numbered migration.
- Integration tests use `server/test/helpers/db.js` → `freshDatabase(t, name)`.
- **No test may place a real order.** Execution tests run against a stub bridge. The single live check is a manual step you run deliberately, at the end.

---

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `server/src/execution/manager.js` | Approved signal → risk re-check → order → trade row |
| `server/src/execution/reconciler.js` | Poll broker positions, close trades, update risk state, snapshot equity |
| `server/src/execution/journal.js` | Trade queries for the UI |
| `server/src/routes/execution.js` | `/api/trades`, `/api/execution/*` |
| `server/migrations/006_trade_execution.sql` | Order audit columns on `trades` |
| `client/src/pages/Trades.jsx` | Trade journal and open positions |
| `server/test/*.test.js` | Unit and integration tests |

**Modify:** `bridge/app.py` (order endpoints + guards), `bridge/README.md`, `server/src/bridge/client.js` (order methods), `server/src/scheduler/index.js` (execute + reconcile in the tick), `server/src/index.js`, `server/.env` / `.env.example`, `client/src/App.jsx`, `client/src/api.js`, `client/src/styles.css`.

---

### Task 1: Bridge write endpoints, with guards

**Files:**
- Modify: `bridge/app.py`, `bridge/README.md`, `server/.env`, `server/.env.example`
- Test: manual, via curl — the bridge has no automated suite and adding one would need a live terminal

**Interfaces:**
- Produces, all requiring the `X-Bridge-Token` header:
  - `POST /order` — body `{ symbol, side, lot, sl, tp, deviation, comment }` → `{ ok, ticket, price, volume, retcode, comment }`
  - `POST /close` — body `{ ticket, deviation }` → `{ ok, retcode, comment }`
  - `GET /positions` → `{ positions: [ { ticket, symbol, side, volume, price_open, sl, tp, profit, swap, time } ] }`
  - `GET /deals?ticket=` → `{ deals: [ { ticket, position_id, profit, commission, swap, price, time, entry } ] }`

Three guards sit in front of every write, and they are deliberately redundant:

1. `MT5_ALLOW_TRADING` must be `true`, or writes return 403.
2. The account's `trade_mode` must not be real, unless `MT5_ALLOW_LIVE` is `true`.
3. An order without a finite `sl` is rejected with 400.

- [ ] **Step 1: Add the trading configuration**

Append to `server/.env`:

```
# ---- Execution guards ----
# The bridge is read-only unless this is true.
MT5_ALLOW_TRADING=true
# A REAL account is refused unless this is true. Leave false until the demo
# period is complete and you have decided to go live deliberately.
MT5_ALLOW_LIVE=false
# Maximum slippage in points accepted on a market order.
MT5_MAX_DEVIATION=20
```

Append the same keys to `server/.env.example` with `MT5_ALLOW_TRADING=false`, `MT5_ALLOW_LIVE=false`, `MT5_MAX_DEVIATION=20`.

- [ ] **Step 2: Add the guards to the bridge**

In `bridge/app.py`, after the `not_connected_response()` function, add:

```python
# --- Write guards ------------------------------------------------------
#
# Three independent checks stand in front of every write. They overlap on
# purpose: this is the boundary where software starts spending money, and a
# single check is one bug away from being no check.

def trading_enabled():
    return os.getenv("MT5_ALLOW_TRADING", "false").lower() == "true"


def live_allowed():
    return os.getenv("MT5_ALLOW_LIVE", "false").lower() == "true"


def account_is_real():
    """True when the logged-in account trades real money."""
    info = mt5.account_info()
    if info is None:
        return True  # Unknown means treat it as real. Fail closed.
    # ACCOUNT_TRADE_MODE_REAL == 2 in the MT5 API.
    return int(info.trade_mode) == 2


def write_guard():
    """Return an error response when writing is not permitted, else None."""
    if not trading_enabled():
        return jsonify(
            error="trading is disabled on this bridge (set MT5_ALLOW_TRADING=true to enable)",
            code="trading_disabled",
        ), 403
    if account_is_real() and not live_allowed():
        return jsonify(
            error="refusing to trade a REAL account (set MT5_ALLOW_LIVE=true to permit)",
            code="live_account_blocked",
        ), 403
    return None
```

- [ ] **Step 3: Add the order endpoints**

In `bridge/app.py`, immediately before the `@app.post("/reconnect")` route, add:

```python
@app.get("/positions")
@require_token
def positions():
    if not connected():
        return not_connected_response()

    rows = mt5.positions_get()
    if rows is None:
        return jsonify(positions=[])

    return jsonify(positions=[
        {
            "ticket": p.ticket,
            "symbol": p.symbol,
            # POSITION_TYPE_BUY == 0
            "side": "BUY" if p.type == 0 else "SELL",
            "volume": p.volume,
            "price_open": p.price_open,
            "price_current": p.price_current,
            "sl": p.sl,
            "tp": p.tp,
            "profit": p.profit,
            "swap": p.swap,
            "time": int(p.time),
        }
        for p in rows
    ])


@app.get("/deals")
@require_token
def deals():
    """Closed deals for one position, used to recover the realised result."""
    if not connected():
        return not_connected_response()

    ticket = request.args.get("ticket")
    if not ticket:
        return jsonify(error="ticket is required"), 400

    rows = mt5.history_deals_get(position=int(ticket))
    if rows is None:
        return jsonify(deals=[])

    return jsonify(deals=[
        {
            "ticket": d.ticket,
            "position_id": d.position_id,
            "symbol": d.symbol,
            "volume": d.volume,
            "price": d.price,
            "profit": d.profit,
            "commission": d.commission,
            "swap": d.swap,
            "time": int(d.time),
            # DEAL_ENTRY_IN == 0, DEAL_ENTRY_OUT == 1
            "entry": int(d.entry),
        }
        for d in rows
    ])


@app.post("/order")
@require_token
def order():
    if not connected():
        return not_connected_response()

    blocked = write_guard()
    if blocked:
        return blocked

    body = request.get_json(silent=True) or {}
    symbol = body.get("symbol")
    side = str(body.get("side", "")).upper()
    lot = body.get("lot")
    sl = body.get("sl")
    tp = body.get("tp")

    if not symbol:
        return jsonify(error="symbol is required"), 400
    if side not in ("BUY", "SELL"):
        return jsonify(error="side must be BUY or SELL"), 400
    try:
        lot = float(lot)
    except (TypeError, ValueError):
        return jsonify(error="lot must be a number"), 400
    if lot <= 0:
        return jsonify(error="lot must be greater than zero"), 400

    # The stop loss check is repeated here on purpose. The Node risk engine
    # already enforces it; this is the last line of defence, and the one
    # failure mode that must never get through.
    try:
        sl = float(sl)
    except (TypeError, ValueError):
        return jsonify(error="a stop loss is required on every order", code="no_stop_loss"), 400
    if sl <= 0:
        return jsonify(error="a stop loss is required on every order", code="no_stop_loss"), 400

    if not mt5.symbol_select(symbol, True):
        return jsonify(error=f"symbol_select failed for {symbol}: {mt5.last_error()}"), 400

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify(error=f"no tick for {symbol}; the market may be closed"), 400

    price = tick.ask if side == "BUY" else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL

    request_payload = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": lot,
        "type": order_type,
        "price": price,
        "sl": sl,
        "deviation": int(body.get("deviation", os.getenv("MT5_MAX_DEVIATION", 20))),
        "magic": 20260829,
        "comment": str(body.get("comment", "trading-agent"))[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    if tp:
        request_payload["tp"] = float(tp)

    result = mt5.order_send(request_payload)
    if result is None:
        return jsonify(error=f"order_send returned nothing: {mt5.last_error()}"), 502

    ok = result.retcode == mt5.TRADE_RETCODE_DONE
    return jsonify(
        ok=ok,
        retcode=int(result.retcode),
        comment=result.comment,
        ticket=int(result.order) if ok else None,
        position=int(getattr(result, "deal", 0)) or None,
        price=float(result.price) if ok else None,
        volume=float(result.volume) if ok else None,
    ), (200 if ok else 400)


@app.post("/close")
@require_token
def close_position():
    if not connected():
        return not_connected_response()

    blocked = write_guard()
    if blocked:
        return blocked

    body = request.get_json(silent=True) or {}
    ticket = body.get("ticket")
    if not ticket:
        return jsonify(error="ticket is required"), 400

    found = mt5.positions_get(ticket=int(ticket))
    if not found:
        return jsonify(error=f"no open position with ticket {ticket}"), 404
    position = found[0]

    tick = mt5.symbol_info_tick(position.symbol)
    if tick is None:
        return jsonify(error=f"no tick for {position.symbol}; the market may be closed"), 400

    # Closing is the opposite side at the opposite price.
    closing_buy = position.type != 0
    result = mt5.order_send({
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": position.symbol,
        "volume": position.volume,
        "type": mt5.ORDER_TYPE_BUY if closing_buy else mt5.ORDER_TYPE_SELL,
        "position": int(ticket),
        "price": tick.ask if closing_buy else tick.bid,
        "deviation": int(body.get("deviation", os.getenv("MT5_MAX_DEVIATION", 20))),
        "magic": 20260829,
        "comment": "trading-agent close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    })

    if result is None:
        return jsonify(error=f"order_send returned nothing: {mt5.last_error()}"), 502

    ok = result.retcode == mt5.TRADE_RETCODE_DONE
    return jsonify(ok=ok, retcode=int(result.retcode), comment=result.comment), (200 if ok else 400)
```

- [ ] **Step 4: Report the guard state in /health**

In the `health()` route, inside the `jsonify(...)` call for the connected case, add these three fields after `trade_allowed=...`:

```python
        trading_enabled=trading_enabled(),
        live_allowed=live_allowed(),
        account_is_real=account_is_real(),
```

- [ ] **Step 5: Restart the bridge and verify the guards by hand**

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*app.py*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
sleep 2
(./bridge/venv/Scripts/python.exe bridge/app.py > logs/bridge.log 2>&1 &)
sleep 20
TOKEN=$(grep '^BRIDGE_TOKEN=' server/.env | cut -d= -f2)
curl -s -H "X-Bridge-Token: $TOKEN" http://127.0.0.1:8000/health
```

Expected: `trading_enabled: true`, `live_allowed: false`, `account_is_real: false`.

Now prove the stop-loss guard rejects an order, **before** any order is ever sent successfully:

```bash
curl -s -X POST http://127.0.0.1:8000/order -H "X-Bridge-Token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"symbol":"EURUSD","side":"BUY","lot":0.01}'
```

Expected: HTTP 400, `"code": "no_stop_loss"`. If this returns anything else, **stop** — the last line of defence is not working.

And prove the token still gates writes:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8000/order \
  -H 'content-type: application/json' -d '{"symbol":"EURUSD","side":"BUY","lot":0.01,"sl":1.0}'
```

Expected: `401`.

- [ ] **Step 6: Document the guards**

In `bridge/README.md`, replace the line `Phase 1 is read-only by design. There are no order endpoints, so this bridge cannot place a trade.` with:

```markdown
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
```

- [ ] **Step 7: Commit**

```bash
git add bridge/app.py bridge/README.md server/.env.example
git commit -m "feat(bridge): add guarded order endpoints"
```

---

### Task 2: Bridge client order methods

**Files:**
- Modify: `server/src/bridge/client.js`
- Test: `server/test/bridge-orders.test.js`

**Interfaces:**
- Consumes: `createBridgeClient` from phase 1.
- Produces, added to the object `createBridgeClient` returns:
  - `positions() -> Promise<{ positions: [...] }>`
  - `deals({ ticket }) -> Promise<{ deals: [...] }>`
  - `order({ symbol, side, lot, sl, tp, comment }) -> Promise<{ ok, ticket, price, volume, retcode, comment }>`
  - `closePosition({ ticket }) -> Promise<{ ok, retcode, comment }>`

`request` currently only issues GETs. It gains an options argument for method and body. Order calls get their own longer timeout: a fill can take several seconds and timing out mid-order leaves you unsure whether a position exists.

- [ ] **Step 1: Write the failing test**

Create `server/test/bridge-orders.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createBridgeClient } = require('../src/bridge/client');

function startStub(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

test('order posts JSON and returns the ticket', async (t) => {
  let seen = null;
  let method = null;
  const { server, url } = await startStub(async (req, res) => {
    method = req.method;
    seen = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ticket: 12345, price: 1.1, volume: 0.01, retcode: 10009 }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });
  const result = await client.order({ symbol: 'EURUSD', side: 'BUY', lot: 0.01, sl: 1.09, tp: 1.12 });

  assert.equal(method, 'POST');
  assert.equal(seen.symbol, 'EURUSD');
  assert.equal(seen.side, 'BUY');
  assert.equal(seen.lot, 0.01);
  assert.equal(seen.sl, 1.09);
  assert.equal(result.ticket, 12345);
});

test('a rejected order surfaces the status and the broker comment', async (t) => {
  const { server, url } = await startStub((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'a stop loss is required on every order', code: 'no_stop_loss' }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });
  await assert.rejects(
    () => client.order({ symbol: 'EURUSD', side: 'BUY', lot: 0.01 }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /stop loss is required/);
      return true;
    }
  );
});

test('positions and deals are fetched as GETs', async (t) => {
  const seen = [];
  const { server, url } = await startStub((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/positions')
      ? { positions: [{ ticket: 1, symbol: 'EURUSD', side: 'BUY', volume: 0.01 }] }
      : { deals: [{ ticket: 2, position_id: 1, profit: 3.5 }] }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });

  const p = await client.positions();
  assert.equal(p.positions.length, 1);

  const d = await client.deals({ ticket: 1 });
  assert.equal(d.deals[0].profit, 3.5);

  assert.deepEqual(seen.map((s) => s.method), ['GET', 'GET']);
  assert.match(seen[1].url, /ticket=1/);
});

test('closePosition posts the ticket', async (t) => {
  let seen = null;
  const { server, url } = await startStub(async (req, res) => {
    seen = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, retcode: 10009 }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });
  const result = await client.closePosition({ ticket: 999 });

  assert.equal(seen.ticket, 999);
  assert.equal(result.ok, true);
});

test('an order gets a longer timeout than a health check', async (t) => {
  const sockets = new Set();
  const { server, url } = await startStub(() => {});
  server.on('connection', (s) => sockets.add(s));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });

  const client = createBridgeClient({ baseUrl: url, token: 't', timeoutMs: 100 });

  const started = Date.now();
  await assert.rejects(() => client.order({ symbol: 'EURUSD', side: 'BUY', lot: 0.01, sl: 1 }),
    /timed out/i);
  const elapsed = Date.now() - started;

  // A fill can take seconds; timing out early leaves the caller unsure
  // whether a position exists.
  assert.ok(elapsed > 100, `order timeout must exceed the default, took ${elapsed}ms`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/bridge-orders.test.js
```

Expected: FAIL — `client.order is not a function`.

- [ ] **Step 3: Extend the bridge client**

In `server/src/bridge/client.js`, change the `request` signature and body handling. Replace:

```js
  async function request(path, params, overrideTimeoutMs) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const budgetMs = overrideTimeoutMs ?? timeoutMs;

    let response;
    try {
      response = await fetch(url, {
        headers: { 'X-Bridge-Token': token || '' },
        signal: AbortSignal.timeout(budgetMs)
      });
    } catch (cause) {
```

with:

```js
  async function request(path, params, overrideTimeoutMs, options = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const budgetMs = overrideTimeoutMs ?? timeoutMs;
    const headers = { 'X-Bridge-Token': token || '' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(budgetMs)
      });
    } catch (cause) {
```

Then extend the returned object. Replace:

```js
    candles: ({ symbol, timeframe = 'H1', count = 500 }) =>
      request('/candles', { symbol, timeframe, count })
  };
```

with:

```js
    candles: ({ symbol, timeframe = 'H1', count = 500 }) =>
      request('/candles', { symbol, timeframe, count }),

    positions: () => request('/positions', undefined, 20000),
    deals: ({ ticket }) => request('/deals', { ticket }, 20000),

    // Orders get their own, longer budget. A fill can take several seconds,
    // and timing out mid-order leaves the caller unsure whether a position
    // now exists - the worst possible state to be in.
    order: (payload) => request('/order', undefined, ORDER_TIMEOUT_MS, { method: 'POST', body: payload }),
    closePosition: ({ ticket }) =>
      request('/close', undefined, ORDER_TIMEOUT_MS, { method: 'POST', body: { ticket } })
  };
```

Add near the top of the file, after the opening comment block:

```js
const ORDER_TIMEOUT_MS = 30000;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test test/bridge-orders.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/bridge/client.js server/test/bridge-orders.test.js
git commit -m "feat(bridge-client): add order, close, positions and deals methods"
```

---

### Task 3: Execution manager

**Files:**
- Create: `server/src/execution/manager.js`, `server/migrations/006_trade_execution.sql`
- Test: `server/test/execution-manager.test.js`

**Interfaces:**
- Consumes: `assessSignal` (phase 3), `getSignal` (phase 3 store), `query`, a bridge client.
- Produces:
  - `executeApprovedSignals({ bridge, mode, balance }) -> Promise<{ attempted, filled, skipped, failed }>`
  - `executeSignal({ bridge, signal, mode, balance }) -> Promise<{ status, tradeId, ticket, reason }>` where `status` is `'filled' | 'skipped' | 'failed'`

The order of operations is the safety property here:

1. Load the signal and its symbol.
2. **Re-run the risk engine.** Approval happened at some earlier moment; since then the kill switch may have tripped, the loss cap may have been hit, or another position may have opened. A stale approval is not a licence to trade.
3. **Insert the trade row with `status = 'PENDING'` before sending.** If the order succeeds and the process dies before the response is handled, the row is the evidence that something may be open.
4. Send the order.
5. On success, update the row to `OPEN` with the broker ticket and fill price. On failure, mark it `CANCELLED` with the reason.

- [ ] **Step 1: Write the migration**

Create `server/migrations/006_trade_execution.sql`:

```sql
-- A trade row is written BEFORE the order is sent, so a crash between send
-- and response leaves evidence rather than an untracked position. PENDING is
-- that pre-send state.
ALTER TABLE trades
  MODIFY COLUMN status ENUM('PENDING','OPEN','CLOSED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  MODIFY COLUMN lot DECIMAL(20,8) NOT NULL,
  ADD COLUMN requested_price DECIMAL(18,8) NULL AFTER entry_price,
  ADD COLUMN retcode         INT          NULL AFTER broker_ticket,
  ADD COLUMN broker_comment  VARCHAR(255) NULL AFTER retcode,
  ADD COLUMN exit_reason     VARCHAR(32)  NULL AFTER close_price,
  ADD COLUMN last_synced_at  DATETIME     NULL AFTER closed_at;
```

- [ ] **Step 2: Write the failing test**

Create `server/test/execution-manager.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_exec_test';

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, currency_profit, currency_margin, synced_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, 'USD', 'USD', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);
  const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");

  return { symbolId: sym.id, strategyId: st.id };
}

async function insertSignal({ strategyId, symbolId, status = 'approved', sl = 99 }) {
  const { query } = require('../src/db/pool');
  const result = await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, lot, status)
     VALUES (?, ?, 'H1', 'demo', UTC_TIMESTAMP(), '2026-02-01 00:00:00', 'BUY', 100, ?, 102, 0.5, ?)`,
    [strategyId, symbolId, sl, status]
  );
  return result.insertId;
}

function stubBridge({ ok = true, ticket = 555, price = 100.05, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    order: async (payload) => {
      calls.push(payload);
      if (fail) throw Object.assign(new Error(fail), { status: 400 });
      return { ok, ticket, price, volume: payload.lot, retcode: ok ? 10009 : 10016, comment: ok ? 'Done' : 'Invalid stops' };
    },
    positions: async () => ({ positions: [] }),
    deals: async () => ({ deals: [] }),
    closePosition: async () => ({ ok: true, retcode: 10009 })
  };
}

test('an approved signal is sent and recorded as OPEN', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  const signalId = await insertSignal({ strategyId, symbolId });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');
  const bridge = stubBridge();

  const result = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(result.attempted, 1);
  assert.equal(result.filled, 1);

  const trades = await query('SELECT * FROM trades');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'OPEN');
  assert.equal(Number(trades[0].broker_ticket), 555);
  assert.equal(Number(trades[0].entry_price), 100.05);
  assert.equal(Number(trades[0].signal_id), signalId);

  const [signal] = await query('SELECT status FROM signals WHERE id = ?', [signalId]);
  assert.equal(signal.status, 'executed');
});

test('every order carries the stop loss from the signal', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId, sl: 98.5 });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const bridge = stubBridge();

  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(bridge.calls.length, 1);
  assert.equal(Number(bridge.calls[0].sl), 98.5);
  assert.ok(bridge.calls[0].lot > 0);
});

test('the risk engine runs again at send time, not just at approval', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  // The signal was approved earlier; the switch trips before it is sent.
  const { tripKillSwitch } = require('../src/risk/state');
  await tripKillSwitch({ mode: 'demo', reason: 'tripped after approval' });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');
  const bridge = stubBridge();

  const result = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(result.skipped, 1);
  assert.equal(result.filled, 0);
  assert.equal(bridge.calls.length, 0, 'no order may be sent once the switch is on');
  assert.equal((await query('SELECT COUNT(*) AS n FROM trades'))[0].n, 0);
});

test('a signal with no stop loss is never sent', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  const { query } = require('../src/db/pool');
  const result = await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, status)
     VALUES (?, ?, 'H1', 'demo', UTC_TIMESTAMP(), '2026-02-01 00:00:00', 'BUY', 100, 100, 102, 'approved')`,
    [strategyId, symbolId]
  );
  assert.ok(result.insertId);

  const { executeApprovedSignals } = require('../src/execution/manager');
  const bridge = stubBridge();

  const outcome = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });
  assert.equal(outcome.skipped, 1);
  assert.equal(bridge.calls.length, 0, 'a zero-width stop must not reach the broker');
});

test('a rejected order leaves a CANCELLED trade with the reason', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');
  const bridge = stubBridge({ fail: 'bridge /order returned 400: Invalid stops' });

  const result = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(result.failed, 1);
  const trades = await query('SELECT * FROM trades');
  assert.equal(trades.length, 1, 'the pre-send row survives so nothing is invisible');
  assert.equal(trades[0].status, 'CANCELLED');
  assert.match(trades[0].broker_comment, /Invalid stops/);
});

test('only approved signals are executed', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId, status: 'new' });
  await insertSignal({ strategyId, symbolId, status: 'rejected' });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const bridge = stubBridge();

  const result = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });
  assert.equal(result.attempted, 0);
  assert.equal(bridge.calls.length, 0);
});

test('a signal is never executed twice', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');
  const bridge = stubBridge();

  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });
  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(bridge.calls.length, 1, 'the second pass finds nothing approved');
  assert.equal((await query('SELECT COUNT(*) AS n FROM trades'))[0].n, 1);
});

test('the trade row is written before the order is sent', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  const { query } = require('../src/db/pool');
  let rowsAtSendTime = null;

  const bridge = {
    order: async (payload) => {
      // Observe the database from inside the send.
      rowsAtSendTime = await query('SELECT status FROM trades');
      return { ok: true, ticket: 777, price: 100.05, volume: payload.lot, retcode: 10009, comment: 'Done' };
    },
    positions: async () => ({ positions: [] }),
    deals: async () => ({ deals: [] }),
    closePosition: async () => ({ ok: true })
  };

  const { executeApprovedSignals } = require('../src/execution/manager');
  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(rowsAtSendTime.length, 1, 'a row exists before the broker is called');
  assert.equal(rowsAtSendTime[0].status, 'PENDING');
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && node --test test/execution-manager.test.js
```

Expected: FAIL — `Cannot find module '../src/execution/manager'`.

- [ ] **Step 4: Implement the manager**

Create `server/src/execution/manager.js`:

```js
const { query } = require('../db/pool');
const { assessSignal } = require('../risk/engine');
const { countOpenPositions } = require('../signals/generator');

/**
 * Turns approved signals into broker orders.
 *
 * Two properties matter more than anything else here:
 *
 *   1. The risk engine runs AGAIN immediately before sending. Approval
 *      happened at some earlier moment; since then the kill switch may have
 *      tripped, the daily loss cap may have been hit, or another position may
 *      have opened. A stale approval is not a licence to trade.
 *
 *   2. The trade row is written BEFORE the order is sent. If the order
 *      succeeds and this process dies before handling the response, the row
 *      is the evidence that something may be open at the broker. An
 *      untracked position is the worst state this system can reach.
 */

async function loadApprovedSignals(mode) {
  return query(
    `SELECT sig.*, st.status AS strategy_status
       FROM signals sig
       JOIN strategies st ON st.id = sig.strategy_id
      WHERE sig.mode = ? AND sig.status = 'approved'
      ORDER BY sig.id`,
    [mode]
  );
}

async function executeSignal({ bridge, signal, mode, balance }) {
  const symbolRows = await query('SELECT * FROM symbols WHERE id = ?', [signal.symbol_id]);
  if (symbolRows.length === 0) {
    return { status: 'skipped', reason: `unknown symbolId ${signal.symbol_id}` };
  }
  const symbol = symbolRows[0];

  // Re-assess. The world has moved on since approval.
  const decision = await assessSignal({
    signal: {
      side: signal.side,
      entry: Number(signal.entry),
      sl: Number(signal.sl),
      tp: signal.tp === null ? null : Number(signal.tp),
      symbol_id: signal.symbol_id,
      strategy_status: signal.strategy_status
    },
    symbol,
    mode,
    balance,
    openPositions: await countOpenPositions(mode)
  });

  if (!decision.allowed) {
    await query(
      `UPDATE signals
          SET status = 'rejected', decided_at = UTC_TIMESTAMP(), decided_by = 'system',
              decision = JSON_SET(COALESCE(decision, JSON_OBJECT()), '$.atSendTime', CAST(? AS JSON))
        WHERE id = ?`,
      [JSON.stringify(decision), signal.id]
    );
    return { status: 'skipped', reason: decision.denialReasons.join('; ') };
  }

  // Write the row first, so a crash mid-send leaves evidence.
  const inserted = await query(
    `INSERT INTO trades
       (signal_id, symbol_id, mode, side, lot, entry_price, requested_price, sl, tp,
        opened_at, status)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, UTC_TIMESTAMP(), 'PENDING')`,
    [
      signal.id, signal.symbol_id, mode, signal.side, decision.lot,
      Number(signal.entry), Number(signal.sl),
      signal.tp === null ? null : Number(signal.tp)
    ]
  );
  const tradeId = inserted.insertId;

  let result;
  try {
    result = await bridge.order({
      symbol: symbol.broker_symbol,
      side: signal.side,
      lot: decision.lot,
      sl: Number(signal.sl),
      tp: signal.tp === null ? null : Number(signal.tp),
      comment: `sig-${signal.id}`
    });
  } catch (error) {
    await query(
      `UPDATE trades SET status = 'CANCELLED', broker_comment = ?, last_synced_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [String(error.message).slice(0, 255), tradeId]
    );
    return { status: 'failed', tradeId, reason: error.message };
  }

  if (!result.ok) {
    await query(
      `UPDATE trades SET status = 'CANCELLED', retcode = ?, broker_comment = ?,
              last_synced_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [result.retcode ?? null, String(result.comment || 'rejected').slice(0, 255), tradeId]
    );
    return { status: 'failed', tradeId, reason: result.comment || 'the broker rejected the order' };
  }

  await query(
    `UPDATE trades
        SET status = 'OPEN', broker_ticket = ?, retcode = ?, broker_comment = ?,
            entry_price = ?, lot = ?, last_synced_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [
      result.ticket ?? null, result.retcode ?? null,
      String(result.comment || '').slice(0, 255),
      result.price ?? Number(signal.entry),
      result.volume ?? decision.lot,
      tradeId
    ]
  );

  await query(
    `UPDATE signals SET status = 'executed', decided_at = UTC_TIMESTAMP() WHERE id = ?`,
    [signal.id]
  );

  await query(
    `INSERT INTO audit_log (logged_at, actor, action, payload)
     VALUES (UTC_TIMESTAMP(), 'system', 'order_filled', CAST(? AS JSON))`,
    [JSON.stringify({ tradeId, signalId: signal.id, ticket: result.ticket, lot: decision.lot, mode })]
  );

  return { status: 'filled', tradeId, ticket: result.ticket };
}

async function executeApprovedSignals({ bridge, mode = 'demo', balance = 10000 }) {
  const signals = await loadApprovedSignals(mode);

  let filled = 0;
  let skipped = 0;
  let failed = 0;

  for (const signal of signals) {
    const outcome = await executeSignal({ bridge, signal, mode, balance });
    if (outcome.status === 'filled') filled += 1;
    else if (outcome.status === 'skipped') skipped += 1;
    else failed += 1;
  }

  return { attempted: signals.length, filled, skipped, failed };
}

module.exports = { executeApprovedSignals, executeSignal };
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && node --test test/execution-manager.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Apply the migration**

```bash
npm --prefix server run migrate
docker exec trading-mysql mysql -utrader -ptraderpass trading_agent -e "SHOW COLUMNS FROM trades LIKE 'requested_price';"
```

Expected: one row.

- [ ] **Step 7: Commit**

```bash
git add server/src/execution/manager.js server/migrations/006_trade_execution.sql server/test/execution-manager.test.js
git commit -m "feat(execution): send approved signals with a risk re-check before every order"
```

---

### Task 4: Reconciler

**Files:**
- Create: `server/src/execution/reconciler.js`
- Test: `server/test/reconciler.test.js`

**Interfaces:**
- Consumes: `recordTradeResult` (phase 3 state), `query`, a bridge client.
- Produces: `reconcile({ bridge, mode }) -> Promise<{ openAtBroker, closed, orphans, updated }>`

The rule: **the broker is the source of truth.** Every cycle, positions are read from MT5. A trade the app thinks is `OPEN` but the broker no longer reports has been closed — by stop, target, or by hand in the terminal — and its realised result is recovered from the deal history and fed into the risk state, so the kill switch responds to what actually happened.

An `orphan` is a broker position with no matching trade row. It is logged loudly and never auto-closed: closing a position the system does not understand is worse than reporting it.

- [ ] **Step 1: Write the failing test**

Create `server/test/reconciler.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_recon_test';

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);
  return sym.id;
}

async function openTrade(symbolId, ticket, lot = 0.1) {
  const { query } = require('../src/db/pool');
  const r = await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, tp, opened_at,
       status, broker_ticket)
     VALUES (?, 'demo', 'BUY', ?, 100, 99, 102, UTC_TIMESTAMP(), 'OPEN', ?)`,
    [symbolId, lot, ticket]
  );
  return r.insertId;
}

function stubBridge({ positions = [], deals = [], account = null } = {}) {
  return {
    positions: async () => ({ positions }),
    deals: async () => ({ deals }),
    account: async () => account || { balance: 10000, equity: 10000, margin_free: 9000 },
    order: async () => { throw new Error('the reconciler must never place an order'); },
    closePosition: async () => { throw new Error('the reconciler must never close a position'); }
  };
}

test('a trade still open at the broker stays open', async (t) => {
  const symbolId = await seeded(t);
  await openTrade(symbolId, 111);

  const { reconcile } = require('../src/execution/reconciler');
  const { query } = require('../src/db/pool');

  const result = await reconcile({
    bridge: stubBridge({ positions: [{ ticket: 111, symbol: 'XAUUSD', side: 'BUY', volume: 0.1, profit: 3 }] }),
    mode: 'demo'
  });

  assert.equal(result.openAtBroker, 1);
  assert.equal(result.closed, 0);
  assert.equal((await query("SELECT status FROM trades WHERE broker_ticket = 111"))[0].status, 'OPEN');
});

test('a trade the broker no longer reports is closed with its realised result', async (t) => {
  const symbolId = await seeded(t);
  await openTrade(symbolId, 222);

  const { reconcile } = require('../src/execution/reconciler');
  const { query } = require('../src/db/pool');

  const result = await reconcile({
    bridge: stubBridge({
      positions: [],
      deals: [
        { ticket: 1, position_id: 222, entry: 0, profit: 0, commission: -0.7, swap: 0, price: 100 },
        { ticket: 2, position_id: 222, entry: 1, profit: 12.5, commission: -0.7, swap: -0.1, price: 101.25 }
      ]
    }),
    mode: 'demo'
  });

  assert.equal(result.closed, 1);

  const [trade] = await query('SELECT * FROM trades WHERE broker_ticket = 222');
  assert.equal(trade.status, 'CLOSED');
  assert.equal(Number(trade.close_price), 101.25);
  // Profit plus both commissions plus swap.
  assert.equal(Number(trade.pnl), 11);
  assert.ok(trade.closed_at);
});

test('a closed trade feeds the daily risk state', async (t) => {
  const symbolId = await seeded(t);
  await openTrade(symbolId, 333);

  const { reconcile } = require('../src/execution/reconciler');
  const { getState } = require('../src/risk/state');

  await reconcile({
    bridge: stubBridge({
      positions: [],
      deals: [{ ticket: 9, position_id: 333, entry: 1, profit: -20, commission: 0, swap: 0, price: 98 }]
    }),
    mode: 'demo'
  });

  const state = await getState('demo');
  assert.equal(Number(state.realized_pnl), -20);
  assert.equal(state.trades_count, 1);
  assert.equal(state.consecutive_losses, 1, 'the kill switch must see real results');
});

test('three losing closes trip the kill switch through reconciliation', async (t) => {
  const symbolId = await seeded(t);
  const { reconcile } = require('../src/execution/reconciler');
  const { getState } = require('../src/risk/state');

  for (const ticket of [401, 402, 403]) {
    await openTrade(symbolId, ticket);
    await reconcile({
      bridge: stubBridge({
        positions: [],
        deals: [{ ticket, position_id: ticket, entry: 1, profit: -5, commission: 0, swap: 0, price: 99 }]
      }),
      mode: 'demo'
    });
  }

  const state = await getState('demo');
  assert.equal(state.kill_switch, 1, 'real losses trip the switch, not simulated ones');
});

test('a broker position with no trade row is reported as an orphan, never closed', async (t) => {
  await seeded(t);

  const { reconcile } = require('../src/execution/reconciler');
  const result = await reconcile({
    bridge: stubBridge({ positions: [{ ticket: 999, symbol: 'XAUUSD', side: 'BUY', volume: 0.5, profit: 1 }] }),
    mode: 'demo'
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].ticket, 999);
  // stubBridge throws if closePosition is called, so reaching here proves it
  // was not. Closing a position the system does not understand is worse than
  // reporting it.
});

test('a close with no deal history still closes the trade', async (t) => {
  const symbolId = await seeded(t);
  await openTrade(symbolId, 555);

  const { reconcile } = require('../src/execution/reconciler');
  const { query } = require('../src/db/pool');

  const result = await reconcile({ bridge: stubBridge({ positions: [], deals: [] }), mode: 'demo' });

  assert.equal(result.closed, 1);
  const [trade] = await query('SELECT * FROM trades WHERE broker_ticket = 555');
  assert.equal(trade.status, 'CLOSED');
  assert.equal(Number(trade.pnl), 0, 'unknown result is recorded as zero, not guessed');
});

test('reconcile records an equity snapshot', async (t) => {
  await seeded(t);
  const { reconcile } = require('../src/execution/reconciler');
  const { query } = require('../src/db/pool');

  await reconcile({
    bridge: stubBridge({ account: { balance: 100000, equity: 100120, margin_free: 99000 } }),
    mode: 'demo'
  });

  const snaps = await query('SELECT * FROM equity_snapshots');
  assert.equal(snaps.length, 1);
  assert.equal(Number(snaps[0].equity), 100120);
  assert.equal(snaps[0].mode, 'demo');
});

test('PENDING trades are left alone, not treated as closed', async (t) => {
  const symbolId = await seeded(t);
  const { query } = require('../src/db/pool');
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, 'demo', 'BUY', 0.1, 100, 99, UTC_TIMESTAMP(), 'PENDING')`,
    [symbolId]
  );

  const { reconcile } = require('../src/execution/reconciler');
  const result = await reconcile({ bridge: stubBridge({ positions: [] }), mode: 'demo' });

  assert.equal(result.closed, 0);
  assert.equal((await query("SELECT status FROM trades"))[0].status, 'PENDING');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/reconciler.test.js
```

Expected: FAIL — `Cannot find module '../src/execution/reconciler'`.

- [ ] **Step 3: Implement the reconciler**

Create `server/src/execution/reconciler.js`:

```js
const { query } = require('../db/pool');
const { recordTradeResult } = require('../risk/state');

/**
 * The broker is the source of truth.
 *
 * Every cycle reads open positions from MT5 and reconciles them against the
 * trades table. A trade the app believes is OPEN that the broker no longer
 * reports has been closed - by stop, by target, or by hand in the terminal -
 * and its realised result is recovered from the deal history and pushed into
 * the daily risk state, so the kill switch reacts to what actually happened
 * rather than to what the app assumed.
 *
 * The app never acts on its own cached picture of the account.
 */

async function realisedResultFor(bridge, ticket) {
  let deals = [];
  try {
    deals = (await bridge.deals({ ticket })).deals || [];
  } catch {
    // History can be briefly unavailable. Closing with a zero result is
    // recoverable; leaving the trade open forever is not.
    return null;
  }
  if (deals.length === 0) return null;

  // DEAL_ENTRY_OUT === 1 is the closing leg.
  const closing = deals.filter((d) => Number(d.entry) === 1);
  const source = closing.length > 0 ? closing : deals;

  const pnl = deals.reduce(
    (sum, d) => sum + Number(d.profit || 0) + Number(d.commission || 0) + Number(d.swap || 0),
    0
  );
  const commission = deals.reduce((sum, d) => sum + Number(d.commission || 0), 0);
  const swap = deals.reduce((sum, d) => sum + Number(d.swap || 0), 0);

  return {
    pnl: Number(pnl.toFixed(4)),
    commission: Number(commission.toFixed(4)),
    swap: Number(swap.toFixed(4)),
    closePrice: Number(source[source.length - 1].price)
  };
}

async function snapshotEquity(bridge, mode) {
  try {
    const account = await bridge.account();
    if (!account || account.balance === undefined) return;
    await query(
      `INSERT INTO equity_snapshots (mode, captured_at, balance, equity, margin_free)
       VALUES (?, UTC_TIMESTAMP(), ?, ?, ?)`,
      [mode, account.balance, account.equity, account.margin_free ?? null]
    );
  } catch {
    // A missing snapshot is cosmetic; it must never abort reconciliation.
  }
}

async function reconcile({ bridge, mode = 'demo' }) {
  const { positions = [] } = await bridge.positions();
  const openTickets = new Set(positions.map((p) => Number(p.ticket)));

  // PENDING is deliberately excluded: those orders were never confirmed, so
  // their absence from the broker means nothing.
  const tracked = await query(
    "SELECT * FROM trades WHERE mode = ? AND status = 'OPEN' AND broker_ticket IS NOT NULL",
    [mode]
  );
  const trackedTickets = new Set(tracked.map((t) => Number(t.broker_ticket)));

  let closed = 0;
  let updated = 0;

  for (const trade of tracked) {
    const ticket = Number(trade.broker_ticket);

    if (openTickets.has(ticket)) {
      await query('UPDATE trades SET last_synced_at = UTC_TIMESTAMP() WHERE id = ?', [trade.id]);
      updated += 1;
      continue;
    }

    const realised = await realisedResultFor(bridge, ticket);
    const pnl = realised ? realised.pnl : 0;

    await query(
      `UPDATE trades
          SET status = 'CLOSED', closed_at = UTC_TIMESTAMP(), last_synced_at = UTC_TIMESTAMP(),
              close_price = ?, pnl = ?, commission = ?, swap = ?, exit_reason = ?
        WHERE id = ?`,
      [
        realised ? realised.closePrice : null,
        pnl,
        realised ? Math.abs(realised.commission) : 0,
        realised ? realised.swap : 0,
        realised ? 'BROKER' : 'BROKER_NO_HISTORY',
        trade.id
      ]
    );

    // Feed the real result into the daily state so the kill switch reacts to
    // what happened rather than to what was expected.
    await recordTradeResult({ mode, pnl });

    await query(
      `INSERT INTO audit_log (logged_at, actor, action, payload)
       VALUES (UTC_TIMESTAMP(), 'system', 'trade_closed', CAST(? AS JSON))`,
      [JSON.stringify({ tradeId: trade.id, ticket, pnl, mode })]
    );

    closed += 1;
  }

  // A broker position with no trade row. Reported, never touched: closing a
  // position the system does not understand is worse than reporting it.
  const orphans = positions
    .filter((p) => !trackedTickets.has(Number(p.ticket)))
    .map((p) => ({ ticket: Number(p.ticket), symbol: p.symbol, side: p.side, volume: p.volume }));

  if (orphans.length > 0) {
    await query(
      `INSERT INTO audit_log (logged_at, actor, action, payload)
       VALUES (UTC_TIMESTAMP(), 'system', 'orphan_positions', CAST(? AS JSON))`,
      [JSON.stringify({ mode, orphans })]
    );
  }

  await snapshotEquity(bridge, mode);

  return { openAtBroker: positions.length, closed, updated, orphans };
}

module.exports = { reconcile };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test test/reconciler.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/execution/reconciler.js server/test/reconciler.test.js
git commit -m "feat(execution): reconcile positions from the broker as the source of truth"
```

---

### Task 5: Journal, scheduler wiring and API

**Files:**
- Create: `server/src/execution/journal.js`, `server/src/routes/execution.js`
- Modify: `server/src/scheduler/index.js`, `server/src/index.js`
- Test: `server/test/execution-routes.test.js`

**Interfaces:**
- Consumes: `executeApprovedSignals` (Task 3), `reconcile` (Task 4).
- Produces:
  - `journal.js`: `listTrades({ mode, status, limit })`, `tradeStats({ mode })` → `{ open, closed, netPnl, wins, losses, winRatePct }`, `equityHistory({ mode, limit })`
  - `execution.js` router:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/trades?mode=&status=&limit=` | Trade journal |
| GET | `/api/trades/stats?mode=` | Aggregate performance |
| GET | `/api/equity?mode=&limit=` | Equity snapshots |
| POST | `/api/execution/run` | Execute approved signals now |
| POST | `/api/execution/reconcile` | Reconcile now |
| POST | `/api/execution/close/:tradeId` | Close one position by hand |

The scheduler tick becomes: sync candles → generate signals → **execute approved** → **reconcile** → expire stale. Execution before reconciliation, so a fill in this tick is picked up by the next one rather than being reconciled against a broker that has not registered it yet.

**Deviation from the spec, recorded deliberately:** section 8 specifies reconciliation every 30 seconds, but this plan reconciles once per scheduler tick, which defaults to 60. Two cadences would mean two loops and two chances to race each other over the same trade rows. The tick interval is a parameter, so `intervalMs: 30000` gets the spec's cadence for both when the demo period starts; until then a slower loop is easier to watch.

**`EXECUTION_ENABLED` defaults to false.** Even with the scheduler running, no order is sent until this is explicitly turned on. Two switches, because a loop that trades is a different thing from a loop that watches.

- [ ] **Step 1: Write the failing test**

Create `server/test/execution-routes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_execroutes_test';

function stubBridge() {
  return {
    positions: async () => ({ positions: [] }),
    deals: async () => ({ deals: [] }),
    account: async () => ({ balance: 10000, equity: 10050, margin_free: 9000 }),
    order: async (p) => ({ ok: true, ticket: 4242, price: 100.1, volume: p.lot, retcode: 10009, comment: 'Done' }),
    closePosition: async () => ({ ok: true, retcode: 10009 })
  };
}

async function startApp(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, currency_profit, currency_margin, synced_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, 'USD', 'USD', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);
  const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");

  await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, status)
     VALUES (?, ?, 'H1', 'demo', UTC_TIMESTAMP(), '2026-02-01 00:00:00', 'BUY', 100, 99, 102, 'approved')`,
    [st.id, sym.id]
  );

  const { createExecutionRouter } = require('../src/routes/execution');
  const app = express();
  app.use(express.json());
  app.use('/api', createExecutionRouter({ bridge: stubBridge() }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());

  return { base: `http://127.0.0.1:${server.address().port}`, symbolId: sym.id };
}

test('POST /api/execution/run fills the approved signal', async (t) => {
  const { base } = await startApp(t);

  const res = await fetch(`${base}/api/execution/run`, { method: 'POST' });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.filled, 1);

  const trades = await (await fetch(`${base}/api/trades?mode=demo`)).json();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'OPEN');
  assert.equal(Number(trades[0].broker_ticket), 4242);
  assert.equal(trades[0].broker_symbol, 'XAUUSD');
});

test('reconcile closes the trade the stub broker no longer reports', async (t) => {
  const { base } = await startApp(t);
  await fetch(`${base}/api/execution/run`, { method: 'POST' });

  const res = await fetch(`${base}/api/execution/reconcile`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).closed, 1);

  const trades = await (await fetch(`${base}/api/trades?mode=demo`)).json();
  assert.equal(trades[0].status, 'CLOSED');
});

test('GET /api/trades/stats aggregates the journal', async (t) => {
  const { base } = await startApp(t);
  await fetch(`${base}/api/execution/run`, { method: 'POST' });
  await fetch(`${base}/api/execution/reconcile`, { method: 'POST' });

  const stats = await (await fetch(`${base}/api/trades/stats?mode=demo`)).json();
  assert.equal(stats.closed, 1);
  assert.equal(typeof stats.netPnl, 'number');
  assert.equal(typeof stats.winRatePct, 'number');
});

test('GET /api/equity returns snapshots after reconciliation', async (t) => {
  const { base } = await startApp(t);
  await fetch(`${base}/api/execution/reconcile`, { method: 'POST' });

  const equity = await (await fetch(`${base}/api/equity?mode=demo`)).json();
  assert.equal(equity.length, 1);
  assert.equal(Number(equity[0].equity), 10050);
});

test('closing an unknown trade is a 404', async (t) => {
  const { base } = await startApp(t);
  const res = await fetch(`${base}/api/execution/close/999999`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('a manual close sends the ticket to the broker', async (t) => {
  const { base } = await startApp(t);
  await fetch(`${base}/api/execution/run`, { method: 'POST' });

  const [trade] = await (await fetch(`${base}/api/trades?mode=demo`)).json();
  const res = await fetch(`${base}/api/execution/close/${trade.id}`, { method: 'POST' });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/execution-routes.test.js
```

Expected: FAIL — `Cannot find module '../src/routes/execution'`.

- [ ] **Step 3: Implement the journal**

Create `server/src/execution/journal.js`:

```js
const { query } = require('../db/pool');

const SELECT = `
  SELECT t.*, sym.broker_symbol, sig.reason AS signal_reason
    FROM trades t
    JOIN symbols sym ON sym.id = t.symbol_id
    LEFT JOIN signals sig ON sig.id = t.signal_id
`;

async function listTrades({ mode, status, limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 1000);
  const where = [];
  const params = [];
  if (mode) { where.push('t.mode = ?'); params.push(mode); }
  if (status) { where.push('t.status = ?'); params.push(status); }

  return query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.id DESC LIMIT ${safeLimit}`,
    params
  );
}

async function tradeStats({ mode = 'demo' } = {}) {
  const rows = await query(
    `SELECT
       SUM(status = 'OPEN')                        AS openCount,
       SUM(status = 'CLOSED')                      AS closedCount,
       COALESCE(SUM(CASE WHEN status = 'CLOSED' THEN pnl ELSE 0 END), 0) AS netPnl,
       SUM(status = 'CLOSED' AND pnl > 0)          AS wins,
       SUM(status = 'CLOSED' AND pnl <= 0)         AS losses
     FROM trades WHERE mode = ?`,
    [mode]
  );
  const r = rows[0];
  const closed = Number(r.closedCount || 0);
  const wins = Number(r.wins || 0);

  return {
    open: Number(r.openCount || 0),
    closed,
    netPnl: Number(r.netPnl || 0),
    wins,
    losses: Number(r.losses || 0),
    winRatePct: closed > 0 ? (wins / closed) * 100 : 0
  };
}

async function equityHistory({ mode = 'demo', limit = 500 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 5000);
  const rows = await query(
    `SELECT captured_at, balance, equity, margin_free
       FROM equity_snapshots WHERE mode = ?
      ORDER BY id DESC LIMIT ${safeLimit}`,
    [mode]
  );
  return rows.reverse();
}

module.exports = { listTrades, tradeStats, equityHistory };
```

- [ ] **Step 4: Implement the router**

Create `server/src/routes/execution.js`:

```js
const express = require('express');

const { query } = require('../db/pool');
const { executeApprovedSignals } = require('../execution/manager');
const { reconcile } = require('../execution/reconciler');
const { listTrades, tradeStats, equityHistory } = require('../execution/journal');

function createExecutionRouter({ bridge }) {
  const router = express.Router();

  router.get('/trades', async (req, res, next) => {
    try {
      res.json(await listTrades({
        mode: req.query.mode, status: req.query.status, limit: req.query.limit
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/trades/stats', async (req, res, next) => {
    try {
      res.json(await tradeStats({ mode: req.query.mode || 'demo' }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/equity', async (req, res, next) => {
    try {
      res.json(await equityHistory({ mode: req.query.mode || 'demo', limit: req.query.limit }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/execution/run', async (req, res, next) => {
    try {
      const mode = String(req.body?.mode || process.env.TRADING_MODE || 'demo');
      const balance = Number(req.body?.balance || process.env.ACCOUNT_BALANCE_HINT || 10000);
      res.json(await executeApprovedSignals({ bridge, mode, balance }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/execution/reconcile', async (req, res, next) => {
    try {
      const mode = String(req.body?.mode || process.env.TRADING_MODE || 'demo');
      res.json(await reconcile({ bridge, mode }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/execution/close/:tradeId', async (req, res, next) => {
    try {
      const rows = await query(
        "SELECT * FROM trades WHERE id = ? AND status = 'OPEN'",
        [Number(req.params.tradeId)]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: `no open trade with id ${req.params.tradeId}` });
      }
      res.json(await bridge.closePosition({ ticket: Number(rows[0].broker_ticket) }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createExecutionRouter };
```

- [ ] **Step 5: Wire execution into the scheduler tick**

In `server/src/scheduler/index.js`, add to the imports:

```js
const { executeApprovedSignals } = require('../execution/manager');
const { reconcile } = require('../execution/reconciler');
```

Add to the destructured options, after `expireStaleSignalsFn = expireStaleSignals,`:

```js
  executeFn = executeApprovedSignals,
  reconcileFn = reconcile,
  // A loop that watches and a loop that trades are different things, so they
  // get separate switches. Even with the scheduler running, no order is sent
  // until this is explicitly enabled.
  executionEnabled = process.env.EXECUTION_ENABLED === 'true',
  balance = Number(process.env.ACCOUNT_BALANCE_HINT || 10000),
```

Then replace the body of `runOnce` between the `generateSignalsFn` call and the `expireStaleSignalsFn` call. Change:

```js
    const signals = await generateSignalsFn({ mode, timeframe });
    const expired = await expireStaleSignalsFn({ olderThanMinutes: 60, mode });

    lastResult = { at: new Date().toISOString(), symbolsSynced, signals, expired };
    return lastResult;
```

to:

```js
    const signals = await generateSignalsFn({ mode, timeframe });

    // Execute before reconciling: a fill from this tick is then picked up by
    // the next one, rather than being reconciled against a broker that has
    // not registered it yet.
    const execution = executionEnabled
      ? await executeFn({ bridge, mode, balance })
      : { attempted: 0, filled: 0, skipped: 0, failed: 0, disabled: true };

    const reconciliation = await reconcileFn({ bridge, mode });
    const expired = await expireStaleSignalsFn({ olderThanMinutes: 60, mode });

    lastResult = {
      at: new Date().toISOString(),
      symbolsSynced, signals, execution, reconciliation, expired
    };
    return lastResult;
```

- [ ] **Step 6: Mount the router**

In `server/src/index.js`, below the risk router line, add:

```js
const { createExecutionRouter } = require('./routes/execution');

app.use('/api', createExecutionRouter({ bridge: bridgeFromEnv() }));
```

Delete the `sampleTrades` constant and its `/api/trades` route — the real router replaces them.

Add to `server/.env`:

```
# Set to true to let the scheduler actually send orders. Separate from
# SCHEDULER_ENABLED on purpose: watching and trading are different things.
EXECUTION_ENABLED=false
# Account balance used for position sizing until reconciliation supplies one.
ACCOUNT_BALANCE_HINT=100000
```

Add the same keys to `server/.env.example` with `EXECUTION_ENABLED=false` and `ACCOUNT_BALANCE_HINT=10000`.

- [ ] **Step 7: Update the scheduler tests for the new tick shape**

In `server/test/scheduler.test.js`, in the first test, change the assertions block. Replace:

```js
  const result = await scheduler.runOnce();

  assert.deepEqual(calls, ['sync', 'generate', 'expire'], 'sync, then generate, then expire');
  assert.equal(result.symbolsSynced, 1);
  assert.equal(result.signals.created, 1);
  assert.equal(result.expired, 2);
```

with:

```js
  const result = await scheduler.runOnce();

  assert.deepEqual(calls, ['sync', 'generate', 'reconcile', 'expire'],
    'reconcile runs every tick; execution is off by default');
  assert.equal(result.symbolsSynced, 1);
  assert.equal(result.signals.created, 1);
  assert.equal(result.execution.disabled, true, 'execution is opt-in');
  assert.equal(result.expired, 2);
```

And in that same test, add these two injected dependencies to the `createScheduler` call, after `expireStaleSignalsFn`:

```js
    executeFn: async () => { calls.push('execute'); return { attempted: 0, filled: 0, skipped: 0, failed: 0 }; },
    reconcileFn: async () => { calls.push('reconcile'); return { openAtBroker: 0, closed: 0, updated: 0, orphans: [] }; }
```

Add these same two stubs to the `createScheduler` call in every other test in that file, so no test reaches the real database:

```js
    executeFn: async () => ({ attempted: 0, filled: 0, skipped: 0, failed: 0 }),
    reconcileFn: async () => ({ openAtBroker: 0, closed: 0, updated: 0, orphans: [] })
```

Then add a new test at the end of the file:

```js
test('execution runs only when explicitly enabled', async () => {
  const calls = [];
  const base = {
    bridge: fakeBridge(),
    syncCandlesFn: async () => ({ received: 0, stored: 0 }),
    listSymbolsFn: async () => [],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0,
    executeFn: async () => { calls.push('execute'); return { attempted: 1, filled: 1, skipped: 0, failed: 0 }; },
    reconcileFn: async () => ({ openAtBroker: 0, closed: 0, updated: 0, orphans: [] })
  };

  const off = createScheduler({ ...base, executionEnabled: false });
  const offResult = await off.runOnce();
  assert.deepEqual(calls, [], 'no order path is touched while execution is off');
  assert.equal(offResult.execution.disabled, true);

  const on = createScheduler({ ...base, executionEnabled: true });
  const onResult = await on.runOnce();
  assert.deepEqual(calls, ['execute']);
  assert.equal(onResult.execution.filled, 1);
});
```

- [ ] **Step 8: Run the full suite**

```bash
npm --prefix server test
```

Expected: PASS, all tests.

- [ ] **Step 9: Commit**

```bash
git add server/src/execution/journal.js server/src/routes/execution.js server/src/scheduler/index.js server/src/index.js server/.env.example server/test/execution-routes.test.js server/test/scheduler.test.js
git commit -m "feat(execution): add the trade journal, execution API and scheduler wiring"
```

---

### Task 6: Trades UI

**Files:**
- Create: `client/src/pages/Trades.jsx`
- Modify: `client/src/api.js`, `client/src/App.jsx`, `client/src/styles.css`

**Interfaces:**
- Consumes: the API from Task 5.
- Produces: an Execution view — open positions, closed trade journal, aggregate stats, an equity curve, manual close and manual run/reconcile buttons.

- [ ] **Step 1: Add the API helpers**

In `client/src/api.js`, add these entries inside the exported `api` object:

```js
  trades: (mode = 'demo', status = '') =>
    request(`/api/trades?mode=${mode}${status ? `&status=${status}` : ''}`),
  tradeStats: (mode = 'demo') => request(`/api/trades/stats?mode=${mode}`),
  equity: (mode = 'demo') => request(`/api/equity?mode=${mode}`),
  runExecution: (mode = 'demo') =>
    request('/api/execution/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode })
    }),
  reconcile: (mode = 'demo') =>
    request('/api/execution/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode })
    }),
  closeTrade: (tradeId) => request(`/api/execution/close/${tradeId}`, { method: 'POST' }),
```

- [ ] **Step 2: Write the Trades page**

Create `client/src/pages/Trades.jsx`:

```jsx
import { useCallback, useEffect, useState } from 'react';
import EquityCurve from '../components/EquityCurve';
import { api } from '../api';

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

export default function Trades() {
  const [mode, setMode] = useState('demo');
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [equity, setEquity] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setTrades(await api.trades(mode));
    setStats(await api.tradeStats(mode));
    setEquity(await api.equity(mode));
  }, [mode]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const open = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
  const done = trades.filter((t) => t.status === 'CLOSED' || t.status === 'CANCELLED');

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Execution</h3>
        <span>{mode} account</span>
      </div>

      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
        <button disabled={busy} onClick={() => act(() => api.runExecution(mode))}>
          Send approved signals
        </button>
        <button disabled={busy} onClick={() => act(() => api.reconcile(mode))}>
          Reconcile with broker
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {stats && (
        <section className="stats-grid">
          <div className="stat-card blue"><span>Open</span><strong>{stats.open}</strong></div>
          <div className="stat-card purple"><span>Closed</span><strong>{stats.closed}</strong></div>
          <div className={`stat-card ${stats.netPnl >= 0 ? 'green' : 'orange'}`}>
            <span>Net P&amp;L</span><strong>{num(stats.netPnl)}</strong>
          </div>
          <div className="stat-card orange"><span>Win rate</span><strong>{num(stats.winRatePct, 1)}%</strong></div>
        </section>
      )}

      <h4>Open positions</h4>
      {open.length === 0 ? <p className="empty">No open positions.</p> : (
        <table className="table">
          <thead>
            <tr><th>#</th><th>Symbol</th><th>Side</th><th>Lot</th><th>Entry</th><th>Stop</th><th>Target</th><th>Ticket</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {open.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>{t.broker_symbol}</td>
                <td className={t.side === 'BUY' ? 'up' : 'down'}>{t.side}</td>
                <td>{num(t.lot, 2)}</td>
                <td>{num(t.entry_price, 5)}</td>
                <td>{num(t.sl, 5)}</td>
                <td>{t.tp ? num(t.tp, 5) : '—'}</td>
                <td>{t.broker_ticket ?? '—'}</td>
                <td>{t.status}</td>
                <td>
                  {t.status === 'OPEN' && (
                    <button disabled={busy} onClick={() => act(() => api.closeTrade(t.id))}>Close</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Equity</h4>
      <EquityCurve equity={equity.map((e) => Number(e.equity))} />

      <h4>Journal</h4>
      {done.length === 0 ? <p className="empty">No closed trades yet.</p> : (
        <table className="table">
          <thead>
            <tr><th>#</th><th>Symbol</th><th>Side</th><th>Lot</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Reason</th><th>Status</th></tr>
          </thead>
          <tbody>
            {done.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>{t.broker_symbol}</td>
                <td className={t.side === 'BUY' ? 'up' : 'down'}>{t.side}</td>
                <td>{num(t.lot, 2)}</td>
                <td>{num(t.entry_price, 5)}</td>
                <td>{t.close_price ? num(t.close_price, 5) : '—'}</td>
                <td className={Number(t.pnl) >= 0 ? 'up' : 'down'}>{num(t.pnl)}</td>
                <td>{t.exit_reason || t.broker_comment || '—'}</td>
                <td>{t.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Wire the view into the app shell**

In `client/src/App.jsx`, add beside the other page imports:

```jsx
import Trades from './pages/Trades';
```

Change the Execution nav button:

```jsx
          <button className={view === 'execution' ? 'nav active' : 'nav'} onClick={() => setView('execution')}>Execution</button>
```

Add a branch to the view switch, after the `signals` branch:

```jsx
          : view === 'execution' ? <Trades />
```

Also delete the `trades` state, its `fetch('/api/trades')` call, and the "Recent trades" panel from the Overview — that route now returns real rows with a different shape.

- [ ] **Step 4: Build and verify in the browser**

```bash
npm run build
npm run dev
```

Open `http://localhost:5173`, click **Execution**, and confirm the four stat cards, the empty-state messages, and both buttons render without errors.

- [ ] **Step 5: Commit**

```bash
git add client/src
git commit -m "feat(ui): add the Execution view with the trade journal and equity curve"
```

---

### Task 7: The first real order

**Files:** none — this is a deliberate manual verification against the live demo account.

This is the first time the system sends an order to a broker. It is done by hand, watched, on the smallest possible size, and then immediately closed.

- [ ] **Step 1: Confirm the guards before doing anything**

```bash
TOKEN=$(grep '^BRIDGE_TOKEN=' server/.env | cut -d= -f2)
curl -s -H "X-Bridge-Token: $TOKEN" http://127.0.0.1:8000/health
```

Required, all four: `ok: true`, `trade_allowed: true`, `trading_enabled: true`, and **`account_is_real: false`**. If `account_is_real` is anything but false, **stop** — that is not a demo account.

- [ ] **Step 2: Confirm the stop-loss guard still refuses**

```bash
curl -s -X POST http://127.0.0.1:8000/order -H "X-Bridge-Token: $TOKEN" \
  -H 'content-type: application/json' -d '{"symbol":"EURUSD","side":"BUY","lot":0.01}'
```

Expected: 400 with `"code": "no_stop_loss"`. Anything else means the last line of defence is broken; stop and fix it.

- [ ] **Step 3: Place one minimum-size order with a stop**

The market must be open. Take the current price from the bridge and set a stop well away from it:

```bash
curl -s -H "X-Bridge-Token: $TOKEN" "http://127.0.0.1:8000/candles?symbol=EURUSD&timeframe=M1&count=1"
```

Using the close from that response as `P`, place a 0.01 lot buy with a stop roughly 50 pips below:

```bash
curl -s -X POST http://127.0.0.1:8000/order -H "X-Bridge-Token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"symbol":"EURUSD","side":"BUY","lot":0.01,"sl":<P minus 0.0050>,"comment":"first-manual-test"}'
```

Expected: `"ok": true` with a `ticket`. Confirm the position also appears in the MT5 terminal window — the terminal is the independent check on everything this system reports.

- [ ] **Step 4: Confirm the reconciler sees it**

```bash
curl -s -X POST http://localhost:3001/api/execution/reconcile -H 'content-type: application/json' -d '{"mode":"demo"}'
```

Expected: `openAtBroker: 1` and one entry in `orphans` — correct, because this order was placed by hand rather than through the execution manager, so no trade row exists. That the reconciler notices and reports it rather than ignoring it is the point of the check.

- [ ] **Step 5: Close it**

```bash
curl -s -X POST http://127.0.0.1:8000/close -H "X-Bridge-Token: $TOKEN" \
  -H 'content-type: application/json' -d '{"ticket":<ticket from step 3>}'
```

Expected: `"ok": true`. Confirm the position is gone from the terminal.

- [ ] **Step 6: Record the result**

Note in `docs/superpowers/specs/2026-08-29-trading-agent-dashboard-design.md`, under a new "Execution verification" heading, the date, the ticket, the fill price and that the round trip completed. This is the evidence that the write path works end to end before the demo period starts.

---

## Phase 4 Definition of Done

- [ ] `npm --prefix server test` passes.
- [ ] `npm run build` succeeds.
- [ ] `MT5_ALLOW_TRADING`, `MT5_ALLOW_LIVE` and `EXECUTION_ENABLED` all default to false in `.env.example`.
- [ ] The bridge rejects an order with no stop loss, verified by curl.
- [ ] The bridge rejects a real account while `MT5_ALLOW_LIVE=false`.
- [ ] The risk engine is re-run at send time — a kill switch tripped after approval prevents the order.
- [ ] A trade row exists in `PENDING` before the broker is called.
- [ ] Reconciliation closes trades the broker has closed and feeds the result into `risk_state`.
- [ ] Orphan broker positions are reported and never auto-closed.
- [ ] One manual round trip completed on the demo account.

## What Phase 4 deliberately does not do

No authentication, no alerting, no LLM commentary, no deployment. Those are phase 5, and **authentication must land before this is exposed on any network** — a dashboard that can place orders has no business being reachable without a login.
