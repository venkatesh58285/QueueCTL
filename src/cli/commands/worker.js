'use strict';

const { spawn } = require('child_process');
const path = require('path');

/**
 * `queuectl worker start --count N` — Start N worker processes
 * `queuectl worker stop` — Signal all workers to stop gracefully
 *
 * Worker start spawns detached child processes running the worker loop.
 * Worker stop uses the SQLite workers table as a signaling mechanism.
 *
 * Why SQLite for signaling (not PID files or sockets)?
 * - Works across terminals without shared filesystem state files
 * - Atomic state transitions (no race conditions)
 * - Workers already poll the database, so checking state is free
 * - No cleanup needed if a worker crashes (heartbeat handles it)
 * - Simplest approach that satisfies all requirements
 */
function registerWorkerCommand(program) {
  const worker = program
    .command('worker')
    .description('Manage worker processes');

  worker
    .command('start')
    .description('Start worker processes')
    .option('--count <n>', 'Number of workers to start', '1')
    .action((options) => {
      const count = parseInt(options.count, 10);

      if (isNaN(count) || count < 1) {
        console.error('Error: --count must be a positive integer');
        process.exitCode = 1;
        return;
      }

      const workerScript = path.join(__dirname, '..', '..', 'workers', 'worker-process.js');

      console.log(`Starting ${count} worker(s)...`);

      for (let i = 0; i < count; i++) {
        const child = spawn(process.execPath, [workerScript], {
          detached: true,
          stdio: 'ignore'
        });

        child.unref();
        console.log(`  Worker spawned (PID: ${child.pid})`);
      }

      console.log(`\n${count} worker(s) started. Use "queuectl status" to monitor.`);
    });

  worker
    .command('stop')
    .description('Stop all running workers gracefully')
    .action(() => {
      const { createContainer } = require('../../container');
      const container = createContainer();

      try {
        const running = container.workerRepository.findRunning();

        if (running.length === 0) {
          console.log('No running workers found.');
          return;
        }

        container.workerRepository.requestStopAll();
        console.log(`Stop signal sent to ${running.length} worker(s).`);
        console.log('Workers will finish current jobs and exit.');
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      } finally {
        container.close();
      }
    });
}

module.exports = { registerWorkerCommand };
