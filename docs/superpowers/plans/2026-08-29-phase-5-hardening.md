# Phase 5: Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a login in front of a dashboard that can place orders, tell the operator when something important happens, and write down how to deploy it — so the two-week demo can run unattended without the system being a liability.

**Architecture:** Authentication uses `node:crypto` scrypt for password hashing and opaque random session tokens stored in MySQL, set as an httpOnly cookie. No authentication dependency is added: scrypt is a proper password KDF in the standard library, and a random token in a table is simpler to audit than a self-rolled JWT. Alerts are a thin Telegram notifier called from the places that matter. LLM commentary is strictly advisory and cannot alter a signal.

**Tech Stack:** Node 22 (built-in `node:test`, `node:crypto`), Express 4, mysql2, MySQL 8.4, React 18 + Vite.

**Spec:** `docs/superpowers/specs/2026-08-29-trading-agent-dashboard-design.md`

**Deviation from the spec, recorded deliberately:** section 5 specifies
`password_hash (bcrypt)`. This plan uses scrypt from `node:crypto` instead.
bcrypt would mean a native dependency on an authentication path, and scrypt is
a memory-hard KDF in the standard library with no such exposure. The column is
unchanged; only the algorithm inside the stored string differs, and that string
carries its own parameters so it can be migrated later.

## Global Constraints

- **No new npm dependencies on the authentication or alerting path.** `node:crypto` provides scrypt and `randomBytes`; `fetch` is global in Node 22. Every dependency on an auth path is a dependency that can be compromised. One exception: the LLM commentary feature uses the official `@anthropic-ai/sdk`, because hand-rolled HTTP against a provider API silently rots as request shapes and model ids change.
- **Passwords are never stored, logged, or returned.** Only the scrypt hash, and comparison is constant-time via `timingSafeEqual`.
- **Every `/api` route requires a session except** `/api/health`, `/api/auth/login`, and `/api/auth/status`. The default is closed: routes are protected by mounting the guard before them, so a new route added later is protected unless someone deliberately exempts it.
- **The LLM cannot change a signal.** It receives a read-only summary and returns text. It is never consulted before an order, and the feature is off unless `ANTHROPIC_API_KEY` is set.
- Alerts must never break trading. Every notifier call is wrapped so a failed send is logged and swallowed.
- All timestamps UTC. CommonJS in `server/`, ES modules in `client/`.
- Every SQL change is a new numbered migration.
- Integration tests use `server/test/helpers/db.js` → `freshDatabase(t, name)`.
- **No test may call the real Telegram or Anthropic API.** Both are tested against stubs.

---

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `server/src/auth/passwords.js` | scrypt hashing and constant-time verification |
| `server/src/auth/sessions.js` | Session create, lookup, destroy, prune |
| `server/src/auth/middleware.js` | `requireSession` guard and cookie parsing |
| `server/src/routes/auth.js` | `/api/auth/login`, `/logout`, `/status` |
| `server/src/cli/create-user.js` | Create the operator account from the terminal |
| `server/src/alerts/notifier.js` | Telegram send, never throws |
| `server/src/alerts/events.js` | The events worth waking someone for |
| `server/src/ai/commentary.js` | Advisory market commentary |
| `server/src/routes/ai.js` | `/api/commentary` |
| `server/migrations/007_sessions.sql` | `sessions` table |
| `client/src/pages/Login.jsx` | Login screen |
| `docs/DEPLOYMENT.md` | Hostinger deployment and production checklist |
| `server/test/*.test.js` | Unit and integration tests |

**Modify:** `server/src/index.js`, `server/package.json` (a `create-user` script), `server/src/risk/state.js` (alert on kill switch), `server/src/execution/manager.js` (alert on fill and failure), `client/src/App.jsx`, `client/src/api.js`, `client/src/styles.css`, `server/.env` / `.env.example`.

---

### Task 1: Password hashing

**Files:**
- Create: `server/src/auth/passwords.js`
- Test: `server/test/passwords.test.js`

**Interfaces:**
- Consumes: `node:crypto` only.
- Produces:
  - `hashPassword(plain) -> Promise<string>` — returns `scrypt$N$r$p$<saltHex>$<hashHex>`
  - `verifyPassword(plain, stored) -> Promise<boolean>` — constant-time, false on any malformed input

The parameters live inside the stored string so a future cost increase can be rolled out without invalidating existing hashes. Verification is `timingSafeEqual`: comparing hashes with `===` leaks how many leading bytes matched, which is enough to recover a hash byte by byte.

- [ ] **Step 1: Write the failing test**

Create `server/test/passwords.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, verifyPassword } = require('../src/auth/passwords');

test('a hash verifies against its own password', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
});

test('a wrong password does not verify', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('Correct horse battery staple', stored), false);
  assert.equal(await verifyPassword('', stored), false);
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
});

test('the same password hashes differently every time', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b, 'a per-hash salt means identical passwords never collide');
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('the stored form contains no plaintext and carries its parameters', async () => {
  const stored = await hashPassword('hunter2');
  assert.ok(!stored.includes('hunter2'), 'the password must not appear in the stored value');
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
});

test('malformed stored values return false rather than throwing', async () => {
  for (const bad of ['', 'nonsense', 'scrypt$broken', null, undefined, 'md5$1$1$1$aa$bb']) {
    assert.equal(await verifyPassword('anything', bad), false, `input ${bad} must be rejected`);
  }
});

test('a hash produced with different cost parameters still verifies', async () => {
  // Simulates rolling the cost forward: an old hash must keep working.
  const stored = await hashPassword('portable', { N: 2 ** 13 });
  assert.match(stored, /^scrypt\$8192\$/);
  assert.equal(await verifyPassword('portable', stored), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/passwords.test.js
```

Expected: FAIL — `Cannot find module '../src/auth/passwords'`.

- [ ] **Step 3: Implement hashing**

Create `server/src/auth/passwords.js`:

