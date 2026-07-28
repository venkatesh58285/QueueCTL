'use strict';

const { Command } = require('commander');
const { registerEnqueueCommand } = require('./commands/enqueue');
const { registerWorkerCommand } = require('./commands/worker');
const { registerStatusCommand } = require('./commands/status');
const { registerListCommand } = require('./commands/list');
const { registerDLQCommand } = require('./commands/dlq');
const { registerConfigCommand } = require('./commands/config');

/**
 * Creates the main CLI program with all commands registered.
 *
 * Design: each command is in its own file, registered via a function.
 * This keeps the program file lean and each command self-contained.
 */
function createProgram() {
  const program = new Command();

  program
    .name('queuectl')
    .description('A persistent background job queue')
    .version('1.0.0');

  registerEnqueueCommand(program);
  registerWorkerCommand(program);
  registerStatusCommand(program);
  registerListCommand(program);
  registerDLQCommand(program);
  registerConfigCommand(program);

  return program;
}

module.exports = { createProgram };
