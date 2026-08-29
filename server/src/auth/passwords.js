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
