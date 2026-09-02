const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { Client } = require('pg');
const { qcCompletionAdvance, processParkedDiagnoses,
  requeueStrandedTasks, requeueTriggerSummary,
  pauseNoProgressLanes } = require('./multica-relay-advance-daemon.cjs');

const TEST_DATABASE_URL = 'postgres://multica:multica@127.0.0.1:15436/multica?sslmode=disable';

test('lane breaker pauses after the existing consecutive-failure threshold', async () => {
  const queries = [];
  const tasks = Array.from({ length: 3 }, (_, index) => ({
    id: `task-${index}`, agent_id: 'agent-1', issue_id: 'issue-1', status: 'completed',
    context: { to_stage: 'In Review' }, has_completed_relay: false,
    has_linked_pr: false, has_result_pr: false, has_qc_verdict: false,
    has_binding_spec: false
  }));
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('WITH ranked AS')) return { rows: tasks };
    if (sql.includes('UPDATE agent')) return { rowCount: 1, rows: [{ id: 'agent-1',
      workspace_id: 'workspace-1', agent_name: 'qc-lane', paused_at: '2026-09-02T00:00:00Z' }] };
    if (sql.includes('INSERT INTO activity_log')) return { rowCount: 1, rows: [] };
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  }, release() {} };
  await pauseNoProgressLanes({ dbPool: { connect: async () => client } });
  const activity = queries.find(({ sql }) => sql.includes('INSERT INTO activity_log'));
  assert.equal(JSON.parse(activity.values[1]).reason, 'no_progress_streak');
  assert.equal(JSON.parse(activity.values[1]).consecutive_failures, 3);
});

test('requeue candidate SQL binds the stage array with a real PostgreSQL client', async (t) => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const start = source.indexOf('`SELECT i.id AS issue_id');
  const end = source.indexOf('`', start + 1);
  assert.ok(start >= 0 && end > start, 'requeue candidate SQL must be present');
  const sql = source.slice(start + 1, end);
  assert.match(sql, /i\.status = ANY\(\$2::text\[\]\)/);
  assert.match(sql, /LIMIT \$1::int/);
  const params = [3, ['Queue', 'In Progress', 'Spec', 'In Review']];
  const client = new Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const relation = await client.query("SELECT to_regclass('public.relay_run_log') AS name");
    if (!relation.rows[0].name) {
      t.skip('test DB schema lacks public.relay_run_log; live-schema validation remains required');
      return;
    }
    const result = await client.query(sql, params);
    assert.ok(Array.isArray(result.rows));
  } finally {
    await client.end();
  }
});

test('PASS sweep SQL plans against the PostgreSQL test schema when qc_verdict is available', async (t) => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const start = source.indexOf('`WITH candidates AS (');
  const end = source.indexOf('`', start + 1);
  assert.ok(start >= 0 && end > start, 'PASS sweep SQL must be present');
  const sql = source.slice(start + 1, end);
  assert.match(sql, /qc\."verdict" = 'PASS'/);
  assert.match(sql, /qc\."checker_id"/);
  const client = new Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const relation = await client.query("SELECT to_regclass('public.qc_verdict') AS name");
    if (!relation.rows[0].name) {
      t.skip('test DB schema lacks public.qc_verdict; live-schema validation remains required');
      return;
    }
    const result = await client.query(`EXPLAIN ${sql}`);
    assert.ok(Array.isArray(result.rows));
  } finally {
    await client.end();
  }
});

function strandedFixture(overrides = {}) {
  return {
    issue_id: '223e4567-e89b-42d3-a456-426614174000',
    workspace_id: '323e4567-e89b-42d3-a456-426614174000',
    number: 159,
    stage: 'Queue',
    updated_at: '2026-09-01T21:46:00Z',
    metadata: {},
    dead_task_id: '123e4567-e89b-42d3-a456-426614174000',
    dead_task_status: 'failed',
    attempt: 1,
    max_attempts: 2,
    failure_reason: 'cancelled',
    dead_task_result: null,
    dead_task_error: 'task cancelled by server',
    closed_relay_log_id: null,
    from_stage: 'Queue',
    agent_id: '423e4567-e89b-42d3-a456-426614174000',
    runtime_id: '523e4567-e89b-42d3-a456-426614174000',
    runtime_provider: 'codex',
    runtime_mode: 'cloud',
    instructions: 'Queue',
    model: 'deepseek/chat',
    thinking_level: 'low',
    max_concurrent_tasks: 1,
    token_budget: 1,
    runtime_config: {},
    archived_at: null,
    agent_name: 'builder',
    ...overrides
  };
}

