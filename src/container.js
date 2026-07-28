'use strict';

/**
 * Dependency Injection Container
 *
 * This module wires together all components with their dependencies.
 * Instead of scattered `require()` calls, everything is assembled here.
 *
 * Benefits:
 * - Single place to see how the system fits together
 * - Easy to swap implementations for testing
 * - No circular dependencies
 * - Clear initialization order
 */

const { createConnection } = require('./database/connection');
const { initializeSchema } = require('./database/schema');
const { createJobRepository } = require('./repositories/job-repository');
const { createWorkerRepository } = require('./repositories/worker-repository');
const { createConfigRepository } = require('./repositories/config-repository');
const { createQueueService } = require('./services/queue-service');
const { createConfigService } = require('./services/config-service');
const { createLogger } = require('./utils/logger');

/**
 * Creates and returns the full application container.
 *
 * @param {object} [options]
 * @param {string} [options.dbPath] - Override database path (useful for tests)
 * @param {boolean} [options.silent] - Suppress log output
 * @returns {object} Container with all services and repositories
 */
function createContainer(options = {}) {
  const { dbPath, silent = false } = options;

  // Database
  const db = createConnection(dbPath);
  initializeSchema(db);

  // Repositories
  const jobRepository = createJobRepository(db);
  const workerRepository = createWorkerRepository(db);
  const configRepository = createConfigRepository(db);

  // Services
  const queueService = createQueueService({ jobRepository, configRepository });
  const configService = createConfigService({ configRepository });

  // Logger
  const logger = createLogger({ silent });

  return {
    db,
    jobRepository,
    workerRepository,
    configRepository,
    queueService,
    configService,
    logger,

    /**
     * Clean shutdown — close the database connection.
     */
    close() {
      db.close();
    }
  };
}

module.exports = { createContainer };
