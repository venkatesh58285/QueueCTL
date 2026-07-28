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

describe('ConfigService', () => {
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

  test('defaults are seeded on first run', () => {
    const maxRetries = container.configService.get('max-retries');
    const backoffBase = container.configService.get('backoff-base');

    assert.strictEqual(maxRetries, '3');
    assert.strictEqual(backoffBase, '2');
  });

  test('set updates a config value', () => {
    container.configService.set('max-retries', '10');
    assert.strictEqual(container.configService.get('max-retries'), '10');
  });

  test('set rejects invalid keys', () => {
    assert.throws(() => container.configService.set('invalid-key', '5'), /Unknown config key/);
  });

  test('set rejects non-numeric values', () => {
    assert.throws(() => container.configService.set('max-retries', 'abc'), /must be a number/);
  });

  test('set rejects negative max-retries', () => {
    assert.throws(() => container.configService.set('max-retries', '-1'), /must be >= 0/);
  });

  test('set rejects zero backoff-base', () => {
    assert.throws(() => container.configService.set('backoff-base', '0'), /must be >= 1/);
  });

  test('getAll returns all config', () => {
    const all = container.configService.getAll();
    assert.ok(all.length >= 2);
  });
});