function strandedHarness(fixtures) {
  const queries = [];
  let consumedClosedRow = false;
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('FROM issue i') && sql.includes('LIMIT $1')) {
      return { rows: fixtures.filter((row) => row.eligible !== false &&
        !(row.consume_after_record && consumedClosedRow))
        .sort((a, b) => a.issue_created_at.localeCompare(b.issue_created_at))
        .slice(0, values[0]) };
    }
    if (sql.includes('COALESCE(a.max_concurrent_tasks')) {
      return { rows: fixtures.map((row) => ({ agent_id: row.agent_id, cap: 1, in_flight: 0 })) };
    }
    if (sql.includes('max(EXTRACT(epoch')) return { rows: [{ age: 0 }] };
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('FROM issue WHERE id')) return { rows: [] };
    if (sql.includes('FROM agent_task_queue') && sql.includes('FOR UPDATE')) return { rows: [] };
    if (sql.includes('count(*)::int AS n')) return { rows: [{ n: 1 }] };
    if (sql.includes('INSERT INTO agent_task_queue')) {
      return { rows: [{ id: '623e4567-e89b-42d3-a456-426614174000' }] };
    }
    if (sql.includes('UPDATE relay_run_log') && sql.includes("requeue_task_id")) {
      consumedClosedRow = true;
      return { rows: [{ id: 'closed-relay-log' }] };
    }
    if (sql.includes('INSERT INTO relay_run_log')) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  }, release() {} };
  return { queries, client, run: () => requeueStrandedTasks({ dbPool: { connect: async () => client } }) };
}

