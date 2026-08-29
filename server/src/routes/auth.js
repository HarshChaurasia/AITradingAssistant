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
