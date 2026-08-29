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
