# Phase 1: Foundations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get real OHLCV data from the Axi MT5 demo account into MySQL and onto a candlestick chart in the dashboard, replacing all mock data.

**Architecture:** A thin Python Flask sidecar wraps the `MetaTrader5` package and exposes read-only market data over `127.0.0.1` behind a shared token. The Node server calls it through a single typed client, normalises broker-timezone bar times to true UTC, and upserts candles into MySQL. React renders them with `lightweight-charts`.

**Tech Stack:** Node 22 (built-in `node:test`), Express 4, mysql2, React 18 + Vite, `lightweight-charts`, Python 3.12 + Flask 3 + MetaTrader5 5.0.6147, MySQL 8.4 in Docker.

**Spec:** `docs/superpowers/specs/2026-08-29-trading-agent-dashboard-design.md`

## Global Constraints

- Node >= 22. Use the built-in `node:test` runner and `node:assert/strict`. Do **not** add jest, vitest, or mocha.
- All timestamps stored and transported in **UTC**. MySQL container and connection are pinned to UTC.
- Prices stored as `DECIMAL`, never `FLOAT`/`DOUBLE`. The mysql2 pool sets `decimalNumbers: true`.
- The bridge binds to `127.0.0.1` only and requires header `X-Bridge-Token` matching `BRIDGE_TOKEN`.
- The bridge contains **no trading logic** — transport and serialisation only.
- Phase 1 is **read-only**. Do not implement order placement, position closing, or any write to the broker.
- No secrets in committed files. Credentials live in `server/.env` and `.env`, both git-ignored.
- CommonJS (`require`) in `server/`, ES modules in `client/`. Match the existing files.
- Every SQL schema change is a new numbered migration file. Never edit an applied migration.

---

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `server/migrations/001_core_market_data.sql` | `symbols`, `candles` |
| `server/migrations/002_trading_state.sql` | strategies, signals, trades, backtests, risk, news, equity, audit, users, settings |
| `server/src/db/pool.js` | mysql2 pool creation and query helpers (replaces `src/db.js`) |
| `server/src/db/migrate.js` | Migration runner, also runnable as a CLI |
| `server/src/bridge/client.js` | HTTP client for the Python bridge |
| `server/src/market/rates.js` | Pure functions: broker-time normalisation, rate-row mapping |
| `server/src/market/symbols.js` | Symbol spec sync into `symbols` |
| `server/src/market/candles.js` | Candle backfill and incremental sync |
| `server/src/routes/market.js` | `/api/symbols`, `/api/candles`, `/api/bridge/health`, sync endpoints |
| `server/test/*.test.js` | Unit tests |
| `bridge/app.py` | Flask sidecar wrapping MetaTrader5 |
| `bridge/requirements.txt` | Python dependencies |
| `bridge/README.md` | How to run the bridge |
| `client/src/api.js` | Fetch helpers |
| `client/src/components/CandleChart.jsx` | lightweight-charts wrapper |
| `client/src/pages/Markets.jsx` | Symbol picker, timeframe picker, chart |

**Modify:** `server/package.json`, `client/package.json` (remove the self-referencing dependency), `server/src/index.js` (mount real routes), `client/src/App.jsx` (add Markets view).

**Delete:** `server/src/db.js` (superseded by `src/db/pool.js`).

---

### Task 1: Repository hygiene and the migration runner

**Files:**
- Create: `server/src/db/pool.js`, `server/src/db/migrate.js`, `server/migrations/001_core_market_data.sql`
- Test: `server/test/migrate.test.js`
- Modify: `server/package.json`, `client/package.json`
- Delete: `server/src/db.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pool.js` exports `getPool()`, `query(sql, params) -> Promise<rows>`, `withConnection(fn)`, `closePool()`
  - `migrate.js` exports `runMigrations({ silent })  -> Promise<string[]>` (returns applied filenames)

- [ ] **Step 1: Initialise git and make the first commit**

The project is not yet a git repository. The plan requires commits per task.

```bash
git init
git add .gitignore docker-compose.yml package.json .env.example \
        server/package.json server/.env.example server/src client/package.json \
        client/vite.config.js client/index.html client/src docs
git commit -m "chore: initial commit of scaffold, docker compose and design docs"
```

Verify `.env` and `server/.env` are NOT staged:

```bash
git status --short | grep -E '^\S+\s+(\.env|server/\.env)$' && echo "LEAK - stop and fix .gitignore" || echo "secrets safely ignored"
```

- [ ] **Step 2: Remove the self-referencing dependency**

Both packages depend on the workspace root that contains them. Delete the line `"trading-agent-dashboard": "file:..",` from the `dependencies` block of **both** `server/package.json` and `client/package.json`.

Then add the test and migrate scripts to `server/package.json`:

```json
  "scripts": {
    "dev": "nodemon src/index.js",
    "start": "node src/index.js",
    "test": "node --test test/",
    "migrate": "node src/db/migrate.js"
  },
```

Reinstall to prove it resolves cleanly:

```bash
rm -rf node_modules server/node_modules client/node_modules package-lock.json
npm install
```

Expected: install completes with no `EUNSUPPORTEDPROTOCOL` or self-reference error.

- [ ] **Step 3: Write the migration 001 SQL**

Create `server/migrations/001_core_market_data.sql`:

```sql
CREATE TABLE symbols (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  broker_symbol   VARCHAR(32)     NOT NULL,
  description     VARCHAR(160)    NULL,
  digits          TINYINT UNSIGNED NOT NULL,
  point           DECIMAL(18,10)  NOT NULL,
  contract_size   DECIMAL(18,4)   NOT NULL,
  tick_size       DECIMAL(18,10)  NOT NULL,
  tick_value      DECIMAL(18,10)  NOT NULL,
  min_lot         DECIMAL(10,4)   NOT NULL,
  lot_step        DECIMAL(10,4)   NOT NULL,
  max_lot         DECIMAL(10,4)   NOT NULL,
  spread_points   INT UNSIGNED    NULL,
  currency_profit CHAR(8)         NULL,
  currency_margin CHAR(8)         NULL,
  enabled         TINYINT(1)      NOT NULL DEFAULT 0,
  synced_at       DATETIME        NOT NULL,
  UNIQUE KEY uq_symbols_broker_symbol (broker_symbol),
  KEY idx_symbols_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE candles (
  symbol_id   INT UNSIGNED    NOT NULL,
  timeframe   VARCHAR(4)      NOT NULL,
  open_time   DATETIME        NOT NULL COMMENT 'UTC, broker offset already removed',
  open        DECIMAL(18,8)   NOT NULL,
  high        DECIMAL(18,8)   NOT NULL,
  low         DECIMAL(18,8)   NOT NULL,
  close       DECIMAL(18,8)   NOT NULL,
  tick_volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
  real_volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
  spread      INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol_id, timeframe, open_time),
  CONSTRAINT fk_candles_symbol FOREIGN KEY (symbol_id)
    REFERENCES symbols(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 4: Write the connection pool**

Create `server/src/db/pool.js`:

```js
const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (pool) return pool;

  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) {
    throw new Error('Database is not configured: set DB_HOST, DB_USER and DB_NAME in server/.env');
  }

  pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT || 3306),
    user: DB_USER,
    password: DB_PASSWORD || '',
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    // Every timestamp in this system is UTC. See the spec, section 5.
    timezone: 'Z',
    // Return DECIMAL as a JS number rather than a string, so indicator maths
    // does not silently concatenate prices.
    decimalNumbers: true
  });

  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function withConnection(fn) {
  const conn = await getPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, withConnection, closePool };
```

- [ ] **Step 5: Write the failing test for the migration runner**

Create `server/test/migrate.test.js`. This is an integration test against the Docker MySQL, run inside a transaction-free scratch database that it drops afterwards.

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

require('dotenv').config();

const SCRATCH_DB = 'trading_agent_test';

async function adminConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true
  });
}

test('runMigrations applies every file once and is idempotent', async (t) => {
  const admin = await adminConnection();
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  process.env.DB_NAME = SCRATCH_DB;

  // Load after DB_NAME is set so the pool targets the scratch database.
  const { runMigrations } = require('../src/db/migrate');
  const { query, closePool } = require('../src/db/pool');

  t.after(async () => {
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await admin.end();
  });

  const firstRun = await runMigrations({ silent: true });
  assert.ok(firstRun.includes('001_core_market_data.sql'), 'first run applies 001');

  const tables = await query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
    [SCRATCH_DB]
  );
  const names = tables.map((r) => r.t);
  assert.ok(names.includes('symbols'), 'symbols table exists');
  assert.ok(names.includes('candles'), 'candles table exists');
  assert.ok(names.includes('migrations'), 'migrations ledger exists');

  const secondRun = await runMigrations({ silent: true });
  assert.deepEqual(secondRun, [], 'second run applies nothing');
});

test('candles rejects a duplicate (symbol, timeframe, open_time)', async (t) => {
  const admin = await adminConnection();
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  process.env.DB_NAME = SCRATCH_DB;
  const { runMigrations } = require('../src/db/migrate');
  const { query, closePool } = require('../src/db/pool');
  await runMigrations({ silent: true });

  t.after(async () => {
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await admin.end();
  });

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, synced_at)
     VALUES ('TESTPAIR', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['TESTPAIR']);

  const insert = `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close)
                  VALUES (?, 'M1', '2026-01-01 00:00:00', 1, 2, 0.5, 1.5)`;
  await query(insert, [sym.id]);

  await assert.rejects(() => query(insert, [sym.id]), /Duplicate entry/);
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npm --prefix server test
```

