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

describe('JobRepository', () => {
  let container;
  let dbPath;

  beforeEach(() => {
    dbPath = getTestDbPath();
    container = createContainer({ dbPath, silent: true });
  });

  afterEach(() => {
    container.close();
    try { fs.unlinkSync(dbPath); } catch (e) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (e) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (e) {}
  });

  test('claimNext atomically claims a pending job', () => {
    container.jobRepository.create('job-1', 'echo test', 3);

    const claimed = container.jobRepository.claimNext('worker-1');

    assert.ok(claimed);
    assert.strictEqual(claimed.id, 'job-1');
    assert.strictEqual(claimed.state, 'processing');
    assert.strictEqual(claimed.worker_id, 'worker-1');
  });

  test('claimNext returns null when no jobs available', () => {
    const claimed = container.jobRepository.claimNext('worker-1');
    assert.strictEqual(claimed, null);
  });

  test('claimNext claims oldest job first (FIFO)', () => {
    container.jobRepository.create('job-1', 'echo first', 3);
    container.jobRepository.create('job-2', 'echo second', 3);

    const claimed = container.jobRepository.claimNext('worker-1');
    assert.strictEqual(claimed.id, 'job-1');
  });

  test('claimed job is not claimable by another worker', () => {
    container.jobRepository.create('job-1', 'echo test', 3);

    container.jobRepository.claimNext('worker-1');
    const secondClaim = container.jobRepository.claimNext('worker-2');

    assert.strictEqual(secondClaim, null);
  });

  test('markCompleted transitions job state', () => {
    container.jobRepository.create('job-1', 'echo test', 3);
    container.jobRepository.claimNext('worker-1');
    container.jobRepository.markCompleted('job-1');

    const job = container.jobRepository.findById('job-1');
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(job.worker_id, null);
  });

  test('findStaleProcessing detects abandoned jobs', () => {
    container.jobRepository.create('job-1', 'echo test', 3);
    container.jobRepository.claimNext('worker-1');

    // Manually backdate started_at to simulate a stale job
    container.db.prepare(
      "UPDATE jobs SET started_at = datetime('now', '-60 seconds') WHERE id = ?"
    ).run('job-1');

    const stale = container.jobRepository.findStaleProcessing('-30 seconds');
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].id, 'job-1');
  });

  test('findStaleProcessing does not flag recent jobs', () => {
    container.jobRepository.create('job-1', 'echo test', 3);
    container.jobRepository.claimNext('worker-1');

    const stale = container.jobRepository.findStaleProcessing('-30 seconds');
    assert.strictEqual(stale.length, 0);
  });
});