```js
const crypto = require('node:crypto');

/**
 * Password hashing with scrypt from the standard library.
 *
 * No dependency is added for this. scrypt is a proper memory-hard password
 * KDF, and every package on an authentication path is a package that can be
 * compromised.
 *
 * The cost parameters are stored inside the hash so they can be raised later
 * without invalidating existing passwords.
 */

const DEFAULTS = { N: 2 ** 15, r: 8, p: 1, keyLength: 64 };

function scryptAsync(password, salt, { N, r, p, keyLength }) {
  return new Promise((resolve, reject) => {
    // maxmem must exceed 128 * N * r or scrypt refuses to run.
    crypto.scrypt(password, salt, keyLength, { N, r, p, maxmem: 256 * N * r }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

async function hashPassword(plain, options = {}) {
  const params = { ...DEFAULTS, ...options };
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(String(plain), salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex)) return false;

  const expected = Buffer.from(hashHex, 'hex');

  let derived;
  try {
    derived = await scryptAsync(String(plain), Buffer.from(saltHex, 'hex'), {
      N, r, p, keyLength: expected.length
    });
  } catch {
    return false;
  }

  // Constant time. Comparing with === leaks how many leading bytes matched,
  // which is enough to recover a hash byte by byte.
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test test/passwords.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/passwords.js server/test/passwords.test.js
git commit -m "feat(auth): add scrypt password hashing with no new dependencies"
```

---

### Task 2: Sessions and the guard

**Files:**
- Create: `server/src/auth/sessions.js`, `server/src/auth/middleware.js`, `server/migrations/007_sessions.sql`
- Test: `server/test/sessions.test.js`

**Interfaces:**
- Consumes: `query` from `src/db/pool.js`, `node:crypto`.
- Produces:
  - `sessions.js`: `createSession(userId, { ttlHours }) -> Promise<{ token, expiresAt }>`, `findSession(token) -> Promise<row|null>`, `destroySession(token) -> Promise<void>`, `pruneExpired() -> Promise<number>`
  - `middleware.js`: `requireSession(req, res, next)`, `parseCookies(header) -> object`, `SESSION_COOKIE` (the string `'ta_session'`)

The token is 32 random bytes, opaque, and only the **SHA-256 of it** is stored. A stolen database dump then contains no usable sessions. `findSession` rejects expired rows rather than relying on a cleanup job having run.

- [ ] **Step 1: Write the migration**

Create `server/migrations/007_sessions.sql`:

```sql
-- Only the SHA-256 of the session token is stored. A stolen database dump
-- then contains no usable sessions, which a plaintext token table would.
CREATE TABLE sessions (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  created_at DATETIME     NOT NULL,
  expires_at DATETIME     NOT NULL,
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: Write the failing test**

Create `server/test/sessions.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_sessions_test';

async function withUser(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  const r = await query(
    "INSERT INTO users (username, password_hash, created_at) VALUES ('operator', 'x', UTC_TIMESTAMP())"
  );
  return r.insertId;
}

test('a created session is findable by its token', async (t) => {
  const userId = await withUser(t);
  const { createSession, findSession } = require('../src/auth/sessions');

  const { token, expiresAt } = await createSession(userId, { ttlHours: 12 });
  assert.match(token, /^[0-9a-f]{64}$/, 'the token is 32 random bytes as hex');
  assert.ok(expiresAt instanceof Date);

  const session = await findSession(token);
  assert.ok(session);
  assert.equal(Number(session.user_id), userId);
  assert.equal(session.username, 'operator');
});

test('the raw token is never stored', async (t) => {
  const userId = await withUser(t);
  const { createSession } = require('../src/auth/sessions');
  const { query } = require('../src/db/pool');

  const { token } = await createSession(userId, {});
  const rows = await query('SELECT token_hash FROM sessions');

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token, 'only the hash may be stored');
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test('an unknown or malformed token finds nothing', async (t) => {
  await withUser(t);
  const { findSession } = require('../src/auth/sessions');

  assert.equal(await findSession('deadbeef'), null);
  assert.equal(await findSession(''), null);
  assert.equal(await findSession(null), null);
  assert.equal(await findSession(undefined), null);
});

test('an expired session is refused even before it is pruned', async (t) => {
  const userId = await withUser(t);
  const { createSession, findSession } = require('../src/auth/sessions');
  const { query } = require('../src/db/pool');

  const { token } = await createSession(userId, { ttlHours: 1 });
  await query('UPDATE sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)');

  assert.equal(await findSession(token), null, 'expiry is enforced on read, not by a cleanup job');
});

test('destroySession makes the token useless', async (t) => {
  const userId = await withUser(t);
  const { createSession, findSession, destroySession } = require('../src/auth/sessions');

  const { token } = await createSession(userId, {});
  assert.ok(await findSession(token));

  await destroySession(token);
  assert.equal(await findSession(token), null);
});

test('pruneExpired removes only expired rows', async (t) => {
  const userId = await withUser(t);
  const { createSession, pruneExpired } = require('../src/auth/sessions');
  const { query } = require('../src/db/pool');

  await createSession(userId, { ttlHours: 12 });
  const { token: stale } = await createSession(userId, { ttlHours: 12 });
  const crypto = require('node:crypto');
  await query('UPDATE sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE token_hash = ?',
    [crypto.createHash('sha256').update(stale).digest('hex')]);

  assert.equal(await pruneExpired(), 1);
  assert.equal((await query('SELECT COUNT(*) AS n FROM sessions'))[0].n, 1);
});

test('parseCookies handles absent, single and multiple cookies', async () => {
  const { parseCookies } = require('../src/auth/middleware');

  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('a=1'), { a: '1' });
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies('ta_session=abc%3Ddef'), { ta_session: 'abc=def' });
});

