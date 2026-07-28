'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Queue Service — business logic for job lifecycle management.
 *
 * Responsibilities:
 * - Enqueue new jobs with proper defaults
 * - Determine retry vs. dead letter decisions
 * - Calculate backoff delays
 * - Provide status summaries
 *
 * This service does NOT execute jobs — that's the worker's job.
 * Clean separation: service decides, worker executes.
 */

/**
 * @param {object} deps
 * @param {object} deps.jobRepository
 * @param {object} deps.configRepository
 */
function createQueueService({ jobRepository, configRepository }) {
  return {
    /**
     * Enqueue a new job.
     * max_retries is captured at enqueue time from current config.
     * This means config changes do NOT affect already-queued jobs.
     *
     * @param {string} command - Shell command to execute
     * @returns {object} The created job
     */
    enqueue(command) {
      if (!command || typeof command !== 'string' || command.trim() === '') {
        throw new Error('Command must be a non-empty string');
      }

      const id = uuidv4();
      const maxRetries = parseInt(configRepository.get('max-retries'), 10) || 3;

      jobRepository.create(id, command.trim(), maxRetries);

      return jobRepository.findById(id);
    },

    /**
     * Handle a job failure: decide whether to retry or move to DLQ.
     *
     * @param {object} job - The failed job
     * @returns {{ action: 'retry'|'dead', delay?: number }}
     */
    handleFailure(job) {
      const newAttempts = job.attempts + 1;
      jobRepository.incrementAttempts(job.id);

      if (newAttempts >= job.max_retries) {
        // Exhausted all retries — move to Dead Letter Queue
        jobRepository.markDead(job.id);
        return { action: 'dead' };
      }

      // Schedule retry with exponential backoff
      jobRepository.markFailed(job.id);
      const delay = this.calculateBackoff(newAttempts);
      return { action: 'retry', delay };
    },

    /**
     * Calculate exponential backoff delay.
     * Formula: base ^ attempts (in seconds)
     *
     * Example with base=2:
     *   attempt 1 → 2^1 = 2 seconds
     *   attempt 2 → 2^2 = 4 seconds
     *   attempt 3 → 2^3 = 8 seconds
     *
     * @param {number} attempts - Current attempt number
     * @returns {number} Delay in milliseconds
     */
    calculateBackoff(attempts) {
      const base = parseInt(configRepository.get('backoff-base'), 10) || 2;
      const delaySeconds = Math.pow(base, attempts);
      return delaySeconds * 1000;
    },

    /**
     * Re-queue a failed job for retry after backoff period.
     */
    requeueForRetry(jobId) {
      jobRepository.requeueForRetry(jobId);
    },

    /**
     * Retry a dead-lettered job (from DLQ).
     * Resets state to pending and resets attempts.
     */
    retryFromDLQ(jobId) {
      const job = jobRepository.findById(jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }
      if (job.state !== 'dead') {
        throw new Error(`Job ${jobId} is not in dead letter queue (state: ${job.state})`);
      }
      jobRepository.requeueForRetry(jobId);
      return jobRepository.findById(jobId);
    },

    getStatus() {
      const counts = jobRepository.getStatusCounts();
      const result = { pending: 0, processing: 0, completed: 0, failed: 0, dead: 0 };
      for (const row of counts) {
        result[row.state] = row.count;
      }
      return result;
    },

    listByState(state) {
      const validStates = ['pending', 'processing', 'completed', 'failed', 'dead'];
      if (!validStates.includes(state)) {
        throw new Error(`Invalid state: ${state}. Valid states: ${validStates.join(', ')}`);
      }
      return jobRepository.findByState(state);
    },

    listDLQ() {
      return jobRepository.findByState('dead');
    }
  };
}

module.exports = { createQueueService };