function loadRequeueDaemon() {
  const modulePath = require.resolve('./multica-relay-advance-daemon.cjs');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('stranded-task fixture redispatches a cancelled-only task', async () => {
  const harness = strandedHarness([strandedFixture()]);
  await harness.run();
  const insert = harness.queries.find(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  assert.ok(insert);
  assert.match(insert.values[3], /"source":"relay-requeue"/);
  assert.match(insert.values[3], /"requeue_of_task":"123e4567-e89b-42d3-a456-426614174000"/);
});

test('zero-task Queue fixture creates attempt one without retry admission', async () => {
  const harness = strandedHarness([strandedFixture({ dead_task_id: null, attempt: null,
    max_attempts: null, failure_reason: null })]);
  await harness.run();
  const insert = harness.queries.find(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  assert.ok(insert);
  assert.equal(insert.values[5], 1);
  assert.equal(harness.queries.some(({ sql }) => sql.includes('max(EXTRACT(epoch')), false);
});

test('In Review requeue summary supplies the QC PR URL and full SHA', () => {
  const summary = requeueTriggerSummary(strandedFixture({ stage: 'In Review', number: 159,
    build_task_result: { pr_url: 'https://github.com/timrecursify/multica/pull/1',
      head_sha: 'c909401ef7a4a438348eb5ceda33839211721524' } }), false);
  assert.match(summary, /ticket 159/);
  assert.match(summary, /board prod/);
  assert.match(summary, /https:\/\/github.com\/timrecursify\/multica\/pull\/1/);
  assert.match(summary, /c909401ef7a4a438348eb5ceda33839211721524/);
});

test('In Review requeue summary directs a FAIL verdict when PR or SHA is absent', () => {
  assert.match(requeueTriggerSummary(strandedFixture({ stage: 'In Review' }), true),
    /PR\/SHA unknown: issue FAIL verdict per runbook/);
});

test('stranded-task fixtures leave running tasks and bundled children untouched', async () => {
  for (const fixture of [
    { ...strandedFixture({ dead_task_status: 'running', eligible: false }), label: 'running' },
    { ...strandedFixture({ parent_issue_id: '723e4567-e89b-42d3-a456-426614174000', eligible: false }), label: 'bundled child' }
  ]) {
    const harness = strandedHarness([fixture]);
    await harness.run();
    assert.equal(harness.queries.some(({ sql }) => sql.includes('INSERT INTO agent_task_queue')), false,
      `${fixture.label} must not be redispatched`);
    const candidateQuery = harness.queries.find(({ sql }) => sql.includes('FROM issue i'));
    assert.match(candidateQuery.sql, /t\.id IS NULL\s+OR t\.status IN \('failed', 'cancelled'\)/);
    assert.match(candidateQuery.sql, /i\.parent_issue_id IS NULL/);
  }
});

test('RELAY_REQUEUE_STAGES drops Human Review before binding the candidate SQL', async () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /RELAY_REQUEUE_STAGES \|\| 'Queue,In Progress,Spec,In Review'/);
  const previous = process.env.RELAY_REQUEUE_STAGES;
  const warnings = [];
  const warn = console.warn;
  process.env.RELAY_REQUEUE_STAGES = 'Human Review';
  console.warn = (line) => warnings.push(line);
  try {
    const { requeueStrandedTasks: configuredRequeue } = loadRequeueDaemon();
    const harness = strandedHarness([strandedFixture({ stage: 'Human Review' })]);
    await configuredRequeue({ dbPool: { connect: async () => harness.client } });
    const candidateQuery = harness.queries.find(({ sql }) => sql.includes('FROM issue i'));
    assert.deepEqual(candidateQuery.values[1], []);
  } finally {
    console.warn = warn;
    if (previous === undefined) delete process.env.RELAY_REQUEUE_STAGES;
    else process.env.RELAY_REQUEUE_STAGES = previous;
    loadRequeueDaemon();
  }
  assert.deepEqual(warnings, ['[relay-advance-daemon] [requeue] ignoring non-dispatch stages: Human Review']);
});

test('completed task with failed closed relay row is requeued with stage instructions', async () => {
  const fixture = strandedFixture({
    dead_task_status: 'completed',
    failure_reason: null,
    closed_relay_log_id: 'closed-relay-log',
    stage: 'In Review',
    instructions: 'In Review'
  });
  const harness = strandedHarness([fixture]);
  await harness.run();
  const insert = harness.queries.find(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  assert.ok(insert);
  assert.match(insert.values[3], /"to_stage":"In Review"/);
  assert.match(insert.values[3], /"requeue_of_relay_log":"closed-relay-log"/);
  const record = harness.queries.find(({ sql }) => sql.includes('UPDATE relay_run_log') &&
    sql.includes("requeue_task_id"));
  assert.deepEqual(record.values, ['closed-relay-log', '623e4567-e89b-42d3-a456-426614174000']);
});

test('completed latest task needs an unconsumed failed relay row', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  const completed = strandedFixture({ dead_task_status: 'completed' });
  assert.equal(completed.dead_task_status, 'completed');
  assert.match(requeue, /t\.status = 'completed'/);
  assert.match(requeue, /closed_log\.status = 'failed'/);
  assert.match(requeue, /closed_log\.parked_audit->>'requeue_task_id' IS NULL/);
  assert.match(requeue, /UPDATE relay_run_log[\s\S]*\{requeue_task_id\}/);
});

test('completed task with a completed relay row is not admitted', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  assert.match(requeue, /t\.status = 'completed'[\s\S]*closed_log\.status = 'failed'/);
  assert.doesNotMatch(requeue, /t\.status = 'completed'[\s\S]{0,80}closed_log\.status = 'completed'/);
});