test('requireSession rejects without a cookie and admits with one', async (t) => {
  const userId = await withUser(t);
  const { createSession } = require('../src/auth/sessions');
  const { requireSession, SESSION_COOKIE } = require('../src/auth/middleware');

  const app = express();
  app.get('/protected', requireSession, (req, res) => res.json({ user: req.user.username }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const anonymous = await fetch(`${base}/protected`);
  assert.equal(anonymous.status, 401);

  const { token } = await createSession(userId, {});
  const authorised = await fetch(`${base}/protected`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` }
  });
  assert.equal(authorised.status, 200);
  assert.equal((await authorised.json()).user, 'operator');

  const forged = await fetch(`${base}/protected`, {
    headers: { cookie: `${SESSION_COOKIE}=${'0'.repeat(64)}` }
  });
  assert.equal(forged.status, 401, 'a well-formed but unknown token is still rejected');
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && node --test test/sessions.test.js
```

Expected: FAIL — `Cannot find module '../src/auth/sessions'`.

- [ ] **Step 4: Implement sessions**

Create `server/src/auth/sessions.js`:

```js
const crypto = require('node:crypto');
const { query } = require('../db/pool');

/**
 * Opaque random session tokens, stored only as a SHA-256 digest.
 *
 * A stolen database dump then contains no usable sessions. The token itself
 * is 32 random bytes, so it carries no structure to forge and needs no
 * signature scheme of its own.
 */

const DEFAULT_TTL_HOURS = 24 * 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function createSession(userId, { ttlHours = DEFAULT_TTL_HOURS } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  await query(
    `INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, UTC_TIMESTAMP(), ?)`,
    [userId, hashToken(token), expiresAt.toISOString().slice(0, 19).replace('T', ' ')]
  );

  return { token, expiresAt };
}

async function findSession(token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  // Expiry is checked here rather than trusting a cleanup job to have run.
  const rows = await query(
    `SELECT s.*, u.username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function destroySession(token) {
  if (typeof token !== 'string' || token.length === 0) return;
  await query('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

async function pruneExpired() {
  const result = await query('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()');
  return result.affectedRows || 0;
}

module.exports = { createSession, findSession, destroySession, pruneExpired, hashToken };
```

- [ ] **Step 5: Implement the middleware**

Create `server/src/auth/middleware.js`:

```js
const { findSession } = require('./sessions');

const SESSION_COOKIE = 'ta_session';

function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

async function requireSession(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = await findSession(token);
    if (!session) {
      return res.status(401).json({ error: 'authentication required' });
    }
    req.user = { id: session.user_id, username: session.username };
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requireSession, parseCookies, SESSION_COOKIE };
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd server && node --test test/sessions.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/auth/sessions.js server/src/auth/middleware.js server/migrations/007_sessions.sql server/test/sessions.test.js
git commit -m "feat(auth): add hashed session tokens and the route guard"
```

---

### Task 3: Login routes, the operator CLI, and locking down the API

**Files:**
- Create: `server/src/routes/auth.js`, `server/src/cli/create-user.js`
- Modify: `server/src/index.js`, `server/package.json`, `server/.env`, `server/.env.example`
- Test: `server/test/auth-routes.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  - `createAuthRouter()` mounted at `/api`:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` | `{ username, password }` → sets the session cookie |
| POST | `/api/auth/logout` | Destroys the session |
| GET | `/api/auth/status` | `{ authenticated, username }` — unprotected, so the UI can decide what to render |

  - `npm --prefix server run create-user -- <username> <password>`

Two details that matter more than they look:

- **A wrong username and a wrong password return the same message and take the same work.** Returning "no such user" quickly tells an attacker which usernames exist, so a failed lookup still runs a hash.
- **`AUTH_ENABLED` exists but defaults to true.** It can be turned off for local development, and the server logs a loud warning when it is, because an unprotected dashboard that can trade is the single worst state this system can be deployed in.

- [ ] **Step 1: Write the failing test**

Create `server/test/auth-routes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_authroutes_test';

async function startApp(t, { authEnabled = true } = {}) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  const { hashPassword } = require('../src/auth/passwords');
  await query(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, UTC_TIMESTAMP())',
    ['operator', await hashPassword('s3cret-passphrase')]
  );

  const { createAuthRouter } = require('../src/routes/auth');
  const { requireSession } = require('../src/auth/middleware');

  const app = express();
  app.use(express.json());
  app.use('/api', createAuthRouter());
  if (authEnabled) app.use('/api', requireSession);
  app.get('/api/secret', (req, res) => res.json({ ok: true, user: req.user?.username ?? null }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());

  return `http://127.0.0.1:${server.address().port}`;
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie');
  return header ? header.split(';')[0] : null;
}

test('login with the right password sets an httpOnly cookie', async (t) => {
  const base = await startApp(t);

  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 's3cret-passphrase' })
  });

  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'a session cookie is set');
  assert.match(setCookie, /HttpOnly/i, 'the cookie must be unreadable from JavaScript');
  assert.match(setCookie, /SameSite=Lax/i);
  assert.equal((await res.json()).username, 'operator');
});

test('the session cookie opens a protected route', async (t) => {
  const base = await startApp(t);

  const denied = await fetch(`${base}/api/secret`);
  assert.equal(denied.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 's3cret-passphrase' })
  });

  const allowed = await fetch(`${base}/api/secret`, { headers: { cookie: cookieFrom(login) } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).user, 'operator');
});

test('a wrong password and an unknown user are indistinguishable', async (t) => {
  const base = await startApp(t);

  const wrongPassword = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'wrong' })
  });
  const unknownUser = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'nobody', password: 'wrong' })
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.deepEqual(await wrongPassword.json(), await unknownUser.json(),
    'the response must not reveal which usernames exist');
});

test('logout invalidates the session', async (t) => {
  const base = await startApp(t);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 's3cret-passphrase' })
  });
  const cookie = cookieFrom(login);

  assert.equal((await fetch(`${base}/api/secret`, { headers: { cookie } })).status, 200);

  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);

  assert.equal((await fetch(`${base}/api/secret`, { headers: { cookie } })).status, 401,
    'the old cookie must stop working immediately');
});

test('auth status is readable without a session', async (t) => {
  const base = await startApp(t);

  const anonymous = await (await fetch(`${base}/api/auth/status`)).json();
  assert.equal(anonymous.authenticated, false);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 's3cret-passphrase' })
  });

  const signedIn = await (await fetch(`${base}/api/auth/status`, { headers: { cookie: cookieFrom(login) } })).json();
  assert.equal(signedIn.authenticated, true);
  assert.equal(signedIn.username, 'operator');
});

