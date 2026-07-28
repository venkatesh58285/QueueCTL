'use strict';

/**
 * Worker Process — runs as a separate OS process.
 *
 * Lifecycle:
 * 1. Register self in workers table
 * 2. Poll for pending jobs
 * 3. Claim a job atomically
 * 4. Execute the shell command
 * 5. Handle success/failure
 * 6. Repeat until stop signal received
 *
 * Crash Recovery:
 * - Workers update a heartbeat every HEARTBEAT_INTERVAL ms
 * - If a worker crashes (SIGKILL), its heartbeat goes stale
 * - The recovery service (runs in each worker) detects stale jobs
 *   and requeues them
 *
 * Graceful Shutdown:
 * - Worker checks its state in the DB each poll cycle
 * - If state = 'stopping', it finishes current job and exits
 * - SIGTERM/SIGINT are caught to trigger graceful shutdown
 */

const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const { createContainer } = require('../container');
const { createLogger } = require('../utils/logger');

// --- Constants ---
const POLL_INTERVAL_MS = 1000;       // How often to check for new jobs
const HEARTBEAT_INTERVAL_MS = 5000;  // How often to update heartbeat
const LEASE_TIMEOUT_SECONDS = 30;    // Seconds before a job is considered abandoned
const RECOVERY_INTERVAL_MS = 10000;  // How often to scan for abandoned jobs

// --- Worker State ---
const workerId = uuidv4();
const workerPid = process.pid;
let isShuttingDown = false;
let isExecutingJob = false;

// --- Initialize ---
const container = createContainer();
const logger = createLogger({ prefix: `worker:${workerId.slice(0, 8)}` });

logger.info('Worker starting', { workerId, pid: workerPid });

// Register this worker
container.workerRepository.register(workerId, workerPid);

// --- Heartbeat ---
// Updates last_heartbeat periodically so the system knows we're alive.
const heartbeatTimer = setInterval(() => {
  try {
    container.workerRepository.updateHeartbeat(workerId);
  } catch (err) {
    logger.error('Heartbeat update failed', { error: err.message });
  }
}, HEARTBEAT_INTERVAL_MS);

// --- Crash Recovery ---
// Each worker participates in crash recovery by scanning for stale jobs.
// This is distributed — any worker can recover jobs from a crashed worker.
const recoveryTimer = setInterval(() => {
  try {
    recoverAbandonedJobs();
  } catch (err) {
    logger.error('Recovery scan failed', { error: err.message });
  }
}, RECOVERY_INTERVAL_MS);

function recoverAbandonedJobs() {
  const timeoutModifier = `-${LEASE_TIMEOUT_SECONDS} seconds`;
  const staleJobs = container.jobRepository.findStaleProcessing(timeoutModifier);

  for (const job of staleJobs) {
    logger.warn('Recovering abandoned job', { jobId: job.id, worker: job.worker_id });

    // Treat abandoned processing as a failed attempt
    container.jobRepository.incrementAttempts(job.id);
    const updatedJob = container.jobRepository.findById(job.id);

    if (updatedJob.attempts >= updatedJob.max_retries) {
      container.jobRepository.markDead(job.id);
      logger.info('Abandoned job moved to DLQ', { jobId: job.id });
    } else {
      container.jobRepository.requeueForRetry(job.id);
      logger.info('Abandoned job requeued', { jobId: job.id });
    }
  }

  // Clean up stale worker records
  container.workerRepository.cleanupStale(timeoutModifier);
}

// --- Job Execution ---
function executeJob(job) {
  isExecutingJob = true;
  logger.info('Job claimed', { jobId: job.id, command: job.command, attempt: job.attempts + 1 });

  try {
    execSync(job.command, {
      timeout: 60000, // 60 second timeout per job
      stdio: 'pipe',
      shell: true
    });

    // Success — exit code 0
    container.jobRepository.markCompleted(job.id);
    logger.info('Job completed', { jobId: job.id });
  } catch (err) {
    // Failure — non-zero exit code or timeout
    logger.warn('Job execution failed', {
      jobId: job.id,
      exitCode: err.status,
      error: err.stderr ? err.stderr.toString().slice(0, 200) : err.message
    });

    const result = container.queueService.handleFailure(job);

    if (result.action === 'dead') {
      logger.info('Job moved to DLQ', { jobId: job.id });
    } else {
      // Schedule retry after backoff
      logger.info('Job scheduled for retry', {
        jobId: job.id,
        delay: result.delay,
        nextAttempt: job.attempts + 2
      });

      // Use setTimeout to requeue after backoff delay
      setTimeout(() => {
        try {
          container.queueService.requeueForRetry(job.id);
          logger.info('Job requeued after backoff', { jobId: job.id });
        } catch (requeueErr) {
          logger.error('Failed to requeue job', { jobId: job.id, error: requeueErr.message });
        }
      }, result.delay);
    }
  } finally {
    isExecutingJob = false;
  }
}

// --- Main Poll Loop ---
function shouldStop() {
  if (isShuttingDown) return true;

  try {
    const worker = container.workerRepository.findById(workerId);
    if (!worker || worker.state === 'stopping') {
      return true;
    }
  } catch (err) {
    // If we can't read state, keep running
    logger.error('Failed to check worker state', { error: err.message });
  }

  return false;
}

async function pollLoop() {
  while (!shouldStop()) {
    try {
      const job = container.jobRepository.claimNext(workerId);

      if (job) {
        executeJob(job);
      }
    } catch (err) {
      logger.error('Poll loop error', { error: err.message });
    }

    // Wait before next poll
    await sleep(POLL_INTERVAL_MS);
  }

  shutdown();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Graceful Shutdown ---
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Worker shutting down', { workerId });

  // Stop timers
  clearInterval(heartbeatTimer);
  clearInterval(recoveryTimer);

  // Mark ourselves as stopped
  try {
    container.workerRepository.setState(workerId, 'stopped');
  } catch (err) {
    // Best effort
  }

  // Close DB connection
  container.close();

  logger.info('Worker stopped', { workerId });
  process.exit(0);
}

// Handle graceful shutdown signals
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM');
  if (!isExecutingJob) {
    shutdown();
  } else {
    // Let the current job finish, then the poll loop will exit
    isShuttingDown = true;
  }
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT');
  if (!isExecutingJob) {
    shutdown();
  } else {
    isShuttingDown = true;
  }
});

// --- Start ---
pollLoop();