Expected: FAIL — `Cannot find module '../src/db/migrate'`.

- [ ] **Step 7: Write the migration runner**

Create `server/src/db/migrate.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { query } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function ensureLedger() {
  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      filename   VARCHAR(255) NOT NULL,
      applied_at DATETIME     NOT NULL,
      UNIQUE KEY uq_migrations_filename (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

// A dedicated connection: migration files contain several statements, which
// the pooled connection deliberately disallows.
async function multiStatementConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    multipleStatements: true,
    timezone: 'Z'
  });
}

async function runMigrations({ silent = false } = {}) {
  await ensureLedger();

  const applied = new Set(
    (await query('SELECT filename FROM migrations')).map((r) => r.filename)
  );
  const pending = migrationFiles().filter((f) => !applied.has(f));
  if (pending.length === 0) return [];

  const conn = await multiStatementConnection();
  const done = [];
  try {
    for (const filename of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      await conn.query(sql);
      await conn.execute(
        'INSERT INTO migrations (filename, applied_at) VALUES (?, UTC_TIMESTAMP())',
        [filename]
      );
      done.push(filename);
      if (!silent) console.log(`applied ${filename}`);
    }
  } finally {
    await conn.end();
  }
  return done;
}

module.exports = { runMigrations };

if (require.main === module) {
  require('dotenv').config();
  const { closePool } = require('./pool');
  runMigrations()
    .then(async (applied) => {
      console.log(applied.length ? `${applied.length} migration(s) applied` : 'database up to date');
      await closePool();
    })
    .catch(async (err) => {
      console.error('migration failed:', err.message);
      await closePool();
      process.exit(1);
    });
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npm --prefix server test
```

Expected: PASS, 2 tests.

- [ ] **Step 9: Apply migrations to the real database and verify**

```bash
npm --prefix server run migrate
docker exec trading-mysql mysql -utrader -ptraderpass trading_agent -e "SHOW TABLES;"
```

Expected: `candles`, `migrations`, `symbols`.

- [ ] **Step 10: Delete the superseded db module**

`server/src/db.js` is replaced by `server/src/db/pool.js`. Remove it and update the `require` in `server/src/index.js` from `./db` to `./db/pool` — replacing `testConnection()` usage with a `SELECT 1` through `query`.

In `server/src/index.js`, change the health route to:

```js
const { query } = require('./db/pool');

app.get('/api/health', async (req, res) => {
  let database = { connected: false, message: 'unknown' };
  try {
    const rows = await query('SELECT 1 AS ok');
    database = { connected: rows[0].ok === 1, message: 'MySQL OK' };
  } catch (error) {
    database = { connected: false, message: error.message };
  }
  res.json({ ok: true, service: 'trading-agent-server', timestamp: new Date().toISOString(), database });
});
```

Also delete the now-unused `createPool` import and its call.

```bash
rm server/src/db.js
npm --prefix server start &
sleep 3 && curl -s http://localhost:3001/api/health && kill %1
```

Expected: JSON with `"connected": true`.

- [ ] **Step 11: Commit**

```bash
git add server/package.json client/package.json server/migrations server/src/db server/test server/src/index.js package-lock.json
git rm --cached server/src/db.js 2>/dev/null || true
git commit -m "feat: add migration runner, core market data schema and UTC-pinned pool"
```

---

### Task 2: Remaining schema

**Files:**
- Create: `server/migrations/002_trading_state.sql`
- Test: `server/test/schema.test.js`

**Interfaces:**
- Consumes: `runMigrations` from Task 1.
- Produces: tables `strategies`, `signals`, `trades`, `backtest_runs`, `backtest_trades`, `risk_state`, `news_events`, `equity_snapshots`, `audit_log`, `users`, `settings`.

- [ ] **Step 1: Write the failing test**

Create `server/test/schema.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

require('dotenv').config();

const SCRATCH_DB = 'trading_agent_schema_test';

const EXPECTED = [
  'symbols', 'candles', 'strategies', 'signals', 'trades',
  'backtest_runs', 'backtest_trades', 'risk_state', 'news_events',
  'equity_snapshots', 'audit_log', 'users', 'settings', 'migrations'
];

test('full schema creates every expected table', async (t) => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  process.env.DB_NAME = SCRATCH_DB;
  const { runMigrations } = require('../src/db/migrate');
  const { query, closePool } = require('../src/db/pool');

  t.after(async () => {
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await admin.end();
  });

  await runMigrations({ silent: true });

  const rows = await query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
    [SCRATCH_DB]
  );
  const found = rows.map((r) => r.t).sort();
  for (const table of EXPECTED) {
    assert.ok(found.includes(table), `missing table: ${table}`);
  }
});

test('trades.mode only accepts backtest, demo or live', async (t) => {
  process.env.DB_NAME = SCRATCH_DB;
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  const { runMigrations } = require('../src/db/migrate');
  const { query, closePool } = require('../src/db/pool');
  await runMigrations({ silent: true });

  t.after(async () => {
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await admin.end();
  });

  // Insert a real symbol first, so the rejection below is caused by the mode
  // enum and not incidentally by the foreign key.
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, synced_at)
     VALUES ('TESTPAIR', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['TESTPAIR']);

  const insert = (mode) => query(
    `INSERT INTO trades (mode, symbol_id, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, ?, 'BUY', 0.01, 1.0, 0.9, UTC_TIMESTAMP(), 'OPEN')`,
    [mode, sym.id]
  );

  await assert.rejects(() => insert('production'), /Data truncated|Incorrect/i);
  await insert('demo'); // a valid mode is accepted
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix server test -- --test-name-pattern="full schema"
```

Expected: FAIL — `missing table: strategies`.

- [ ] **Step 3: Write migration 002**

Create `server/migrations/002_trading_state.sql`:

```sql
CREATE TABLE strategies (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(64)  NOT NULL,
  version     VARCHAR(16)  NOT NULL,
  params      JSON         NOT NULL,
  status      ENUM('draft','backtested','demo','live') NOT NULL DEFAULT 'draft',
  enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL,
  UNIQUE KEY uq_strategies_name_version (name, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE signals (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id  INT UNSIGNED    NOT NULL,
  symbol_id    INT UNSIGNED    NOT NULL,
  timeframe    VARCHAR(4)      NOT NULL,
  mode         ENUM('backtest','demo','live') NOT NULL,
  generated_at DATETIME        NOT NULL,
  bar_time     DATETIME        NOT NULL,
  side         ENUM('BUY','SELL') NOT NULL,
  entry        DECIMAL(18,8)   NOT NULL,
  sl           DECIMAL(18,8)   NOT NULL,
  tp           DECIMAL(18,8)   NULL,
  confidence   DECIMAL(5,2)    NULL,
  reason       VARCHAR(512)    NULL,
  features     JSON            NULL,
  status       ENUM('new','approved','rejected','expired','executed') NOT NULL DEFAULT 'new',
  KEY idx_signals_status (status, mode),
  KEY idx_signals_symbol_time (symbol_id, bar_time),
  UNIQUE KEY uq_signals_dedupe (strategy_id, symbol_id, timeframe, bar_time, mode),
  CONSTRAINT fk_signals_strategy FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  CONSTRAINT fk_signals_symbol   FOREIGN KEY (symbol_id)   REFERENCES symbols(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE trades (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  signal_id     BIGINT UNSIGNED NULL,
  symbol_id     INT UNSIGNED    NOT NULL,
  mode          ENUM('backtest','demo','live') NOT NULL,
  broker_ticket BIGINT UNSIGNED NULL,
  side          ENUM('BUY','SELL') NOT NULL,
  lot           DECIMAL(10,4)   NOT NULL,
  entry_price   DECIMAL(18,8)   NOT NULL,
  sl            DECIMAL(18,8)   NOT NULL,
  tp            DECIMAL(18,8)   NULL,
  close_price   DECIMAL(18,8)   NULL,
  opened_at     DATETIME        NOT NULL,
  closed_at     DATETIME        NULL,
  pnl           DECIMAL(18,4)   NULL,
  commission    DECIMAL(18,4)   NOT NULL DEFAULT 0,
  swap          DECIMAL(18,4)   NOT NULL DEFAULT 0,
  status        ENUM('OPEN','CLOSED','CANCELLED') NOT NULL DEFAULT 'OPEN',
  KEY idx_trades_mode_status (mode, status),
  UNIQUE KEY uq_trades_ticket (mode, broker_ticket),
  CONSTRAINT fk_trades_symbol FOREIGN KEY (symbol_id) REFERENCES symbols(id),
  CONSTRAINT fk_trades_signal FOREIGN KEY (signal_id) REFERENCES signals(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE backtest_runs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id INT UNSIGNED    NOT NULL,
  symbol_id   INT UNSIGNED    NOT NULL,
  timeframe   VARCHAR(4)      NOT NULL,
  from_time   DATETIME        NOT NULL,
  to_time     DATETIME        NOT NULL,
  params      JSON            NOT NULL,
  metrics     JSON            NULL,
  passed      TINYINT(1)      NOT NULL DEFAULT 0,
  created_at  DATETIME        NOT NULL,
  CONSTRAINT fk_runs_strategy FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  CONSTRAINT fk_runs_symbol   FOREIGN KEY (symbol_id)   REFERENCES symbols(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE backtest_trades (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id      BIGINT UNSIGNED NOT NULL,
  side        ENUM('BUY','SELL') NOT NULL,
  lot         DECIMAL(10,4)   NOT NULL,
  entry_time  DATETIME        NOT NULL,
  entry_price DECIMAL(18,8)   NOT NULL,
  exit_time   DATETIME        NOT NULL,
  exit_price  DECIMAL(18,8)   NOT NULL,
  sl          DECIMAL(18,8)   NOT NULL,
  tp          DECIMAL(18,8)   NULL,
  pnl         DECIMAL(18,4)   NOT NULL,
  exit_reason ENUM('SL','TP','SIGNAL','END') NOT NULL,
  KEY idx_backtest_trades_run (run_id),
  CONSTRAINT fk_bt_trades_run FOREIGN KEY (run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE risk_state (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  trading_day        DATE         NOT NULL,
  mode               ENUM('backtest','demo','live') NOT NULL,
  realized_pnl       DECIMAL(18,4) NOT NULL DEFAULT 0,
  trades_count       INT UNSIGNED  NOT NULL DEFAULT 0,
  consecutive_losses INT UNSIGNED  NOT NULL DEFAULT 0,
  kill_switch        TINYINT(1)    NOT NULL DEFAULT 0,
  kill_switch_reason VARCHAR(255)  NULL,
  updated_at         DATETIME      NOT NULL,
  UNIQUE KEY uq_risk_day_mode (trading_day, mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE news_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_time DATETIME     NOT NULL,
  currency   CHAR(8)      NULL,
  title      VARCHAR(255) NOT NULL,
  source     VARCHAR(64)  NULL,
  impact     ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'LOW',
  url        VARCHAR(512) NULL,
  KEY idx_news_time (event_time),
  UNIQUE KEY uq_news_dedupe (event_time, title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE equity_snapshots (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mode         ENUM('backtest','demo','live') NOT NULL,
  captured_at  DATETIME      NOT NULL,
  balance      DECIMAL(18,4) NOT NULL,
  equity       DECIMAL(18,4) NOT NULL,
  margin_free  DECIMAL(18,4) NULL,
  KEY idx_equity_mode_time (mode, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  logged_at  DATETIME     NOT NULL,
  actor      ENUM('system','user') NOT NULL,
  action     VARCHAR(64)  NOT NULL,
  payload    JSON         NULL,
  KEY idx_audit_time (logged_at),
  KEY idx_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    DATETIME     NOT NULL,
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  setting_key   VARCHAR(64) NOT NULL PRIMARY KEY,
  setting_value JSON        NOT NULL,
  updated_at    DATETIME    NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (setting_key, setting_value, updated_at) VALUES
  ('risk', JSON_OBJECT(
      'riskPctPerTrade', 1.0,
      'dailyLossCapPct', 5.0,
      'maxConcurrentPositions', 2,
      'consecutiveLossLimit', 3,
      'newsBlackoutMinutes', 15), UTC_TIMESTAMP()),
  ('backtestThresholds', JSON_OBJECT(
      'minProfitFactor', 1.3,
      'maxDrawdownPct', 15.0,
      'minTrades', 50), UTC_TIMESTAMP());
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm --prefix server test
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Apply to the real database and verify**

```bash
npm --prefix server run migrate
docker exec trading-mysql mysql -utrader -ptraderpass trading_agent \
  -e "SELECT setting_key, setting_value FROM settings;"
```

Expected: two rows, `risk` and `backtestThresholds`.

- [ ] **Step 6: Commit**

```bash
git add server/migrations/002_trading_state.sql server/test/schema.test.js
git commit -m "feat: add trading state schema with risk and backtest tables"
```

---

### Task 3: Python MT5 bridge

**Files:**
- Create: `bridge/app.py`, `bridge/requirements.txt`, `bridge/README.md`, `bridge/.gitignore`
- Modify: `.gitignore` (ignore `bridge/venv/`)

**Interfaces:**
- Consumes: `server/.env` values `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER`, `MT5_TERMINAL_PATH`, `BRIDGE_TOKEN`.
- Produces: HTTP API on `127.0.0.1:8000`, every route requiring header `X-Bridge-Token`:
  - `GET /health` → `{ ok, mt5_initialized, terminal, account_login, server_utc_offset_seconds }`
  - `GET /account` → `{ login, currency, balance, equity, margin_free, leverage, server }`
  - `GET /symbols` → `{ symbols: [ { name, description, digits, point, contract_size, tick_size, tick_value, min_lot, lot_step, max_lot, spread, currency_profit, currency_margin } ] }`
  - `GET /candles?symbol=&timeframe=&count=` → `{ symbol, timeframe, server_utc_offset_seconds, candles: [ { time, open, high, low, close, tick_volume, real_volume, spread } ] }` where `time` is an **integer Unix epoch in true UTC**.

**Why the offset field exists:** `mt5.copy_rates_*` returns bar times in the *broker's* server timezone encoded as a Unix timestamp. Axi runs UTC+2/UTC+3 depending on DST. Stored raw, every candle would be shifted by hours and every time-based filter would be wrong. The bridge measures the offset by comparing the broker's latest tick time against real UTC and reports it; the Node side subtracts it.

- [ ] **Step 1: Create the Python environment and dependency file**

```bash
mkdir -p bridge
cat > bridge/requirements.txt <<'EOF'
MetaTrader5==5.0.6147
Flask==3.1.3
python-dotenv==1.0.1
EOF
python -m venv bridge/venv
./bridge/venv/Scripts/python.exe -m pip install --upgrade pip
./bridge/venv/Scripts/python.exe -m pip install -r bridge/requirements.txt
```

Verify:

```bash
./bridge/venv/Scripts/python.exe -c "import MetaTrader5 as m, flask; print('mt5', m.__version__, 'flask ok')"
```

Expected: prints a version. If `MetaTrader5` fails to install, the terminal is 64-bit and the venv must be too — confirm with `./bridge/venv/Scripts/python.exe -c "import struct; print(struct.calcsize('P')*8)"` which must print `64`.

- [ ] **Step 2: Ignore the virtualenv**

```bash
cat > bridge/.gitignore <<'EOF'
venv/
__pycache__/
*.pyc
EOF
```

- [ ] **Step 3: Write the bridge**

Create `bridge/app.py`:

```python
"""Read-only MT5 bridge.

Transport and serialisation only - no trading logic lives here.
Binds to 127.0.0.1 and requires the X-Bridge-Token header on every route.

Phase 1 is read-only: no order placement endpoints exist yet by design.
"""

import os
import time
from functools import wraps

import MetaTrader5 as mt5
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "server", ".env"))

app = Flask(__name__)

BRIDGE_TOKEN = os.getenv("BRIDGE_TOKEN", "")

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


def require_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not BRIDGE_TOKEN:
            return jsonify(error="BRIDGE_TOKEN is not configured on the bridge"), 500
        if request.headers.get("X-Bridge-Token") != BRIDGE_TOKEN:
            return jsonify(error="unauthorized"), 401
        return fn(*args, **kwargs)

    return wrapper


def initialize():
    """Attach to the terminal and log in. Safe to call repeatedly."""
    path = os.getenv("MT5_TERMINAL_PATH") or None
    kwargs = {"path": path} if path else {}
    if not mt5.initialize(**kwargs):
        return False, f"initialize failed: {mt5.last_error()}"

    login = os.getenv("MT5_LOGIN")
    password = os.getenv("MT5_PASSWORD")
    server = os.getenv("MT5_SERVER")
    if login and password and server:
        if not mt5.login(int(login), password=password, server=server):
            return False, f"login failed: {mt5.last_error()}"
    return True, "ok"


def server_utc_offset_seconds():
    """Broker server time minus true UTC, rounded to the nearest 30 minutes.

    MT5 reports bar and tick times in the broker's server timezone encoded as a
    Unix timestamp. Broker offsets are always whole or half hours, so rounding
    removes the sampling jitter between the tick and our clock.
    """
    tick = None
    for candidate in ("EURUSD", "XAUUSD", "BTCUSD"):
        info = mt5.symbol_info_tick(candidate)
        if info is not None and info.time:
            tick = info
            break
    if tick is None:
        return 0
    raw = tick.time - time.time()
    return int(round(raw / 1800.0) * 1800)


@app.get("/health")
@require_token
def health():
    ok, message = initialize()
    info = mt5.terminal_info()
    account = mt5.account_info()
    return jsonify(
        ok=ok,
        message=message,
        mt5_initialized=info is not None,
        terminal=info.name if info else None,
        account_login=account.login if account else None,
        server_utc_offset_seconds=server_utc_offset_seconds() if ok else 0,
    )