test('a login without credentials is rejected', async (t) => {
  const base = await startApp(t);

  for (const body of [{}, { username: 'operator' }, { password: 'x' }]) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be rejected`);
  }
});

test('the password hash never leaves the server', async (t) => {
  const base = await startApp(t);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 's3cret-passphrase' })
  });
  const body = JSON.stringify(await login.json());

  assert.ok(!body.includes('scrypt'), 'no hash in the response');
  assert.ok(!body.includes('s3cret-passphrase'), 'no password in the response');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/auth-routes.test.js
```

Expected: FAIL — `Cannot find module '../src/routes/auth'`.

- [ ] **Step 3: Implement the auth router**

Create `server/src/routes/auth.js`:

```js
const express = require('express');

const { query } = require('../db/pool');
const { verifyPassword, hashPassword } = require('../auth/passwords');
const { createSession, destroySession, findSession } = require('../auth/sessions');
const { parseCookies, SESSION_COOKIE } = require('../auth/middleware');

// A hash to compare against when the username does not exist, so a failed
// lookup costs the same work as a wrong password. Without this, response
// timing tells an attacker which usernames are real.
let decoyHash = null;
async function getDecoyHash() {
  if (!decoyHash) decoyHash = await hashPassword('decoy-for-constant-time-login');
  return decoyHash;
}

function sessionCookie(token, expiresAt) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`
  ];
  // Secure is added behind TLS. Setting it unconditionally would break the
  // plain-HTTP local setup, where the cookie would silently never be sent.
  if (process.env.COOKIE_SECURE === 'true') parts.push('Secure');
  return parts.join('; ');
}

