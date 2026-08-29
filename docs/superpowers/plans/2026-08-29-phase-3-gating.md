# Phase 3: Gating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the brakes — a risk engine that can veto any trade, a live signal generator sharing the backtest's exact strategy code, and an approval queue — so that phase 4 can place orders without the system being able to hurt the account.

**Architecture:** Position sizing moves out of the backtest engine into `src/risk/sizing.js` and is imported by both, so live and backtest size positions with byte-identical code. A `RiskEngine` layers stateful gates on top: daily loss cap, concurrent positions, consecutive-loss kill switch, news blackout, and a non-negotiable stop-loss requirement. A scheduler syncs candles and runs the same `evaluate()` the backtester uses, persisting signals; demo mode auto-approves, live mode queues for a human click.

**Tech Stack:** Node 22 (built-in `node:test`), Express 4, mysql2, MySQL 8.4, React 18 + Vite.

**Spec:** `docs/superpowers/specs/2026-08-29-trading-agent-dashboard-design.md`

## Global Constraints

- Node >= 22. Built-in `node:test` and `node:assert/strict`. No new test framework. No scheduler library — `setInterval` is sufficient and adds no dependency.
- All timestamps UTC. Prices are JS numbers (`decimalNumbers: true` on the pool).
- CommonJS (`require`) in `server/`, ES modules in `client/`.
- Every SQL change is a new numbered migration. Never edit an applied migration.
- **Phase 3 places no orders.** It produces signals and decisions only; `src/execution/` arrives in phase 4. Nothing here may call the bridge's order endpoints — which do not exist yet, by design.
- **No order without a stop loss. Not configurable.** A signal lacking a finite `sl` is rejected before sizing.
- **A lot below `min_lot` is refused, never rounded up.** On $100 that single rule is the difference between 1% risk and 20%.
- Live mode additionally requires: strategy `status = 'live'`, kill switch off, and explicit per-signal operator approval.
- Integration tests use `server/test/helpers/db.js` → `freshDatabase(t, name)`, which registers cleanup before anything that can throw.

---

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `server/src/risk/sizing.js` | Position sizing, shared verbatim by backtest and live |
| `server/src/risk/settings.js` | Load/save the `risk` settings row with defaults |
| `server/src/risk/state.js` | `risk_state` read/write: daily rollover, loss tally, consecutive losses, kill switch |
| `server/src/risk/engine.js` | `assessSignal()` — runs every gate, returns an allow/deny decision |
| `server/src/signals/generator.js` | Runs strategies over stored candles, persists signals |
| `server/src/signals/store.js` | Signal queries: list, approve, reject, expire |
| `server/src/scheduler/index.js` | Periodic candle sync + signal generation, start/stop |
| `server/src/routes/signals.js` | `/api/signals`, approve/reject |
| `server/src/routes/risk.js` | `/api/risk/*` — state, settings, kill switch |
| `server/migrations/005_signal_decisions.sql` | Decision audit columns on `signals` |
| `client/src/pages/Signals.jsx` | Live signals and the approval queue |
| `client/src/pages/Risk.jsx` | Risk state, settings, kill switch |
| `server/test/*.test.js` | Unit and integration tests |

**Modify:** `server/src/backtest/engine.js` (import shared sizing, delete the local copy), `server/src/index.js` (mount routers, start scheduler), `client/src/App.jsx`, `client/src/api.js`, `client/src/styles.css`.

---

### Task 1: Shared position sizing

**Files:**
- Create: `server/src/risk/sizing.js`
- Modify: `server/src/backtest/engine.js`
- Test: `server/test/sizing.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sizePosition({ balance, riskPct, entry, sl, symbol }) -> { lot, riskAmount, stopDistance, rejected, reason }`
    - `symbol` is a row from `symbols`: `{ contract_size, min_lot, lot_step, max_lot }`
    - `lot` is `0` when rejected; `reason` names why
  - `roundToStep(value, step) -> number`

The backtest engine currently owns a private `sizePosition` returning a bare number. It moves here and gains a reason, so live rejections can be explained to the operator. **Both callers must import the same function** — a live path that sizes differently from the backtest makes the backtest meaningless.

- [ ] **Step 1: Write the failing test**

Create `server/test/sizing.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { sizePosition, roundToStep } = require('../src/risk/sizing');

const FX = { contract_size: 100000, min_lot: 0.01, lot_step: 0.01, max_lot: 500 };
const GOLD = { contract_size: 100, min_lot: 0.01, lot_step: 0.01, max_lot: 100 };

test('roundToStep floors to the step and absorbs float noise', () => {
  assert.equal(roundToStep(0.0999999999, 0.01), 0.09);
  // 1.1 - 1.09 is 0.010000000000000009 in binary floating point; without
  // absorbing that, this floors one whole step low.
  assert.equal(roundToStep(100 / ((1.1 - 1.09) * 100000) / 0.01 * 0.01, 0.01), 0.1);
  assert.equal(roundToStep(0.005, 0.01), 0);
});

test('lot follows risk, stop distance and contract size', () => {
  // 1% of 10,000 = $100 risk. Stop 0.0100 wide on a 100,000 contract loses
  // $1,000 per lot, so 0.1 lots.
  const r = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.09, symbol: FX });
  assert.equal(r.rejected, false);
  assert.equal(r.lot, 0.1);
  assert.equal(r.riskAmount, 100);
  assert.equal(Number(r.stopDistance.toFixed(5)), 0.01);
});

test('halving risk halves the lot', () => {
  const full = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.09, symbol: FX });
  const half = sizePosition({ balance: 10000, riskPct: 0.5, entry: 1.10, sl: 1.09, symbol: FX });
  assert.equal(half.lot, Number((full.lot / 2).toFixed(4)));
});

test('a lot below the broker minimum is REFUSED, never rounded up', () => {
  // The real case: $100 account, EURUSD, a 22 pip ATR stop. The minimum lot
  // would risk $2.23, i.e. 2.2% of the account against a 1% cap.
  const r = sizePosition({ balance: 100, riskPct: 1, entry: 1.1000, sl: 1.09777, symbol: FX });
  assert.equal(r.rejected, true);
  assert.equal(r.lot, 0);
  assert.match(r.reason, /below the broker minimum/i);
});

test('a lot above the broker maximum is capped, not rejected', () => {
  const r = sizePosition({ balance: 100000000, riskPct: 1, entry: 1.10, sl: 1.09, symbol: FX });
  assert.equal(r.rejected, false);
  assert.equal(r.lot, FX.max_lot);
});

test('a zero-width stop is rejected rather than dividing by zero', () => {
  const r = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.10, symbol: FX });
  assert.equal(r.rejected, true);
  assert.match(r.reason, /stop distance/i);
});

test('a missing stop loss is rejected outright', () => {
  for (const sl of [null, undefined, NaN]) {
    const r = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl, symbol: FX });
    assert.equal(r.rejected, true, `sl ${sl} must be rejected`);
    assert.match(r.reason, /stop loss/i);
  }
});

test('contract size changes the lot for the same price move', () => {
  const fx = sizePosition({ balance: 10000, riskPct: 1, entry: 100, sl: 99, symbol: FX });
  const gold = sizePosition({ balance: 10000, riskPct: 1, entry: 100, sl: 99, symbol: GOLD });
  assert.ok(gold.lot > fx.lot, 'a smaller contract permits a larger lot for the same risk');
});

test('the direction of the stop does not change the size', () => {
  const long = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.09, symbol: FX });
  const short = sizePosition({ balance: 10000, riskPct: 1, entry: 1.10, sl: 1.11, symbol: FX });
  assert.equal(long.lot, short.lot);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/sizing.test.js
```

Expected: FAIL — `Cannot find module '../src/risk/sizing'`.

- [ ] **Step 3: Implement sizing**

Create `server/src/risk/sizing.js`:

```js
/**
 * Position sizing, shared verbatim by the backtest engine and the live risk
 * engine. If these ever diverge, a backtest stops predicting live behaviour
 * and the demo period proves nothing.
 */

function roundToStep(value, step) {
  const safeStep = step || 0.01;
  // Binary floating point makes a stop distance like 1.1 - 1.09 come out as
  // 0.010000000000000009, which floors one whole step too low and silently
  // under-sizes every position. Absorb that noise before flooring.
  const steps = Math.floor(Number((value / safeStep).toFixed(8)));
  return Number((steps * safeStep).toFixed(8));
}

function sizePosition({ balance, riskPct, entry, sl, symbol }) {
  const base = { lot: 0, riskAmount: 0, stopDistance: 0, rejected: true, reason: '' };

  if (sl === null || sl === undefined || !Number.isFinite(Number(sl))) {
    return { ...base, reason: 'no stop loss on the signal' };
  }

  const stopDistance = Math.abs(Number(entry) - Number(sl));
  if (!(stopDistance > 0)) {
    return { ...base, reason: 'stop distance is zero' };
  }

  const riskAmount = Number(balance) * (Number(riskPct) / 100);
  if (!(riskAmount > 0)) {
    return { ...base, stopDistance, reason: 'risk budget is zero' };
  }

  const lossPerLot = stopDistance * Number(symbol.contract_size);
  if (!(lossPerLot > 0)) {
    return { ...base, stopDistance, riskAmount, reason: 'contract size is zero' };
  }

  const minLot = Number(symbol.min_lot) || 0.01;
  const maxLot = Number(symbol.max_lot) || Infinity;
  const raw = riskAmount / lossPerLot;
  const lot = roundToStep(raw, Number(symbol.lot_step) || 0.01);

  if (lot < minLot) {
    // Rounding up here would silently multiply the intended risk. On a small
    // account that is the single fastest way to lose it.
    const riskAtMin = minLot * lossPerLot;
    return {
      ...base,
      stopDistance,
      riskAmount,
      reason:
        `sized lot ${lot} is below the broker minimum ${minLot}; ` +
        `trading ${minLot} would risk ${riskAtMin.toFixed(2)} ` +
        `(${((riskAtMin / balance) * 100).toFixed(2)}% of balance) against a ${riskPct}% cap`
    };
  }

  return {
    lot: Math.min(lot, maxLot),
    riskAmount,
    stopDistance,
    rejected: false,
    reason: ''
  };
}

module.exports = { sizePosition, roundToStep };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test test/sizing.test.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Point the backtest engine at the shared function**

In `server/src/backtest/engine.js`, delete the whole local `sizePosition` function and add to the imports at the top:

```js
const { sizePosition } = require('../risk/sizing');
```

Then change the single call site inside `runBacktest` from:

```js
      const lot = sizePosition({
        balance, riskPct: riskPctPerTrade, entry: entryPrice, sl: pending.sl, symbol
      });