@app.get("/account")
@require_token
def account():
    ok, message = initialize()
    if not ok:
        return jsonify(error=message), 502
    a = mt5.account_info()
    if a is None:
        return jsonify(error=f"account_info failed: {mt5.last_error()}"), 502
    return jsonify(
        login=a.login,
        currency=a.currency,
        balance=a.balance,
        equity=a.equity,
        margin_free=a.margin_free,
        leverage=a.leverage,
        server=a.server,
    )


@app.get("/symbols")
@require_token
def symbols():
    ok, message = initialize()
    if not ok:
        return jsonify(error=message), 502

    all_symbols = mt5.symbols_get()
    if all_symbols is None:
        return jsonify(error=f"symbols_get failed: {mt5.last_error()}"), 502

    out = []
    for s in all_symbols:
        out.append(
            {
                "name": s.name,
                "description": s.description,
                "digits": s.digits,
                "point": s.point,
                "contract_size": s.trade_contract_size,
                "tick_size": s.trade_tick_size or s.point,
                "tick_value": s.trade_tick_value,
                "min_lot": s.volume_min,
                "lot_step": s.volume_step,
                "max_lot": s.volume_max,
                "spread": s.spread,
                "currency_profit": s.currency_profit,
                "currency_margin": s.currency_margin,
            }
        )
    return jsonify(symbols=out)


@app.get("/candles")
@require_token
def candles():
    ok, message = initialize()
    if not ok:
        return jsonify(error=message), 502

    symbol = request.args.get("symbol")
    timeframe = request.args.get("timeframe", "H1")
    count = int(request.args.get("count", 500))

    if not symbol:
        return jsonify(error="symbol is required"), 400
    if timeframe not in TIMEFRAMES:
        return jsonify(error=f"unknown timeframe {timeframe}"), 400
    count = max(1, min(count, 20000))

    # A symbol must be selected in Market Watch before its history is readable.
    if not mt5.symbol_select(symbol, True):
        return jsonify(error=f"symbol_select failed for {symbol}: {mt5.last_error()}"), 400

    rates = mt5.copy_rates_from_pos(symbol, TIMEFRAMES[timeframe], 0, count)
    if rates is None:
        return jsonify(error=f"copy_rates failed: {mt5.last_error()}"), 502

    offset = server_utc_offset_seconds()
    out = [
        {
            # Broker-time epoch. The Node side subtracts the offset below.
            "time": int(r["time"]),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "tick_volume": int(r["tick_volume"]),
            "real_volume": int(r["real_volume"]),
            "spread": int(r["spread"]),
        }
        for r in rates
    ]
    return jsonify(
        symbol=symbol,
        timeframe=timeframe,
        server_utc_offset_seconds=offset,
        candles=out,
    )


if __name__ == "__main__":
    # 127.0.0.1 only. This process can read a funded trading account.
    app.run(host="127.0.0.1", port=int(os.getenv("BRIDGE_PORT", 8000)), debug=False)
```

- [ ] **Step 4: Set a real bridge token**

Replace the placeholder in `server/.env`:

```bash
TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
sed -i -E "s|^BRIDGE_TOKEN=.*|BRIDGE_TOKEN=$TOKEN|" server/.env
grep '^BRIDGE_TOKEN' server/.env
```

- [ ] **Step 5: Start the MT5 terminal, then the bridge, and verify against the live demo account**

The MetaTrader 5 terminal must be running and logged in to `Axi-US50-Demo` before the bridge can attach.

```bash
./bridge/venv/Scripts/python.exe bridge/app.py &
sleep 4
TOKEN=$(grep '^BRIDGE_TOKEN=' server/.env | cut -d= -f2)
curl -s -H "X-Bridge-Token: $TOKEN" http://127.0.0.1:8000/health
```

Expected: `"ok": true`, `"account_login": 50045322`, and `server_utc_offset_seconds` a multiple of 1800 (Axi is typically 7200 or 10800).

Verify the token gate actually gates:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/health
```

Expected: `401`.

Then check data:

```bash
curl -s -H "X-Bridge-Token: $TOKEN" "http://127.0.0.1:8000/candles?symbol=EURUSD&timeframe=H1&count=3"
curl -s -H "X-Bridge-Token: $TOKEN" http://127.0.0.1:8000/account
```

Expected: three candles with plausible EURUSD prices, and an account showing the demo balance.

If `symbol_select failed for EURUSD`, list the broker's real names and use one of them — Axi may suffix symbols:

```bash
curl -s -H "X-Bridge-Token: $TOKEN" http://127.0.0.1:8000/symbols | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).symbols.slice(0,40).map(s=>s.name).join(' ')))"
```

- [ ] **Step 6: Write the bridge README**

Create `bridge/README.md`:

```markdown
# MT5 Bridge

Read-only sidecar exposing MetaTrader 5 market data to the Node server.

## Why this is Python

MetaQuotes ships the MT5 programmatic API as a Python package only. There is no
Node binding and no public cloud REST API for MT5. This process is deliberately
thin: transport and serialisation, no trading logic.

## Prerequisites

- MetaTrader 5 terminal installed and **running**, logged in to the account in
  `server/.env`.
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

## Broker time

MT5 returns bar times in the **broker's** timezone as a Unix timestamp. Axi runs
UTC+2/UTC+3 with DST. Responses include `server_utc_offset_seconds`; the Node
side subtracts it so everything in MySQL is true UTC. Never store the raw value.
```

- [ ] **Step 7: Commit**

```bash
echo "bridge/venv/" >> .gitignore
git add bridge/app.py bridge/requirements.txt bridge/README.md bridge/.gitignore .gitignore
git commit -m "feat: add read-only Python MT5 bridge with broker-time offset reporting"
```

---

### Task 4: Node bridge client and rate normalisation

**Files:**
- Create: `server/src/bridge/client.js`, `server/src/market/rates.js`
- Test: `server/test/rates.test.js`, `server/test/bridge-client.test.js`

**Interfaces:**
- Consumes: the bridge HTTP API from Task 3.
- Produces:
  - `client.js` exports `createBridgeClient({ baseUrl, token, timeoutMs })` returning `{ health(), account(), symbols(), candles({ symbol, timeframe, count }) }`. Each rejects with an `Error` whose `.status` is the HTTP status when the bridge returns non-2xx.
  - `rates.js` exports:
    - `toUtcDate(brokerEpochSeconds, offsetSeconds) -> Date`
    - `formatUtcDateTime(date) -> 'YYYY-MM-DD HH:MM:SS'`
    - `mapRatesToRows(candles, offsetSeconds, symbolId, timeframe) -> Array<Array>` producing rows ordered `[symbol_id, timeframe, open_time, open, high, low, close, tick_volume, real_volume, spread]`

- [ ] **Step 1: Write the failing test for rate normalisation**

Create `server/test/rates.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { toUtcDate, formatUtcDateTime, mapRatesToRows } = require('../src/market/rates');

test('toUtcDate subtracts the broker offset', () => {
  // Broker clock says 12:00 while true UTC is 09:00 -> offset is +3h.
  const brokerEpoch = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
  const utc = toUtcDate(brokerEpoch, 3 * 3600);
  assert.equal(utc.toISOString(), '2026-01-15T09:00:00.000Z');
});

test('toUtcDate is a no-op when the broker runs on UTC', () => {
  const brokerEpoch = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
  assert.equal(toUtcDate(brokerEpoch, 0).toISOString(), '2026-01-15T12:00:00.000Z');
});

test('formatUtcDateTime renders a MySQL DATETIME in UTC', () => {
  const d = new Date('2026-01-15T09:05:07.000Z');
  assert.equal(formatUtcDateTime(d), '2026-01-15 09:05:07');
});

test('mapRatesToRows shifts times and preserves OHLCV ordering', () => {
  const candles = [
    { time: Date.UTC(2026, 0, 15, 12, 0, 0) / 1000, open: 1.1, high: 1.2, low: 1.0, close: 1.15,
      tick_volume: 42, real_volume: 7, spread: 3 }
  ];
  const rows = mapRatesToRows(candles, 2 * 3600, 9, 'H1');
  assert.deepEqual(rows, [[9, 'H1', '2026-01-15 10:00:00', 1.1, 1.2, 1.0, 1.15, 42, 7, 3]]);
});

test('mapRatesToRows tolerates missing volume fields', () => {
  const candles = [
    { time: Date.UTC(2026, 0, 15, 0, 0, 0) / 1000, open: 1, high: 1, low: 1, close: 1 }
  ];
  const rows = mapRatesToRows(candles, 0, 1, 'M5');
  assert.deepEqual(rows, [[1, 'M5', '2026-01-15 00:00:00', 1, 1, 1, 1, 0, 0, 0]]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix server test -- --test-name-pattern="toUtcDate"
```

Expected: FAIL — `Cannot find module '../src/market/rates'`.

- [ ] **Step 3: Implement rate normalisation**

Create `server/src/market/rates.js`:

