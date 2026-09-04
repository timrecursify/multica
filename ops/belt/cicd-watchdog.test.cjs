#!/usr/bin/env node
const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWatchdog, correlationKey, SENTINEL_MS } = require('./cicd-watchdog.cjs');

test('default sentinel threshold matches the 20-minute alert contract', () => {
  assert.equal(SENTINEL_MS, 20 * 60 * 1000);
});

test('watchdog persists first-seen and correlation state across restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicd-watchdog-'));
  const file = path.join(dir, 'state.json'); let now = 1000;
  const a = createWatchdog({ file, now: () => now });
  const row = a.observe('issue-1', { sha: 'a'.repeat(40), error: 'timeout' });
  now += 100; a.observe('issue-1', { sha: 'a'.repeat(40), error: 'retry' });
  const b = createWatchdog({ file, now: () => now });
  const restored = b.snapshot()['issue-1:CI/CD & Deploy'];
  assert.equal(restored.first_seen_at, row.first_seen_at);
  assert.equal(restored.correlation_key, correlationKey('issue-1', 'a'.repeat(40)));
  assert.equal(restored.attempts, 2);
});

test('stalled alert is emitted once after threshold and backoff is capped', () => {
  let now = 0; const w = createWatchdog({ now: () => now });
  const row = w.observe('issue-2', { error: 'provider unavailable' });
  now = SENTINEL_MS + 1;
  assert.equal(w.stalled(row), true);
  w.markAlerted(row);
  assert.equal(w.stalled(row), false);
  assert.ok(w.backoffMs({ attempts: 99 }) <= SENTINEL_MS);
});

test('successful closure clears the correlation state so a later flight starts fresh', () => {
  const w = createWatchdog();
  w.observe('issue-3', { sha: 'c'.repeat(40), outcome: 'closure_pending' });
  assert.ok(w.snapshot()['issue-3:CI/CD & Deploy']);
  w.clear('issue-3');
  assert.equal(w.snapshot()['issue-3:CI/CD & Deploy'], undefined);
  const next = w.observe('issue-3', { sha: 'd'.repeat(40), outcome: 'closure_pending' });
  assert.equal(next.correlation_key, correlationKey('issue-3', 'd'.repeat(40)));
  assert.equal(next.attempts, 1);
});