```

to:

```js
      const { lot } = sizePosition({
        balance, riskPct: riskPctPerTrade, entry: entryPrice, sl: pending.sl, symbol
      });
```

Finally change the export line at the bottom from `module.exports = { runBacktest, sizePosition };` to:

```js
module.exports = { runBacktest };
```

- [ ] **Step 6: Run the whole suite — the backtest must be unchanged**

```bash
npm --prefix server test
```

Expected: PASS, all tests including every existing backtest engine test. If any backtest test fails, the shared function does not match the old behaviour and must be reconciled before continuing.

- [ ] **Step 7: Commit**

```bash
git add server/src/risk/sizing.js server/src/backtest/engine.js server/test/sizing.test.js
git commit -m "refactor: share one position sizing function between backtest and live"
```

---

### Task 2: Risk settings and state

**Files:**
- Create: `server/src/risk/settings.js`, `server/src/risk/state.js`
- Test: `server/test/risk-state.test.js`

**Interfaces:**
- Consumes: `query` from `src/db/pool.js`.
- Produces:
  - `settings.js`: `loadRiskSettings() -> Promise<settings>`, `saveRiskSettings(patch) -> Promise<settings>`, `DEFAULT_RISK_SETTINGS`
    - settings shape: `{ riskPctPerTrade, dailyLossCapPct, maxConcurrentPositions, consecutiveLossLimit, newsBlackoutMinutes }`
  - `state.js`:
    - `getState(mode, day) -> Promise<row>` — creates today's row if absent
    - `recordTradeResult({ mode, pnl, day }) -> Promise<row>` — updates tally, increments or resets consecutive losses, trips the kill switch on the limit
    - `tripKillSwitch({ mode, reason, day }) -> Promise<row>`
    - `resetKillSwitch({ mode, day }) -> Promise<row>` — manual only
    - `currentTradingDay() -> 'YYYY-MM-DD'` (UTC)

The kill switch trips automatically but **only resets by hand**. An automatic reset would let a broken strategy resume unsupervised, which is the exact failure the switch exists to stop.

- [ ] **Step 1: Write the failing test**

Create `server/test/risk-state.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_riskstate_test';

async function migrated(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });
}

test('getState creates one row per day and mode, then reuses it', async (t) => {
  await migrated(t);
  const { getState, currentTradingDay } = require('../src/risk/state');
  const { query } = require('../src/db/pool');

  const day = currentTradingDay();
  const first = await getState('demo', day);
  assert.equal(first.realized_pnl, 0);
  assert.equal(first.consecutive_losses, 0);
  assert.equal(first.kill_switch, 0);

  await getState('demo', day);
  const rows = await query('SELECT COUNT(*) AS n FROM risk_state WHERE mode = ?', ['demo']);
  assert.equal(rows[0].n, 1, 'no duplicate row for the same day and mode');

  // A different mode is tracked separately: demo losses must never halt live.
  await getState('live', day);
  const all = await query('SELECT COUNT(*) AS n FROM risk_state');
  assert.equal(all[0].n, 2);
});

test('recordTradeResult accumulates pnl and counts trades', async (t) => {
  await migrated(t);
  const { recordTradeResult, currentTradingDay } = require('../src/risk/state');
  const day = currentTradingDay();

  await recordTradeResult({ mode: 'demo', pnl: 5, day });
  const s = await recordTradeResult({ mode: 'demo', pnl: -2, day });

  assert.equal(Number(s.realized_pnl), 3);
  assert.equal(s.trades_count, 2);
});

test('a win resets the consecutive loss counter', async (t) => {
  await migrated(t);
  const { recordTradeResult, currentTradingDay } = require('../src/risk/state');
  const day = currentTradingDay();

  await recordTradeResult({ mode: 'demo', pnl: -1, day });
  let s = await recordTradeResult({ mode: 'demo', pnl: -1, day });
  assert.equal(s.consecutive_losses, 2);

  s = await recordTradeResult({ mode: 'demo', pnl: 3, day });
  assert.equal(s.consecutive_losses, 0, 'a winner clears the streak');
});

test('the configured number of consecutive losses trips the kill switch', async (t) => {
  await migrated(t);
  const { recordTradeResult, currentTradingDay } = require('../src/risk/state');
  const day = currentTradingDay();

  await recordTradeResult({ mode: 'demo', pnl: -1, day });
  await recordTradeResult({ mode: 'demo', pnl: -1, day });
  const s = await recordTradeResult({ mode: 'demo', pnl: -1, day });

  assert.equal(s.kill_switch, 1, 'three consecutive losses trips the switch');
  assert.match(s.kill_switch_reason, /consecutive/i);
});

test('the kill switch does not reset itself on a later win', async (t) => {
  await migrated(t);
  const { recordTradeResult, getState, resetKillSwitch, currentTradingDay } = require('../src/risk/state');
  const day = currentTradingDay();

  for (let i = 0; i < 3; i += 1) await recordTradeResult({ mode: 'demo', pnl: -1, day });
  await recordTradeResult({ mode: 'demo', pnl: 10, day });

  let s = await getState('demo', day);
  assert.equal(s.kill_switch, 1, 'only a human may clear it');

  s = await resetKillSwitch({ mode: 'demo', day });
  assert.equal(s.kill_switch, 0);
  assert.equal(s.consecutive_losses, 0, 'a manual reset also clears the streak');
});

test('tripKillSwitch records the reason it was tripped', async (t) => {
  await migrated(t);
  const { tripKillSwitch, currentTradingDay } = require('../src/risk/state');

  const s = await tripKillSwitch({ mode: 'live', reason: 'daily loss cap breached', day: currentTradingDay() });
  assert.equal(s.kill_switch, 1);
  assert.equal(s.kill_switch_reason, 'daily loss cap breached');
});

test('risk settings load defaults and accept a partial patch', async (t) => {
  await migrated(t);
  const { loadRiskSettings, saveRiskSettings } = require('../src/risk/settings');

  const defaults = await loadRiskSettings();
  assert.equal(defaults.riskPctPerTrade, 1.0);
  assert.equal(defaults.dailyLossCapPct, 5.0);
  assert.equal(defaults.maxConcurrentPositions, 2);
  assert.equal(defaults.consecutiveLossLimit, 3);

  const updated = await saveRiskSettings({ riskPctPerTrade: 0.5 });
  assert.equal(updated.riskPctPerTrade, 0.5);
  assert.equal(updated.dailyLossCapPct, 5.0, 'untouched keys survive a partial patch');

  assert.equal((await loadRiskSettings()).riskPctPerTrade, 0.5, 'the change persists');
});