function createAuthRouter() {
  const router = express.Router();

  router.post('/auth/login', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
      }

      const rows = await query('SELECT * FROM users WHERE username = ?', [String(username)]);
      const stored = rows.length ? rows[0].password_hash : await getDecoyHash();
      const ok = await verifyPassword(String(password), stored);

      if (!rows.length || !ok) {
        // One message for both failures. Saying "no such user" hands an
        // attacker a list of valid usernames.
        return res.status(401).json({ error: 'invalid username or password' });
      }

      const { token, expiresAt } = await createSession(rows[0].id, {});
      res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));
      res.json({ authenticated: true, username: rows[0].username });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/logout', async (req, res, next) => {
    try {
      await destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
      res.json({ authenticated: false });
    } catch (error) {
      next(error);
    }
  });

  // Unprotected on purpose: the UI needs to know whether to show the login
  // screen before it has a session.
  router.get('/auth/status', async (req, res, next) => {
    try {
      const session = await findSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      res.json(session
        ? { authenticated: true, username: session.username }
        : { authenticated: false });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test test/auth-routes.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the operator CLI**

Create `server/src/cli/create-user.js`:

```js
require('dotenv').config();

const { query, closePool } = require('../db/pool');
const { hashPassword } = require('../auth/passwords');

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error('usage: npm --prefix server run create-user -- <username> <password>');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('password must be at least 12 characters: this login can place trades');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  await query(
    `INSERT INTO users (username, password_hash, created_at)
     VALUES (?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [username, hash]
  );

  console.log(`user "${username}" created or updated`);
}

main()
  .then(closePool)
  .catch(async (error) => {
    console.error('failed:', error.message);
    await closePool();
    process.exit(1);
  });
```

Add the script to `server/package.json`, inside `"scripts"`:

```json
    "create-user": "node src/cli/create-user.js",
```

- [ ] **Step 6: Lock down the API**

In `server/src/index.js`, add the auth router and the guard **before** every other router. Replace the line:

```js
app.use('/api', createMarketRouter({ bridge: bridgeFromEnv() }));
```

with:

```js
const { createAuthRouter } = require('./routes/auth');
const { requireSession } = require('./auth/middleware');

// Auth routes first: login and status must be reachable without a session.
app.use('/api', createAuthRouter());

// Everything mounted after this line requires a session. The guard sits here
// rather than on each route so a route added later is protected by default -
// a dashboard that can place orders must never be open by accident.
if (process.env.AUTH_ENABLED === 'false') {
  console.warn('WARNING: AUTH_ENABLED=false - the API is UNPROTECTED and it can place trades');
} else {
  app.use('/api', requireSession);
}

app.use('/api', createMarketRouter({ bridge: bridgeFromEnv() }));
```

Move the `/api/health` route **above** the auth router so uptime checks work without a session. Cut the whole `app.get('/api/health', ...)` block and paste it directly after `app.use(express.json());`.

Add to `server/.env` and `server/.env.example`:

```
# ---- Authentication ----
# Set to false ONLY for local development. The server warns loudly, because an
# unprotected dashboard that can place trades is the worst possible state.
AUTH_ENABLED=true
# Add the Secure flag to the session cookie. Required behind HTTPS; leave
# false on plain-HTTP local setups or the cookie is silently never sent.
COOKIE_SECURE=false
```

- [ ] **Step 7: Create the operator and verify by hand**

```bash
npm --prefix server run migrate
npm --prefix server run create-user -- operator "change-this-passphrase"
```

Start the server, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/symbols
```

Expected: `401`.

```bash
curl -s -c /tmp/ta-cookies -X POST http://localhost:3001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"operator","password":"change-this-passphrase"}'
curl -s -b /tmp/ta-cookies -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/symbols
```

Expected: `200`. And health stays open:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/health
```

Expected: `200`.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/auth.js server/src/cli/create-user.js server/src/index.js server/package.json server/.env.example server/test/auth-routes.test.js
git commit -m "feat(auth): require a session for every API route except health"
```

---

### Task 4: Client login

**Files:**
- Create: `client/src/pages/Login.jsx`
- Modify: `client/src/api.js`, `client/src/App.jsx`, `client/src/styles.css`

**Interfaces:**
- Consumes: `/api/auth/*` from Task 3.
- Produces: a login gate around the whole dashboard, and a sign-out control.

`request` in `api.js` must send cookies. `fetch` omits them cross-origin by default, and the Vite dev server proxies to a different port, so without `credentials: 'include'` every request after login is anonymous — a confusing failure that looks like the session is broken.

- [ ] **Step 1: Send credentials and surface 401s**

In `client/src/api.js`, replace the `request` function with:

```js
export class AuthError extends Error {}

async function request(path, options) {
  // Cookies must be sent explicitly: the dev server proxies to another port,
  // and without this every call after login is silently anonymous.
  const response = await fetch(path, { credentials: 'include', ...options });

  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).error || message;
    } catch {
      // Response had no JSON body; the status text is the best we have.
    }
    if (response.status === 401) throw new AuthError(message);
    throw new Error(message);
  }
  return response.json();
}
```

Then add these entries inside the exported `api` object:

```js
  authStatus: () => request('/api/auth/status'),
  login: (username, password) =>
    request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
```

- [ ] **Step 2: Write the login page**

Create `client/src/pages/Login.jsx`:

```jsx
import { useState } from 'react';
import { api } from '../api';

export default function Login({ onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username, password);
      onSignedIn(result.username);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h2>TradePilot</h2>
        <p className="muted">This dashboard can place live orders. Sign in to continue.</p>

        <label className="field">
          username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label className="field">
          password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Gate the app**

In `client/src/App.jsx`, add to the imports:

```jsx
import Login from './pages/Login';
```

Add auth state inside `App`, immediately after the `view` state:

```jsx
  const [auth, setAuth] = useState({ checked: false, username: null });
```

Add an effect that runs once, before the existing data effect:

```jsx
  useEffect(() => {
    api.authStatus()
      .then((s) => setAuth({ checked: true, username: s.authenticated ? s.username : null }))
      .catch(() => setAuth({ checked: true, username: null }));
  }, []);
```

Add the `api` import at the top if it is not already there:

```jsx
import { api } from './api';
```

Then, immediately before the component's `return`, add the two gates:

```jsx
  if (!auth.checked) return <div className="login-shell"><p className="muted">Loading…</p></div>;
  if (!auth.username) return <Login onSignedIn={(username) => setAuth({ checked: true, username })} />;
```

Finally, put a sign-out control in the topbar. Replace:

```jsx
          <div className="status-pill">System online</div>
```

with:

```jsx
          <div className="topbar-right">
            <span className="status-pill">System online</span>
            <button
              className="link"
              onClick={() => api.logout().then(() => setAuth({ checked: true, username: null }))}
            >
              sign out ({auth.username})
            </button>
          </div>
```

- [ ] **Step 4: Add the styles**

Append to `client/src/styles.css`:

```css
.login-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b1220;
}

.login-card {
  background: #121a26;
  border: 1px solid #2d3748;
  border-radius: 14px;
  padding: 28px 26px;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-card h2 { margin: 0; color: #e6edf7; }
.login-card .field input { width: 100%; box-sizing: border-box; }

.login-card button {
  background: #1d4ed8;
  color: #e6edf7;
  border: none;
  border-radius: 8px;
  padding: 10px;
  font-size: 14px;
  cursor: pointer;
  margin-top: 6px;
}

.login-card button:disabled { opacity: 0.5; cursor: not-allowed; }

.topbar-right { display: flex; align-items: center; gap: 12px; }
```

- [ ] **Step 5: Build and check in the browser**

```bash
npm run build
npm run dev
```

Open `http://localhost:5173`. Confirm the login screen appears, that a wrong password shows "invalid username or password", that the right one reveals the dashboard, and that "sign out" returns you to the login screen.

- [ ] **Step 6: Commit**

```bash
git add client/src
git commit -m "feat(ui): gate the dashboard behind a login"
```

---

### Task 5: Telegram alerts

**Files:**
- Create: `server/src/alerts/notifier.js`, `server/src/alerts/events.js`
- Modify: `server/src/risk/state.js`, `server/src/execution/manager.js`, `server/.env`, `server/.env.example`
- Test: `server/test/alerts.test.js`

**Interfaces:**
- Consumes: `fetch` (global in Node 22).
- Produces:
  - `notifier.js`: `sendAlert(text, { fetchImpl }) -> Promise<{ sent, reason }>` — **never throws**
  - `events.js`: `alertKillSwitch({ mode, reason })`, `alertOrderFilled({ symbol, side, lot, ticket, mode })`, `alertOrderFailed({ symbol, reason, mode })`, `alertDailyLossCap({ mode, realized, cap })`

Every alert path is wrapped so a failed send is logged and swallowed. An alerting outage must never stop or corrupt trading — the notification is the least important thing in the process.

- [ ] **Step 1: Write the failing test**

Create `server/test/alerts.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { sendAlert } = require('../src/alerts/notifier');

function stubFetch(impl) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return impl ? impl(url, options) : { ok: true, status: 200, text: async () => 'ok' };
  };
  fn.calls = calls;
  return fn;
}

test('an alert posts to the Telegram bot API', async () => {
  const fetchImpl = stubFetch();
  const result = await sendAlert('kill switch tripped', {
    fetchImpl, botToken: 'BOT123', chatId: '456'
  });

  assert.equal(result.sent, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /api\.telegram\.org\/botBOT123\/sendMessage/);

  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.chat_id, '456');
  assert.match(body.text, /kill switch tripped/);
});

test('an unconfigured notifier is a no-op, not an error', async () => {
  const fetchImpl = stubFetch();
  const result = await sendAlert('anything', { fetchImpl, botToken: '', chatId: '' });

  assert.equal(result.sent, false);
  assert.match(result.reason, /not configured/i);
  assert.equal(fetchImpl.calls.length, 0, 'nothing is sent when there is nowhere to send it');
});

test('a network failure is swallowed, never thrown', async () => {
  const fetchImpl = stubFetch(() => { throw new Error('ENOTFOUND api.telegram.org'); });

  const result = await sendAlert('important', {
    fetchImpl, botToken: 'B', chatId: 'C', logger: { error: () => {} }
  });

  assert.equal(result.sent, false);
  assert.match(result.reason, /ENOTFOUND/);
});

test('a non-2xx response is reported but does not throw', async () => {
  const fetchImpl = stubFetch(async () => ({ ok: false, status: 429, text: async () => 'Too Many Requests' }));

  const result = await sendAlert('rate limited', {
    fetchImpl, botToken: 'B', chatId: 'C', logger: { error: () => {} }
  });

  assert.equal(result.sent, false);
  assert.match(result.reason, /429/);
});

test('event helpers produce messages naming what happened', async () => {
  const events = require('../src/alerts/events');
  const sent = [];
  const send = async (text) => { sent.push(text); return { sent: true }; };

  await events.alertKillSwitch({ mode: 'demo', reason: '3 consecutive losses', send });
  await events.alertOrderFilled({ symbol: 'EURUSD', side: 'BUY', lot: 0.1, ticket: 42, mode: 'demo', send });
  await events.alertOrderFailed({ symbol: 'XAUUSD', reason: 'Invalid stops', mode: 'demo', send });
  await events.alertDailyLossCap({ mode: 'live', realized: -55, cap: 50, send });

  assert.match(sent[0], /KILL SWITCH/i);
  assert.match(sent[0], /3 consecutive losses/);
  assert.match(sent[1], /EURUSD/);
  assert.match(sent[1], /BUY/);
  assert.match(sent[1], /0\.1/);
  assert.match(sent[2], /Invalid stops/);
  assert.match(sent[3], /loss cap/i);
  assert.match(sent[3], /-55/);
});

test('an alert failure inside an event helper does not propagate', async () => {
  const events = require('../src/alerts/events');
  const send = async () => { throw new Error('telegram exploded'); };

  // Must resolve, not reject: an alerting outage cannot be allowed to break
  // the trading path that called it.
  await events.alertKillSwitch({ mode: 'demo', reason: 'x', send, logger: { error: () => {} } });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test test/alerts.test.js
```

Expected: FAIL — `Cannot find module '../src/alerts/notifier'`.

- [ ] **Step 3: Implement the notifier**

Create `server/src/alerts/notifier.js`:

```js
/**
 * Telegram alerts.
 *
 * sendAlert never throws. An alerting outage is the least important failure
 * in this process, and it must never stop or corrupt trading.
 */

async function sendAlert(text, {
  fetchImpl = fetch,
  botToken = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  logger = console
} = {}) {
  if (!botToken || !chatId) {
    return { sent: false, reason: 'alerts are not configured' };
  }

  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const detail = await response.text();
      const reason = `telegram returned ${response.status}: ${detail}`;
      logger.error(reason);
      return { sent: false, reason };
    }

    return { sent: true };
  } catch (error) {
    logger.error(`alert failed: ${error.message}`);
    return { sent: false, reason: error.message };
  }
}

module.exports = { sendAlert };
```

- [ ] **Step 4: Implement the events**

Create `server/src/alerts/events.js`:

```js
const { sendAlert } = require('./notifier');

/**
 * The events worth waking someone for.
 *
 * Each helper swallows its own failures. The trading paths that call these
 * must not care whether a message was delivered.
 */

async function safely(send, text, logger) {
  try {
    await send(text);
  } catch (error) {
    logger.error(`alert failed: ${error.message}`);
  }
}

async function alertKillSwitch({ mode, reason, send = sendAlert, logger = console }) {
  await safely(send, `KILL SWITCH tripped on ${mode}: ${reason}. Trading is halted until you reset it.`, logger);
}

async function alertOrderFilled({ symbol, side, lot, ticket, mode, send = sendAlert, logger = console }) {
  await safely(send, `Filled ${side} ${lot} ${symbol} on ${mode} (ticket ${ticket}).`, logger);
}

async function alertOrderFailed({ symbol, reason, mode, send = sendAlert, logger = console }) {
  await safely(send, `Order REJECTED for ${symbol} on ${mode}: ${reason}`, logger);
}

async function alertDailyLossCap({ mode, realized, cap, send = sendAlert, logger = console }) {
  await safely(send, `Daily loss cap reached on ${mode}: realized ${realized} against a cap of ${cap}. No further trades today.`, logger);
}

module.exports = { alertKillSwitch, alertOrderFilled, alertOrderFailed, alertDailyLossCap };
```

- [ ] **Step 5: Wire the alerts into the paths that matter**

In `server/src/risk/state.js`, add to the imports at the top:

```js
const { alertKillSwitch } = require('../alerts/events');
```

Then in `recordTradeResult`, immediately before `return getState(mode, day);`, add:

```js
  // Fire and forget: the caller is in the trading path and must not wait on,
  // or be broken by, a notification.
  if (shouldTrip && state.kill_switch !== 1) {
    const reason = `${consecutive} consecutive losses reached the limit of ${settings.consecutiveLossLimit}`;
    alertKillSwitch({ mode, reason }).catch(() => {});
  }
```

And in `tripKillSwitch`, immediately before `return getState(mode, day);`, add:

```js
  alertKillSwitch({ mode, reason }).catch(() => {});
```

In `server/src/execution/manager.js`, add to the imports:

```js
const { alertOrderFilled, alertOrderFailed } = require('../alerts/events');
```

In `executeSignal`, immediately before `return { status: 'filled', tradeId, ticket: result.ticket };`, add:

```js
  alertOrderFilled({
    symbol: symbol.broker_symbol, side: signal.side, lot: decision.lot,
    ticket: result.ticket, mode
  }).catch(() => {});
```

And immediately before `return { status: 'failed', tradeId, reason: result.comment || 'the broker rejected the order' };`, add:

```js
  alertOrderFailed({
    symbol: symbol.broker_symbol,
    reason: result.comment || 'rejected',
    mode
  }).catch(() => {});
```

- [ ] **Step 6: Run the full suite**

```bash
npm --prefix server test
```

Expected: PASS, all tests. `TELEGRAM_BOT_TOKEN` is unset in tests, so every alert is a silent no-op and nothing reaches the network.

- [ ] **Step 7: Commit**

```bash
git add server/src/alerts server/src/risk/state.js server/src/execution/manager.js server/test/alerts.test.js
git commit -m "feat(alerts): notify on kill switch, fills and rejections"
```

---

### Task 6: Advisory LLM commentary

**Files:**
- Create: `server/src/ai/commentary.js`, `server/src/routes/ai.js`
- Modify: `server/src/index.js`, `client/src/api.js`
- Test: `server/test/commentary.test.js`

**Interfaces:**
- Consumes: `fetch`, `query`.
- Produces:
  - `commentary.js`: `marketCommentary({ symbolId, timeframe, apiKey, client }) -> Promise<{ available, text, snapshot, reason }>` — `client` is injectable so no test touches the network
  - `ai.js`: `GET /api/commentary?symbolId=&timeframe=`

The model is given indicator values and recent news headlines and asked for a short plain-English read. **It is never called before an order, and its output is never parsed into a decision.** An LLM in the signal path makes the strategy non-deterministic and therefore unbacktestable, which defeats the point of the system. This is a reading aid.

- [ ] **Step 1: Install the official SDK**

```bash
npm --prefix server install @anthropic-ai/sdk
```

The official SDK rather than raw `fetch`: request shapes and model identifiers change, and a hand-rolled HTTP call silently rots. This is the only dependency phase 5 adds, and it sits nowhere near the authentication or execution paths.

- [ ] **Step 2: Write the failing test**

Create `server/test/commentary.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_commentary_test';

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, currency_profit, currency_margin, synced_at)
     VALUES ('EURUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, 1, 'USD', 'EUR', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['EURUSD']);

  const rows = [];
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < 200; i += 1) {
    const close = 1.1 + i * 0.0001;
    rows.push([
      sym.id, 'H1',
      new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      close, close + 0.0005, close - 0.0005, close, 100, 0, 8
    ]);
  }
  await query(
    `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close,
       tick_volume, real_volume, spread) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    rows.flat()
  );

  return sym.id;
}

