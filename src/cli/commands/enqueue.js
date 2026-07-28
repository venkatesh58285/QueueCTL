'use strict';

const { createContainer } = require('../../container');

/**
 * `queuectl enqueue <command>`
 *
 * Adds a new job to the queue. The command argument is the shell command
 * that workers will execute.
 */
function registerEnqueueCommand(program) {
  program
    .command('enqueue')
    .description('Add a new job to the queue')
    .argument('<command>', 'Shell command to execute')
    .action((command) => {
      const container = createContainer();
      try {
        const job = container.queueService.enqueue(command);
        console.log(JSON.stringify({
          status: 'enqueued',
          job: {
            id: job.id,
            command: job.command,
            state: job.state,
            created_at: job.created_at
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

module.exports = { registerEnqueueCommand };
