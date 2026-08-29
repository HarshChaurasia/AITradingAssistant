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
