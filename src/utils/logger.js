'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Structured Logger — outputs JSON log lines.
 *
 * Why structured logging?
 * - Machine-parseable: can be piped to jq, grep, or log aggregators
 * - Consistent format: every log line has timestamp, level, message, and context
 * - Easy to explain in an interview: "structured logs let you filter and search"
 *
 * Logs go to both console (stderr) and a log file.
 * stderr is used so stdout remains clean for CLI output.
 */

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'queuectl.log');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Create a logger instance with an optional prefix (e.g., worker ID).
 *
 * @param {object} [options]
 * @param {string} [options.prefix] - Prefix for context (e.g., 'worker:abc123')
 * @param {string} [options.level] - Minimum log level (default: 'info')
 * @param {boolean} [options.silent] - Suppress console output (for tests)
 */
function createLogger(options = {}) {
  const { prefix = '', level = 'info', silent = false } = options;
  const minLevel = LEVELS[level] || LEVELS.info;

  ensureLogDir();

  function formatEntry(lvl, message, context = {}) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: lvl,
      prefix: prefix || undefined,
      message,
      ...context
    });
  }

  function log(lvl, message, context = {}) {
    if (LEVELS[lvl] < minLevel) return;

    const entry = formatEntry(lvl, message, context);

    // Write to log file (append)
    try {
      fs.appendFileSync(LOG_FILE, entry + '\n');
    } catch (err) {
      // Don't crash if log file write fails
    }

    // Write to console (stderr to keep stdout clean for CLI output)
    if (!silent) {
      process.stderr.write(entry + '\n');
    }
  }

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx)
  };
}

module.exports = { createLogger };
