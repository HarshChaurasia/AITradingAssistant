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