```js
/**
 * MT5 reports bar times in the broker's server timezone encoded as a Unix
 * timestamp. Everything this system stores is true UTC, so the offset the
 * bridge measures is removed here, once, at the boundary.
 */

function toUtcDate(brokerEpochSeconds, offsetSeconds) {
  return new Date((brokerEpochSeconds - offsetSeconds) * 1000);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatUtcDateTime(date) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function mapRatesToRows(candles, offsetSeconds, symbolId, timeframe) {
  return candles.map((c) => [
    symbolId,
    timeframe,
    formatUtcDateTime(toUtcDate(c.time, offsetSeconds)),
    c.open,
    c.high,
    c.low,
    c.close,
    c.tick_volume ?? 0,
    c.real_volume ?? 0,
    c.spread ?? 0
  ]);
}

module.exports = { toUtcDate, formatUtcDateTime, mapRatesToRows };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm --prefix server test -- --test-name-pattern="mapRatesToRows|toUtcDate|formatUtcDateTime"
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing test for the bridge client**

Create `server/test/bridge-client.test.js`. It runs a stub HTTP server so the suite needs no MT5 terminal.

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

test('bridge client sends the token header and parses JSON', async (t) => {
  let seenToken = null;
  const { server, url } = await startStub((req, res) => {
    seenToken = req.headers['x-bridge-token'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, account_login: 50045322 }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 'secret-token' });
  const health = await client.health();

  assert.equal(seenToken, 'secret-token');
  assert.equal(health.account_login, 50045322);
});

test('bridge client surfaces the status code on an error response', async (t) => {
  const { server, url } = await startStub((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 'wrong' });
  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /unauthorized/);
      return true;
    }
  );
});

test('bridge client passes candle query parameters through', async (t) => {
  let seenUrl = null;
  const { server, url } = await startStub((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ symbol: 'EURUSD', timeframe: 'H1', server_utc_offset_seconds: 7200, candles: [] }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });
  const result = await client.candles({ symbol: 'EURUSD', timeframe: 'H1', count: 250 });

  assert.match(seenUrl, /symbol=EURUSD/);
  assert.match(seenUrl, /timeframe=H1/);
  assert.match(seenUrl, /count=250/);
  assert.equal(result.server_utc_offset_seconds, 7200);
});

test('bridge client times out rather than hanging', async (t) => {
  const { server, url } = await startStub(() => {
    // Never respond: the bridge is wedged behind a frozen terminal.
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't', timeoutMs: 150 });
  await assert.rejects(() => client.health(), /timed out|aborted/i);
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npm --prefix server test -- --test-name-pattern="bridge client"
```

Expected: FAIL — `Cannot find module '../src/bridge/client'`.

- [ ] **Step 7: Implement the bridge client**

Create `server/src/bridge/client.js`:

```js
/**
 * The only place the Node server talks to the Python MT5 bridge.
 * Node 22 provides global fetch and AbortSignal.timeout.
 */

function createBridgeClient({ baseUrl, token, timeoutMs = 15000 }) {
  if (!baseUrl) throw new Error('bridge client requires baseUrl');

  async function request(path, params) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let response;
    try {
      response = await fetch(url, {
        headers: { 'X-Bridge-Token': token || '' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) {
      const err = new Error(
        cause.name === 'TimeoutError'
          ? `bridge request to ${path} timed out after ${timeoutMs}ms`
          : `bridge request to ${path} failed: ${cause.message}`
      );
      err.cause = cause;
      throw err;
    }

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text };
    }

    if (!response.ok) {
      const err = new Error(`bridge ${path} returned ${response.status}: ${body.error || text}`);
      err.status = response.status;
      throw err;
    }
    return body;
  }

  return {
    health: () => request('/health'),
    account: () => request('/account'),
    symbols: () => request('/symbols'),
    candles: ({ symbol, timeframe = 'H1', count = 500 }) =>
      request('/candles', { symbol, timeframe, count })
  };
}

function bridgeFromEnv() {
  return createBridgeClient({
    baseUrl: process.env.BRIDGE_URL || 'http://127.0.0.1:8000',
    token: process.env.BRIDGE_TOKEN
  });
}

module.exports = { createBridgeClient, bridgeFromEnv };
```

- [ ] **Step 8: Run the full suite**

```bash
npm --prefix server test
```

Expected: PASS, all tests.

- [ ] **Step 9: Commit**

```bash
git add server/src/bridge server/src/market/rates.js server/test/rates.test.js server/test/bridge-client.test.js
git commit -m "feat: add bridge client and broker-time to UTC normalisation"
```

---

### Task 5: Symbol specification sync

**Files:**
- Create: `server/src/market/symbols.js`
- Test: `server/test/symbols-sync.test.js`

**Interfaces:**
- Consumes: `createBridgeClient` (Task 4), `query` (Task 1).
- Produces:
  - `syncSymbols(bridge) -> Promise<{ inserted, updated, total }>`
  - `listSymbols({ enabledOnly }) -> Promise<rows>`
  - `setSymbolEnabled(id, enabled) -> Promise<void>`

Symbols are synced wholesale from the broker and default to `enabled = 0`. Names are not guessed — Axi suffixes some instruments, so the operator enables what they want from the UI.

- [ ] **Step 1: Write the failing test**

Create `server/test/symbols-sync.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

require('dotenv').config();

const SCRATCH_DB = 'trading_agent_symbols_test';

const FAKE_SYMBOLS = {
  symbols: [
    { name: 'EURUSD', description: 'Euro vs US Dollar', digits: 5, point: 0.00001,
      contract_size: 100000, tick_size: 0.00001, tick_value: 1.0, min_lot: 0.01,
      lot_step: 0.01, max_lot: 100, spread: 8, currency_profit: 'USD', currency_margin: 'EUR' },
    { name: 'XAUUSD', description: 'Gold vs US Dollar', digits: 2, point: 0.01,
      contract_size: 100, tick_size: 0.01, tick_value: 1.0, min_lot: 0.01,
      lot_step: 0.01, max_lot: 50, spread: 25, currency_profit: 'USD', currency_margin: 'USD' }
  ]
};

async function freshDatabase(t) {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  process.env.DB_NAME = SCRATCH_DB;

  const { runMigrations } = require('../src/db/migrate');
  const { closePool } = require('../src/db/pool');
  await runMigrations({ silent: true });

  t.after(async () => {
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await admin.end();
  });
}

test('syncSymbols inserts symbols and re-running updates rather than duplicates', async (t) => {
  await freshDatabase(t);
  const { syncSymbols, listSymbols } = require('../src/market/symbols');
  const { query } = require('../src/db/pool');

  const bridge = { symbols: async () => FAKE_SYMBOLS };

  const first = await syncSymbols(bridge);
  assert.equal(first.total, 2);
  assert.equal(first.inserted, 2);

  const rows = await listSymbols({});
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.broker_symbol === 'XAUUSD').contract_size, 100);

  // Symbols default to disabled; the operator opts in.
  assert.equal(rows.every((r) => r.enabled === 0), true);

  // Broker widens the gold spread; a re-sync must update in place.
  const widened = JSON.parse(JSON.stringify(FAKE_SYMBOLS));
  widened.symbols[1].spread = 40;
  const second = await syncSymbols({ symbols: async () => widened });

  assert.equal(second.inserted, 0);
  assert.equal(second.total, 2);

  const after = await query('SELECT COUNT(*) AS n FROM symbols');
  assert.equal(after[0].n, 2, 'no duplicate rows');

  const gold = (await listSymbols({})).find((r) => r.broker_symbol === 'XAUUSD');
  assert.equal(gold.spread_points, 40);
});

test('syncSymbols preserves the enabled flag across a re-sync', async (t) => {
  await freshDatabase(t);
  const { syncSymbols, listSymbols } = require('../src/market/symbols');
  const { query } = require('../src/db/pool');

  const bridge = { symbols: async () => FAKE_SYMBOLS };
  await syncSymbols(bridge);
  await query('UPDATE symbols SET enabled = 1 WHERE broker_symbol = ?', ['EURUSD']);

  await syncSymbols(bridge);

  const enabled = await listSymbols({ enabledOnly: true });
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].broker_symbol, 'EURUSD');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix server test -- --test-name-pattern="syncSymbols"
```

Expected: FAIL — `Cannot find module '../src/market/symbols'`.

- [ ] **Step 3: Implement symbol sync**

Create `server/src/market/symbols.js`:

