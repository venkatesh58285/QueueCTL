'use strict';

const { createContainer } = require('../../container');

/**
 * `queuectl config set <key> <value>`
 *
 * Persistently sets a configuration value.
 * Supported keys: max-retries, backoff-base
 */
function registerConfigCommand(program) {
  const config = program
    .command('config')
    .description('Manage queue configuration');

  config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Configuration key')
    .argument('<value>', 'Configuration value')
    .action((key, value) => {
      const container = createContainer();
      try {
        const result = container.configService.set(key, value);
        console.log(JSON.stringify({
          status: 'updated',
          config: result
        }, null, 2));
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      } finally {
        container.close();
      }
    });

  config
    .command('get')
    .description('Show all configuration')
    .action(() => {
      const container = createContainer();
      try {
        const all = container.configService.getAll();
        console.log(JSON.stringify(all, null, 2));
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      } finally {
        container.close();
      }
    });
}

module.exports = { registerConfigCommand };
