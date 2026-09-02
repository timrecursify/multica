const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const {
  isBundledChild, instructionCompatibility, hasActiveTaskForIssueStage,
  crossStageExecutionAdmission,
  retryAdmission, spendPreflight, beltRoutingAdmission, stageCycleAdmission, lifetimeTaskAdmission,
  isExecutionStage, routableOwnerDefects, assertRoutableStageOwners,
  quotaCircuitAdmission, QUOTA_PAUSE_MAX_AGE_MS, quotaPauseClearance, quotaPauseFlipLogLine
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

test('belt routing allows DeepSeek/Terra builders and Sol-low QC/spec only', () => {
  assert.equal(beltRoutingAdmission({ name: 'gsp-build-deepseek', model: 'deepseek/v4', thinking_level: 'low' }).ok, true);
  assert.equal(beltRoutingAdmission({ name: 'gsp-build-terra', model: 'gpt-5.6-terra', thinking_level: 'low' }).ok, true);
  assert.equal(beltRoutingAdmission({ name: 'gsp-build-luna', model: 'gpt-5.6-luna', thinking_level: 'low' }).reason, 'builder_requires_deepseek_or_terra');
  assert.equal(beltRoutingAdmission({ name: 'gsp-qc', model: 'gpt-5.6-sol', thinking_level: 'low' }).ok, true);
  assert.equal(beltRoutingAdmission({ name: 'gsp-qc', model: 'gpt-5.6-sol', thinking_level: 'high' }).reason, 'belt_low_reasoning_effort_required');
  assert.equal(beltRoutingAdmission({ name: 'ppp-spec', model: 'gpt-5.6-terra', thinking_level: 'low' }).reason, 'qc_spec_requires_sol_low');
  const configOnly = beltRoutingAdmission({ id: 'agent-1', name: 'gsp-build', model: 'gpt-5.6-luna', thinking_level: '', runtime_config: { model: 'gpt-5.6-terra', reasoning_effort: 'low' } });
  assert.equal(configOnly.reason, 'belt_low_reasoning_effort_required');
  assert.deepEqual({ agent_name: configOnly.agent_name, agent_id: configOnly.agent_id, model: configOnly.model, effort: configOnly.effort }, { agent_name: 'gsp-build', agent_id: 'agent-1', model: 'gpt-5.6-luna', effort: '' });
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

test('cross-stage admission defers a second relay execution until its predecessor is terminal', () => {
  const activeSpec = [{ id: 'f06c', issue_id: 'GSP1158', status: 'running',
    context: { source: 'relay-advance', from_stage: 'Spec', to_stage: 'Queue' } }];
  assert.deepEqual(crossStageExecutionAdmission(activeSpec, 'GSP1158'), {
    ok: false,
    reason: 'prior_execution_active',
    active_task_ids: ['f06c'],
    active_stages: ['Queue']
  });
  assert.deepEqual(crossStageExecutionAdmission([{ ...activeSpec[0], status: 'completed' }], 'GSP1158'),
    { ok: true });
});

test('cross-stage admission ignores manual and non-execution tasks', () => {
  const tasks = [
    { id: 'manual', issue_id: 'i', status: 'running', context: { source: 'manual', to_stage: 'Queue' } },
    { id: 'review', issue_id: 'i', status: 'queued', context: { source: 'relay-advance', to_stage: 'Human Review' } }
  ];
  assert.deepEqual(crossStageExecutionAdmission(tasks, 'i'), { ok: true });
});

test('both concurrent relay creation paths take the same issue admission lock', () => {
  for (const file of ['ops/belt/multica-bridge.cjs', 'ops/belt/parity/multica-relay-advance-daemon.cjs']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(\$1::text, 804\)\)/);
    assert.match(source, /crossStageExecutionAdmission/);
  }
});

test('infra retry stops when queue loses headroom and never spends attempt', () => {
  const args = { attempt: 1, maxAttempts: 2, failureReason: 'timeout',
    queueAgeMinutes: 61, queueTtlMinutes: 120, infraReasons: ['timeout'] };
  assert.deepEqual(retryAdmission(args), { ok: false, reason: 'queue_headroom_exhausted' });
  assert.deepEqual(retryAdmission({ ...args, queueAgeMinutes: 5 }), { ok: true, consumesAttempt: false });
  assert.deepEqual(retryAdmission({ ...args, failureReason: 'implementation', queueAgeMinutes: 5,
    infraReasons: ['timeout'] }), { ok: true, consumesAttempt: true });
});

test('infrastructure recovery remains admissible at the attempt ceiling', () => {
  const args = { attempt: 2, maxAttempts: 2, failureReason: 'timeout',
    queueAgeMinutes: 5, queueTtlMinutes: 120, infraReasons: ['timeout'] };
  assert.deepEqual(retryAdmission(args), { ok: true, consumesAttempt: false });
  assert.deepEqual(retryAdmission({ ...args, failureReason: 'implementation' }), {
    ok: false, reason: 'attempt_budget_exhausted'
  });
});

test('paid dispatch requires a live configured agent', () => {
  assert.equal(spendPreflight({ max_concurrent_tasks: 4, instructions: 'Queue', model: 'deepseek/v4' }, { provider: 'openrouter', token_budget: 1000 }).ok, true);
  assert.equal(spendPreflight({ max_concurrent_tasks: 0, instructions: 'Queue', model: 'deepseek/v4' }, { provider: 'openrouter', token_budget: 1000 }).ok, false);
  assert.equal(spendPreflight({ max_concurrent_tasks: 4, instructions: 'Queue', model: 'deepseek/v4' }, { provider: 'openrouter' }).ok, false);
  assert.equal(spendPreflight({ max_concurrent_tasks: null, instructions: 'Queue', model: 'gpt-5.6-luna' }, { provider: 'codex' }).ok, true);
  assert.equal(spendPreflight({ max_concurrent_tasks: 4, instructions: 'Queue', model: '' }, { provider: 'codex' }).ok, true);
  assert.deepEqual(spendPreflight({ id: 'a-1', name: 'DeepSeek Builder', instructions: 'Queue', runtime_config: { quota_paused: true } }, { provider: 'codex' }),
    { ok: false, reason: 'provider_quota_paused:DeepSeek Builder' });
  assert.deepEqual(spendPreflight({ agent_name: 'Queued Builder', instructions: 'Queue', runtime_config: { quota_paused: true } }, { provider: 'codex' }),
    { ok: false, reason: 'provider_quota_paused:Queued Builder' });
});

test('quota pauses self-clear after fifteen minutes without an exhausted workspace budget', () => {
  const now = Date.parse('2026-09-01T12:16:00.000Z');
  const old = '2026-09-01T12:00:00.000Z';
  assert.deepEqual(quotaPauseClearance({ pausedAt: old, budgetExhausted: false, now }), {
    clear: true, reason: 'build_budget_not_exhausted'
  });
  assert.deepEqual(quotaPauseClearance({ pausedAt: old, budgetExhausted: true, now }), {
    clear: false, reason: 'build_budget_exhausted'
  });
  assert.deepEqual(quotaPauseClearance({ pausedAt: old, budgetExhausted: false,
    now: Date.parse(old) + QUOTA_PAUSE_MAX_AGE_MS }), {
    clear: false, reason: 'pause_within_grace_period'
  });
  assert.deepEqual(quotaPauseClearance({ pausedAt: 'not-a-timestamp', budgetExhausted: true, now }), {
    clear: true, reason: 'invalid_pause_timestamp'
  });
  assert.equal(quotaPauseFlipLogLine('DeepSeek Builder', old, true),
    'quota_paused flip agent="DeepSeek Builder" timestamp=2026-09-01T12:00:00.000Z value=true');
});

test('stage cycle breaker escalates repeated task creation to Sol-low re-spec', () => {
  assert.deepEqual(stageCycleAdmission(0), { ok: true, ceiling: 2 });
  assert.deepEqual(stageCycleAdmission(1), { ok: true, ceiling: 2 });
  assert.deepEqual(stageCycleAdmission(2), {
    ok: false, reason: 'stage_cycle_limit', ceiling: 2,
    disposition: 'Spec', escalation: 'sol_low_respec'
  });
});

test('recovery ceilings count queued tasks that never started', () => {
  const source = fs.readFileSync(
    require.resolve('./parity/multica-relay-advance-daemon.cjs'), 'utf8'
  );
  const stageHistory = source.match(
    /SELECT count\(\*\)::int AS n FROM agent_task_queue\s+WHERE issue_id = \$1 AND context->>'to_stage' = \$2\s+AND trigger_comment_id IS NULL\s+AND \(\$3::timestamptz IS NULL OR created_at >= \$3\)/
  );
  const lifetimeHistory = source.match(
    /SELECT count\(\*\)::int AS n FROM agent_task_queue\s+WHERE issue_id = \$1\s+AND trigger_comment_id IS NULL\s+AND \(\$2::timestamptz IS NULL OR created_at >= \$2\)/
  );
  assert.ok(stageHistory, 'stage ceiling must count every non-comment task');
  assert.ok(lifetimeHistory, 'lifetime ceiling must count every non-comment task');
});

test('lifetime ceiling bounds paid work across stage changes', () => {
  assert.deepEqual(lifetimeTaskAdmission(5), { ok: true, ceiling: 6 });
  assert.deepEqual(lifetimeTaskAdmission(6), {
    ok: false, reason: 'lifetime_task_limit', ceiling: 6,
    disposition: 'Spec', escalation: 'sol_low_respec'
  });
});

test('human and disposition stages never execute tasks', () => {
  assert.equal(isExecutionStage('Queue'), true);
  assert.equal(isExecutionStage('Human Review'), false);
  assert.equal(isExecutionStage('Parked'), false);
  assert.equal(isExecutionStage('Rejected'), false);
  assert.equal(isExecutionStage('Done'), false);
  assert.equal(isExecutionStage('Archived'), false);
});

test('startup rejects routable stages without an owner', () => {
  const rows = [
    { stage_name: 'Queue', next_stage: 'In Progress', agent_id: 'builder',
      owner_id: 'builder', owner_status: 'working', owner_archived_at: null,
      owner_instructions: 'Own Queue and In Progress build stages' },
    { stage_name: 'Parked', next_stage: 'Queue', agent_id: null },
    { stage_name: 'Human Review', next_stage: 'CI/CD & Deploy', agent_id: null },
    { stage_name: 'Done', next_stage: 'Archived', agent_id: null },
    { stage_name: 'Archived', next_stage: null, agent_id: null }
  ];
  assert.deepEqual(routableOwnerDefects(rows), [
    'Human Review:missing_owner', 'Parked:missing_owner'
  ]);
  assert.throws(() => assertRoutableStageOwners(rows), /Human Review:missing_owner/);
  assert.doesNotThrow(() => assertRoutableStageOwners([rows[0], rows[3], rows[4]]));
});

test('startup rejects archived, inactive, and instruction-incompatible owners', () => {
  const owner = { agent_id: 'agent', owner_id: 'agent', owner_status: 'idle',
    owner_archived_at: null, owner_instructions: 'Own Queue and In Progress build stages' };
  const rows = [
    { stage_name: 'Spec', next_stage: 'Queue', ...owner, owner_archived_at: '2026-09-01' },
    { stage_name: 'Queue', next_stage: 'In Progress', ...owner, owner_status: 'offline' },
    { stage_name: 'In Progress', next_stage: 'In Review', ...owner }
  ];
  assert.deepEqual(routableOwnerDefects(rows), [
    'In Progress:instruction_incompatible',
    'Queue:owner_inactive',
    'Spec:owner_archived'
  ]);
});

test('quota circuit pauses only after consecutive money failures', () => {
  assert.deepEqual(quotaCircuitAdmission(['402', 'provider_quota_limit', 'payment required']),
    { pause: true, consecutive: 3, ceiling: 3 });
  assert.deepEqual(quotaCircuitAdmission(['402', 'timeout', '402']),
    { pause: false, consecutive: 1, ceiling: 3 });
});

test('quota circuit ignores a quota failure outside the pause window', () => {
  const now = Date.parse('2026-09-02T02:00:00.000Z');
  assert.deepEqual(quotaCircuitAdmission([{ failure_reason: 'provider_quota_limit',
    updated_at: new Date(now - QUOTA_PAUSE_MAX_AGE_MS - 1).toISOString() }], 1, { now }),
  { pause: false, consecutive: 0, ceiling: 1 });
});