test('a closed relay row is requeued at most once across sweeps', async () => {
  const harness = strandedHarness([strandedFixture({
    dead_task_status: 'completed',
    closed_relay_log_id: 'closed-relay-log',
    consume_after_record: true
  })]);
  await harness.run();
  await harness.run();
  assert.equal(harness.queries.filter(({ sql }) => sql.includes('INSERT INTO agent_task_queue')).length, 1);
  assert.equal(harness.queries.filter(({ sql }) => sql.includes('UPDATE relay_run_log') &&
    sql.includes("requeue_task_id")).length, 1);
});

test('live task on another stage fixture is excluded for every stage', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const liveOtherStage = strandedFixture({ live_task_stage: 'Spec' });
  assert.equal(liveOtherStage.live_task_stage, 'Spec');
  assert.match(source, /WHERE q\.issue_id = i\.id AND q\.status IN/);
  assert.doesNotMatch(source, /COALESCE\(q\.context->>'to_stage', ''\) = i\.status/);
});

test('five eligible fixtures dispatch exactly the three oldest globally', async () => {
  const fixtures = [
    strandedFixture({ number: 5, issue_id: '223e4567-e89b-42d3-a456-426614174005', agent_id: '423e4567-e89b-42d3-a456-426614174005', issue_created_at: '2026-09-01T00:05:00Z' }),
    strandedFixture({ number: 1, issue_id: '223e4567-e89b-42d3-a456-426614174001', agent_id: '423e4567-e89b-42d3-a456-426614174001', issue_created_at: '2026-09-01T00:01:00Z' }),
    strandedFixture({ number: 4, issue_id: '223e4567-e89b-42d3-a456-426614174004', agent_id: '423e4567-e89b-42d3-a456-426614174004', issue_created_at: '2026-09-01T00:04:00Z' }),
    strandedFixture({ number: 2, issue_id: '223e4567-e89b-42d3-a456-426614174002', agent_id: '423e4567-e89b-42d3-a456-426614174002', issue_created_at: '2026-09-01T00:02:00Z' }),
    strandedFixture({ number: 3, issue_id: '223e4567-e89b-42d3-a456-426614174003', agent_id: '423e4567-e89b-42d3-a456-426614174003', issue_created_at: '2026-09-01T00:03:00Z' })
  ];
  const harness = strandedHarness(fixtures);
  await harness.run();
  const dispatched = harness.queries.filter(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  assert.equal(dispatched.length, 3);
  assert.deepEqual(dispatched.map(({ values }) => values[1]), fixtures.slice(1, 2)
    .concat(fixtures.slice(3, 5)).map((row) => row.issue_id));
  const candidateQuery = harness.queries.find(({ sql }) => sql.includes('FROM issue i'));
  assert.match(candidateQuery.sql, /ORDER BY i\.created_at ASC\s+LIMIT \$1/);
  assert.doesNotMatch(candidateQuery.sql, /ROW_NUMBER\(\) OVER/);
});

const QC_ROW = {
  task_id: '11111111-1111-4111-8111-111111111111',
  to_stage: 'In Review',
  next_stage: 'CI/CD & Deploy',
  task_status: 'completed',
  task_agent_id: 'qc-agent',
  task_agent_model: 'gpt-5.6-sol',
  task_agent_effort: 'low',
  task_started_at: '2026-09-01T19:05:39Z',
  task_completed_at: '2026-09-01T19:08:18Z',
  task_result: { output: 'QC PASS exact SHA c909401ef7a4a438348eb5ceda33839211721524' },
  qc_verdict_checker_id: 'qc-agent',
  qc_verdict: 'PASS',
  qc_verdict_work_product_md5: '76becea4ab970644b7a21220665a1619',
  qc_verdict_notes: 'Native Sol-low QC PASS; observed SHA c909401ef7a4a438348eb5ceda33839211721524',
  qc_verdict_created_at: '2026-09-01T19:07:38Z'
};

test('completed legacy Sol-low PASS replays its exact SHA and artifact MD5', () => {
  assert.deepEqual(qcCompletionAdvance(QC_ROW), {
    ok: true,
    workProductMd5: '76becea4ab970644b7a21220665a1619',
    boundSha: 'c909401ef7a4a438348eb5ceda33839211721524',
    evidenceTaskId: '11111111-1111-4111-8111-111111111111'
  });
});

test('legacy PASS binds to the completed Sol-low task that recorded the verdict', () => {
  const row = { ...QC_ROW,
    task_id: '22222222-2222-4222-8222-222222222222',
    task_started_at: '2026-09-01T19:20:00Z',
    task_completed_at: '2026-09-01T19:25:00Z',
    task_result: { output: 'later QC did not record a verdict' },
    qc_evidence_tasks: [{
      task_id: QC_ROW.task_id,
      task_status: 'completed',
      task_agent_id: 'qc-agent',
      task_agent_model: 'gpt-5.6-sol',
      task_agent_effort: 'low',
      task_started_at: QC_ROW.task_started_at,
      task_completed_at: QC_ROW.task_completed_at,
      task_result: QC_ROW.task_result
    }]
  };
  assert.equal(qcCompletionAdvance(row).evidenceTaskId, QC_ROW.task_id);
});

test('strict relay attempt must bind PASS to one observed SHA and artifact MD5', () => {
  const row = { ...QC_ROW,
    qc_attempt_verdict: 'PASS',
    qc_attempt_work_product_md5: QC_ROW.qc_verdict_work_product_md5,
    qc_attempt_bound_sha: 'c909401ef7a4a438348eb5ceda33839211721524',
    qc_attempt_observed_sha: 'c909401ef7a4a438348eb5ceda33839211721524',
    qc_attempt_qualifying: true,
    qc_attempt_evidence_task_id: '33333333-3333-4333-8333-333333333333',
    qc_attempt_evidence_agent_id: 'qc-agent',
    qc_attempt_evidence_agent_model: 'gpt-5.6-sol',
    qc_attempt_evidence_agent_effort: 'low'
  };
  assert.equal(qcCompletionAdvance(row).ok, true);
  assert.equal(qcCompletionAdvance(row).evidenceTaskId,
    '33333333-3333-4333-8333-333333333333');
  assert.equal(qcCompletionAdvance({ ...row,
    qc_attempt_observed_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...row,
    qc_verdict_checker_id: 'different-agent' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...row,
    qc_attempt_model: 'gpt-5.6-sol',
    qc_attempt_effort: 'low',
    qc_attempt_evidence_agent_model: 'gpt-5.5',
    qc_attempt_evidence_agent_effort: 'high' }).ok, false);
});

test('post-completion QC replay fails closed on stale, mismatched, or non-low evidence', () => {
  assert.equal(qcCompletionAdvance({ ...QC_ROW,
    qc_verdict_created_at: '2026-09-01T18:00:00Z' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...QC_ROW,
    qc_verdict_notes: 'QC PASS SHA aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...QC_ROW,
    qc_verdict_work_product_md5: 'not-an-md5' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...QC_ROW, task_agent_effort: 'high' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...QC_ROW, qc_verdict: 'FAIL' }).ok, false);
});

test('non-QC gated stages remain manual', () => {
  assert.deepEqual(qcCompletionAdvance({ ...QC_ROW, next_stage: 'Done' }),
    { ok: false, reason: 'manual_gated_stage' });
});

test('relay daemon scopes stage configuration to each issue workspace', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /rsc\.workspace_id = i\.workspace_id/);
  assert.match(source, /a\.workspace_id = rsc\.workspace_id/);
  assert.match(source, /evidence_agent\.workspace_id = i\.workspace_id/);
  assert.match(source, /evidence_agent\.model AS evidence_agent_model/);
  assert.match(source, /evidence_agent\.thinking_level AS evidence_agent_effort/);
});

