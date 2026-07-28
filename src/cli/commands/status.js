'use strict';

const { createContainer } = require('../../container');

/**
 * `queuectl status`
 *
 * Shows a summary of job counts by state and active workers.
 */
function registerStatusCommand(program) {
  program
    .command('status')
    .description('Show queue status summary')
    .action(() => {
      const container = createContainer();
      try {
        const jobStatus = container.queueService.getStatus();
        const workers = container.workerRepository.findRunning();

        console.log(JSON.stringify({
          jobs: jobStatus,
          workers: {
            active: workers.length,
            list: workers.map(w => ({
              id: w.id,
              pid: w.pid,
              last_heartbeat: w.last_heartbeat
            }))
          }
        }, null, 2));
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      } finally {
        container.close();
      }
    });
}

module.exports = { registerStatusCommand };
