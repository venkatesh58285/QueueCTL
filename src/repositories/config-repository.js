'use strict';

/**
 * Config Repository — persistent key-value configuration store.
 *
 * Configuration is stored in SQLite so it survives restarts and
 * is accessible to all worker processes without file parsing.
 */

/**
 * @param {import('better-sqlite3').Database} db
 */
function createConfigRepository(db) {
  const statements = {
    get: db.prepare('SELECT value FROM config WHERE key = ?'),
    set: db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'),
    getAll: db.prepare('SELECT key, value FROM config')
  };

  return {
    get(key) {
      const row = statements.get.get(key);
      return row ? row.value : null;
    },

    set(key, value) {
      return statements.set.run(key, String(value));
    },

    getAll() {
      return statements.getAll.all();
    }
  };
}

module.exports = { createConfigRepository };