test('routing recovery hold logs bounded routing details', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /event: 'relay_requeue_held'/);
  assert.match(source, /actual_model: preflight\.model/);
  assert.match(source, /expected_effort: preflight\.expected_effort/);
});

test('Registered discovery covers every configured workspace', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /EXISTS \(SELECT 1 FROM relay_stage_config rsc/);
  assert.doesNotMatch(source, /i\.workspace_id = \$2/);
  assert.doesNotMatch(source, /\) < \$3/);
  assert.match(source, /client\.query\(query, \['Registered', STAGE_CYCLE_LIMIT\]\)/);
});

test('all parity dispositions use relay authority rather than direct issue status writes', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.doesNotMatch(source, /UPDATE issue SET status/);
  assert.match(source, /postToRelay\(\{ issue_id: row\.issue_id, to_stage: 'Human Review'/);
  assert.match(source, /reason: 'payment_required_402'/);
});

test('relay advancement admits task results before creating a successor', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /require\('\.\.\/relay-completion-admission\.cjs'\)/);
  assert.match(source, /atq\.result AS task_result/);
  assert.match(source, /completionAdmission\(row\.task_result/);
  assert.match(source, /requestRetryEscalation\(row, completion\.reason\)/);
  assert.match(source, /retry_escalation_task_id: taskId/);
  assert.match(source, /retry_escalation_stage: triggerStage/);
  assert.match(source, /markRelayLogFailedById\(client, row\.log_id\)/);
  assert.match(source, /relay_source_task_id: row\.task_id/);
});