test('currentTradingDay is a UTC calendar date', async (t) => {
  await migrated(t);
  const { currentTradingDay } = require('../src/risk/state');
  assert.match(currentTradingDay(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(currentTradingDay(new Date('2026-03-15T23:30:00Z')), '2026-03-15');
  assert.equal(currentTradingDay(new Date('2026-03-16T00:30:00Z')), '2026-03-16');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/risk-state.test.js
```

Expected: FAIL — `Cannot find module '../src/risk/state'`.

- [ ] **Step 3: Implement settings**

Create `server/src/risk/settings.js`:

```js
const { query } = require('../db/pool');

const DEFAULT_RISK_SETTINGS = {
  riskPctPerTrade: 1.0,
  dailyLossCapPct: 5.0,
  maxConcurrentPositions: 2,
  consecutiveLossLimit: 3,
  newsBlackoutMinutes: 15
};

async function loadRiskSettings() {
  const rows = await query('SELECT setting_value FROM settings WHERE setting_key = ?', ['risk']);
  return rows.length ? { ...DEFAULT_RISK_SETTINGS, ...rows[0].setting_value } : { ...DEFAULT_RISK_SETTINGS };
}

async function saveRiskSettings(patch) {
  const merged = { ...(await loadRiskSettings()), ...(patch || {}) };
  await query(
    `INSERT INTO settings (setting_key, setting_value, updated_at)
     VALUES ('risk', CAST(? AS JSON), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = UTC_TIMESTAMP()`,
    [JSON.stringify(merged)]
  );
  return merged;
}

module.exports = { loadRiskSettings, saveRiskSettings, DEFAULT_RISK_SETTINGS };
```

- [ ] **Step 4: Implement state**

Create `server/src/risk/state.js`:

```js
const { query } = require('../db/pool');
const { loadRiskSettings } = require('./settings');

function currentTradingDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function getState(mode, day = currentTradingDay()) {
  await query(
    `INSERT INTO risk_state (trading_day, mode, updated_at)
     VALUES (?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
    [day, mode]
  );
  const rows = await query(
    'SELECT * FROM risk_state WHERE trading_day = ? AND mode = ?',
    [day, mode]
  );
  return rows[0];
}

async function recordTradeResult({ mode, pnl, day = currentTradingDay() }) {
  const settings = await loadRiskSettings();
  const state = await getState(mode, day);

  const isLoss = Number(pnl) < 0;
  const consecutive = isLoss ? state.consecutive_losses + 1 : 0;
  const shouldTrip = consecutive >= settings.consecutiveLossLimit;

  await query(
    `UPDATE risk_state
        SET realized_pnl = realized_pnl + ?,
            trades_count = trades_count + 1,
            consecutive_losses = ?,
            kill_switch = CASE WHEN ? THEN 1 ELSE kill_switch END,
            kill_switch_reason = CASE WHEN ? THEN ? ELSE kill_switch_reason END,
            updated_at = UTC_TIMESTAMP()
      WHERE trading_day = ? AND mode = ?`,
    [
      Number(pnl),
      consecutive,
      shouldTrip ? 1 : 0,
      shouldTrip ? 1 : 0,
      `${consecutive} consecutive losses reached the limit of ${settings.consecutiveLossLimit}`,
      day,
      mode
    ]
  );

  return getState(mode, day);
}

async function tripKillSwitch({ mode, reason, day = currentTradingDay() }) {
  await getState(mode, day);
  await query(
    `UPDATE risk_state
        SET kill_switch = 1, kill_switch_reason = ?, updated_at = UTC_TIMESTAMP()
      WHERE trading_day = ? AND mode = ?`,
    [reason, day, mode]
  );
  return getState(mode, day);
}

/**
 * Manual only. The switch trips by itself but never clears by itself: an
 * automatic reset would let a broken strategy resume unsupervised, which is
 * precisely the failure the switch exists to prevent.
 */
async function resetKillSwitch({ mode, day = currentTradingDay() }) {
  await getState(mode, day);
  await query(
    `UPDATE risk_state
        SET kill_switch = 0, kill_switch_reason = NULL,
            consecutive_losses = 0, updated_at = UTC_TIMESTAMP()
      WHERE trading_day = ? AND mode = ?`,
    [day, mode]
  );
  return getState(mode, day);
}

module.exports = { getState, recordTradeResult, tripKillSwitch, resetKillSwitch, currentTradingDay };
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && node --test test/risk-state.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/risk/settings.js server/src/risk/state.js server/test/risk-state.test.js
git commit -m "feat(risk): add risk settings and daily risk state with a manual-reset kill switch"
```

---

### Task 3: The risk engine

**Files:**
- Create: `server/src/risk/engine.js`
- Test: `server/test/risk-engine.test.js`

**Interfaces:**
- Consumes: `sizePosition` (Task 1), `loadRiskSettings` (Task 2), `getState` (Task 2), `query`.
- Produces: `assessSignal({ signal, symbol, mode, balance, openPositions, now }) -> Promise<decision>` where

```js
{
  allowed: boolean,
  lot: number,          // 0 when denied
  riskAmount: number,
  stopDistance: number,
  checks: [ { name, passed, detail } ],   // every gate, in order, always
  denialReasons: string[]
}
```

`signal` is `{ side, entry, sl, tp, symbol_id, strategy_status }`; `openPositions` is a count.

**Every gate runs and is reported even when an earlier one fails.** A decision that stops at the first failure hides the others, and when something goes wrong at 3am the full picture is what you need.

Gates, in order:

1. `stop_loss_present` — a finite `sl`. Not configurable.
2. `kill_switch` — off for this mode.
3. `daily_loss_cap` — realized loss for the day is within `dailyLossCapPct` of balance.
4. `max_concurrent_positions` — below the cap.
5. `news_blackout` — no HIGH impact event within `newsBlackoutMinutes` of `now` for either currency of the symbol.
6. `strategy_promoted` — in live mode the strategy must be `status = 'live'`.
7. `position_size` — sizing succeeded and is at or above `min_lot`.

- [ ] **Step 1: Write the failing test**

Create `server/test/risk-engine.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_riskengine_test';

const SYMBOL = {
  id: 1, broker_symbol: 'EURUSD', contract_size: 100000,
  min_lot: 0.01, lot_step: 0.01, max_lot: 500,
  currency_profit: 'USD', currency_margin: 'EUR'
};

const GOOD_SIGNAL = { side: 'BUY', entry: 1.1000, sl: 1.0900, tp: 1.1200, symbol_id: 1 };

async function migrated(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });
}

function check(decision, name) {
  const found = decision.checks.find((c) => c.name === name);
  assert.ok(found, `expected a check named ${name}`);
  return found;
}

test('a sound signal passes every gate and gets a lot', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo',
    balance: 10000, openPositions: 0
  });

  assert.equal(d.allowed, true, d.denialReasons.join('; '));
  assert.equal(d.lot, 0.1);
  assert.deepEqual(d.denialReasons, []);
  assert.ok(d.checks.length >= 7, 'every gate is reported');
  assert.ok(d.checks.every((c) => c.passed));
});

test('a signal without a stop loss is denied, and that gate is not configurable', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, sl: null }, symbol: SYMBOL, mode: 'demo',
    balance: 10000, openPositions: 0
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'stop_loss_present').passed, false);
  assert.equal(d.lot, 0);
});

test('a tripped kill switch denies everything', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { tripKillSwitch } = require('../src/risk/state');

  await tripKillSwitch({ mode: 'demo', reason: 'manual halt' });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'kill_switch').passed, false);
  assert.match(check(d, 'kill_switch').detail, /manual halt/);
});

test('a kill switch on one mode does not block the other', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { tripKillSwitch } = require('../src/risk/state');

  await tripKillSwitch({ mode: 'live', reason: 'live halted' });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });
  assert.equal(check(d, 'kill_switch').passed, true);
});

test('breaching the daily loss cap denies further trades', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { recordTradeResult } = require('../src/risk/state');

  // 5% of 10,000 is 500. Lose 600 in one trade.
  await recordTradeResult({ mode: 'demo', pnl: -600 });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'daily_loss_cap').passed, false);
});

test('a profitable day does not trip the loss cap', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { recordTradeResult } = require('../src/risk/state');

  await recordTradeResult({ mode: 'demo', pnl: 900 });

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0
  });
  assert.equal(check(d, 'daily_loss_cap').passed, true);
});

test('the concurrent position cap is enforced', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const ok = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 1
  });
  assert.equal(check(ok, 'max_concurrent_positions').passed, true);

  const denied = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 2
  });
  assert.equal(denied.allowed, false);
  assert.equal(check(denied, 'max_concurrent_positions').passed, false);
});

test('a high-impact news event inside the blackout window denies the trade', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { query } = require('../src/db/pool');

  const now = new Date('2026-06-01T12:00:00Z');
  // Ten minutes away, inside the default fifteen minute window.
  await query(
    `INSERT INTO news_events (event_time, currency, title, source, impact)
     VALUES ('2026-06-01 12:10:00', 'USD', 'FOMC rate decision', 'test', 'HIGH')`
  );

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0, now
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'news_blackout').passed, false);
  assert.match(check(d, 'news_blackout').detail, /FOMC/);
});

test('news outside the window, or of low impact, does not block', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { query } = require('../src/db/pool');

  const now = new Date('2026-06-01T12:00:00Z');
  await query(
    `INSERT INTO news_events (event_time, currency, title, source, impact) VALUES
      ('2026-06-01 14:00:00', 'USD', 'Far away high impact', 'test', 'HIGH'),
      ('2026-06-01 12:05:00', 'USD', 'Nearby but low impact', 'test', 'LOW'),
      ('2026-06-01 12:05:00', 'JPY', 'Nearby high impact, wrong currency', 'test', 'HIGH')`
  );

  const d = await assessSignal({
    signal: GOOD_SIGNAL, symbol: SYMBOL, mode: 'demo', balance: 10000, openPositions: 0, now
  });
  assert.equal(check(d, 'news_blackout').passed, true);
});

test('live mode requires a promoted strategy; demo does not', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  const draftInDemo = await assessSignal({
    signal: { ...GOOD_SIGNAL, strategy_status: 'draft' }, symbol: SYMBOL,
    mode: 'demo', balance: 10000, openPositions: 0
  });
  assert.equal(check(draftInDemo, 'strategy_promoted').passed, true);

  const draftInLive = await assessSignal({
    signal: { ...GOOD_SIGNAL, strategy_status: 'draft' }, symbol: SYMBOL,
    mode: 'live', balance: 10000, openPositions: 0
  });
  assert.equal(draftInLive.allowed, false);
  assert.equal(check(draftInLive, 'strategy_promoted').passed, false);

  const liveInLive = await assessSignal({
    signal: { ...GOOD_SIGNAL, strategy_status: 'live' }, symbol: SYMBOL,
    mode: 'live', balance: 10000, openPositions: 0
  });
  assert.equal(check(liveInLive, 'strategy_promoted').passed, true);
});

test('a 100 dollar account on a 22 pip stop is denied on size', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');

  // The measured real case: the broker minimum lot would risk 2.2% against a
  // 1% cap, so no trade is possible.
  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, sl: 1.09777 }, symbol: SYMBOL,
    mode: 'demo', balance: 100, openPositions: 0
  });

  assert.equal(d.allowed, false);
  assert.equal(check(d, 'position_size').passed, false);
  assert.match(check(d, 'position_size').detail, /below the broker minimum/i);
});

test('every gate is evaluated even when several fail at once', async (t) => {
  await migrated(t);
  const { assessSignal } = require('../src/risk/engine');
  const { tripKillSwitch } = require('../src/risk/state');
  await tripKillSwitch({ mode: 'demo', reason: 'halted' });

  const d = await assessSignal({
    signal: { ...GOOD_SIGNAL, sl: null }, symbol: SYMBOL,
    mode: 'demo', balance: 10000, openPositions: 99
  });

  assert.equal(d.allowed, false);
  assert.ok(d.denialReasons.length >= 3, 'all failures are reported, not just the first');
  const names = d.checks.map((c) => c.name);
  for (const gate of ['stop_loss_present', 'kill_switch', 'daily_loss_cap',
    'max_concurrent_positions', 'news_blackout', 'strategy_promoted', 'position_size']) {
    assert.ok(names.includes(gate), `missing gate: ${gate}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/risk-engine.test.js
```

Expected: FAIL — `Cannot find module '../src/risk/engine'`.

- [ ] **Step 3: Implement the engine**

Create `server/src/risk/engine.js`:

```js
const { query } = require('../db/pool');
const { sizePosition } = require('./sizing');
const { loadRiskSettings } = require('./settings');
const { getState, currentTradingDay } = require('./state');

/**
 * Runs every risk gate over a candidate signal.
 *
 * All gates are evaluated even after one fails. A decision that short-circuits
 * hides the other problems, and when something goes wrong unattended the full
 * picture is what makes it diagnosable.
 */

async function newsConflict({ symbol, now, blackoutMinutes }) {
  const currencies = [symbol.currency_profit, symbol.currency_margin].filter(Boolean);
  if (currencies.length === 0) return null;

  const windowMs = blackoutMinutes * 60 * 1000;
  const from = new Date(now.getTime() - windowMs);
  const to = new Date(now.getTime() + windowMs);

  const rows = await query(
    `SELECT title, currency, event_time
       FROM news_events
      WHERE impact = 'HIGH'
        AND event_time BETWEEN ? AND ?
        AND currency IN (${currencies.map(() => '?').join(',')})
      ORDER BY event_time
      LIMIT 1`,
    [
      from.toISOString().slice(0, 19).replace('T', ' '),
      to.toISOString().slice(0, 19).replace('T', ' '),
      ...currencies
    ]
  );
  return rows[0] || null;
}

async function assessSignal({ signal, symbol, mode, balance, openPositions = 0, now = new Date() }) {
  const settings = await loadRiskSettings();
  const day = currentTradingDay(now);
  const state = await getState(mode, day);

  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });

  // 1. Stop loss. Not configurable, and checked before anything else.
  const hasStop = signal.sl !== null && signal.sl !== undefined && Number.isFinite(Number(signal.sl));
  add('stop_loss_present', hasStop,
    hasStop ? `stop at ${signal.sl}` : 'the signal carries no stop loss');

  // 2. Kill switch, per mode.
  const killed = state.kill_switch === 1;
  add('kill_switch', !killed,
    killed ? `kill switch is on: ${state.kill_switch_reason}` : 'kill switch is off');

  // 3. Daily realized loss against the cap.
  const realized = Number(state.realized_pnl);
  const capAmount = balance * (settings.dailyLossCapPct / 100);
  const capBreached = realized < 0 && Math.abs(realized) >= capAmount;
  add('daily_loss_cap', !capBreached,
    `realized ${realized.toFixed(2)} against a cap of ${capAmount.toFixed(2)} ` +
    `(${settings.dailyLossCapPct}% of ${balance})`);

  // 4. Concurrent positions.
  const atCap = openPositions >= settings.maxConcurrentPositions;
  add('max_concurrent_positions', !atCap,
    `${openPositions} open, limit ${settings.maxConcurrentPositions}`);

  // 5. High impact news near the entry.
  const news = await newsConflict({ symbol, now, blackoutMinutes: settings.newsBlackoutMinutes });
  add('news_blackout', !news,
    news
      ? `${news.title} (${news.currency}) within ${settings.newsBlackoutMinutes} minutes`
      : `no high impact news within ${settings.newsBlackoutMinutes} minutes`);

  // 6. Promotion. Live capital demands a strategy that finished validation.
  const promoted = mode !== 'live' || signal.strategy_status === 'live';
  add('strategy_promoted', promoted,
    mode === 'live'
      ? `strategy status is ${signal.strategy_status || 'unknown'}, live requires 'live'`
      : `${mode} mode does not require promotion`);

  // 7. Position size.
  const sized = hasStop
    ? sizePosition({ balance, riskPct: settings.riskPctPerTrade, entry: signal.entry, sl: signal.sl, symbol })
    : { lot: 0, riskAmount: 0, stopDistance: 0, rejected: true, reason: 'no stop loss on the signal' };
  add('position_size', !sized.rejected,
    sized.rejected ? sized.reason : `${sized.lot} lots risking ${sized.riskAmount.toFixed(2)}`);

  const denialReasons = checks.filter((c) => !c.passed).map((c) => c.detail);

  return {
    allowed: denialReasons.length === 0,
    lot: denialReasons.length === 0 ? sized.lot : 0,
    riskAmount: sized.riskAmount,
    stopDistance: sized.stopDistance,
    checks,
    denialReasons
  };
}

module.exports = { assessSignal };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test test/risk-engine.test.js
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/risk/engine.js server/test/risk-engine.test.js
git commit -m "feat(risk): add the risk engine with seven independently reported gates"
```

---

### Task 4: Signal generation and store

**Files:**
- Create: `server/src/signals/generator.js`, `server/src/signals/store.js`, `server/migrations/005_signal_decisions.sql`
- Test: `server/test/signal-generator.test.js`

**Interfaces:**
- Consumes: `getStrategy`, `mergeParams`, `listStrategies` (phase 2 registry); `getCandles` (phase 1); `assessSignal` (Task 3).
- Produces:
  - `generator.js`: `generateSignals({ mode, now }) -> Promise<{ evaluated, created, skipped }>`
  - `store.js`: `listSignals({ mode, status, limit })`, `approveSignal(id)`, `rejectSignal(id, reason)`, `expireStaleSignals({ olderThanMinutes, mode })`

Signals carry the risk decision that produced them. `signals` gains `decision` JSON, `lot`, and `auto_approved` so a past decision can be audited without re-running anything — the inputs are gone by then.

Dedupe is by the existing `uq_signals_dedupe` key `(strategy_id, symbol_id, timeframe, bar_time, mode)`. The scheduler runs every minute over the same bars, and without dedupe one setup would become dozens of signals.

- [ ] **Step 1: Write the migration**

Create `server/migrations/005_signal_decisions.sql`:

```sql
-- A signal stores the risk decision that produced it, so a past decision can
-- be audited later without re-running anything: by then the balance, open
-- position count and news window that shaped it are all gone.
ALTER TABLE signals
  ADD COLUMN lot           DECIMAL(20,8) NULL AFTER tp,
  ADD COLUMN decision      JSON          NULL AFTER features,
  ADD COLUMN auto_approved TINYINT(1)    NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN decided_at    DATETIME      NULL AFTER auto_approved,
  ADD COLUMN decided_by    VARCHAR(32)   NULL AFTER decided_at;
```

- [ ] **Step 2: Write the failing test**

Create `server/test/signal-generator.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_siggen_test';

async function seeded(t, { status = 'demo' } = {}) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();

  await query('UPDATE strategies SET enabled = 1, status = ? WHERE name = ?', [status, 'trend-breakout']);
  await query('UPDATE strategies SET enabled = 0 WHERE name = ?', ['mean-reversion']);

  // A gold-shaped contract: with a 100,000 unit FX contract an ATR stop on a
  // price-100 series sizes below min_lot, every trade is correctly refused,
  // and the assertions below would pass while proving nothing.
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, currency_profit, currency_margin, synced_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, 'USD', 'USD', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);

  // A rising series with tight bars, so a Donchian breakout actually occurs.
  const rows = [];
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < 300; i += 1) {
    const close = 100 + i * 0.02 + Math.sin(i / 9) * 1.2;
    rows.push([
      sym.id, 'H1',
      new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      close - 0.02, close + 0.05, close - 0.05, close, 100, 0, 8
    ]);
  }
  await query(
    `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close,
       tick_volume, real_volume, spread) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    rows.flat()
  );

  return sym.id;
}

test('generateSignals creates signals from the newest bar only', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  const result = await generateSignals({ mode: 'demo' });
  assert.ok(result.evaluated > 0, 'at least one enabled strategy/symbol pair was evaluated');

  const signals = await query('SELECT * FROM signals');
  // The generator looks at the last closed bar, so it creates at most one
  // signal per strategy/symbol/timeframe per run.
  assert.ok(signals.length <= result.evaluated);
  for (const s of signals) {
    assert.equal(s.mode, 'demo');
    assert.ok(s.sl !== null, 'every stored signal carries a stop');
    assert.ok(s.decision, 'the risk decision is stored alongside');
  }
});

test('running twice does not duplicate a signal for the same bar', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  await generateSignals({ mode: 'demo' });
  const first = (await query('SELECT COUNT(*) AS n FROM signals'))[0].n;

  await generateSignals({ mode: 'demo' });
  const second = (await query('SELECT COUNT(*) AS n FROM signals'))[0].n;

  assert.equal(second, first, 'the dedupe key prevents a second signal for the same bar');
});

test('a disabled strategy produces nothing', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  await query('UPDATE strategies SET enabled = 0');
  const result = await generateSignals({ mode: 'demo' });

  assert.equal(result.evaluated, 0);
  assert.equal((await query('SELECT COUNT(*) AS n FROM signals'))[0].n, 0);
});

test('a disabled symbol produces nothing', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  await query('UPDATE symbols SET enabled = 0');
  const result = await generateSignals({ mode: 'demo' });

  assert.equal(result.evaluated, 0);
});

test('demo signals are auto-approved; live signals wait for a human', async (t) => {
  const symbolId = await seeded(t, { status: 'live' });
  const { generateSignals } = require('../src/signals/generator');
  const { query } = require('../src/db/pool');

  await generateSignals({ mode: 'demo' });
  const demoSignals = await query("SELECT * FROM signals WHERE mode = 'demo'");

  await query('DELETE FROM signals');
  await generateSignals({ mode: 'live' });
  const liveSignals = await query("SELECT * FROM signals WHERE mode = 'live'");

  for (const s of demoSignals.filter((x) => x.status !== 'rejected')) {
    assert.equal(s.auto_approved, 1, 'demo runs hands-off so the demo period measures the system');
  }
  for (const s of liveSignals.filter((x) => x.status !== 'rejected')) {
    assert.equal(s.status, 'new', 'live signals queue for approval');
    assert.equal(s.auto_approved, 0);
  }
});

test('a signal denied by risk is stored as rejected with its reasons', async (t) => {
  await seeded(t);
  const { generateSignals } = require('../src/signals/generator');
  const { tripKillSwitch } = require('../src/risk/state');
  const { query } = require('../src/db/pool');

  await tripKillSwitch({ mode: 'demo', reason: 'test halt' });
  await generateSignals({ mode: 'demo' });

  const signals = await query('SELECT * FROM signals');
  for (const s of signals) {
    assert.equal(s.status, 'rejected');
    assert.ok(JSON.stringify(s.decision).includes('kill switch'), 'the denial reason is recorded');
  }
});

test('approveSignal and rejectSignal move a signal out of the queue', async (t) => {
  await seeded(t, { status: 'live' });
  const { generateSignals } = require('../src/signals/generator');
  const { listSignals, approveSignal, rejectSignal } = require('../src/signals/store');
  const { query } = require('../src/db/pool');

  await generateSignals({ mode: 'live' });
  const pending = await listSignals({ mode: 'live', status: 'new' });
  if (pending.length === 0) {
    // The fixture produced no live candidate; insert one directly so the
    // approval path is still covered.
    const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");
    const [sym] = await query("SELECT id FROM symbols WHERE broker_symbol = 'XAUUSD'");
    await query(
      `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
         side, entry, sl, tp, status)
       VALUES (?, ?, 'H1', 'live', UTC_TIMESTAMP(), '2026-02-01 00:00:00', 'BUY', 100, 99, 102, 'new')`,
      [st.id, sym.id]
    );
  }

  const queue = await listSignals({ mode: 'live', status: 'new' });
  assert.ok(queue.length > 0);

  const approved = await approveSignal(queue[0].id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decided_by, 'user');
  assert.ok(approved.decided_at);

  const [again] = await listSignals({ mode: 'live', status: 'new' });
  if (again) {
    const rejected = await rejectSignal(again.id, 'not convinced');
    assert.equal(rejected.status, 'rejected');
    assert.match(JSON.stringify(rejected.decision), /not convinced/);
  }
});

test('expireStaleSignals ages out untouched signals', async (t) => {
  await seeded(t, { status: 'live' });
  const { expireStaleSignals, listSignals } = require('../src/signals/store');
  const { query } = require('../src/db/pool');

  const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");
  const [sym] = await query("SELECT id FROM symbols WHERE broker_symbol = 'XAUUSD'");
  await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, status)
     VALUES (?, ?, 'H1', 'live', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR),
             '2026-02-01 00:00:00', 'BUY', 100, 99, 102, 'new')`,
    [st.id, sym.id]
  );

  const expired = await expireStaleSignals({ olderThanMinutes: 60, mode: 'live' });
  assert.ok(expired >= 1);
  assert.equal((await listSignals({ mode: 'live', status: 'new' })).length, 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && node --test test/signal-generator.test.js
```

Expected: FAIL — `Cannot find module '../src/signals/generator'`.

- [ ] **Step 4: Implement the store**

Create `server/src/signals/store.js`:

```js
const { query } = require('../db/pool');

const SELECT = `
  SELECT sig.*, st.name AS strategy_name, st.status AS strategy_status, sym.broker_symbol
    FROM signals sig
    JOIN strategies st ON st.id = sig.strategy_id
    JOIN symbols   sym ON sym.id = sig.symbol_id
`;

async function listSignals({ mode, status, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 500);
  const where = [];
  const params = [];
  if (mode) { where.push('sig.mode = ?'); params.push(mode); }
  if (status) { where.push('sig.status = ?'); params.push(status); }

  return query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY sig.generated_at DESC, sig.id DESC LIMIT ${safeLimit}`,
    params
  );
}

async function getSignal(id) {
  const rows = await query(`${SELECT} WHERE sig.id = ?`, [id]);
  return rows[0] || null;
}

async function approveSignal(id) {
  await query(
    `UPDATE signals SET status = 'approved', decided_at = UTC_TIMESTAMP(), decided_by = 'user'
      WHERE id = ? AND status = 'new'`,
    [id]
  );
  return getSignal(id);
}

async function rejectSignal(id, reason) {
  await query(
    `UPDATE signals
        SET status = 'rejected', decided_at = UTC_TIMESTAMP(), decided_by = 'user',
            decision = JSON_SET(COALESCE(decision, JSON_OBJECT()), '$.userReason', ?)
      WHERE id = ?`,
    [String(reason || 'rejected by the operator'), id]
  );
  return getSignal(id);
}

/**
 * A signal describes a setup on one bar. Once that bar is well in the past the
 * setup no longer exists, so acting on it would be trading a stale idea.
 */
async function expireStaleSignals({ olderThanMinutes = 60, mode } = {}) {
  const minutes = Math.max(Number.parseInt(olderThanMinutes, 10) || 60, 1);
  const params = [];
  let modeClause = '';
  if (mode) { modeClause = 'AND mode = ?'; params.push(mode); }

  const result = await query(
    `UPDATE signals
        SET status = 'expired', decided_at = UTC_TIMESTAMP(), decided_by = 'system'
      WHERE status = 'new'
        AND generated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${minutes} MINUTE)
        ${modeClause}`,
    params
  );
  return result.affectedRows || 0;
}

module.exports = { listSignals, getSignal, approveSignal, rejectSignal, expireStaleSignals };
```

- [ ] **Step 5: Implement the generator**

Create `server/src/signals/generator.js`:

```js
const { query } = require('../db/pool');
const { getCandles } = require('../market/candles');
const { getStrategy, mergeParams } = require('../strategies/registry');
const { assessSignal } = require('../risk/engine');

const DEFAULT_TIMEFRAME = 'H1';
const HISTORY_BARS = 500;

/**
 * Runs enabled strategies over stored candles and persists what they produce.
 *
 * This calls the SAME evaluate() the backtester calls. That is the whole point
 * of the strategy contract: if live and backtest ever run different code, the
 * demo period measures nothing about the strategy.
 */
async function generateSignals({ mode = 'demo', now = new Date(), timeframe = DEFAULT_TIMEFRAME } = {}) {
  const strategies = await query('SELECT * FROM strategies WHERE enabled = 1');
  const symbols = await query('SELECT * FROM symbols WHERE enabled = 1');

  let evaluated = 0;
  let created = 0;
  let skipped = 0;

  for (const strategyRow of strategies) {
    let strategy;
    try {
      strategy = getStrategy(strategyRow.name);
    } catch {
      skipped += 1;
      continue; // Registered in the database but no longer shipped in code.
    }

    for (const symbol of symbols) {
      const candles = await getCandles({ symbolId: symbol.id, timeframe, limit: HISTORY_BARS });
      if (candles.length < 2) { skipped += 1; continue; }

      evaluated += 1;

      const params = mergeParams(strategy, strategyRow.params);
      const context = strategy.prepare(candles, params);

      // Only the last CLOSED bar is considered. The newest bar is still
      // forming, and acting on a price that can still move is the live
      // equivalent of the backtest's lookahead bug.
      const index = candles.length - 2;
      const raw = strategy.evaluate(candles, index, params, context);
      if (!raw) continue;

      const barTime = candles[index].open_time.slice(0, 19).replace('T', ' ');

      const decision = await assessSignal({
        signal: { ...raw, symbol_id: symbol.id, strategy_status: strategyRow.status },
        symbol,
        mode,
        balance: Number(process.env.ACCOUNT_BALANCE_HINT || 10000),
        openPositions: await countOpenPositions(mode),
        now
      });

      // Demo runs hands-off so the two week demo measures the system rather
      // than the operator's reflexes. Live queues for a click.
      const status = decision.allowed ? (mode === 'demo' ? 'approved' : 'new') : 'rejected';
      const autoApproved = decision.allowed && mode === 'demo' ? 1 : 0;

      const result = await query(
        `INSERT IGNORE INTO signals
           (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time, side,
            entry, sl, tp, lot, confidence, reason, features, decision, status,
            auto_approved, decided_at, decided_by)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?,
                 CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, ?)`,
        [
          strategyRow.id, symbol.id, timeframe, mode, barTime, raw.side,
          raw.entry, raw.sl, raw.tp ?? null, decision.lot || null,
          raw.confidence ?? null, raw.reason || null,
          JSON.stringify(raw.features || {}),
          JSON.stringify(decision),
          status,
          autoApproved,
          status === 'new' ? null : new Date().toISOString().slice(0, 19).replace('T', ' '),
          status === 'new' ? null : 'system'
        ]
      );

      if (result.affectedRows > 0) created += 1;
    }
  }

  return { evaluated, created, skipped };
}

async function countOpenPositions(mode) {
  const rows = await query(
    "SELECT COUNT(*) AS n FROM trades WHERE mode = ? AND status = 'OPEN'",
    [mode]
  );
  return rows[0].n;
}

module.exports = { generateSignals, countOpenPositions };
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd server && node --test test/signal-generator.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Apply the migration**

```bash
npm --prefix server run migrate
docker exec trading-mysql mysql -utrader -ptraderpass trading_agent -e "SHOW COLUMNS FROM signals LIKE 'decision';"
```

Expected: one row named `decision`.

- [ ] **Step 8: Commit**

```bash
git add server/src/signals server/migrations/005_signal_decisions.sql server/test/signal-generator.test.js
git commit -m "feat(signals): generate live signals through the risk engine with dedupe"
```

---

### Task 5: Scheduler

**Files:**
- Create: `server/src/scheduler/index.js`
- Test: `server/test/scheduler.test.js`

**Interfaces:**
- Consumes: `syncCandles`, `listSymbols` (phase 1); `generateSignals` (Task 4); `expireStaleSignals` (Task 4); `bridgeFromEnv` (phase 1).
- Produces: `createScheduler({ bridge, intervalMs, mode, timeframe }) -> { start(), stop(), runOnce(), isRunning() }`

`setInterval` rather than a cron library: the cadence is a fixed interval, and a dependency would earn nothing. **Ticks never overlap** — a slow candle sync must not have a second tick running behind it, or two generators race on the same bar.

- [ ] **Step 1: Write the failing test**

Create `server/test/scheduler.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createScheduler } = require('../src/scheduler');

