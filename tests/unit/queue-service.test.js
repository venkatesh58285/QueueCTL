'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { createContainer } = require('../../src/container');

const TEST_DB_DIR = path.join(__dirname, '..', 'fixtures');

function getTestDbPath() {
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }
  return path.join(TEST_DB_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('QueueService', () => {
  let container;
  let dbPath;

  beforeEach(() => {
    dbPath = getTestDbPath();
    container = createContainer({ dbPath, silent: true });
  });

  afterEach(() => {
    container.close();
    // Clean up test database
    try { fs.unlinkSync(dbPath); } catch (e) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (e) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (e) {}
  });

  test('enqueue creates a job with correct defaults', () => {
    const job = container.queueService.enqueue('echo hello');

    assert.strictEqual(job.command, 'echo hello');
    assert.strictEqual(job.state, 'pending');
    assert.strictEqual(job.attempts, 0);
    assert.strictEqual(job.max_retries, 3);
    assert.ok(job.id);
    assert.ok(job.created_at);
  });

  test('enqueue respects current max-retries config', () => {
    container.configService.set('max-retries', '5');
    const job = container.queueService.enqueue('echo test');

    assert.strictEqual(job.max_retries, 5);
  });

  test('enqueue rejects empty command', () => {
    assert.throws(() => container.queueService.enqueue(''), /non-empty string/);
    assert.throws(() => container.queueService.enqueue('  '), /non-empty string/);
  });

  test('handleFailure retries when attempts < max_retries', () => {
    const job = container.queueService.enqueue('exit 1');
    // Simulate claiming
    container.jobRepository.claimNext('worker-1');
    const claimed = container.jobRepository.findById(job.id);

    const result = container.queueService.handleFailure(claimed);

    assert.strictEqual(result.action, 'retry');
    assert.ok(result.delay > 0);
  });

  test('handleFailure moves to DLQ when max retries exhausted', () => {
    container.configService.set('max-retries', '1');
    const job = container.queueService.enqueue('exit 1');

    // Simulate first failure
    container.jobRepository.claimNext('worker-1');
    const claimed = container.jobRepository.findById(job.id);
    const result = container.queueService.handleFailure(claimed);

    assert.strictEqual(result.action, 'dead');

    const updated = container.jobRepository.findById(job.id);
    assert.strictEqual(updated.state, 'dead');
  });

  test('calculateBackoff uses exponential formula', () => {
    container.configService.set('backoff-base', '2');

    assert.strictEqual(container.queueService.calculateBackoff(1), 2000);  // 2^1 * 1000
    assert.strictEqual(container.queueService.calculateBackoff(2), 4000);  // 2^2 * 1000
    assert.strictEqual(container.queueService.calculateBackoff(3), 8000);  // 2^3 * 1000
  });

  test('retryFromDLQ requeues a dead job', () => {
    container.configService.set('max-retries', '1');
    const job = container.queueService.enqueue('exit 1');
    container.jobRepository.claimNext('worker-1');
    const claimed = container.jobRepository.findById(job.id);
    container.queueService.handleFailure(claimed);

    const requeued = container.queueService.retryFromDLQ(job.id);
    assert.strictEqual(requeued.state, 'pending');
  });

  test('retryFromDLQ rejects non-dead jobs', () => {
    const job = container.queueService.enqueue('echo test');
    assert.throws(() => container.queueService.retryFromDLQ(job.id), /not in dead letter queue/);
  });

  test('listByState returns filtered jobs', () => {
    container.queueService.enqueue('echo 1');
    container.queueService.enqueue('echo 2');

    const pending = container.queueService.listByState('pending');
    assert.strictEqual(pending.length, 2);
  });

  test('listByState rejects invalid state', () => {
    assert.throws(() => container.queueService.listByState('invalid'), /Invalid state/);
  });

  test('getStatus returns correct counts', () => {
    container.queueService.enqueue('echo 1');
    container.queueService.enqueue('echo 2');

    const status = container.queueService.getStatus();
    assert.strictEqual(status.pending, 2);
    assert.strictEqual(status.completed, 0);
  });
});