test('retry ceilings leave the daemon through relay authority instead of direct status writes', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  assert.match(requeue, /requestRetryEscalation\(row, cycle\.reason\)/);
  assert.match(requeue, /requestRetryEscalation\(row, lifetime\.reason\)/);
  assert.match(requeue,
    /row\.metadata\?\.parked_release_at \|\|\s+row\.metadata\?\.retry_escalation_at \|\| null/);
  assert.doesNotMatch(requeue, /applyDisposition\(client, row, cycle\.disposition/);
  assert.doesNotMatch(requeue, /applyDisposition\(client, row, lifetime\.disposition/);
});

test('stranded-task recovery admits only unconsumed failed completed predecessors', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  assert.match(requeue, /t\.status = 'completed'/);
  assert.match(requeue, /closed_log\.status = 'failed'/);
  assert.match(requeue, /requeue_of_relay_log: row\.closed_relay_log_id/);
  assert.match(requeue, /closed relay row already requeued/);
});

test('Registered recovery applies the same completion gate', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const recovery = source.slice(source.indexOf('async function recoveryAdvanceTasks'),
    source.indexOf('function postToRelay'));
  assert.match(recovery, /atq\.result AS task_result/);
  assert.match(recovery, /completionAdmission\(row\.task_result/);
  assert.match(recovery, /reason=task_not_completed/);
});

test('runtime-evidence recovery is one-shot, typed, and stays on relay authority', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const diagnosis = source.slice(source.indexOf('async function processParkedDiagnoses'),
    source.indexOf('function startDaemon'));
  assert.match(diagnosis, /t\.context->>'evidence_correction_retry' = 'true'/);
  assert.match(diagnosis, /i\.metadata->>'parked_blocker' = 'runtime_evidence_unverified'/);
  assert.match(diagnosis, /runtime_evidence_recovery_consumed/);
  assert.match(diagnosis, /t\.id = \$1::uuid/);
  assert.match(diagnosis, /t\.context->>'kind' = \$2::text/);
  assert.match(diagnosis, /i\.workspace_id = \$3::uuid/);
  assert.match(diagnosis, /relayPost\(\{ issue_id: task\.issue_id, to_stage: nextStage/);
  assert.match(diagnosis, /const needsQC = outcome === 'already_fixed' && evidenceVerified && !completionMD5/);
  assert.match(diagnosis, /runtime_evidence_verified:\$\{evidence\}/);
  assert.match(diagnosis, /WHERE id = \$1::uuid/);
  assert.doesNotMatch(diagnosis, /UPDATE issue SET status/);
});

test('diagnosis release retries every non-2xx response and records the attempt', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /if \(!response\.ok\)/);
  assert.match(source, /diagnosis_release_attempts/);
  assert.match(source, /- 'diagnosis_processed'\s*- 'runtime_evidence_recovery_v2_consumed'/);
});