function fakeBridge() {
  return { candles: async () => ({ server_utc_offset_seconds: 0, candles: [] }) };
}

test('runOnce reports what each phase did', async () => {
  const calls = [];
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    syncCandlesFn: async () => { calls.push('sync'); return { received: 5, stored: 5 }; },
    listSymbolsFn: async () => [{ id: 1, broker_symbol: 'EURUSD' }],
    generateSignalsFn: async () => { calls.push('generate'); return { evaluated: 1, created: 1, skipped: 0 }; },
    expireStaleSignalsFn: async () => { calls.push('expire'); return 2; }
  });

  const result = await scheduler.runOnce();

  assert.deepEqual(calls, ['sync', 'generate', 'expire'], 'sync, then generate, then expire');
  assert.equal(result.symbolsSynced, 1);
  assert.equal(result.signals.created, 1);
  assert.equal(result.expired, 2);
});

test('ticks never overlap', async () => {
  let active = 0;
  let maxActive = 0;

  const scheduler = createScheduler({
    bridge: fakeBridge(),
    intervalMs: 10,
    syncCandlesFn: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return { received: 0, stored: 0 };
    },
    listSymbolsFn: async () => [{ id: 1, broker_symbol: 'EURUSD' }],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 200));
  scheduler.stop();

  assert.equal(maxActive, 1, 'a slow tick must not have another running behind it');
});