// A stand-in for the Anthropic client, so no test reaches the network.
function stubClient(impl) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        if (impl) return impl(params);
        return { content: [{ type: 'text', text: 'Price is grinding higher with no news risk nearby.' }] };
      }
    }
  };
}

test('commentary is unavailable without an API key', async (t) => {
  const symbolId = await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');

  const result = await marketCommentary({ symbolId, timeframe: 'H1', apiKey: '' });

  assert.equal(result.available, false);
  assert.match(result.reason, /not configured/i);
});

test('commentary summarises indicators and returns the model text', async (t) => {
  const symbolId = await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');

  const client = stubClient();
  const result = await marketCommentary({ symbolId, timeframe: 'H1', apiKey: 'sk-test', client });

  assert.equal(result.available, true);
  assert.match(result.text, /grinding higher/);

  assert.equal(client.calls.length, 1);
  const params = client.calls[0];
  assert.equal(params.model, 'claude-opus-5');

  // The prompt must carry computed indicator values, not raw candle rows.
  const prompt = JSON.stringify(params.messages);
  assert.match(prompt, /EURUSD/);
  assert.match(prompt, /rsi14/);
  assert.ok(!prompt.includes('open_time'), 'raw candle rows must not be pasted into the prompt');
});

test('an API failure degrades rather than throwing', async (t) => {
  const symbolId = await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');

  const client = stubClient(() => { throw new Error('overloaded_error'); });
  const result = await marketCommentary({
    symbolId, timeframe: 'H1', apiKey: 'sk-test', client, logger: { error: () => {} }
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /overloaded/);
});

test('a symbol with no candles reports why', async (t) => {
  await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');
  const { query } = require('../src/db/pool');

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, synced_at)
     VALUES ('GBPUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, UTC_TIMESTAMP())`
  );
  const [empty] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['GBPUSD']);

  const client = stubClient();
  const result = await marketCommentary({ symbolId: empty.id, timeframe: 'H1', apiKey: 'sk-test', client });

  assert.equal(result.available, false);
  assert.match(result.reason, /no candles/i);
  assert.equal(client.calls.length, 0, 'no point paying for a call with nothing to describe');
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && node --test test/commentary.test.js
```

Expected: FAIL — `Cannot find module '../src/ai/commentary'`.

- [ ] **Step 4: Implement commentary**

Create `server/src/ai/commentary.js`:

```js
const Anthropic = require('@anthropic-ai/sdk');

const { query } = require('../db/pool');
const { getCandles } = require('../market/candles');
const { ema, rsi, atr, donchian } = require('../indicators');

/**
 * Plain-English commentary on the current market state.
 *
 * STRICTLY ADVISORY. This is never called before an order, and its output is
 * never parsed into a decision. An LLM in the signal path makes the strategy
 * non-deterministic and therefore unbacktestable, which defeats the purpose of
 * the whole system. This is a reading aid for the operator.
 */

const MODEL = 'claude-opus-5';

async function marketCommentary({
  symbolId,
  timeframe = 'H1',
  apiKey = process.env.ANTHROPIC_API_KEY,
  client = null,
  logger = console
} = {}) {
  if (!apiKey && !client) {
    return { available: false, reason: 'commentary is not configured (set ANTHROPIC_API_KEY)' };
  }

  const symbolRows = await query('SELECT * FROM symbols WHERE id = ?', [symbolId]);
  if (symbolRows.length === 0) {
    return { available: false, reason: `unknown symbolId ${symbolId}` };
  }
  const symbol = symbolRows[0];

  const candles = await getCandles({ symbolId, timeframe, limit: 300 });
  if (candles.length < 120) {
    return { available: false, reason: `no candles stored for ${symbol.broker_symbol} ${timeframe}` };
  }

  const closes = candles.map((c) => c.close);
  const last = candles.length - 1;
  const channel = donchian(candles, 20);

  // Indicator values, not raw candles: a few numbers describe the state far
  // better than 300 rows of OHLC, at a fraction of the tokens.
  const snapshot = {
    symbol: symbol.broker_symbol,
    timeframe,
    lastClose: closes[last],
    ema20: ema(closes, 20)[last],
    ema50: ema(closes, 50)[last],
    ema100: ema(closes, 100)[last],
    rsi14: rsi(closes, 14)[last],
    atr14: atr(candles, 14)[last],
    donchianHigh20: channel.upper[last],
    donchianLow20: channel.lower[last],
    barsCovered: candles.length
  };

  const news = await query(
    `SELECT event_time, currency, title, impact
       FROM news_events
      WHERE impact IN ('HIGH','MEDIUM')
        AND event_time BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 HOUR)
      ORDER BY event_time LIMIT 5`
  );

  const prompt =
    `You are helping a retail trader read the current market state. Be concise and neutral.\n\n` +
    `Indicator snapshot (all prices in the instrument's own units):\n` +
    `${JSON.stringify(snapshot, null, 2)}\n\n` +
    `Upcoming economic events in the next 12 hours:\n` +
    `${news.length ? JSON.stringify(news, null, 2) : 'none recorded'}\n\n` +
    `In at most 120 words: describe the trend, where price sits relative to the ` +
    `20-bar channel, whether volatility is high or low for this instrument, and ` +
    `any event risk worth noting. Do NOT give a buy or sell recommendation and ` +
    `do NOT suggest entry, stop or target levels - those are decided by a ` +
    `separate rules engine.`;

  const anthropic = client || new Anthropic({ apiKey });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      // Thinking is on by default on this model and its tokens count against
      // max_tokens, so leave headroom well above the 120-word answer.
      max_tokens: 4000,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }]
    });

    if (response.stop_reason === 'refusal') {
      return { available: false, reason: 'the model declined to answer' };
    }

    const text = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return { available: true, text, snapshot };
  } catch (error) {
    logger.error(`commentary failed: ${error.message}`);
    return { available: false, reason: error.message };
  }
}

