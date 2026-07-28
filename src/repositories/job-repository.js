'use strict';

/**
 * Job Repository — all database operations for jobs.
 *
 * This layer owns the SQL. Business logic (retry decisions, state transitions)
 * lives in the service layer. This separation means:
 * - Easy to test services with a mock repository
 * - Easy to explain: "repository = data access, service = business rules"
 * - SQL is centralized, not scattered across the codebase
 */

/**
 * @param {import('better-sqlite3').Database} db
 */
function createJobRepository(db) {
  // Prepared statements — created once, reused for performance
  const statements = {
    insert: db.prepare(`
      INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at)
      VALUES (?, ?, 'pending', 0, ?, datetime('now'), datetime('now'))
    `),

    findById: db.prepare('SELECT * FROM jobs WHERE id = ?'),

    findByState: db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC'),

    /**
     * ATOMIC JOB CLAIMING — the most critical query in the system.
     *
     * This uses a single UPDATE with a subquery to atomically:
     * 1. Find the oldest pending job
     * 2. Assign it to the requesting worker
     * 3. Transition state to 'processing'
     *
     * Because SQLite serializes writes, only ONE worker can win this race.
     * No external locking needed — the database IS the lock.
     *
     * LIMIT 1 ensures exactly one job is claimed per call.
     */
    claimJob: db.prepare(`
      UPDATE jobs
      SET state = 'processing',
          worker_id = ?,
          started_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = (
        SELECT id FROM jobs
        WHERE state = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      )
    `),

    markCompleted: db.prepare(`
      UPDATE jobs
      SET state = 'completed',
          worker_id = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `),

    markFailed: db.prepare(`
      UPDATE jobs
      SET state = 'failed',
          attempts = attempts + 1,
          worker_id = NULL,
          started_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `),

    markDead: db.prepare(`
      UPDATE jobs
      SET state = 'dead',
          worker_id = NULL,
          started_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `),

    requeueForRetry: db.prepare(`
      UPDATE jobs
      SET state = 'pending',
          worker_id = NULL,
          started_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `),

    incrementAttempts: db.prepare(`
      UPDATE jobs
      SET attempts = attempts + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `),

    /**
     * Find jobs that are stuck in 'processing' state.
     * A job is "stuck" if its started_at is older than the timeout threshold.
     * This powers crash recovery.
     */
    findStaleProcessing: db.prepare(`
      SELECT * FROM jobs
      WHERE state = 'processing'
        AND started_at < datetime('now', ?)
    `),

    countByState: db.prepare(`
      SELECT state, COUNT(*) as count FROM jobs GROUP BY state
    `),

    getAll: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC')
  };

  return {
    /**
     * Insert a new job into the queue.
     * @param {string} id - UUID
     * @param {string} command - Shell command to execute
     * @param {number} maxRetries - Maximum retry attempts
     * @returns {import('better-sqlite3').RunResult}
     */
    create(id, command, maxRetries) {
      return statements.insert.run(id, command, maxRetries);
    },

    findById(id) {
      return statements.findById.get(id);
    },

    findByState(state) {
      return statements.findByState.all(state);
    },

    /**
     * Atomically claim the next pending job for a worker.
     * Returns the claimed job, or null if no jobs available.
     *
     * @param {string} workerId - The worker claiming the job
     * @returns {object|null} The claimed job row, or null
     */
    claimNext(workerId) {
      const result = statements.claimJob.run(workerId);
      if (result.changes === 0) {
        return null;
      }
      // Fetch the job we just claimed
      const job = db.prepare(
        "SELECT * FROM jobs WHERE worker_id = ? AND state = 'processing' ORDER BY updated_at DESC LIMIT 1"
      ).get(workerId);
      return job;
    },

    markCompleted(id) {
      return statements.markCompleted.run(id);
    },

    markFailed(id) {
      return statements.markFailed.run(id);
    },

    markDead(id) {
      return statements.markDead.run(id);
    },

    requeueForRetry(id) {
      return statements.requeueForRetry.run(id);
    },

    incrementAttempts(id) {
      return statements.incrementAttempts.run(id);
    },

    /**
     * Find processing jobs whose lease has expired.
     * @param {string} timeoutModifier - SQLite time modifier, e.g. '-30 seconds'
     */
    findStaleProcessing(timeoutModifier) {
      return statements.findStaleProcessing.all(timeoutModifier);
    },

    getStatusCounts() {
      return statements.countByState.all();
    },

    getAll() {
      return statements.getAll.all();
    }
  };
}

module.exports = { createJobRepository };