test('a failing tick is contained and the scheduler keeps running', async () => {
  let ticks = 0;
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    intervalMs: 10,
    syncCandlesFn: async () => { ticks += 1; throw new Error('bridge is down'); },
    listSymbolsFn: async () => [{ id: 1, broker_symbol: 'EURUSD' }],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0,
    // The failures here are deliberate; keep them out of the test output.
    logger: { error: () => {} }
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 120));
  scheduler.stop();

  assert.ok(ticks >= 2, 'an error on one tick must not stop the schedule');
});

test('stop halts the schedule and isRunning reflects it', async () => {
  let ticks = 0;
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    intervalMs: 10,
    syncCandlesFn: async () => { ticks += 1; return { received: 0, stored: 0 }; },
    listSymbolsFn: async () => [{ id: 1, broker_symbol: 'EURUSD' }],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0
  });

  assert.equal(scheduler.isRunning(), false);
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);

  await new Promise((r) => setTimeout(r, 60));
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);

  const after = ticks;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ticks, after, 'no further ticks after stop');
});

test('start is idempotent', async () => {
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    intervalMs: 10,
    syncCandlesFn: async () => ({ received: 0, stored: 0 }),
    listSymbolsFn: async () => [],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0
  });

  scheduler.start();
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false, 'one stop is enough after two starts');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/scheduler.test.js
```

Expected: FAIL — `Cannot find module '../src/scheduler'`.

- [ ] **Step 3: Implement the scheduler**

Create `server/src/scheduler/index.js`:

```js
const { syncCandles } = require('../market/candles');
const { listSymbols } = require('../market/symbols');
const { generateSignals } = require('../signals/generator');
const { expireStaleSignals } = require('../signals/store');