```js
const { query, withConnection } = require('../db/pool');

const UPSERT = `
  INSERT INTO symbols
    (broker_symbol, description, digits, point, contract_size, tick_size, tick_value,
     min_lot, lot_step, max_lot, spread_points, currency_profit, currency_margin, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
  ON DUPLICATE KEY UPDATE
    description     = VALUES(description),
    digits          = VALUES(digits),
    point           = VALUES(point),
    contract_size   = VALUES(contract_size),
    tick_size       = VALUES(tick_size),
    tick_value      = VALUES(tick_value),
    min_lot         = VALUES(min_lot),
    lot_step        = VALUES(lot_step),
    max_lot         = VALUES(max_lot),
    spread_points   = VALUES(spread_points),
    currency_profit = VALUES(currency_profit),
    currency_margin = VALUES(currency_margin),
    synced_at       = UTC_TIMESTAMP()
`;
// enabled is deliberately absent from the UPDATE clause: a re-sync must never
// silently switch a symbol on or off behind the operator.

async function syncSymbols(bridge) {
  const payload = await bridge.symbols();
  const symbols = payload.symbols || [];

  let inserted = 0;
  await withConnection(async (conn) => {
    for (const s of symbols) {
      const [result] = await conn.execute(UPSERT, [
        s.name,
        s.description || null,
        s.digits,
        s.point,
        s.contract_size,
        s.tick_size || s.point,
        s.tick_value,
        s.min_lot,
        s.lot_step,
        s.max_lot,
        s.spread ?? null,
        s.currency_profit || null,
        s.currency_margin || null
      ]);
      // mysql2 reports affectedRows 1 for an insert, 2 for an in-place update.
      if (result.affectedRows === 1) inserted += 1;
    }
  });

  return { inserted, updated: symbols.length - inserted, total: symbols.length };
}

async function listSymbols({ enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? 'SELECT * FROM symbols WHERE enabled = 1 ORDER BY broker_symbol'
    : 'SELECT * FROM symbols ORDER BY broker_symbol';
  return query(sql);
}

async function setSymbolEnabled(id, enabled) {
  await query('UPDATE symbols SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
}

module.exports = { syncSymbols, listSymbols, setSymbolEnabled };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm --prefix server test -- --test-name-pattern="syncSymbols"
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/market/symbols.js server/test/symbols-sync.test.js
git commit -m "feat: sync broker symbol specifications into MySQL"
```

---

### Task 6: Candle backfill and incremental sync

**Files:**
- Create: `server/src/market/candles.js`
- Test: `server/test/candles-sync.test.js`

**Interfaces:**
- Consumes: `createBridgeClient` (Task 4), `mapRatesToRows` (Task 4), `query`/`withConnection` (Task 1).
- Produces:
  - `syncCandles(bridge, { symbolId, brokerSymbol, timeframe, count }) -> Promise<{ received, stored }>`
  - `getCandles({ symbolId, timeframe, limit }) -> Promise<rows>` returning oldest-first rows with `open_time` as an ISO UTC string
  - `TIMEFRAMES` — the array `['M1','M5','M15','M30','H1','H4','D1']`

Storage uses a single multi-row `INSERT ... ON DUPLICATE KEY UPDATE`. Re-syncing overlapping ranges is normal — the newest bar is still forming and its close changes on every poll — so an upsert is required, not an insert.

- [ ] **Step 1: Write the failing test**

Create `server/test/candles-sync.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

require('dotenv').config();

const SCRATCH_DB = 'trading_agent_candles_test';

async function freshDatabase(t) {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  process.env.DB_NAME = SCRATCH_DB;

  const { runMigrations } = require('../src/db/migrate');
  const { query, closePool } = require('../src/db/pool');
  await runMigrations({ silent: true });
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at)
     VALUES ('EURUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, 1, UTC_TIMESTAMP())`
  );

  t.after(async () => {
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await admin.end();
  });

  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['EURUSD']);
  return sym.id;
}

function bridgeReturning(candles, offsetSeconds = 7200) {
  return {
    candles: async () => ({
      symbol: 'EURUSD',
      timeframe: 'H1',
      server_utc_offset_seconds: offsetSeconds,
      candles
    })
  };
}

test('syncCandles stores bars shifted from broker time to UTC', async (t) => {
  const symbolId = await freshDatabase(t);
  const { syncCandles, getCandles } = require('../src/market/candles');

  // Broker clock 12:00 with a +2h offset is 10:00 UTC.
  const bridge = bridgeReturning([
    { time: Date.UTC(2026, 0, 15, 12, 0, 0) / 1000, open: 1.10, high: 1.12, low: 1.09, close: 1.11,
      tick_volume: 100, real_volume: 0, spread: 8 },
    { time: Date.UTC(2026, 0, 15, 13, 0, 0) / 1000, open: 1.11, high: 1.13, low: 1.10, close: 1.125,
      tick_volume: 120, real_volume: 0, spread: 9 }
  ]);

  const result = await syncCandles(bridge, { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10 });
  assert.equal(result.received, 2);
  assert.equal(result.stored, 2);

  const rows = await getCandles({ symbolId, timeframe: 'H1', limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].open_time, '2026-01-15T10:00:00.000Z');
  assert.equal(rows[1].open_time, '2026-01-15T11:00:00.000Z');
  assert.equal(rows[0].close, 1.11);
});

test('re-syncing the same bar updates it instead of failing', async (t) => {
  const symbolId = await freshDatabase(t);
  const { syncCandles, getCandles } = require('../src/market/candles');
  const { query } = require('../src/db/pool');

  const barTime = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;

  await syncCandles(
    bridgeReturning([{ time: barTime, open: 1.10, high: 1.12, low: 1.09, close: 1.11, tick_volume: 100, real_volume: 0, spread: 8 }]),
    { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10 }
  );

  // The bar is still forming: the close moves and volume grows.
  await syncCandles(
    bridgeReturning([{ time: barTime, open: 1.10, high: 1.15, low: 1.09, close: 1.148, tick_volume: 260, real_volume: 0, spread: 8 }]),
    { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10 }
  );

  const count = await query('SELECT COUNT(*) AS n FROM candles');
  assert.equal(count[0].n, 1, 'the forming bar is updated, not duplicated');

  const rows = await getCandles({ symbolId, timeframe: 'H1', limit: 10 });
  assert.equal(rows[0].close, 1.148);
  assert.equal(rows[0].high, 1.15);
  assert.equal(rows[0].tick_volume, 260);
});

test('getCandles returns oldest-first and respects the limit', async (t) => {
  const symbolId = await freshDatabase(t);
  const { syncCandles, getCandles } = require('../src/market/candles');

  const base = Date.UTC(2026, 0, 15, 0, 0, 0) / 1000;
  const candles = Array.from({ length: 5 }, (_, i) => ({
    time: base + i * 3600, open: 1 + i, high: 1 + i, low: 1 + i, close: 1 + i,
    tick_volume: i, real_volume: 0, spread: 1
  }));

  await syncCandles(bridgeReturning(candles, 0), { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10 });

  const rows = await getCandles({ symbolId, timeframe: 'H1', limit: 3 });
  assert.equal(rows.length, 3, 'limit applied');
  // The limit takes the most recent bars, then returns them oldest-first.
  assert.equal(rows[0].close, 3);
  assert.equal(rows[2].close, 5);
});