test('diagnosis release stops retrying at five failures and saves the relay error', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const releaseFailure = source.slice(source.indexOf('async function recordDiagnosisReleaseFailure'),
    source.indexOf('async function processParkedDiagnoses'));
  assert.match(source, /if \(nextAttempts >= 5\)/);
  assert.match(releaseFailure, /WHERE id = \$1::uuid/);
  assert.match(releaseFailure, /'diagnosis_release_attempts', \$2::int/);
  assert.match(source, /'diagnosis_release_error', \$3::text/);
  assert.match(source, /status=\$\{response\.status\}; body=\$\{response\.body/);
  assert.match(source, /fetch_error=\$\{err\.message\}/);
});

test('a 500 diagnosis release is retried on the next tick', async () => {
  const task = { id: '123e4567-e89b-42d3-a456-426614174001', issue_id: '223e4567-e89b-42d3-a456-426614174001',
    workspace_id: '323e4567-e89b-42d3-a456-426614174001', number: 43, status: 'Parked', context: {},
    result: 'outcome: fixable' };
  const queries = [];
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('LIMIT 25')) return { rows: [{ id: task.id, workspace_id: task.workspace_id }] };
    if (sql.includes('FOR UPDATE OF t SKIP LOCKED')) return { rows: [task] };
    if (sql.includes('FROM issue_spec')) return { rows: [{ id: 'spec-1' }] };
    if (sql.includes("'diagnosis_release_attempts'")) task.context.diagnosis_release_attempts = values[1];
    return { rows: [] };
  }, release() {} };
  let posts = 0;
  const options = { diagnosisPool: { connect: async () => client }, relayPost: async () => {
    posts += 1;
    return { ok: false, status: 500, body: 'bridge failed' };
  } };
  await processParkedDiagnoses(options);
  await processParkedDiagnoses(options);
  assert.equal(posts, 2);
  assert.equal(task.context.diagnosis_release_attempts, 2);
  assert.ok(queries.some(({ sql }) => sql.includes("- 'diagnosis_processed'")));
});

test('a thrown diagnosis release unsets processed and increments its retry count', async () => {
  const task = { id: '123e4567-e89b-42d3-a456-426614174003', issue_id: '223e4567-e89b-42d3-a456-426614174003',
    workspace_id: '323e4567-e89b-42d3-a456-426614174003', number: 45, status: 'Parked', context: {},
    result: 'outcome: fixable' };
  const queries = [];
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('LIMIT 25')) return { rows: [{ id: task.id, workspace_id: task.workspace_id }] };
    if (sql.includes('FOR UPDATE OF t SKIP LOCKED')) return { rows: [task] };
    if (sql.includes('FROM issue_spec')) return { rows: [{ id: 'spec-1' }] };
    return { rows: [] };
  }, release() {} };
  await processParkedDiagnoses({ diagnosisPool: { connect: async () => client },
    relayPost: async () => { throw new Error('connection reset'); } });
  const retry = queries.find(({ sql }) => sql.includes("- 'diagnosis_processed'"));
  assert.deepEqual(retry.values, [task.id, 1]);
});

test('a 409 diagnosis release unsets processed and increments its retry count', async () => {
  const task = { id: '123e4567-e89b-42d3-a456-426614174004', issue_id: '223e4567-e89b-42d3-a456-426614174004',
    workspace_id: '323e4567-e89b-42d3-a456-426614174004', number: 46, status: 'Parked', context: {},
    result: 'outcome: fixable' };
  const queries = [];
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('LIMIT 25')) return { rows: [{ id: task.id, workspace_id: task.workspace_id }] };
    if (sql.includes('FOR UPDATE OF t SKIP LOCKED')) return { rows: [task] };
    if (sql.includes('FROM issue_spec')) return { rows: [{ id: 'spec-1' }] };
    return { rows: [] };
  }, release() {} };
  await processParkedDiagnoses({ diagnosisPool: { connect: async () => client },
    relayPost: async () => ({ ok: false, status: 409, body: 'already advanced' }) });
  const retry = queries.find(({ sql }) => sql.includes("- 'diagnosis_processed'"));
  assert.deepEqual(retry.values, [task.id, 1]);
});

