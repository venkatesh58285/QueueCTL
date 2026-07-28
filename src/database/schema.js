'use strict';

/**
 * Database schema definition and migration.
 *
 * Schema design rationale:
 *
 * JOBS TABLE:
 * - id: UUID primary key (not auto-increment) so workers can generate IDs without coordination
 * - command: the shell command to execute
 * - state: enum-like text field with CHECK constraint for safety
 * - attempts: tracks how many times execution was tried
 * - max_retries: per-job override (copied from config at enqueue time)
 * - created_at/updated_at: ISO timestamps for observability
 * - started_at: when a worker last claimed this job (used for lease timeout)
 * - worker_id: which worker currently owns this job (null if unclaimed)
 *
 * WORKERS TABLE:
 * - Tracks active worker processes for shutdown signaling and crash detection
 * - last_heartbeat: workers update this periodically; stale = crashed
 *
 * CONFIG TABLE:
 * - Simple key-value store for persistent configuration
 * - Seeded with defaults on first run
 *
 * INDEXES:
 * - idx_jobs_state: speeds up "find pending jobs" queries (most common operation)
 * - idx_jobs_state_started: speeds up crash recovery scans
 * - idx_workers_heartbeat: speeds up stale worker detection
 */

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    worker_id TEXT
  );

  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'running'
      CHECK (state IN ('running', 'stopping', 'stopped')),
    last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
  CREATE INDEX IF NOT EXISTS idx_jobs_state_started ON jobs(state, started_at);
  CREATE INDEX IF NOT EXISTS idx_workers_heartbeat ON workers(last_heartbeat);
`;

/**
 * Default configuration values.
 * These are inserted only if no config exists yet.
 */
const DEFAULT_CONFIG = {
  'max-retries': '3',
  'backoff-base': '2'
};

/**
 * Initializes the database schema and seeds default config.
 * Safe to call multiple times (uses IF NOT EXISTS).
 *
 * @param {import('better-sqlite3').Database} db
 */
function initializeSchema(db) {
  db.exec(SCHEMA_SQL);

  // Seed default config values (only if not already set)
  const insertConfig = db.prepare(
    'INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)'
  );

  const seedDefaults = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      insertConfig.run(key, value);
    }
  });

  seedDefaults();
}

module.exports = { initializeSchema, DEFAULT_CONFIG };