/**
 * Periodic candle sync followed by signal generation.
 *
 * setInterval rather than a cron library: the cadence is a plain fixed
 * interval and a dependency would earn nothing.
 *
 * The dependencies are injectable so the tests can drive the loop without a
 * database or a broker.
 */
function createScheduler({
  bridge,
  intervalMs = 60000,
  mode = process.env.TRADING_MODE || 'demo',
  timeframe = 'H1',
  syncCandlesFn = syncCandles,
  listSymbolsFn = listSymbols,
  generateSignalsFn = generateSignals,
  expireStaleSignalsFn = expireStaleSignals,
  logger = console
} = {}) {
  let timer = null;
  let ticking = false;
  let lastResult = null;

  async function runOnce() {
    const symbols = await listSymbolsFn({ enabledOnly: true });

    let symbolsSynced = 0;
    for (const symbol of symbols) {
      await syncCandlesFn(bridge, {
        symbolId: symbol.id,
        brokerSymbol: symbol.broker_symbol,
        timeframe,
        count: 300
      });
      symbolsSynced += 1;
    }

    const signals = await generateSignalsFn({ mode, timeframe });
    const expired = await expireStaleSignalsFn({ olderThanMinutes: 60, mode });

    lastResult = { at: new Date().toISOString(), symbolsSynced, signals, expired };
    return lastResult;
  }

  async function tick() {
    // A slow candle sync must never have a second tick running behind it, or
    // two generators race to create a signal for the same bar.
    if (ticking) return;
    ticking = true;
    try {
      await runOnce();
    } catch (error) {
      // One bad tick - a closed terminal, a dropped connection - must not end
      // the schedule.
      logger.error(`scheduler tick failed: ${error.message}`);
      lastResult = { at: new Date().toISOString(), error: error.message };
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      // Do not hold the process open on this timer alone.
      if (typeof timer.unref === 'function') timer.unref();
      tick();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning: () => timer !== null,
    lastRun: () => lastResult,
    runOnce
  };
}

module.exports = { createScheduler };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test test/scheduler.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/scheduler server/test/scheduler.test.js
git commit -m "feat(scheduler): add a non-overlapping candle sync and signal generation loop"
```

---

### Task 6: Signals and risk API

**Files:**
- Create: `server/src/routes/signals.js`, `server/src/routes/risk.js`
- Modify: `server/src/index.js`
- Test: `server/test/signal-risk-routes.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces two routers mounted at `/api`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/signals?mode=&status=&limit=` | Signals, newest first |
| POST | `/api/signals/:id/approve` | Approve a queued signal |
| POST | `/api/signals/:id/reject` | `{ reason }` |
| GET | `/api/risk/state?mode=` | Today's risk state |
| GET | `/api/risk/settings` | Risk settings |
| PUT | `/api/risk/settings` | Partial patch |
| POST | `/api/risk/kill-switch` | `{ mode, on, reason }` — trip or reset |
| POST | `/api/risk/assess` | Dry-run a signal through the gates |
| GET | `/api/scheduler` | Running state and the last tick |
| POST | `/api/scheduler/run` | Run one tick immediately |

`POST /api/risk/assess` exists so the operator can ask "what would happen if this fired right now" without waiting for the market — the fastest way to understand why the engine is refusing trades.

- [ ] **Step 1: Write the failing test**

Create `server/test/signal-risk-routes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_riskroutes_test';

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
     VALUES (?, ?, 'H1', 'live', UTC_TIMESTAMP(), '2026-02-01 00:00:00', 'BUY', 100, 99, 102, 'new')`,
    [st.id, sym.id]
  );

  const { createSignalRouter } = require('../src/routes/signals');
  const { createRiskRouter } = require('../src/routes/risk');
  const scheduler = { isRunning: () => false, lastRun: () => null, runOnce: async () => ({ ok: true }) };

  const app = express();
  app.use(express.json());
  app.use('/api', createSignalRouter());
  app.use('/api', createRiskRouter({ scheduler }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());

  return { base: `http://127.0.0.1:${server.address().port}`, symbolId: sym.id };
}

test('GET /api/signals filters by mode and status', async (t) => {
  const { base } = await startApp(t);

  const all = await (await fetch(`${base}/api/signals`)).json();
  assert.equal(all.length, 1);
  assert.equal(all[0].broker_symbol, 'XAUUSD');
  assert.equal(all[0].strategy_name, 'trend-breakout');

  const demo = await (await fetch(`${base}/api/signals?mode=demo`)).json();
  assert.equal(demo.length, 0);
});

