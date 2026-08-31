const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (pool) return pool;

  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) {
    throw new Error('Database is not configured: set DB_HOST, DB_USER and DB_NAME in server/.env');
  }

  pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT || 3306),
    user: DB_USER,
    password: DB_PASSWORD || '',
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    /**
     * Keep the pooled sockets alive, and recycle them before something else
     * kills them.
     *
     * MySQL runs in Docker here, so every connection crosses the WSL2 NAT -
     * which silently drops idle TCP after a few minutes. mysql2 has no
     * keepalive by default, so the pool went on handing out sockets that no
     * longer existed and opening replacements that hung. Measured symptom: a
     * 401 from /api/backtests took 33 SECONDS, because the auth middleware's
     * session lookup sat waiting on a connection that would never arrive,
     * while MySQL itself was idle with 11 of 151 connections in use.
     *
     * Three settings, each doing one job:
     *   keepalive     stops the NAT seeing the socket as idle at all
     *   idleTimeout   retires a connection after a minute, well inside the
     *                 window where it might be dropped underneath us
     *   connectTimeout  fails a genuinely unreachable database in ten
     *                 seconds instead of thirty, so an outage looks like an
     *                 error rather than like the app hanging
     */
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    idleTimeout: 60000,
    maxIdle: 4,
    connectTimeout: 10000,
    charset: 'utf8mb4',
    // Every timestamp in this system is UTC. See the spec, section 5.
    timezone: 'Z',
    // Return DECIMAL as a JS number rather than a string, so indicator maths
    // does not silently concatenate prices.
    decimalNumbers: true
  });

  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function withConnection(fn) {
  const conn = await getPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, withConnection, closePool };
