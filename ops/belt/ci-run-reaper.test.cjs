'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reapCandidates, queueMetrics, createReaper } = require('./ci-run-reaper-lib.cjs');

const now = Date.parse('2026-09-04T12:00:00Z');
const run = (id, status, sha, extra = {}) => ({ id, status, head_sha: sha,
  created_at: '2026-09-03T00:00:00Z', ...extra });

test('reaper protects open PR and held-ticket heads', () => {
  const runs = [run(1, 'queued', 'open'), run(2, 'pending', 'held'), run(3, 'queued', 'old')];
  assert.deepEqual(reapCandidates(runs, { openPrHeads: ['open'], heldTicketHeads: ['held'], now }), [runs[2]]);
});

test('zombie in-progress run without runner is eligible, assigned run is not', () => {
  const zombie = run(10, 'in_progress', 'z');
  const assigned = run(11, 'in_progress', 'a', { runner_name: 'ci-1' });
  assert.deepEqual(reapCandidates([zombie, assigned], { now }), [zombie]);
});

test('cancellation is idempotent and emits bounded queue metrics', async () => {
  const calls = [], logs = [];
  const reap = createReaper({ now: () => now, gh: async args => calls.push(args), log: x => logs.push(x) });
  const runs = [run(20, 'queued', 'old', { labels: ['ci-only'] }), run(21, 'completed', 'x', { conclusion: 'cancelled' })];
  const first = await reap('org/repo', runs);
  assert.deepEqual(first.runIds, [20]);
  assert.equal(calls.length, 1);
  assert.equal(first.metrics.queue_depth, 1);
  assert.match(logs[0], /queue_depth=1/);
  // A subsequent poll sees the cancelled conclusion and performs no call.
  runs[0].conclusion = 'cancelled'; runs[0].status = 'completed';
  const second = await reap('org/repo', runs);
  assert.equal(second.cancelled, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(queueMetrics(runs, { now }).queue_depth, 0);
});
