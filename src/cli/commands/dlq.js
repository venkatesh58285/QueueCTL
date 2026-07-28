'use strict';

const { createContainer } = require('../../container');

/**
 * `queuectl dlq list` — List all dead-lettered jobs
 * `queuectl dlq retry <jobId>` — Retry a specific dead-lettered job
 */
function registerDLQCommand(program) {
  const dlq = program
    .command('dlq')
    .description('Dead Letter Queue management');

  dlq
    .command('list')
    .description('List all dead-lettered jobs')
    .action(() => {
      const container = createContainer();
      try {
        const jobs = container.queueService.listDLQ();
        if (jobs.length === 0) {
          console.log('Dead Letter Queue is empty.');
          return;
        }
        console.log(JSON.stringify(jobs, null, 2));
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      } finally {
        container.close();
      }
    });

  dlq
    .command('retry')
    .description('Retry a dead-lettered job')
    .argument('<jobId>', 'Job ID to retry')
    .action((jobId) => {
      const container = createContainer();
      try {
        const job = container.queueService.retryFromDLQ(jobId);
        console.log(JSON.stringify({
          status: 'requeued',
          job: {
            id: job.id,
            command: job.command,
            state: job.state,
            attempts: job.attempts
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

module.exports = { registerDLQCommand };