test('approve moves a signal out of the queue', async (t) => {
  const { base } = await startApp(t);
  const [signal] = await (await fetch(`${base}/api/signals?status=new`)).json();

  const res = await fetch(`${base}/api/signals/${signal.id}/approve`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'approved');

  assert.equal((await (await fetch(`${base}/api/signals?status=new`)).json()).length, 0);
});

test('reject records the operator reason', async (t) => {
  const { base } = await startApp(t);
  const [signal] = await (await fetch(`${base}/api/signals?status=new`)).json();

  const res = await fetch(`${base}/api/signals/${signal.id}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'spread too wide' })
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, 'rejected');
  assert.match(JSON.stringify(body.decision), /spread too wide/);
});

test('approving an unknown signal is a 404', async (t) => {
  const { base } = await startApp(t);
  const res = await fetch(`${base}/api/signals/999999/approve`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('risk settings round-trip through a partial patch', async (t) => {
  const { base } = await startApp(t);

  const before = await (await fetch(`${base}/api/risk/settings`)).json();
  assert.equal(before.riskPctPerTrade, 1.0);

  const res = await fetch(`${base}/api/risk/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ riskPctPerTrade: 0.5 })
  });
  assert.equal(res.status, 200);

  const after = await (await fetch(`${base}/api/risk/settings`)).json();
  assert.equal(after.riskPctPerTrade, 0.5);
  assert.equal(after.dailyLossCapPct, 5.0, 'other settings are untouched');
});

test('the kill switch can be tripped and reset through the API', async (t) => {
  const { base } = await startApp(t);

  const on = await (await fetch(`${base}/api/risk/kill-switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'demo', on: true, reason: 'operator halt' })
  })).json();
  assert.equal(on.kill_switch, 1);
  assert.equal(on.kill_switch_reason, 'operator halt');

  const state = await (await fetch(`${base}/api/risk/state?mode=demo`)).json();
  assert.equal(state.kill_switch, 1);

  const off = await (await fetch(`${base}/api/risk/kill-switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'demo', on: false })
  })).json();
  assert.equal(off.kill_switch, 0);
});

test('POST /api/risk/assess dry-runs the gates without storing anything', async (t) => {
  const { base, symbolId } = await startApp(t);

  const res = await fetch(`${base}/api/risk/assess`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      symbolId, mode: 'demo', balance: 10000,
      signal: { side: 'BUY', entry: 100, sl: 99, tp: 102 }
    })
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.allowed, true, body.denialReasons?.join('; '));
  assert.ok(body.lot > 0);
  assert.ok(body.checks.length >= 7);

  const signals = await (await fetch(`${base}/api/signals`)).json();
  assert.equal(signals.length, 1, 'a dry run stores nothing');
});

test('assess reports the denial when the account is too small', async (t) => {
  const { base, symbolId } = await startApp(t);

  const body = await (await fetch(`${base}/api/risk/assess`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      symbolId, mode: 'demo', balance: 100,
      signal: { side: 'BUY', entry: 100, sl: 90, tp: 120 }
    })
  })).json();

  assert.equal(body.allowed, false);
  assert.ok(body.denialReasons.some((r) => /below the broker minimum/i.test(r)));
});

