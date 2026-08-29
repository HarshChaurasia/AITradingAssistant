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
