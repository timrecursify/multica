'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const FROZEN_SHA = 'd8712a3c5afa000baa0e84871d445dd28b49059d';
const DISPATCHABLE_STATUSES = Object.freeze(['Spec', 'Queue', 'In Progress', 'In Review', 'CI/CD & Deploy']);
const LIVE_STATUSES = Object.freeze(['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred']);
const LEGACY_QUEUE_WRITERS = Object.freeze([
  'ops/belt/multica-bridge.cjs',
  'ops/belt/parity/multica-relay-advance-daemon.cjs',
  'ops/belt/parked-diagnosis.cjs'
]);

function liveTaskCount(tasks, stage) {
  return tasks.filter((task) => task.stage === stage && LIVE_STATUSES.includes(task.status)).length;
}

test('pins the approved frozen SHA', () => {
  assert.doesNotThrow(() => execFileSync('git', ['cat-file', '-e', `${FROZEN_SHA}^{commit}`]));
});

test('expresses zero, one, and duplicate live current-stage tasks', () => {
  assert.equal(liveTaskCount([], 'Queue'), 0);
  assert.equal(liveTaskCount([{ stage: 'Queue', status: 'queued' }], 'Queue'), 1);
  assert.equal(liveTaskCount([{ stage: 'Queue', status: 'running' }, { stage: 'Queue', status: 'deferred' }], 'Queue'), 2);
  assert.deepEqual(DISPATCHABLE_STATUSES, ['Spec', 'Queue', 'In Progress', 'In Review', 'CI/CD & Deploy']);
});

test('records every legacy executable queue-insert writer for retirement discovery', () => {
  const output = execFileSync('git', ['grep', '-l', 'INSERT INTO agent_task_queue', '--', 'ops/belt'], { encoding: 'utf8' });
  for (const file of LEGACY_QUEUE_WRITERS) assert.match(output, new RegExp(`^${file}$`, 'm'));
});

module.exports = { DISPATCHABLE_STATUSES, FROZEN_SHA, LEGACY_QUEUE_WRITERS, LIVE_STATUSES, liveTaskCount };
