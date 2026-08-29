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
