const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isBundledChild, instructionCompatibility, hasActiveTaskForIssueStage,
  retryAdmission, spendPreflight, stageCycleAdmission
} = require('./guardrails.cjs');

test('any bundled child is withheld, regardless of parent state', () => {
  assert.equal(isBundledChild({ parent_issue_id: 'p', title: 'child' }), true);
  assert.equal(isBundledChild({ parent_issue_id: 'p', title: 'child' }), true);
  assert.equal(isBundledChild({ title: 'MEGA: root' }), false);
});

test('dispatch requires the target stage to be named by agent instructions', () => {
  assert.equal(instructionCompatibility('read RUNBOOK_SPEC_WORKER.md; stop elsewhere', 'Spec').ok, true);
  assert.equal(instructionCompatibility('read RUNBOOK_SPEC_WORKER.md; stop elsewhere', 'Queue').ok, false);
  assert.equal(instructionCompatibility('read RUNBOOK_BUILD_WORKER.md', 'Queue').ok, true);
  assert.equal(instructionCompatibility('', 'Queue').ok, false);
});

test('active tasks deduplicate by issue and target stage', () => {
  const tasks = [
    { issue_id: 'i', status: 'running', context: { to_stage: 'Queue' } },
    { issue_id: 'i', status: 'completed', context: { to_stage: 'Queue' } },
    { issue_id: 'i', status: 'queued', context: { to_stage: 'In Review' } }
  ];
  assert.equal(hasActiveTaskForIssueStage(tasks, 'i', 'Queue'), true);
  assert.equal(hasActiveTaskForIssueStage(tasks, 'i', 'In Review'), true);
  assert.equal(hasActiveTaskForIssueStage(tasks, 'i', 'Spec'), false);
});

test('infra retry stops when queue loses headroom and never spends attempt', () => {
  const args = { attempt: 1, maxAttempts: 2, failureReason: 'timeout',
    queueAgeMinutes: 61, queueTtlMinutes: 120, infraReasons: ['timeout'] };
  assert.deepEqual(retryAdmission(args), { ok: false, reason: 'queue_headroom_exhausted' });
  assert.deepEqual(retryAdmission({ ...args, queueAgeMinutes: 5 }), { ok: true, consumesAttempt: false });
  assert.deepEqual(retryAdmission({ ...args, failureReason: 'implementation', queueAgeMinutes: 5,
    infraReasons: ['timeout'] }), { ok: true, consumesAttempt: true });
});

test('paid dispatch requires a live configured agent', () => {
  assert.equal(spendPreflight({ max_concurrent_tasks: 4, instructions: 'Queue', model: 'deepseek/v4' }, { provider: 'openrouter' }).ok, true);
  assert.equal(spendPreflight({ max_concurrent_tasks: 0, instructions: 'Queue', model: 'deepseek/v4' }, { provider: 'openrouter' }).ok, false);
  assert.equal(spendPreflight({ max_concurrent_tasks: null, instructions: 'Queue', model: 'gpt-5.6-luna' }, { provider: 'codex' }).ok, true);
  assert.equal(spendPreflight({ max_concurrent_tasks: 4, instructions: 'Queue', model: '' }, { provider: 'codex' }).ok, true);
});

test('stage cycle breaker parks repeated model calls for manual disposition', () => {
  assert.deepEqual(stageCycleAdmission(1), { ok: true, ceiling: 2 });
  assert.deepEqual(stageCycleAdmission(2), {
    ok: false, reason: 'stage_cycle_limit', ceiling: 2, disposition: 'Human Review'
  });
});
