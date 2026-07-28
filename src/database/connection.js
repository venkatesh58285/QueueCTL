'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Default database path — stored in a .queuectl directory
 * relative to the project root. This keeps the DB file out of
 * source control while being easy to find.
 */
const DEFAULT_DB_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'queuectl.db');

/**
 * Creates and returns a configured SQLite database connection.
 *
 * Design decisions:
 * - WAL mode: allows concurrent reads while writing, critical for multi-worker access
 * - busy_timeout: prevents SQLITE_BUSY errors when multiple workers contend
 * - foreign_keys: enforces referential integrity
 *
 * The QUEUECTL_DB_PATH env var allows overriding the path (useful for tests
 * and when workers need to point at a specific database).
 *
 * @param {string} [dbPath] - Optional path to the database file
 * @returns {import('better-sqlite3').Database}
 */
function createConnection(dbPath = process.env.QUEUECTL_DB_PATH || DEFAULT_DB_PATH) {
  // Ensure the directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Enable Write-Ahead Logging for concurrent access
  db.pragma('journal_mode = WAL');

  // Wait up to 5 seconds if the database is locked
  db.pragma('busy_timeout = 5000');

  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON');

  return db;
}

module.exports = { createConnection, DEFAULT_DB_PATH };
