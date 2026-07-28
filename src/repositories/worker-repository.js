'use strict';

/**
 * Worker Repository — tracks worker processes in the database.
 *
 * Why track workers in SQLite?
 * - Workers are separate OS processes, possibly from different terminals
 * - SQLite is the shared state accessible to all processes
 * - Enables: graceful shutdown signaling, crash detection, status reporting
 *
 * The 'state' column acts as a signaling mechanism:
 * - 'running': worker is active and processing jobs
 * - 'stopping': another process requested this worker to stop
 * - 'stopped': worker has acknowledged and exited
 */

/**
 * @param {import('better-sqlite3').Database} db
 */
function createWorkerRepository(db) {
  const statements = {
    register: db.prepare(`
      INSERT INTO workers (id, pid, state, last_heartbeat, started_at)
      VALUES (?, ?, 'running', datetime('now'), datetime('now'))
    `),

    updateHeartbeat: db.prepare(`
      UPDATE workers
      SET last_heartbeat = datetime('now')
      WHERE id = ?
    `),

    setState: db.prepare(`
      UPDATE workers
      SET state = ?
      WHERE id = ?
    `),

    setAllRunningToStopping: db.prepare(`
      UPDATE workers
      SET state = 'stopping'
      WHERE state = 'running'
    `),

    findRunning: db.prepare(`
      SELECT * FROM workers WHERE state = 'running'
    `),

    findById: db.prepare('SELECT * FROM workers WHERE id = ?'),

    findStale: db.prepare(`
      SELECT * FROM workers
      WHERE state = 'running'
        AND last_heartbeat < datetime('now', ?)
    `),

    remove: db.prepare('DELETE FROM workers WHERE id = ?'),

    removeStale: db.prepare(`
      DELETE FROM workers
      WHERE state = 'stopped'
        OR (state = 'running' AND last_heartbeat < datetime('now', ?))
    `)
  };

  return {
    register(id, pid) {
      return statements.register.run(id, pid);
    },

    updateHeartbeat(id) {
      return statements.updateHeartbeat.run(id);
    },

    setState(id, state) {
      return statements.setState.run(state, id);
    },

    /**
     * Signal ALL running workers to stop.
     * Used by `queuectl worker stop`.
     */
    requestStopAll() {
      return statements.setAllRunningToStopping.run();
    },

    findRunning() {
      return statements.findRunning.all();
    },

    findById(id) {
      return statements.findById.get(id);
    },

    /**
     * Find workers whose heartbeat is older than the threshold.
     * These are likely crashed.
     */
    findStale(timeoutModifier) {
      return statements.findStale.all(timeoutModifier);
    },

    remove(id) {
      return statements.remove.run(id);
    },

    cleanupStale(timeoutModifier) {
      return statements.removeStale.run(timeoutModifier);
    }
  };
}

module.exports = { createWorkerRepository };
