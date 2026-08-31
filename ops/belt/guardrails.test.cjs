const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isBundledChild, instructionCompatibility, hasActiveTaskForIssueStage,
  retryAdmission, spendPreflight, stageCycleAdmission, lifetimeTaskAdmission,
  isExecutionStage, quotaCircuitAdmission
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
  assert.equal(instructionCompatibility('Own Queue and In Progress build stages', 'In Progress').ok, true);
  assert.equal(instructionCompatibility('Work only CI/CD & Deploy', 'CI/CD & Deploy').ok, true);
  assert.equal(instructionCompatibility('Verify Done closure evidence', 'Done').ok, true);
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
  assert.equal(spendPreflight({ max_concurrent_tasks: 4, instructions: 'Queue', model: 'deepseek/v4' }, { provider: 'openrouter', token_budget: 1000 }).ok, true);
  assert.equal(spendPreflight({ max_concurrent_tasks: 0, instructions: 'Queue', model: 'deepseek/v4' }, { provider: 'openrouter', token_budget: 1000 }).ok, false);
  assert.equal(spendPreflight({ max_concurrent_tasks: 4, instructions: 'Queue', model: 'deepseek/v4' }, { provider: 'openrouter' }).ok, false);
  assert.equal(spendPreflight({ max_concurrent_tasks: null, instructions: 'Queue', model: 'gpt-5.6-luna' }, { provider: 'codex' }).ok, true);
  assert.equal(spendPreflight({ max_concurrent_tasks: 4, instructions: 'Queue', model: '' }, { provider: 'codex' }).ok, true);
  assert.deepEqual(spendPreflight({ instructions: 'Queue', runtime_config: { quota_paused: true } }, { provider: 'codex' }),
    { ok: false, reason: 'provider_quota_paused' });
});

test('stage cycle breaker parks repeated model calls without human review', () => {
  // queued_expired rows have no started_at and therefore do not consume the
  // paid-attempt budget; two such rows still leave a flight admissible.
  assert.deepEqual(stageCycleAdmission(0), { ok: true, ceiling: 2 });
  assert.deepEqual(stageCycleAdmission(1), { ok: true, ceiling: 2 });
  assert.deepEqual(stageCycleAdmission(2), {
    ok: false, reason: 'stage_cycle_limit', ceiling: 2, disposition: 'Parked'
  });
});

test('lifetime ceiling bounds paid work across stage changes', () => {
  assert.deepEqual(lifetimeTaskAdmission(5), { ok: true, ceiling: 6 });
  assert.deepEqual(lifetimeTaskAdmission(6), {
    ok: false, reason: 'lifetime_task_limit', ceiling: 6, disposition: 'Parked'
  });
});

test('human and disposition stages never execute tasks', () => {
  assert.equal(isExecutionStage('Queue'), true);
  assert.equal(isExecutionStage('Human Review'), false);
  assert.equal(isExecutionStage('Parked'), false);
  assert.equal(isExecutionStage('Rejected'), false);
});

test('quota circuit pauses only after consecutive money failures', () => {
  assert.deepEqual(quotaCircuitAdmission(['402', 'provider_quota_limit', 'payment required']),
    { pause: true, consecutive: 3, ceiling: 3 });
  assert.deepEqual(quotaCircuitAdmission(['402', 'timeout', '402']),
    { pause: false, consecutive: 1, ceiling: 3 });
});
