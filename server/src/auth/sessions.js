const crypto = require('node:crypto');
const { query } = require('../db/pool');

/**
 * Opaque random session tokens, stored only as a SHA-256 digest.
 *
 * A stolen database dump then contains no usable sessions. The token itself
 * is 32 random bytes, so it carries no structure to forge and needs no
 * signature scheme of its own.
 */

// A two-week demo outlasts a seven-day session, and being logged out mid-run
// is a poor way to discover that. Configurable, defaulting to 30 days.
const DEFAULT_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 24 * 30);

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
