/**
 * Scratch-database helper for integration tests.
 *
 * Cleanup is registered BEFORE anything that can throw. A require() that fails
 * after the admin socket is open leaves a live handle, and the node:test runner
 * then waits for it forever instead of reporting the failure.
 */
const mysql = require('mysql2/promise');

require('dotenv').config();

function adminConnection(options = {}) {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ...options
  });
}

async function freshDatabase(t, name) {
  const admin = await adminConnection();

  // Every step swallows its own error. An exception thrown inside an after
  // hook leaves the admin socket open, and the runner then hangs rather than
  // reporting the real failure.
  t.after(async () => {
    try {
      await require('../../src/db/pool').closePool();
    } catch {
      // The pool module may never have loaded; nothing to close.
    }
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    } catch {
      // Best effort: the database may never have been created.
    }
    try {
      await admin.end();
    } catch {
      await admin.destroy();
    }
  });

  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  process.env.DB_NAME = name;

  return admin;
}

module.exports = { adminConnection, freshDatabase };
