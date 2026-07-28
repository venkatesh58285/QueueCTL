'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createContainer } = require('../../src/container');

const BIN = path.join(__dirname, '..', '..', 'bin', 'queuectl.js');
const TEST_DB_DIR = path.join(__dirname, '..', 'fixtures');

function getTestDbPath() {
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }
  return path.join(TEST_DB_DIR, `int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Worker Integration', () => {
  let container;
  let dbPath;
  let workerProcesses = [];

  beforeEach(() => {
    dbPath = getTestDbPath();
    container = createContainer({ dbPath, silent: true });
  });

  afterEach(() => {
    // Kill any spawned workers
    for (const proc of workerProcesses) {
      try { proc.kill(); } catch (e) {}
    }
    workerProcesses = [];

    container.close();
    try { fs.unlinkSync(dbPath); } catch (e) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (e) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (e) {}
  });

  function startWorker() {
    const workerScript = path.join(__dirname, '..', '..', 'src', 'workers', 'worker-process.js');
    const proc = spawn(process.execPath, [workerScript], {
      env: { ...process.env, QUEUECTL_DB_PATH: dbPath },
      stdio: 'pipe'
    });
    workerProcesses.push(proc);
    return proc;
  }

  test('worker completes a successful job', async () => {
    container.queueService.enqueue('echo success');

    const workerScript = path.join(__dirname, '..', '..', 'src', 'workers', 'worker-process.js');
    const proc = spawn(process.execPath, [workerScript], {
      stdio: 'pipe'
    });
    workerProcesses.push(proc);

    await sleep(3000);
    proc.kill();

    // Re-open container to read fresh state
    container.close();
    container = createContainer({ dbPath, silent: true });

    const status = container.queueService.getStatus();
    assert.strictEqual(status.completed, 1);
    assert.strictEqual(status.pending, 0);
  });

  test('worker moves failing job to DLQ after max retries', async () => {
    container.configService.set('max-retries', '2');
    container.queueService.enqueue('exit 1');

    const workerScript = path.join(__dirname, '..', '..', 'src', 'workers', 'worker-process.js');
    const proc = spawn(process.execPath, [workerScript], {
      stdio: 'pipe'
    });
    workerProcesses.push(proc);

    // Wait long enough for retries with backoff (2s + 4s + buffer)
    await sleep(12000);
    proc.kill();

    container.close();
    container = createContainer({ dbPath, silent: true });

    const status = container.queueService.getStatus();
    assert.strictEqual(status.dead, 1);
  });

  test('multiple workers do not execute the same job twice', async () => {
    // Enqueue 5 jobs
    for (let i = 0; i < 5; i++) {
      container.queueService.enqueue(`echo job-${i}`);
    }

    const workerScript = path.join(__dirname, '..', '..', 'src', 'workers', 'worker-process.js');

    // Start 3 workers
    for (let i = 0; i < 3; i++) {
      const proc = spawn(process.execPath, [workerScript], {
        stdio: 'pipe'
      });
      workerProcesses.push(proc);
    }

    await sleep(5000);

    // Kill all workers
    for (const proc of workerProcesses) {
      try { proc.kill(); } catch (e) {}
    }

    container.close();
    container = createContainer({ dbPath, silent: true });

    const status = container.queueService.getStatus();
    // All 5 should be completed (no duplicates means exactly 5 completions)
    assert.strictEqual(status.completed, 5);
    assert.strictEqual(status.pending, 0);
  });
});