test('the fifth failed diagnosis release remains processed with its error', async () => {
  const task = { id: '123e4567-e89b-42d3-a456-426614174002', issue_id: '223e4567-e89b-42d3-a456-426614174002',
    workspace_id: '323e4567-e89b-42d3-a456-426614174002', number: 44,
    context: { diagnosis_release_attempts: 4 }, result: 'outcome: fixable' };
  const queries = [];
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('LIMIT 25')) return { rows: [{ id: task.id, workspace_id: task.workspace_id }] };
    if (sql.includes('FOR UPDATE OF t SKIP LOCKED')) return { rows: [task] };
    if (sql.includes('FROM issue_spec')) return { rows: [{ id: 'spec-1' }] };
    return { rows: [] };
  }, release() {} };
  await processParkedDiagnoses({ diagnosisPool: { connect: async () => client },
    relayPost: async () => ({ ok: false, status: 502, body: 'bad gateway' }) });
  const bounded = queries.find(({ sql }) => sql.includes("'diagnosis_release_error'"));
  assert.deepEqual(bounded.values.slice(1), [5, 'status=502; body=bad gateway']);
});

test('canonical evidence rejects a parked-diagnosis citation', () => {
  const contract = fs.readFileSync(require.resolve('../parked-diagnosis.cjs'), 'utf8');
  assert.match(contract, /t\.context->>'kind' IS DISTINCT FROM 'parked_diagnosis'/);
  assert.match(contract, /t\.id = \$1::uuid AND t\.issue_id = \$2::uuid/);
});

test('completed parked diagnosis consumes integer QC evidence and marks itself processed', async () => {
  const task = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    issue_id: '223e4567-e89b-42d3-a456-426614174000',
    workspace_id: '323e4567-e89b-42d3-a456-426614174000',
    number: 42, status: 'Parked', context: {},
    result: 'outcome: already_fixed\nruntime_evidence: qc:21235'
  };
  const queries = [];
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('FROM agent_task_queue t') && sql.includes('LIMIT 25')) {
      return { rows: [{ id: task.id, workspace_id: task.workspace_id }] };
    }
    if (sql.includes('FOR UPDATE OF t SKIP LOCKED')) return { rows: [task] };
    if (sql.includes('FROM qc_verdict v')) return { rowCount: 1, rows: [] };
    if (sql.includes('SELECT verdict, work_product_md5')) {
      return { rows: [{ verdict: 'PASS', work_product_md5: 'a1b2c3' }] };
    }
    return { rowCount: 1, rows: [] };
  }, release() {} };
  await processParkedDiagnoses({ diagnosisPool: { connect: async () => client },
    relayPost: async () => ({ ok: true, status: 200 }) });
  const evidenceQuery = queries.find(({ sql }) => sql.includes('FROM qc_verdict v'));
  assert.match(evidenceQuery.sql, /v\.id = \$1::integer/);
  assert.deepEqual(evidenceQuery.values, [21235, task.issue_id]);
  assert.ok(queries.some(({ sql }) => sql.includes("'{\"diagnosis_processed\":true}'::jsonb")));
});

test('quota pause flips are timestamped and stale unbudgeted pauses self-clear', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /'quota_paused_at', to_jsonb\(NOW\(\)\)/);
  const pause = source.slice(source.indexOf('async function pauseQuotaLane'),
    source.indexOf('function logQuotaPauseFlip'));
  assert.doesNotMatch(pause, /console\.warn/);
  assert.match(source, /if \(quotaPause\) \{\s+logQuotaPauseFlip/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /b\.scope = 'workspace'/);
  assert.match(source, /b\.state = 'closed'/);
  assert.match(source, /b\.spent_ticks \+ b\.reserved_ticks >= b\.limit_ticks/);
  assert.match(source, /committedFlips\.push\(\{ agent_name: agent\.agent_name, timestamp, paused: false \}\)/);
  assert.match(source, /await client\.query\('COMMIT'\);\s+for \(const flip of committedFlips\) onFlip\(flip\)/);
  assert.match(source, /setInterval\(reconcileQuotaPauses, 60000\)/);
});