test('syncCandles handles an empty response without error', async (t) => {
  const symbolId = await freshDatabase(t);
  const { syncCandles } = require('../src/market/candles');

  const result = await syncCandles(bridgeReturning([]), {
    symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10
  });
  assert.deepEqual(result, { received: 0, stored: 0 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix server test -- --test-name-pattern="syncCandles|getCandles|re-syncing"
```

Expected: FAIL — `Cannot find module '../src/market/candles'`.

- [ ] **Step 3: Implement candle sync**

Create `server/src/market/candles.js`:

```js
const { query, withConnection } = require('../db/pool');
const { mapRatesToRows } = require('./rates');

const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

// Chunked so a large backfill never builds a single oversized statement.
const CHUNK_SIZE = 500;

const UPSERT_PREFIX = `
  INSERT INTO candles
    (symbol_id, timeframe, open_time, open, high, low, close, tick_volume, real_volume, spread)
  VALUES `;

const UPSERT_SUFFIX = `
  ON DUPLICATE KEY UPDATE
    open        = VALUES(open),
    high        = VALUES(high),
    low         = VALUES(low),
    close       = VALUES(close),
    tick_volume = VALUES(tick_volume),
    real_volume = VALUES(real_volume),
    spread      = VALUES(spread)
`;

async function syncCandles(bridge, { symbolId, brokerSymbol, timeframe, count = 500 }) {
  if (!TIMEFRAMES.includes(timeframe)) {
    throw new Error(`unsupported timeframe: ${timeframe}`);
  }

  const payload = await bridge.candles({ symbol: brokerSymbol, timeframe, count });
  const received = payload.candles || [];
  if (received.length === 0) return { received: 0, stored: 0 };

  const rows = mapRatesToRows(received, payload.server_utc_offset_seconds || 0, symbolId, timeframe);

  let stored = 0;
  await withConnection(async (conn) => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
      await conn.query(UPSERT_PREFIX + placeholders + UPSERT_SUFFIX, chunk.flat());
      stored += chunk.length;
    }
  });

  return { received: received.length, stored };
}

async function getCandles({ symbolId, timeframe, limit = 500 }) {
  // Take the most recent `limit` bars, then hand them back oldest-first so the
  // chart and the strategy engine both read forward in time.
  // LIMIT is interpolated, not bound: MySQL's prepared-statement protocol
  // rejects a placeholder there. The value is coerced to a bounded integer
  // first, so nothing user-supplied reaches the SQL string.
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 20000);

  const rows = await query(
    `SELECT open_time, open, high, low, close, tick_volume, spread
       FROM candles
      WHERE symbol_id = ? AND timeframe = ?
      ORDER BY open_time DESC
      LIMIT ${safeLimit}`,
    [symbolId, timeframe]
  );

  return rows
    .reverse()
    .map((r) => ({ ...r, open_time: new Date(r.open_time).toISOString() }));
}

module.exports = { syncCandles, getCandles, TIMEFRAMES };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm --prefix server test
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/market/candles.js server/test/candles-sync.test.js
git commit -m "feat: backfill and upsert candles with UTC normalisation"
```

---

### Task 7: Market API routes

**Files:**
- Create: `server/src/routes/market.js`
- Modify: `server/src/index.js`
- Test: `server/test/market-routes.test.js`

**Interfaces:**
- Consumes: `syncSymbols`, `listSymbols`, `setSymbolEnabled` (Task 5); `syncCandles`, `getCandles`, `TIMEFRAMES` (Task 6); `bridgeFromEnv` (Task 4).
- Produces: an Express router mounted at `/api`, exported as `createMarketRouter({ bridge })`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/bridge/health` | Proxy the bridge's health, never 500 when the bridge is down |
| GET | `/api/symbols?enabledOnly=1` | List stored symbols |
| POST | `/api/symbols/sync` | Pull specs from the broker |
| PATCH | `/api/symbols/:id` | `{ enabled: boolean }` |
| GET | `/api/candles?symbolId=&timeframe=&limit=` | Stored candles, oldest-first |
| POST | `/api/candles/sync` | `{ symbolId, timeframe, count }` |

The mock arrays for overview, watchlist, signals, news, backtests and trades stay in `index.js` for now — later phases replace each as its real source lands. Delete only `sampleWatchlist`, which `/api/symbols` supersedes.

- [ ] **Step 1: Write the failing test**

Create `server/test/market-routes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mysql = require('mysql2/promise');

require('dotenv').config();

const SCRATCH_DB = 'trading_agent_routes_test';

async function startApp(t, bridge) {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  process.env.DB_NAME = SCRATCH_DB;

  const { runMigrations } = require('../src/db/migrate');
  const { closePool } = require('../src/db/pool');
  await runMigrations({ silent: true });

  const { createMarketRouter } = require('../src/routes/market');
  const app = express();
  app.use(express.json());
  app.use('/api', createMarketRouter({ bridge }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.close();
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await admin.end();
  });

  return base;
}

const FAKE_BRIDGE = {
  health: async () => ({ ok: true, account_login: 50045322, server_utc_offset_seconds: 7200 }),
  symbols: async () => ({
    symbols: [
      { name: 'EURUSD', description: 'Euro', digits: 5, point: 0.00001, contract_size: 100000,
        tick_size: 0.00001, tick_value: 1, min_lot: 0.01, lot_step: 0.01, max_lot: 100,
        spread: 8, currency_profit: 'USD', currency_margin: 'EUR' }
    ]
  }),
  candles: async () => ({
    server_utc_offset_seconds: 7200,
    candles: [
      { time: Date.UTC(2026, 0, 15, 12, 0, 0) / 1000, open: 1.1, high: 1.2, low: 1.0,
        close: 1.15, tick_volume: 10, real_volume: 0, spread: 8 }
    ]
  })
};

test('POST /api/symbols/sync stores symbols and GET returns them', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);

  const sync = await fetch(`${base}/api/symbols/sync`, { method: 'POST' });
  assert.equal(sync.status, 200);
  assert.equal((await sync.json()).total, 1);

  const list = await (await fetch(`${base}/api/symbols`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].broker_symbol, 'EURUSD');
});

test('PATCH /api/symbols/:id toggles enabled and enabledOnly filters', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);
  await fetch(`${base}/api/symbols/sync`, { method: 'POST' });

  const [symbol] = await (await fetch(`${base}/api/symbols`)).json();
  assert.equal((await (await fetch(`${base}/api/symbols?enabledOnly=1`)).json()).length, 0);

  const patch = await fetch(`${base}/api/symbols/${symbol.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(patch.status, 200);

  assert.equal((await (await fetch(`${base}/api/symbols?enabledOnly=1`)).json()).length, 1);
});

test('candle sync then fetch returns UTC-shifted bars', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);
  await fetch(`${base}/api/symbols/sync`, { method: 'POST' });
  const [symbol] = await (await fetch(`${base}/api/symbols`)).json();

  const sync = await fetch(`${base}/api/candles/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbolId: symbol.id, timeframe: 'H1', count: 10 })
  });
  assert.equal(sync.status, 200);

  const candles = await (await fetch(`${base}/api/candles?symbolId=${symbol.id}&timeframe=H1`)).json();
  assert.equal(candles.length, 1);
  assert.equal(candles[0].open_time, '2026-01-15T10:00:00.000Z');
});

test('an unknown timeframe is rejected with 400', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);
  const res = await fetch(`${base}/api/candles?symbolId=1&timeframe=H7`);
  assert.equal(res.status, 400);
});

test('bridge health reports unreachable instead of throwing', async (t) => {
  const brokenBridge = {
    ...FAKE_BRIDGE,
    health: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8000'); }
  };
  const base = await startApp(t, brokenBridge);

  const res = await fetch(`${base}/api/bridge/health`);
  assert.equal(res.status, 200, 'the dashboard must render even with the bridge down');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /ECONNREFUSED/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix server test -- --test-name-pattern="symbols/sync"
```

Expected: FAIL — `Cannot find module '../src/routes/market'`.

- [ ] **Step 3: Implement the router**

Create `server/src/routes/market.js`:

```js
const express = require('express');

const { syncSymbols, listSymbols, setSymbolEnabled } = require('../market/symbols');
const { syncCandles, getCandles, TIMEFRAMES } = require('../market/candles');
const { query } = require('../db/pool');

function createMarketRouter({ bridge }) {
  const router = express.Router();

  // Never propagate a bridge outage as a 500: the dashboard has to stay usable
  // when the MT5 terminal is closed, which is most of the time during setup.
  router.get('/bridge/health', async (req, res) => {
    try {
      res.json(await bridge.health());
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });

  router.get('/symbols', async (req, res, next) => {
    try {
      res.json(await listSymbols({ enabledOnly: req.query.enabledOnly === '1' }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/symbols/sync', async (req, res, next) => {
    try {
      res.json(await syncSymbols(bridge));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/symbols/:id', async (req, res, next) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: 'body must be { enabled: boolean }' });
      }
      await setSymbolEnabled(Number(req.params.id), req.body.enabled);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/candles', async (req, res, next) => {
    try {
      const symbolId = Number(req.query.symbolId);
      const timeframe = String(req.query.timeframe || 'H1');
      const limit = Math.min(Number(req.query.limit || 500), 5000);

      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });
      if (!TIMEFRAMES.includes(timeframe)) {
        return res.status(400).json({ error: `timeframe must be one of ${TIMEFRAMES.join(', ')}` });
      }

      res.json(await getCandles({ symbolId, timeframe, limit }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/candles/sync', async (req, res, next) => {
    try {
      const { symbolId, timeframe = 'H1', count = 1000 } = req.body || {};
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });
      if (!TIMEFRAMES.includes(timeframe)) {
        return res.status(400).json({ error: `timeframe must be one of ${TIMEFRAMES.join(', ')}` });
      }

      const rows = await query('SELECT broker_symbol FROM symbols WHERE id = ?', [symbolId]);
      if (rows.length === 0) return res.status(404).json({ error: `unknown symbolId ${symbolId}` });

      res.json(await syncCandles(bridge, {
        symbolId,
        brokerSymbol: rows[0].broker_symbol,
        timeframe,
        count: Math.min(Number(count), 20000)
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createMarketRouter };
```

- [ ] **Step 4: Mount the router in the server**

In `server/src/index.js`, after `app.use(express.json());` add:

```js
const { bridgeFromEnv } = require('./bridge/client');
const { createMarketRouter } = require('./routes/market');

app.use('/api', createMarketRouter({ bridge: bridgeFromEnv() }));
```

Delete the `sampleWatchlist` constant and its `/api/watchlist` route — `/api/symbols` replaces it. Leave the other sample routes for later phases.

Add an error handler as the last middleware, before `app.listen`:

```js
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});
```

- [ ] **Step 5: Run the full suite**

```bash
npm --prefix server test
```

Expected: PASS, all tests.

- [ ] **Step 6: Verify end to end against the real broker**

With the MT5 terminal running and the bridge started:

```bash
npm --prefix server start &
sleep 3
curl -s http://localhost:3001/api/bridge/health
curl -s -X POST http://localhost:3001/api/symbols/sync
curl -s 'http://localhost:3001/api/symbols' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('symbols:',s.length);console.log(s.slice(0,10).map(x=>x.broker_symbol).join(' '))})"
```

Pick the EURUSD row's `id` from that output, enable it, and backfill:

```bash
SYMBOL_ID=<id from above>
curl -s -X PATCH "http://localhost:3001/api/symbols/$SYMBOL_ID" -H 'content-type: application/json' -d '{"enabled":true}'
curl -s -X POST http://localhost:3001/api/candles/sync -H 'content-type: application/json' \
  -d "{\"symbolId\":$SYMBOL_ID,\"timeframe\":\"H1\",\"count\":2000}"
curl -s "http://localhost:3001/api/candles?symbolId=$SYMBOL_ID&timeframe=H1&limit=3"
kill %1
```

Expected: roughly 2000 stored, and three candles with plausible EURUSD prices.

**Sanity-check the timezone, which is the whole point of the offset work:** the newest H1 bar's `open_time` must be within about an hour of the current UTC time.

```bash
docker exec trading-mysql mysql -utrader -ptraderpass trading_agent \
  -e "SELECT MAX(open_time) AS newest_bar, UTC_TIMESTAMP() AS utc_now FROM candles;"
```

Expected: the two values differ by less than ~1 hour during market hours. A gap of exactly 2 or 3 hours means the offset was not applied — stop and fix it before continuing, because every later phase inherits the error.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/market.js server/src/index.js server/test/market-routes.test.js
git commit -m "feat: expose symbol and candle sync over the market API"
```

---

### Task 8: Candlestick chart in the dashboard

**Files:**
- Create: `client/src/api.js`, `client/src/components/CandleChart.jsx`, `client/src/pages/Markets.jsx`
- Modify: `client/src/App.jsx`, `client/src/styles.css`, `client/package.json`

**Interfaces:**
- Consumes: the API routes from Task 7.
- Produces: a `Markets` view — symbol dropdown, timeframe buttons, sync button, and a candlestick chart of real broker data.

- [ ] **Step 1: Install the charting library**

```bash
npm --prefix client install lightweight-charts@4.2.3
```

`lightweight-charts` is used rather than recharts because recharts has no candlestick series. Recharts stays for equity curves in later phases.

- [ ] **Step 2: Write the API helpers**

Create `client/src/api.js`:

```js
async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).error || message;
    } catch {
      // Response had no JSON body; the status text is the best we have.
    }
    throw new Error(message);
  }
  return response.json();
}

