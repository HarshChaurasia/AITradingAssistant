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
