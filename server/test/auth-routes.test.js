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