export const api = {
  bridgeHealth: () => request('/api/bridge/health'),
  symbols: (enabledOnly = false) => request(`/api/symbols${enabledOnly ? '?enabledOnly=1' : ''}`),
  syncSymbols: () => request('/api/symbols/sync', { method: 'POST' }),
  setSymbolEnabled: (id, enabled) =>
    request(`/api/symbols/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    }),
  candles: (symbolId, timeframe, limit = 500) =>
    request(`/api/candles?symbolId=${symbolId}&timeframe=${timeframe}&limit=${limit}`),
  syncCandles: (symbolId, timeframe, count = 2000) =>
    request('/api/candles/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbolId, timeframe, count })
    })
};
```

- [ ] **Step 3: Write the chart component**

Create `client/src/components/CandleChart.jsx`:

```jsx
import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode } from 'lightweight-charts';

export default function CandleChart({ candles, height = 420 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

  useEffect(() => {
    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: 'transparent' }, textColor: '#9aa7bc' },
      grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2d3748' },
      timeScale: { borderColor: '#2d3748', timeVisible: true, secondsVisible: false }
    });

    seriesRef.current = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444'
    });
    chartRef.current = chart;

    const resize = () =>
      chart.applyOptions({ width: containerRef.current?.clientWidth ?? 600 });
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, [height]);

  useEffect(() => {
    if (!seriesRef.current) return;

    // lightweight-charts wants seconds since epoch, and our API sends ISO UTC.
    seriesRef.current.setData(
      candles.map((c) => ({
        time: Math.floor(new Date(c.open_time).getTime() / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={containerRef} className="chart-container" />;
}
```

- [ ] **Step 4: Write the Markets page**

Create `client/src/pages/Markets.jsx`:

```jsx
import { useCallback, useEffect, useState } from 'react';
import CandleChart from '../components/CandleChart';
import { api } from '../api';

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

export default function Markets() {
  const [symbols, setSymbols] = useState([]);
  const [symbolId, setSymbolId] = useState(null);
  const [timeframe, setTimeframe] = useState('H1');
  const [candles, setCandles] = useState([]);
  const [bridge, setBridge] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadSymbols = useCallback(async () => {
    const rows = await api.symbols();
    setSymbols(rows);
    setSymbolId((current) => current ?? rows.find((r) => r.enabled)?.id ?? rows[0]?.id ?? null);
  }, []);

  useEffect(() => {
    api.bridgeHealth().then(setBridge).catch((e) => setBridge({ ok: false, error: e.message }));
    loadSymbols().catch((e) => setError(e.message));
  }, [loadSymbols]);

  useEffect(() => {
    if (!symbolId) return;
    api.candles(symbolId, timeframe, 500).then(setCandles).catch((e) => setError(e.message));
  }, [symbolId, timeframe]);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const selected = symbols.find((s) => s.id === symbolId);

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Markets</h3>
        <span className={bridge?.ok ? 'up' : 'down'}>
          {bridge?.ok ? `MT5 connected · account ${bridge.account_login}` : 'MT5 bridge offline'}
        </span>
      </div>

      <div className="toolbar">
        <select value={symbolId ?? ''} onChange={(e) => setSymbolId(Number(e.target.value))}>
          {symbols.length === 0 && <option value="">no symbols — sync first</option>}
          {symbols.map((s) => (
            <option key={s.id} value={s.id}>
              {s.broker_symbol}
              {s.enabled ? ' ●' : ''}
            </option>
          ))}
        </select>

        <div className="tf-group">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              className={tf === timeframe ? 'tf active' : 'tf'}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>

        <button
          disabled={busy}
          onClick={() => run(async () => { await api.syncSymbols(); await loadSymbols(); })}
        >
          Sync symbols
        </button>

        <button
          disabled={busy || !symbolId}
          onClick={() =>
            run(async () => {
              await api.syncCandles(symbolId, timeframe, 2000);
              setCandles(await api.candles(symbolId, timeframe, 500));
            })
          }
        >
          Backfill {timeframe}
        </button>

        {selected && (
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.setSymbolEnabled(selected.id, !selected.enabled);
                await loadSymbols();
              })
            }
          >
            {selected.enabled ? 'Disable' : 'Enable'} {selected.broker_symbol}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {candles.length === 0 ? (
        <p className="empty">
          No candles stored for this symbol and timeframe. Start the MT5 terminal and the bridge,
          then press Backfill.
        </p>
      ) : (
        <CandleChart candles={candles} />
      )}

      <p className="muted">
        {candles.length} bars · times are UTC
        {selected && ` · min lot ${selected.min_lot} · step ${selected.lot_step} · tick value ${selected.tick_value}`}
      </p>
    </section>
  );
}
```

- [ ] **Step 5: Wire the page into the app shell**

In `client/src/App.jsx`, add at the top:

```jsx
import Markets from './pages/Markets';
```

Add a `view` state inside `App`:

```jsx
const [view, setView] = useState('overview');
```

Change the nav buttons to switch views:

```jsx
        <nav>
          <button className={view === 'overview' ? 'nav active' : 'nav'} onClick={() => setView('overview')}>Overview</button>
          <button className={view === 'markets' ? 'nav active' : 'nav'} onClick={() => setView('markets')}>Markets</button>
          <button className="nav">Signals</button>
          <button className="nav">Backtests</button>
          <button className="nav">Execution</button>
          <button className="nav">Risk</button>
        </nav>
```

Wrap the existing dashboard sections so they render only for the overview view, and render `<Markets />` for the markets view. The simplest edit: immediately after the `<header className="topbar">…</header>` block, open `{view === 'markets' ? <Markets /> : (<>` and close `</>)}` just before `</main>`.

Also delete the `watchlist` state, its `fetch('/api/watchlist')` call, and the Watchlist panel — that route no longer exists.

- [ ] **Step 6: Add the styles**

Append to `client/src/styles.css`:

```css
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 16px;
}

.toolbar select,
.toolbar button {
  background: #16202e;
  color: #e6edf7;
  border: 1px solid #2d3748;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
}

.toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }

.tf-group { display: flex; gap: 4px; }

.tf.active { background: #1d4ed8; border-color: #1d4ed8; }

.chart-container { width: 100%; }

.error {
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
}

.empty, .muted { color: #9aa7bc; font-size: 13px; }
```

- [ ] **Step 7: Verify in the browser**

With MT5, the bridge, MySQL and the server all running:

```bash
npm run dev
```

Open `http://localhost:5173`, click **Markets**, and confirm:

1. The header shows `MT5 connected · account 50045322`.
2. **Sync symbols** populates the dropdown with Axi's instruments.
3. Selecting EURUSD and clicking **Backfill H1** draws a candlestick chart.
4. Switching timeframes reloads the chart (backfill each timeframe once).
5. The newest candle's time matches the current UTC hour, not broker time.

- [ ] **Step 8: Build to confirm nothing is broken**

```bash
npm run build
```

Expected: Vite build succeeds with no unresolved imports.

- [ ] **Step 9: Commit**

```bash
git add client/src client/package.json client/package-lock.json package-lock.json
git commit -m "feat: add Markets view with real broker candlestick chart"
```

---

## Phase 1 Definition of Done

- [ ] `npm --prefix server test` passes.
- [ ] `npm run build` succeeds.
- [ ] `docker exec trading-mysql mysql -utrader -ptraderpass trading_agent -e "SELECT COUNT(*) FROM symbols; SELECT COUNT(*) FROM candles;"` shows real rows.
- [ ] The newest stored H1 bar is within ~1 hour of `UTC_TIMESTAMP()` during market hours — proving broker-time normalisation works.
- [ ] The Markets view renders a live candlestick chart of Axi data.
- [ ] No secrets are tracked: `git ls-files | grep -E '(^|/)\.env$'` returns nothing.

## What Phase 1 deliberately does not do

No indicators, no strategies, no backtesting, no risk engine, no order placement, no scheduler, no authentication. Those are phases 2 through 5 in the spec. The bridge has no write endpoints at all, so this phase cannot place a trade even by accident.
