'use strict';

/**
 * Config Service — validates and manages configuration.
 *
 * Supported configuration keys:
 * - max-retries: number of retry attempts before moving to DLQ (integer >= 0)
 * - backoff-base: base for exponential backoff calculation (integer >= 1)
 *
 * Design note: config changes do NOT retroactively affect already-queued jobs.
 * Each job captures max_retries at enqueue time. This is intentional:
 * - Predictable behavior: a job's retry policy doesn't change mid-flight
 * - Easy to reason about in an interview
 */

const VALID_KEYS = ['max-retries', 'backoff-base'];

/**
 * @param {object} deps
 * @param {object} deps.configRepository
 */
function createConfigService({ configRepository }) {
  return {
    get(key) {
      if (!VALID_KEYS.includes(key)) {
        throw new Error(`Unknown config key: ${key}. Valid keys: ${VALID_KEYS.join(', ')}`);
      }
      return configRepository.get(key);
    },

    set(key, value) {
      if (!VALID_KEYS.includes(key)) {
        throw new Error(`Unknown config key: ${key}. Valid keys: ${VALID_KEYS.join(', ')}`);
      }

      const numValue = parseInt(value, 10);
      if (isNaN(numValue)) {
        throw new Error(`Value must be a number, got: ${value}`);
      }

      if (key === 'max-retries' && numValue < 0) {
        throw new Error('max-retries must be >= 0');
      }

      if (key === 'backoff-base' && numValue < 1) {
        throw new Error('backoff-base must be >= 1');
      }

      configRepository.set(key, String(numValue));
      return { key, value: numValue };
    },

    getAll() {
      return configRepository.getAll();
    }
  };
}

module.exports = { createConfigService, VALID_KEYS };