module.exports = { marketCommentary };
```

- [ ] **Step 5: Add the route**

Create `server/src/routes/ai.js`:

```js
const express = require('express');

const { marketCommentary } = require('../ai/commentary');

function createAiRouter() {
  const router = express.Router();

  router.get('/commentary', async (req, res, next) => {
    try {
      const symbolId = Number(req.query.symbolId);
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });

      res.json(await marketCommentary({
        symbolId,
        timeframe: String(req.query.timeframe || 'H1')
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAiRouter };
```

In `server/src/index.js`, below the execution router line, add:

```js
const { createAiRouter } = require('./routes/ai');

app.use('/api', createAiRouter());
```

In `client/src/api.js`, add inside the exported `api` object:

```js
  commentary: (symbolId, timeframe = 'H1') =>
    request(`/api/commentary?symbolId=${symbolId}&timeframe=${timeframe}`),
```

- [ ] **Step 6: Run the tests**

```bash
cd server && node --test test/commentary.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/ai server/src/routes/ai.js server/src/index.js server/package.json server/package-lock.json client/src/api.js server/test/commentary.test.js
git commit -m "feat(ai): add strictly advisory market commentary"
```

---

### Task 7: Deployment guide

**Files:**
- Create: `docs/DEPLOYMENT.md`
- Modify: `README.md` (create it if absent)

- [ ] **Step 1: Write the deployment guide**

Create `docs/DEPLOYMENT.md`:

```markdown
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

Set the connection timezone to UTC. The pool already sets `timezone: 'Z'`; if
the host's MySQL runs on local time, candle timestamps stay correct because
every write goes through `UTC_TIMESTAMP()` or a UTC-formatted string.

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
message - the bridge outage path is already handled.

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

Position sizing is the thing to check before step 1, not after. On a small
account the broker's minimum lot can exceed the risk cap, in which case the
engine refuses every trade - correctly. Use **Risk → assess** to dry-run a
representative signal at your intended balance and confirm it is tradeable at
all before funding anything.
```

- [ ] **Step 2: Write the README**

Create `README.md`:

```markdown
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

And two rules that are not configurable at all: **every order carries a stop
loss**, and **a position smaller than the broker minimum is refused rather
than rounded up**.

## Documentation

- `docs/superpowers/specs/` - the design and why each decision was made
- `docs/superpowers/plans/` - the implementation plans, phase by phase
- `docs/DEPLOYMENT.md` - Hostinger deployment and the pre-flight checklist
- `bridge/README.md` - the MT5 bridge, its guards, and broker-time handling

## Testing

    npm --prefix server test    # needs the Docker MySQL running
    npm run build
```

- [ ] **Step 3: Verify the checklist against reality**

Confirm each claimed default is true:

```bash
grep -E "^(AUTH_ENABLED|MT5_ALLOW_TRADING|MT5_ALLOW_LIVE|EXECUTION_ENABLED|SCHEDULER_ENABLED|COOKIE_SECURE)" server/.env.example
```

Expected: `AUTH_ENABLED=true`, everything else `false`.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOYMENT.md README.md
git commit -m "docs: add the deployment guide and README"
```

---

## Phase 5 Definition of Done

- [ ] `npm --prefix server test` passes.
- [ ] `npm run build` succeeds.
- [ ] `curl http://localhost:3001/api/symbols` returns 401 without a session.
- [ ] `/api/health` stays reachable without a session.
- [ ] Logging in sets an httpOnly, SameSite=Lax cookie and opens the API.
- [ ] Logout invalidates the cookie immediately.
- [ ] A wrong password and an unknown username return identical responses.
- [ ] No dependency was added to the auth or alerting path; only the official Anthropic SDK, for commentary.
- [ ] Alerts are a no-op when unconfigured and never throw.
- [ ] Commentary is unavailable without an API key and is never consulted before an order.
- [ ] `AUTH_ENABLED=true` in `.env.example`; every execution flag is false.

## What Phase 5 deliberately does not do

No multi-user support, no roles, no password reset flow, no rate limiting on
login, and no HTTPS termination - that belongs to the host. Single operator,
one account, created from the command line.

Rate limiting is the notable gap: with scrypt at N=2^15 each attempt costs
real CPU, which slows an online guessing attack considerably, but it is not a
substitute for a lockout. Worth adding before this is exposed to the open
internet rather than reached over a tunnel.