test('GET /api/scheduler reports state', async (t) => {
  const { base } = await startApp(t);
  const body = await (await fetch(`${base}/api/scheduler`)).json();
  assert.equal(body.running, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/signal-risk-routes.test.js
```

Expected: FAIL — `Cannot find module '../src/routes/signals'`.

- [ ] **Step 3: Implement the signals router**

Create `server/src/routes/signals.js`:

```js
const express = require('express');

const { listSignals, getSignal, approveSignal, rejectSignal } = require('../signals/store');

function createSignalRouter() {
  const router = express.Router();

  router.get('/signals', async (req, res, next) => {
    try {
      res.json(await listSignals({
        mode: req.query.mode,
        status: req.query.status,
        limit: req.query.limit
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/signals/:id/approve', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!(await getSignal(id))) {
        return res.status(404).json({ error: `unknown signal ${id}` });
      }
      res.json(await approveSignal(id));
    } catch (error) {
      next(error);
    }
  });

  router.post('/signals/:id/reject', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!(await getSignal(id))) {
        return res.status(404).json({ error: `unknown signal ${id}` });
      }
      res.json(await rejectSignal(id, req.body?.reason));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createSignalRouter };
```

- [ ] **Step 4: Implement the risk router**

Create `server/src/routes/risk.js`:

```js
const express = require('express');

const { query } = require('../db/pool');
const { loadRiskSettings, saveRiskSettings } = require('../risk/settings');
const { getState, tripKillSwitch, resetKillSwitch } = require('../risk/state');
const { assessSignal } = require('../risk/engine');
const { countOpenPositions } = require('../signals/generator');

const MODES = ['backtest', 'demo', 'live'];

function createRiskRouter({ scheduler } = {}) {
  const router = express.Router();

  router.get('/risk/state', async (req, res, next) => {
    try {
      const mode = String(req.query.mode || 'demo');
      if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
      res.json(await getState(mode));
    } catch (error) {
      next(error);
    }
  });

  router.get('/risk/settings', async (req, res, next) => {
    try {
      res.json(await loadRiskSettings());
    } catch (error) {
      next(error);
    }
  });

  router.put('/risk/settings', async (req, res, next) => {
    try {
      res.json(await saveRiskSettings(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  router.post('/risk/kill-switch', async (req, res, next) => {
    try {
      const { mode = 'demo', on, reason } = req.body || {};
      if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
      if (typeof on !== 'boolean') return res.status(400).json({ error: 'body must include { on: boolean }' });

      res.json(on
        ? await tripKillSwitch({ mode, reason: reason || 'tripped by the operator' })
        : await resetKillSwitch({ mode }));
    } catch (error) {
      next(error);
    }
  });

  // A dry run, so the operator can ask "what would happen if this fired now"
  // without waiting for the market. Stores nothing.
  router.post('/risk/assess', async (req, res, next) => {
    try {
      const { symbolId, mode = 'demo', balance = 10000, signal } = req.body || {};
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });
      if (!signal) return res.status(400).json({ error: 'signal is required' });

      const rows = await query('SELECT * FROM symbols WHERE id = ?', [symbolId]);
      if (rows.length === 0) return res.status(404).json({ error: `unknown symbolId ${symbolId}` });

      res.json(await assessSignal({
        signal,
        symbol: rows[0],
        mode,
        balance: Number(balance),
        openPositions: await countOpenPositions(mode)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/scheduler', (req, res) => {
    res.json({
      running: scheduler ? scheduler.isRunning() : false,
      lastRun: scheduler ? scheduler.lastRun() : null
    });
  });

  router.post('/scheduler/run', async (req, res, next) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'no scheduler is configured' });
      res.json(await scheduler.runOnce());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createRiskRouter };
```

- [ ] **Step 5: Mount both routers and start the scheduler**

In `server/src/index.js`, directly below the backtest router line, add:

```js
const { createSignalRouter } = require('./routes/signals');
const { createRiskRouter } = require('./routes/risk');
const { createScheduler } = require('./scheduler');

const scheduler = createScheduler({ bridge: bridgeFromEnv() });

app.use('/api', createSignalRouter());
app.use('/api', createRiskRouter({ scheduler }));

// Opt-in: an unattended loop should never start just because the server did.
if (process.env.SCHEDULER_ENABLED === 'true') {
  scheduler.start();
  console.log(`scheduler started (mode ${process.env.TRADING_MODE || 'demo'})`);
}
```

Delete the `sampleSignals` constant and its `/api/signals` route — the real router replaces them.

Add to `server/.env` and `server/.env.example`:

```
# Set to true to run the candle-sync and signal-generation loop.
# Off by default: an unattended loop should never start just because the
# server did.
SCHEDULER_ENABLED=false
```

- [ ] **Step 6: Run the full suite**

```bash
npm --prefix server test
```

Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/signals.js server/src/routes/risk.js server/src/index.js server/.env.example server/test/signal-risk-routes.test.js
git commit -m "feat(api): expose signals, the approval queue, risk state and the kill switch"
```

---

### Task 7: Signals and Risk UI

**Files:**
- Create: `client/src/pages/Signals.jsx`, `client/src/pages/Risk.jsx`
- Modify: `client/src/api.js`, `client/src/App.jsx`, `client/src/styles.css`

**Interfaces:**
- Consumes: the API from Task 6.
- Produces: a Signals view (queue with approve/reject, per-signal gate breakdown) and a Risk view (state, settings, kill switch, gate dry-run).

Every signal shows **all seven gates with pass/fail and detail**. When the system refuses to trade — which on a small account will be often — the screen has to say exactly why, or the operator will assume it is broken.

- [ ] **Step 1: Add the API helpers**

In `client/src/api.js`, add these entries inside the exported `api` object:

```js
  signals: (params = '') => request(`/api/signals${params}`),
  approveSignal: (id) => request(`/api/signals/${id}/approve`, { method: 'POST' }),
  rejectSignal: (id, reason) =>
    request(`/api/signals/${id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason })
    }),
  riskState: (mode = 'demo') => request(`/api/risk/state?mode=${mode}`),
  riskSettings: () => request('/api/risk/settings'),
  saveRiskSettings: (patch) =>
    request('/api/risk/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }),
  killSwitch: (mode, on, reason) =>
    request('/api/risk/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, on, reason })
    }),
  assess: (payload) =>
    request('/api/risk/assess', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }),
  scheduler: () => request('/api/scheduler'),
  runScheduler: () => request('/api/scheduler/run', { method: 'POST' }),
```

- [ ] **Step 2: Write the Signals page**

Create `client/src/pages/Signals.jsx`:

```jsx
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

function Gates({ decision }) {
  if (!decision?.checks) return null;
  return (
    <ul className="gates">
      {decision.checks.map((c) => (
        <li key={c.name} className={c.passed ? 'gate pass' : 'gate fail'}>
          <span className="gate-name">{c.name.replace(/_/g, ' ')}</span>
          <span className="gate-detail">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Signals() {
  const [mode, setMode] = useState('demo');
  const [status, setStatus] = useState('');
  const [signals, setSignals] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const query = `?mode=${mode}${status ? `&status=${status}` : ''}`;
    setSignals(await api.signals(query));
  }, [mode, status]);

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

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Signals</h3>
        <span>{mode === 'live' ? 'live signals need your approval' : 'demo runs hands-off'}</span>
      </div>

      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all statuses</option>
          <option value="new">new</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
          <option value="expired">expired</option>
        </select>
        <button disabled={busy} onClick={() => act(() => api.runScheduler())}>
          Run a cycle now
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {signals.length === 0 && <p className="empty">No signals for this filter.</p>}

      {signals.map((s) => (
        <div key={s.id} className={`signal-card ${s.status}`}>
          <div className="signal-head">
            <div>
              <strong>{s.broker_symbol}</strong>
              <span className={`badge ${s.side === 'BUY' ? 'buy' : 'sell'}`}>{s.side}</span>
              <small>{s.strategy_name} · {s.timeframe}</small>
            </div>
            <div className="align-right">
              <span className={`status-tag ${s.status}`}>{s.status}</span>
              {s.auto_approved === 1 && <small> auto</small>}
            </div>
          </div>

          <div className="signal-numbers">
            <span>entry <strong>{s.entry}</strong></span>
            <span>stop <strong>{s.sl}</strong></span>
            <span>target <strong>{s.tp ?? '—'}</strong></span>
            <span>lot <strong>{s.lot ?? '—'}</strong></span>
          </div>

          {s.reason && <p className="muted">{s.reason}</p>}

          <button className="link" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
            {expanded === s.id ? 'hide' : 'show'} risk gates
          </button>
          {expanded === s.id && <Gates decision={s.decision} />}

          {s.status === 'new' && (
            <div className="signal-actions">
              <button disabled={busy} onClick={() => act(() => api.approveSignal(s.id))}>Approve</button>
              <button
                disabled={busy}
                onClick={() => act(() => api.rejectSignal(s.id, 'rejected from the dashboard'))}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Write the Risk page**

Create `client/src/pages/Risk.jsx`:

```jsx
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

export default function Risk() {
  const [mode, setMode] = useState('demo');
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [scheduler, setScheduler] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setState(await api.riskState(mode));
    setSettings(await api.riskSettings());
    setScheduler(await api.scheduler());
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

  const killed = state?.kill_switch === 1;

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Risk</h3>
        <span>{scheduler?.running ? 'scheduler running' : 'scheduler stopped'}</span>
      </div>

      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
      </div>

      {error && <p className="error">{error}</p>}

      <div className={killed ? 'verdict fail' : 'verdict pass'}>
        <strong>{killed ? 'TRADING HALTED' : 'TRADING ENABLED'}</strong>
        <span>{killed ? state.kill_switch_reason : `no halt on ${mode}`}</span>
        <div>
          <button
            disabled={busy}
            onClick={() => act(() => api.killSwitch(mode, !killed, 'toggled from the dashboard'))}
          >
            {killed ? 'Reset kill switch' : 'Halt trading'}
          </button>
        </div>
      </div>

      {state && (
        <table className="table">
          <tbody>
            <tr><td>Trading day (UTC)</td><td>{String(state.trading_day).slice(0, 10)}</td></tr>
            <tr><td>Realized P&L</td><td className={Number(state.realized_pnl) >= 0 ? 'up' : 'down'}>{state.realized_pnl}</td></tr>
            <tr><td>Trades today</td><td>{state.trades_count}</td></tr>
            <tr><td>Consecutive losses</td><td>{state.consecutive_losses}</td></tr>
          </tbody>
        </table>
      )}

      <h4>Risk settings</h4>
      {settings && (
        <div className="toolbar">
          {[
            ['riskPctPerTrade', 'risk % / trade', 0.1],
            ['dailyLossCapPct', 'daily loss cap %', 0.5],
            ['maxConcurrentPositions', 'max positions', 1],
            ['consecutiveLossLimit', 'loss streak limit', 1],
            ['newsBlackoutMinutes', 'news blackout min', 1]
          ].map(([key, label, step]) => (
            <label className="field" key={key}>
              {label}
              <input
                type="number"
                step={step}
                value={settings[key]}
                onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
          <button disabled={busy} onClick={() => act(() => api.saveRiskSettings(settings))}>
            Save
          </button>
        </div>
      )}

      <p className="muted">
        The kill switch trips automatically on the loss streak limit and only ever resets by hand.
        A stop loss is required on every order and is not configurable.
      </p>
    </section>
  );
}
```

- [ ] **Step 4: Wire both views into the app shell**

In `client/src/App.jsx`, add beside the existing page imports:

```jsx
import Signals from './pages/Signals';
import Risk from './pages/Risk';
```

Change the Signals and Risk nav buttons to switch views:

```jsx
          <button className={view === 'signals' ? 'nav active' : 'nav'} onClick={() => setView('signals')}>Signals</button>
```

```jsx
          <button className={view === 'risk' ? 'nav active' : 'nav'} onClick={() => setView('risk')}>Risk</button>
```

Extend the view switch. Replace:

```jsx
        {view === 'markets' ? <Markets /> : view === 'backtests' ? <Backtests /> : (<>
```

with:

```jsx
        {view === 'markets' ? <Markets />
          : view === 'backtests' ? <Backtests />
          : view === 'signals' ? <Signals />
          : view === 'risk' ? <Risk />
          : (<>
```

Also delete the `signals` state, its `fetch('/api/signals')` call, and the Signals panel from the Overview — that route now returns real rows with a different shape.

- [ ] **Step 5: Add the styles**

Append to `client/src/styles.css`:

```css
.signal-card {
  border: 1px solid #2d3748;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #121a26;
}

.signal-card.rejected { opacity: 0.65; }
.signal-card.approved { border-color: rgba(34, 197, 94, 0.4); }

.signal-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.signal-head small { display: block; color: #9aa7bc; margin-top: 2px; }

.badge.buy { background: rgba(34, 197, 94, 0.18); color: #86efac; }
.badge.sell { background: rgba(239, 68, 68, 0.18); color: #fca5a5; }

.status-tag { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #9aa7bc; }
.status-tag.approved { color: #86efac; }
.status-tag.rejected { color: #fca5a5; }

.signal-numbers { display: flex; flex-wrap: wrap; gap: 16px; margin: 10px 0; font-size: 13px; color: #9aa7bc; }
.signal-numbers strong { color: #e6edf7; }

.signal-actions { display: flex; gap: 8px; margin-top: 10px; }
.signal-actions button {
  background: #16202e; color: #e6edf7; border: 1px solid #2d3748;
  border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 13px;
}

.link { background: none; border: none; color: #67e8f9; cursor: pointer; padding: 0; font-size: 12px; }

.gates { list-style: none; padding: 0; margin: 10px 0 0; font-size: 12px; }
.gate { display: flex; gap: 10px; padding: 4px 0; border-bottom: 1px solid #1f2937; }
.gate-name { min-width: 190px; text-transform: capitalize; }
.gate.pass .gate-name { color: #86efac; }
.gate.fail .gate-name { color: #fca5a5; }
.gate-detail { color: #9aa7bc; }
```

- [ ] **Step 6: Build and check in the browser**

```bash
npm run build
npm run dev
```

Open `http://localhost:5173` and confirm:

1. **Risk** shows today's state, the settings form saves, and the kill switch toggles.
2. Tripping the kill switch turns the banner red with the reason.
3. **Signals** lists signals for the chosen mode; "show risk gates" reveals all seven with pass/fail.
4. A live signal offers Approve and Reject; a demo signal does not.

- [ ] **Step 7: Commit**

```bash
git add client/src
git commit -m "feat(ui): add Signals approval queue and Risk control views"
```

---

## Phase 3 Definition of Done

- [ ] `npm --prefix server test` passes.
- [ ] `npm run build` succeeds.
- [ ] Backtest and live size positions through the **same** `sizePosition` function — `server/src/backtest/engine.js` has no local copy.
- [ ] A signal without a stop loss is denied, and that gate has no setting.
- [ ] A lot below `min_lot` is denied with a reason naming the actual risk percentage.
- [ ] Three consecutive losses trip the kill switch, and only a manual reset clears it.
- [ ] Running the generator twice over the same bar creates one signal, not two.
- [ ] Demo signals are auto-approved; live signals wait in the queue.
- [ ] The scheduler never overlaps ticks and survives a failing tick.
- [ ] `SCHEDULER_ENABLED` defaults to false.

## What Phase 3 deliberately does not do

No order placement, no broker writes, no position reconciliation, no authentication. An approved signal simply sits at `status = 'approved'` waiting for phase 4's execution layer. The bridge still has no order endpoints, so this phase cannot reach the account even by mistake.
