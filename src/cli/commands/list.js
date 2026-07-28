'use strict';

const { createContainer } = require('../../container');

/**
 * `queuectl list --state <state> [--json]`
 *
 * Lists jobs filtered by state. The --json flag outputs raw JSON
 * (useful for scripting). Without --json, outputs a formatted table.
 */
function registerListCommand(program) {
  program
    .command('list')
    .description('List jobs by state')
    .option('--state <state>', 'Filter by job state', 'pending')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const container = createContainer();
      try {
        const jobs = container.queueService.listByState(options.state);

        if (options.json) {
          console.log(JSON.stringify(jobs, null, 2));
        } else {
          if (jobs.length === 0) {
            console.log(`No jobs in state: ${options.state}`);
            return;
          }
          console.log(`Jobs in state "${options.state}" (${jobs.length}):\n`);
          for (const job of jobs) {
            console.log(`  ID:       ${job.id}`);
            console.log(`  Command:  ${job.command}`);
            console.log(`  Attempts: ${job.attempts}/${job.max_retries}`);
            console.log(`  Created:  ${job.created_at}`);
            console.log('');
          }
        }
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      } finally {
        container.close();
      }
    });
}

module.exports = { registerListCommand };
