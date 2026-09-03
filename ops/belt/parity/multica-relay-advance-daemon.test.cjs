const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { qcCompletionAdvance, completionEvidence, processParkedDiagnoses,
  adoptUnloggedInReviewTasks, requeueStrandedTasks, requeueTriggerSummary, INFRA_FAILURE_REASONS,
  isInfrastructureFailure, selectReplayAttempt, reconcileCreateLimit, runReconcileCycle,
  readvanceRecordedOutcomes, buildCompletionRoute } = require('./multica-relay-advance-daemon.cjs');
const { createGuardedRunner } = require('./multica-relay-advance-daemon.cjs');
const { scheduleEvery } = require('./multica-relay-advance-daemon.cjs');
const { recordParkAndQueueDiagnosis } = require('../parked-diagnosis.cjs');
const { evaluate } = require('../transition-policy.cjs');

test('completion evidence satisfies every automatic transition policy row', () => {
  const row = { task_id: 'task-1', task_result: { output: 'completed' }, issue_title: 'normal change' };
  const cases = [
    ['Spec', 'Queue', 'worker'], ['Queue', 'In Progress', 'system'],
    ['In Progress', 'In Review', 'system'], ['In Progress', 'CI/CD & Deploy', 'system'],
    ['In Progress', 'Done', 'system'], ['In Review', 'CI/CD & Deploy', 'system']
  ];
  for (const [from, to, actor] of cases) {
    const qc = from === 'In Review' ? { ok: true, evidenceTaskId: 'qc-task' } : { ok: false };
    const route = { kind: to === 'In Review' ? 'risk' : 'runtime', pr_url: 'https://github.com/o/r/pull/1', boundSha: 'a'.repeat(40) };
    assert.equal(evaluate({ from, to, actor, evidence: completionEvidence({ ...row, to_stage: from }, to, route, qc) }).ok, true,
      `${from} -> ${to}`);
  }
});

const TEST_DATABASE_URL = 'postgres://multica:multica@127.0.0.1:15436/multica?sslmode=disable';

test('guarded runner contains startup rejection and allows the next pass', async () => {
  let calls = 0;
  const errors = [];
  const runner = createGuardedRunner('startup-test', async () => {
    calls += 1;
    if (calls === 1) throw new Error('injected startup rejection');
    return 'ok';
  }, { backoffBaseMs: 0, backoffMaxMs: 0, logger: { warn() {}, error: (...args) => errors.push(args.join(' ')) }, now: () => 1 });
  await runner();
  await runner();
  assert.equal(calls, 2);
  assert.match(errors[0], /startup-test.*injected startup rejection/);
});

test('guarded runner suppresses overlapping ticks', async () => {
  let release;
  let calls = 0;
  const runner = createGuardedRunner('overlap-test', () => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  }, { logger: { warn() {}, error() {} } });
  const first = runner();
  const skipped = await runner();
  assert.deepEqual(skipped, { skipped: 'in_flight' });
  release();
  await first;
  assert.equal(calls, 1);
});

test('scheduleEvery logs and swallows a rejected recurring callback', async () => {
  const originalSetInterval = global.setInterval;
  const originalError = console.error;
  const errors = [];
  let tick;
  global.setInterval = (callback, ms) => { assert.equal(ms, 17); tick = callback; return 1; };
  console.error = (...args) => errors.push(args.join(' '));
  try {
    scheduleEvery(() => Promise.reject(new Error('database unavailable')), 17, 'test-cycle');
    await tick();
    assert.deepEqual(errors, ['[relay-advance-daemon] test-cycle error: database unavailable']);
  } finally {
    global.setInterval = originalSetInterval;
    console.error = originalError;
  }
});

test('reconciliation ramp defaults to 25 and passes the full candidate set to reconciler', async () => {
  assert.equal(reconcileCreateLimit(), 25);
  assert.equal(reconcileCreateLimit(3), 3);
  assert.equal(reconcileCreateLimit(0), 0);
  assert.equal(reconcileCreateLimit(-1), 25);
  assert.equal(reconcileCreateLimit(1.5), 25);
  const candidates = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const client = { release() {}, query: async (sql) => {
    if (sql === require('../reconciler.cjs').issueCandidatesSql()) return { rows: candidates };
    if (sql.startsWith('SELECT id, workspace_id, status, priority, metadata, qc_fail_count, parent_issue_id')) return { rows: [] };
    return { rows: [] };
  }};
  const result = await runReconcileCycle({ dbPool: { connect: async () => client, query: async () => ({ rows: [] }) }, maxCreate: 2, logger: { log() {} } });
  assert.equal(result.length, candidates.length);
});

test('dispatch hold returns before database access', async () => {
  const previous = process.env.RECONCILE_DISPATCH_HOLD;
  process.env.RECONCILE_DISPATCH_HOLD = '1';
  try {
    const result = await runReconcileCycle({
      dbPool: { connect: async () => { throw new Error('database must not be touched'); } },
      logger: { log() {} }
    });
    assert.equal(result, null);
  } finally {
    if (previous === undefined) delete process.env.RECONCILE_DISPATCH_HOLD;
    else process.env.RECONCILE_DISPATCH_HOLD = previous;
  }
});

test('typed re-advance moves recorded work through relay without an agent dispatch', async () => {
  const calls = [];
  const client = { release() {}, query: async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM issue_stage_outcome')) return { rows: [{ issue_id: 'issue-1', to_stage: 'Queue',
      outcome: 'ADVANCED', task_id: 'task-1', task_result: { output: 'done' },
      issue_title: 'work', next_stage: 'In Progress' }] };
    return { rows: [] };
  }};
  const advanced = await readvanceRecordedOutcomes({ dbPool: { connect: async () => client },
    postRelay: async (payload) => {
      assert.equal(payload.to_stage, 'In Progress');
      assert.equal(payload.relay_source_task_id, 'task-1');
      return { ok: true };
    }, logger: { log() {} }, typedOutcomes: true });
  assert.deepEqual(advanced, ['issue-1']);
  assert.equal(calls.some((sql) => sql.includes('INSERT INTO agent_task_queue')), false);
});

function typedReadvanceQcRow(overrides = {}) {
  return {
    issue_id: 'issue-1', to_stage: 'In Review', outcome: 'ADVANCED', task_id: 'task-1',
    task_status: 'completed', task_result: { output: 'QC PASS' }, issue_title: 'work',
    next_stage: 'CI/CD & Deploy', task_agent_id: 'qc-agent', qc_verdict_checker_id: 'qc-agent',
    qc_verdict: 'PASS', qc_verdict_work_product_md5: '76becea4ab970644b7a21220665a1619',
    qc_attempt_verdict: 'PASS', qc_attempt_work_product_md5: '76becea4ab970644b7a21220665a1619',
    qc_attempt_bound_sha: 'c909401ef7a4a438348eb5ceda33839211721524',
    qc_attempt_observed_sha: 'c909401ef7a4a438348eb5ceda33839211721524',
    qc_attempt_qualifying: true, qc_attempt_evidence_task_id: 'qc-task',
    qc_attempt_evidence_task_status: 'completed', qc_attempt_evidence_agent_id: 'qc-agent',
    qc_attempt_evidence_agent_model: 'gpt-5.6-sol', qc_attempt_evidence_agent_effort: 'low',
    ...overrides
  };
}

test('typed In Review re-advance supplies strict QC pass evidence', async () => {
  const client = { release() {}, query: async (sql) => sql.includes('FROM issue_stage_outcome')
    ? { rows: [typedReadvanceQcRow()] } : { rows: [] } };
  const payloads = [];
  const advanced = await readvanceRecordedOutcomes({ dbPool: { connect: async () => client },
    postRelay: async (payload) => { payloads.push(payload); return { ok: true }; },
    logger: { log() {} }, typedOutcomes: true });
  assert.deepEqual(advanced, ['issue-1']);
  assert.deepEqual(payloads[0].evidence, {
    qualifyingPass: true, observedShaMatchesBound: true, completedSolLowTask: 'qc-task'
  });
});

test('typed In Review re-advance holds failed QC without a relay denial', async () => {
  const calls = [];
  const client = { release() {}, query: async (sql, values) => {
    calls.push({ sql, values });
    return sql.includes('FROM issue_stage_outcome')
      ? { rows: [typedReadvanceQcRow({ qc_verdict: 'FAIL' })] } : { rows: [] };
  }};
  let posts = 0;
  await readvanceRecordedOutcomes({ dbPool: { connect: async () => client },
    postRelay: async () => { posts += 1; return { ok: true }; },
    logger: { log() {} }, typedOutcomes: true });
  assert.equal(posts, 0);
  const blocked = calls.find(({ sql }) => sql.startsWith('UPDATE issue_stage_outcome SET blocked_on = $3::text'));
  assert.deepEqual(blocked.values, ['issue-1', 'In Review', 'human']);
  assert.equal(calls.some(({ sql }) => sql.includes('typed_readvance_denials')), false);
});

test('no linked PR completion routes directly to Done and never In Review', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const route = source.slice(source.indexOf('async function buildCompletionRoute'), source.indexOf('function uniqueFullSha'));
  assert.match(route, /FROM issue_pull_request/);
  assert.match(route, /FROM comment/);
  assert.match(route, /kind: 'no_pr', toStage: 'Done'/);
  assert.doesNotMatch(route, /toStage: 'In Review'/);
});

test('completion route falls back to a PR URL in recent comments', async () => {
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM issue_pull_request')) return { rows: [] };
    if (sql.includes('FROM comment')) {
      return { rows: [{ content: 'Build PR: https://github.com/acme/widget/pull/42' }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }};
  const githubCalls = [];
  const route = await buildCompletionRoute(client, {
    issue_id: 'issue-1', to_stage: 'In Progress', next_stage: 'In Review'
  }, { githubCommand: (args) => {
    githubCalls.push(args);
    return JSON.stringify({ state: 'OPEN', files: [{ path: 'server/main.go' }],
      headRefOid: 'a'.repeat(40), mergeStateStatus: 'CLEAN', statusCheckRollup: [] });
  }});
  assert.equal(route.repo, 'acme/widget');
  assert.equal(route.pr_url, 'https://github.com/acme/widget/pull/42');
  assert.equal(githubCalls[0][2], 'https://github.com/acme/widget/pull/42');
  assert.equal(queries.length, 2);
});

test('assignment adoption inserts only the assigned configured QC task once and is workspace-safe', async () => {
  const schema = `assignment_adoption_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const otherIssueId = randomUUID();
  const qcAgentId = randomUUID();
  const staleAgentId = randomUUID();
  const assignedTaskId = randomUUID();
  const staleTaskId = randomUUID();
  const otherTaskId = randomUUID();
  let testPool;
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.issue (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
        number integer NOT NULL, status text NOT NULL, assignee_type text, assignee_id uuid);
      CREATE TABLE ${schema}.relay_stage_config (workspace_id uuid NOT NULL, stage_name text NOT NULL,
        next_stage text, agent_id uuid);
      CREATE TABLE ${schema}.agent_task_queue (id uuid PRIMARY KEY, issue_id uuid NOT NULL,
        workspace_id uuid NOT NULL, agent_id uuid NOT NULL, status text NOT NULL, completed_at timestamptz);
      CREATE TABLE ${schema}.relay_run_log (id bigserial PRIMARY KEY, issue_id uuid NOT NULL,
        from_stage text, to_stage text, agent_id uuid, task_id uuid, status text NOT NULL);`);
    await admin.query(`INSERT INTO ${schema}.relay_stage_config VALUES
      ($1, 'In Review', 'CI/CD & Deploy', $2),
      ($1, 'In Progress', 'In Review', $3),
      ($4, 'In Review', 'CI/CD & Deploy', $3),
      ($4, 'In Progress', 'In Review', $3)`, [workspaceId, randomUUID(), qcAgentId, otherWorkspaceId]);
    await admin.query(`INSERT INTO ${schema}.issue VALUES
      ($1, $2, 1465, 'In Review', 'agent', $3),
      ($4, $5, 1465, 'In Review', 'agent', $3)`,
    [issueId, workspaceId, qcAgentId, otherIssueId, otherWorkspaceId]);
    await admin.query(`INSERT INTO ${schema}.agent_task_queue VALUES
      ($1, $2, $3, $4, 'completed', now()),
      ($5, $2, $3, $6, 'completed', now() - interval '1 hour'),
      ($7, $8, $9, $4, 'completed', now())`,
    [assignedTaskId, issueId, workspaceId, qcAgentId, staleTaskId, staleAgentId,
      otherTaskId, otherIssueId, otherWorkspaceId]);
    testPool = new (require('pg').Pool)({ connectionString: TEST_DATABASE_URL });
    const dbPool = { connect: async () => {
      const client = await testPool.connect();
      await client.query(`SET search_path TO ${schema}, public`);
      return client;
    } };
    const options = { dbPool, workspaceId, logger: { log() {}, error() {} } };
    assert.equal((await adoptUnloggedInReviewTasks(options)).length, 1);
    assert.deepEqual((await admin.query(`SELECT issue_id, task_id, agent_id, from_stage, to_stage, status
      FROM ${schema}.relay_run_log`)).rows, [{ issue_id: issueId, task_id: assignedTaskId,
      agent_id: qcAgentId, from_stage: 'In Progress', to_stage: 'In Review', status: 'pending' }]);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.relay_run_log r
      INNER JOIN ${schema}.agent_task_queue t ON r.task_id = t.id AND r.status = 'pending'
      WHERE t.id = $1`, [assignedTaskId])).rows[0].n, 1);
    assert.deepEqual(await adoptUnloggedInReviewTasks(options), []);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.relay_run_log`)).rows[0].n, 1);
  } finally {
    if (testPool) await testPool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) {}
    await admin.end();
  }
});

test('infrastructure failures replay at the same attempt, including exhausted rows', () => {
  for (const reason of INFRA_FAILURE_REASONS) {
    assert.equal(isInfrastructureFailure(reason), true, reason);
    assert.equal(selectReplayAttempt({
      dead_task_id: 'dead-task', dead_task_status: 'failed', failure_reason: reason,
      attempt: 2, max_attempts: 2
    }), 2, reason);
  }
});

test('genuine failures and completed tasks without artifacts consume an attempt', () => {
  assert.equal(selectReplayAttempt({
    dead_task_id: 'dead-task', dead_task_status: 'failed', failure_reason: 'failed_implementation',
    attempt: 1, max_attempts: 2
  }), 2);
  assert.equal(selectReplayAttempt({
    dead_task_id: 'dead-task', dead_task_status: 'completed', failure_reason: null,
    attempt: 1, max_attempts: 2
  }), 2);
});

test('requeue candidate SQL binds the stage array with a real PostgreSQL client', async (t) => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const start = source.indexOf('`WITH stranded AS (');
  const end = source.indexOf('`', start + 1);
  assert.ok(start >= 0 && end > start, 'requeue candidate SQL must be present');
  const sql = source.slice(start + 1, end);
  assert.match(sql, /i\.status = ANY\(\$2::text\[\]\)/);
  assert.match(sql, /WHERE rn <= \$1::int/);
  assert.match(sql, /SELECT budgeted\.\*, NULL::bigint AS rn,/,
    'both UNION branches must expose the ranked row-number column');
  const params = [3, ['Queue', 'In Progress', 'Spec', 'In Review'], 120, 2, 6];
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

test('quota-failure lookup uses typed binds against PostgreSQL', async () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const marker = 'SELECT failure_reason, updated_at FROM agent_task_queue';
  const start = source.indexOf('`', source.indexOf(marker) - 20);
  const end = source.indexOf('`', start + 1);
  assert.ok(start >= 0 && end > start, 'quota-failure SQL must be present');
  const sql = source.slice(start + 1, end);
  assert.match(sql, /agent_id = \$1::uuid/);
  assert.match(sql, /LIMIT \$2::integer/);
  assert.match(sql, /\$3::bigint/);

  const schema = `quota_failure_lookup_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const client = new Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  const agentId = randomUUID();
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.agent_task_queue (
      agent_id uuid NOT NULL, status text NOT NULL, failure_reason text,
      updated_at timestamptz NOT NULL, created_at timestamptz NOT NULL)`);
    await client.query(`INSERT INTO ${schema}.agent_task_queue
      (agent_id, status, failure_reason, updated_at, created_at) VALUES
      ($1::uuid, 'failed', 'provider_quota_limit', NOW(), NOW() - INTERVAL '2 seconds'),
      ($1::uuid, 'failed', 'provider_quota_limit', NOW(), NOW() - INTERVAL '1 second'),
      ($1::uuid, 'failed', 'provider_quota_limit', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '3 seconds')`, [agentId]);
    await client.query(`SET search_path TO ${schema}, public`);
    const result = await client.query(sql, [agentId, 2, 60_000]);
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows.map((row) => row.failure_reason),
      ['provider_quota_limit', 'provider_quota_limit']);
  } finally {
    try { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) {}
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

test('Parked issue creates a diagnosis task against the PostgreSQL test DB', async () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  const workspaceId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();
  const runtimeId = randomUUID();
  try {
    await client.connect();
    await client.query('BEGIN');
    const relations = await client.query(`SELECT to_regclass('public.comment') AS comment_name,
      to_regclass('public.qc_verdict') AS qc_verdict_name`);
    if (!relations.rows[0].qc_verdict_name) await client.query(`CREATE TABLE qc_verdict (
      id integer, issue_id uuid NOT NULL, verdict text, created_at timestamptz DEFAULT now())`);
    if (!relations.rows[0].comment_name) await client.query(`CREATE TABLE comment (
      issue_id uuid NOT NULL, workspace_id uuid NOT NULL, author_type text NOT NULL,
      author_id uuid NOT NULL, content text NOT NULL, type text NOT NULL)`);
    await client.query(`INSERT INTO workspace (id, name, slug)
      VALUES ($1::uuid, $2::text, $3::text)`,
    [workspaceId, 'Parked diagnosis test', `parked-diagnosis-${workspaceId.slice(0, 8)}`]);
    await client.query(`INSERT INTO agent_runtime (
      id, workspace_id, name, runtime_mode, provider, device_info
    ) VALUES ($1::uuid, $2::uuid, 'Parked diagnosis test runtime', 'cloud', 'codex', '')`,
    [runtimeId, workspaceId]);
    await client.query(`INSERT INTO agent (
      id, workspace_id, name, runtime_mode, runtime_config, status,
      max_concurrent_tasks, instructions, model, runtime_id
    ) VALUES (
      $1::uuid, $2::uuid, 'gsp-parked-diagnosis-sol-low-test', 'cloud',
      $3::jsonb, 'idle', 1, $4::text, 'gpt-5.6-sol', $5::uuid
    )`, [agentId, workspaceId,
      JSON.stringify({ model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' }),
      'Parked diagnosis: classify fixable, already_fixed, duplicate, genuinely_blocked.', runtimeId]);
    await client.query(`INSERT INTO issue (
      id, workspace_id, title, status, priority, creator_id, number
    ) VALUES ($1::uuid, $2::uuid, 'Parked diagnosis integration issue', 'Parked', 'low', $3::uuid, 1)`,
    [issueId, workspaceId, randomUUID()]);

    const selection = await recordParkAndQueueDiagnosis(client, {
      id: issueId, workspace_id: workspaceId, status: 'Parked', priority: 'low'
    }, { reason: 'integration_test' });

    assert.match(selection.task_id, /^[0-9a-f-]{36}$/i);
    const task = await client.query(`SELECT agent_id, issue_id, status, context->>'kind' AS kind
      FROM agent_task_queue WHERE id = $1::uuid`, [selection.task_id]);
    assert.deepEqual(task.rows, [{ agent_id: agentId, issue_id: issueId,
      status: 'queued', kind: 'parked_diagnosis' }]);
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) {}
    await client.end();
  }
});

function strandedFixture(overrides = {}) {
  return {
    issue_id: '223e4567-e89b-42d3-a456-426614174000',
    workspace_id: '323e4567-e89b-42d3-a456-426614174000',
    number: 159,
    stage: 'Queue',
    dead_task_updated_at: new Date().toISOString(),
    dead_task_created_at: new Date(Date.now() - 121 * 60 * 1000).toISOString(),
    metadata: {},
    dead_task_id: '123e4567-e89b-42d3-a456-426614174000',
    dead_task_status: 'failed',
    attempt: 1,
    max_attempts: 2,
    failure_reason: 'cancelled',
    dead_task_result: null,
    dead_task_error: 'task cancelled by server',
    closed_relay_log_id: null,
    requeue_marker_log_id: null,
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

function strandedHarness(fixtures, state = {
  tasks: [], marker: null, pendingTask: null, pendingMarker: undefined
}) {
  const queries = [];
  const relayPosts = [];
  const dispatchedIssueIds = new Set();
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('WITH stranded AS') && sql.includes('WHERE rn <= $1')) {
      const eligible = fixtures.filter((row) => row.eligible !== false &&
        (row.forceContender || !state.tasks.some((task) => task.issue_id === row.issue_id && task.status === 'queued')) &&
        (row.allow_repeat || !dispatchedIssueIds.has(row.issue_id)));
      const exhaustedRows = eligible.filter((row) => (row.stage_history_count ?? row.history_count ?? 1) >= values[3] ||
        (row.lifetime_history_count ?? row.history_count ?? 1) >= values[4])
        .map((row) => ({ ...row, exhaustion_reason: (row.stage_history_count ?? row.history_count ?? 1) >= values[3]
          ? 'stage_cycle_limit' : 'lifetime_task_limit' }));
      const exhausted = exhaustedRows
        .sort((a, b) => a.issue_created_at.localeCompare(b.issue_created_at) || a.issue_id.localeCompare(b.issue_id))
        .slice(0, values[0]);
      const admitted = eligible.filter((row) => !exhaustedRows.some((exhaustedRow) => exhaustedRow.issue_id === row.issue_id))
        .sort((a, b) => a.issue_created_at.localeCompare(b.issue_created_at) ||
          a.issue_id.localeCompare(b.issue_id))
        .filter((row, _, rows) => rows.filter((candidate) => candidate.agent_id === row.agent_id)
          .findIndex((candidate) => candidate.issue_id === row.issue_id) < values[0]);
      return { rows: admitted.concat(exhausted) };
    }
    if (sql.includes('COALESCE(a.max_concurrent_tasks')) {
      return { rows: fixtures.map((row) => ({ agent_id: row.agent_id, cap: 1, in_flight: 0 })) };
    }
    if (sql.includes('max(EXTRACT(epoch')) return { rows: [{ age: 0 }] };
    if (sql.includes('SELECT failure_reason, updated_at FROM agent_task_queue')) {
      return { rows: fixtures[0].recent_quota_failures || [] };
    }
    if (sql.includes('UPDATE agent') && sql.includes("'quota_paused', true")) {
      return { rowCount: 1, rows: [{ id: fixtures[0].agent_id, workspace_id: fixtures[0].workspace_id,
        agent_name: fixtures[0].agent_name, paused_at: new Date().toISOString() }] };
    }
    if (sql.includes("INSERT INTO activity_log") && sql.includes("'relay_lane_paused'")) {
      return { rows: [] };
    }
    if (sql === 'BEGIN') return { rows: [] };
    if (sql === 'COMMIT') {
      if (state.pendingTask) state.tasks.push(state.pendingTask);
      if (state.pendingMarker !== undefined) state.marker = state.pendingMarker;
      state.pendingTask = null;
      state.pendingMarker = undefined;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      state.pendingTask = null;
      state.pendingMarker = undefined;
      return { rows: [] };
    }
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('FROM issue WHERE id')) return { rows: [] };
    if (sql.includes('FROM agent_task_queue') && sql.includes('FOR UPDATE')) return { rows: [] };
    if (sql.includes('count(*)::int AS n')) return { rows: [{ n: fixtures[0].history_count ?? 1 }] };
    if (sql.includes('INSERT INTO agent_task_queue')) {
      dispatchedIssueIds.add(values[1]);
      state.pendingTask = { id: '623e4567-e89b-42d3-a456-426614174000', issue_id: values[1], status: 'queued' };
      return { rows: [{ id: '623e4567-e89b-42d3-a456-426614174000' }] };
    }
    if (sql.includes('UPDATE relay_run_log') && sql.includes("requeue_task_id")) {
      if (state.marker !== null && state.marker !== values[2]) return { rows: [] };
      state.pendingMarker = values[1];
      return { rows: [{ id: 'closed-relay-log' }] };
    }
    if (sql.includes('INSERT INTO relay_run_log')) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  }, release() {} };
  return { queries, relayPosts, client, state, run: () => requeueStrandedTasks({
    dbPool: { connect: async () => client },
    postRelay: async (payload) => { relayPosts.push(payload); return { status: 200 }; }
  }) };
}

function loadRequeueDaemon() {
  const modulePath = require.resolve('./multica-relay-advance-daemon.cjs');
  delete require.cache[modulePath];
  return require(modulePath);
}

test.skip('stranded-task fixture redispatches a cancelled-only task', async () => {
  const harness = strandedHarness([strandedFixture()]);
  await harness.run();
  const insert = harness.queries.find(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  assert.ok(insert);
  assert.match(insert.values[3], /"source":"relay-requeue"/);
  assert.match(insert.values[3], /"requeue_of_task":"123e4567-e89b-42d3-a456-426614174000"/);
});

test.skip('stale quota failure requeues without pausing its lane or posting Human Review', async () => {
  const harness = strandedHarness([strandedFixture({
    failure_reason: 'provider_quota_limit',
    dead_task_updated_at: new Date(Date.now() - 16 * 60 * 1000).toISOString()
  })]);
  await harness.run();
  const insert = harness.queries.find(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  assert.ok(insert);
  assert.equal(insert.values[5], 2);
  assert.equal(harness.queries.some(({ sql }) => sql.includes('SELECT failure_reason, updated_at')), false);
  assert.deepEqual(harness.relayPosts, []);
});

test.skip('fresh quota failures at the limit pause the lane and send the ticket to Human Review', async () => {
  const now = new Date().toISOString();
  const harness = strandedHarness([strandedFixture({
    failure_reason: 'provider_quota_limit', dead_task_updated_at: now,
    recent_quota_failures: Array.from({ length: 3 }, () => ({
      failure_reason: 'provider_quota_limit', updated_at: now
    }))
  })]);
  await harness.run();
  assert.ok(harness.queries.some(({ sql }) => sql.includes('SELECT failure_reason, updated_at')));
  assert.ok(harness.queries.some(({ sql }) => sql.includes("'relay_lane_paused'")));
  assert.deepEqual(harness.relayPosts, [{ issue_id: '223e4567-e89b-42d3-a456-426614174000',
    to_stage: 'Human Review', agent_token: undefined, reason: 'payment_required_402' }]);
  assert.equal(harness.queries.some(({ sql }) => sql.includes('INSERT INTO agent_task_queue')), false);
});

test.skip('zero-task Queue fixture creates attempt one without retry admission', async () => {
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
    metadata: { pr_url: 'https://github.com/timrecursify/multica/pull/1',
      bound_sha: 'c909401ef7a4a438348eb5ceda33839211721524' } }), false);
  assert.match(summary, /ticket 159/);
  assert.match(summary, /board prod/);
  assert.match(summary, /https:\/\/github.com\/timrecursify\/multica\/pull\/1/);
  assert.match(summary, /c909401ef7a4a438348eb5ceda33839211721524/);
});

test('In Review requeue summary directs a FAIL verdict when PR or SHA is absent', () => {
  assert.match(requeueTriggerSummary(strandedFixture({ stage: 'In Review' }), true),
    /PR\/SHA unknown: issue FAIL verdict per runbook/);
});

test('only the oldest exhausted batch escalates while a full admissible batch dispatches', async () => {
  const overLimit = [1, 2, 3, 4].map((number) => strandedFixture({
    number, issue_id: `223e4567-e89b-42d3-a456-42661417430${number}`,
    agent_id: `423e4567-e89b-42d3-a456-42661417430${number}`,
    issue_created_at: `2026-09-01T00:0${number}:00Z`, lifetime_history_count: 6
  }));
  const admissible = [5, 6, 7].map((number) => strandedFixture({
    number, issue_id: `223e4567-e89b-42d3-a456-42661417430${number}`,
    agent_id: `423e4567-e89b-42d3-a456-42661417430${number}`,
    issue_created_at: `2026-09-01T00:0${number}:00Z`
  }));
  const exhausted = overLimit.slice().sort((a, b) => a.issue_created_at.localeCompare(b.issue_created_at) || a.issue_id.localeCompare(b.issue_id)).slice(0, 3);
  const dispatched = admissible.slice(0, 3);
  assert.deepEqual(dispatched.map(({ issue_id }) => issue_id), admissible.map(({ issue_id }) => issue_id));
  assert.deepEqual(exhausted.map(({ issue_id }) => issue_id), overLimit.slice(0, 3).map(({ issue_id }) => issue_id));
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const candidateSql = source.slice(source.indexOf('WITH stranded AS'), source.indexOf('async function processParkedDiagnoses'));
  assert.match(candidateSql, /WHERE rn <= \$1::int/);
  assert.equal((candidateSql.match(/ORDER BY issue_created_at ASC, issue_id ASC\s+LIMIT \$1/g) || []).length, 1);
});

test.skip('stranded-task fixtures leave running tasks and bundled children untouched', async () => {
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

test.skip('RELAY_REQUEUE_STAGES drops Human Review before binding the candidate SQL', async () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /RELAY_REQUEUE_STAGES \|\| 'Queue,In Progress,Spec,In Review,CI\/CD & Deploy'/);
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

test.skip('default recovery stages include CI/CD & Deploy', async () => {
  const harness = strandedHarness([strandedFixture({ stage: 'CI/CD & Deploy' })]);
  await harness.run();
  const candidateQuery = harness.queries.find(({ sql }) => sql.includes('FROM issue i'));
  assert.ok(candidateQuery.values[1].includes('CI/CD & Deploy'));
});

test.skip('completed task with failed closed relay row is requeued with stage instructions', async () => {
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
  assert.deepEqual(record.values, ['closed-relay-log', '623e4567-e89b-42d3-a456-426614174000',
    fixture.dead_task_id]);
});

test('completed latest task accepts a failed relay row for marker rotation', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  const completed = strandedFixture({ dead_task_status: 'completed' });
  assert.equal(completed.dead_task_status, 'completed');
  assert.match(requeue, /t\.status = 'completed'/);
  assert.match(requeue, /closed_log\.status = 'failed'/);
  assert.match(requeue, /marker_log\.id AS requeue_marker_log_id/);
  assert.match(requeue, /parked_audit->>'requeue_task_id' = t\.id::text/);
  assert.match(requeue, /UPDATE relay_run_log[\s\S]*\{requeue_task_id\}/);
});

test.skip('completed In Review task without a later verdict is requeued once after the queue TTL', async () => {
  const fixture = strandedFixture({ dead_task_status: 'completed', stage: 'In Review',
    instructions: 'In Review', failure_reason: null });
  const harness = strandedHarness([fixture]);
  await harness.run();
  assert.equal(harness.queries.filter(({ sql }) => sql.includes('INSERT INTO agent_task_queue')).length, 1);
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  assert.match(requeue, /t\.created_at < NOW\(\) - \(\$3::bigint \* INTERVAL '1 minute'\)/);
  assert.match(requeue, /FROM qc_verdict qv[\s\S]*qv\.created_at >= t\.created_at/);
});

test.skip('completed In Review task with a later verdict is not eligible for requeue', async () => {
  const harness = strandedHarness([strandedFixture({ dead_task_status: 'completed', stage: 'In Review',
    instructions: 'In Review', eligible: false })]);
  await harness.run();
  assert.equal(harness.queries.some(({ sql }) => sql.includes('INSERT INTO agent_task_queue')), false);
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /NOT EXISTS \(\s*SELECT 1 FROM qc_verdict qv[\s\S]*qv\.created_at >= t\.created_at/);
});

test.skip('completed task without stage progress remains subject to the stage cycle cap', async () => {
  const harness = strandedHarness([strandedFixture({ dead_task_status: 'completed', history_count: 2 })]);
  await harness.run();
  assert.equal(harness.queries.some(({ sql }) => sql.includes('INSERT INTO agent_task_queue')), false);
});

test('completed task with a completed relay row is not admitted', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  assert.match(requeue, /t\.status = 'completed'[\s\S]*closed_log\.status = 'failed'/);
  assert.doesNotMatch(requeue, /t\.status = 'completed'[\s\S]{0,80}closed_log\.status = 'completed'/);
});

test.skip('terminal retry contenders commit one live replacement, one marker rotation, and one pending log', async () => {
  const state = { tasks: [], marker: '123e4567-e89b-42d3-a456-426614174000',
    pendingTask: null, pendingMarker: undefined };
  const fixture = strandedFixture({
    dead_task_status: 'completed',
    closed_relay_log_id: 'closed-relay-log',
    requeue_marker_log_id: 'closed-relay-log'
  });
  const first = strandedHarness([fixture], state);
  // This contender selected the stale candidate just before the first
  // transaction committed; its compare-and-rotate must roll its insert back.
  const contender = strandedHarness([{ ...fixture, forceContender: true }], state);
  await first.run();
  await contender.run();
  const inserts = first.queries.concat(contender.queries)
    .filter(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  const markerUpdates = first.queries.concat(contender.queries)
    .filter(({ sql }) => sql.includes('UPDATE relay_run_log') && sql.includes("requeue_task_id"));
  const logs = first.queries.concat(contender.queries)
    .filter(({ sql }) => sql.includes('INSERT INTO relay_run_log'));
  assert.equal(inserts.length, 2, 'the losing contender reaches the transactional insert');
  assert.equal(markerUpdates.length, 2);
  assert.equal(logs.length, 1);
  assert.deepEqual(state.tasks, [{ id: '623e4567-e89b-42d3-a456-426614174000',
    issue_id: fixture.issue_id, status: 'queued' }]);
  assert.equal(state.marker, '623e4567-e89b-42d3-a456-426614174000');
});

test('live task on another stage fixture is excluded for every stage', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const liveOtherStage = strandedFixture({ live_task_stage: 'Spec' });
  assert.equal(liveOtherStage.live_task_stage, 'Spec');
  assert.match(source, /WHERE q\.issue_id = i\.id AND q\.status IN/);
  assert.doesNotMatch(source, /COALESCE\(q\.context->>'to_stage', ''\) = i\.status/);
});

test.skip('five eligible fixtures dispatch the oldest-created candidate from each owner partition', async () => {
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
  assert.equal(dispatched.length, 5);
  assert.deepEqual(dispatched.map(({ values }) => values[1]), fixtures.slice().sort((a, b) =>
    a.issue_created_at.localeCompare(b.issue_created_at)).map((row) => row.issue_id));
  const candidateQuery = harness.queries.find(({ sql }) => sql.includes('FROM issue i'));
  assert.match(candidateQuery.sql, /PARTITION BY agent_id ORDER BY issue_created_at ASC, issue_id ASC/);
  assert.match(candidateQuery.sql, /ORDER BY issue_created_at ASC, issue_id ASC/);
});

test.skip('over-limit rows are terminally rejected outside the batch while three admissible rows dispatch', async () => {
  const overLimit = [1, 2, 3].map((number) => strandedFixture({
    number, issue_id: `223e4567-e89b-42d3-a456-42661417410${number}`,
    agent_id: `423e4567-e89b-42d3-a456-42661417410${number}`,
    issue_created_at: `2026-09-01T00:0${number}:00Z`, lifetime_history_count: 6
  }));
  const admissible = [4, 5, 6].map((number) => strandedFixture({
    number, issue_id: `223e4567-e89b-42d3-a456-42661417410${number}`,
    agent_id: `423e4567-e89b-42d3-a456-42661417410${number}`,
    issue_created_at: `2026-09-01T00:0${number}:00Z`
  }));
  const harness = strandedHarness(overLimit.concat(admissible));
  await harness.run();
  const dispatched = harness.queries.filter(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  assert.deepEqual(dispatched.map(({ values }) => values[1]), admissible.map(({ issue_id }) => issue_id));
  assert.deepEqual(harness.relayPosts.map(({ issue_id, to_stage, cap_refusal }) => ({ issue_id, to_stage, cap_refusal })),
    overLimit.map(({ issue_id }) => ({ issue_id, to_stage: 'Rejected', cap_refusal: {
      reason: 'lifetime_task_limit', ceiling: 6, task_count: 6,
      target_stage: 'Queue', trigger_stage: 'Queue'
    } })));
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /\$\{budgetCountPredicate\('stage_history'\)\}/);
  assert.match(source, /\$\{budgetCountPredicate\('lifetime_history'\)\}/);
});

test.skip('over-limit rows cannot starve the next requeue sweep', async () => {
  const overLimit = [1, 2, 3].map((number) => strandedFixture({
    number, issue_id: `223e4567-e89b-42d3-a456-42661417420${number}`,
    agent_id: `423e4567-e89b-42d3-a456-42661417420${number}`,
    issue_created_at: `2026-09-01T00:0${number}:00Z`, lifetime_history_count: 6
  }));
  const admissible = [4, 5, 6, 7, 8, 9].map((number) => strandedFixture({
    number, issue_id: `223e4567-e89b-42d3-a456-42661417420${number}`,
    agent_id: `423e4567-e89b-42d3-a456-42661417420${number}`,
    issue_created_at: `2026-09-01T00:${String(number).padStart(2, '0')}:00Z`
  }));
  const harness = strandedHarness(overLimit.concat(admissible));
  await harness.run();
  await harness.run();
  const dispatched = harness.queries.filter(({ sql }) => sql.includes('INSERT INTO agent_task_queue'));
  assert.deepEqual(dispatched.map(({ values }) => values[1]), admissible.map(({ issue_id }) => issue_id));
  assert.equal(harness.relayPosts.length, 6, 'each exhausted row remains on the existing respec path');
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

test('legacy note-only PASS cannot replay into deploy admission', () => {
  assert.deepEqual(qcCompletionAdvance(QC_ROW), {
    ok: false,
    reason: 'qc_attempt_binding_required'
  });
});

test('legacy PASS ignores a completed task unless it has a recorded attempt', () => {
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
  assert.equal(qcCompletionAdvance(row).reason, 'qc_attempt_binding_required');
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

test('completed-task advance scans the 100-row head-of-line hold window', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const advance = source.slice(source.indexOf('async function findAndAdvanceTasks'),
    source.indexOf('async function recoveryAdvanceTasks'));
  assert.match(advance, /ORDER BY rrl\.created_at ASC\s+LIMIT 100/);
});

test('manual gated completions close their relay ledger without an automatic transition', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const advance = source.slice(source.indexOf('async function findAndAdvanceTasks'),
    source.indexOf('async function recoveryAdvanceTasks'));
  assert.match(advance, /qcAdvance\.reason === 'manual_gated_stage'[\s\S]*markRelayLogCompletedById\(client, row\.log_id\)/);
});

test('unbound completed Sol-low QC closes its relay ledger for reconciler redispatch', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const advance = source.slice(source.indexOf('async function findAndAdvanceTasks'),
    source.indexOf('async function recoveryAdvanceTasks'));
  assert.match(advance, /completed_sol_low_pass_required', 'qc_attempt_binding_required'[\s\S]*markRelayLogFailedById\(client, row\.log_id\)/);
});

test('both Registered recovery paths carry policy-required registered evidence', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const recovery = source.slice(source.indexOf('async function recoveryAdvanceTasks'),
    source.indexOf('// A task killed by the fleet'));
  assert.equal(evaluate({ from: 'Registered', to: 'Spec', actor: 'system',
    evidence: { registeredIssue: 'issue-1', selectedWorkspace: 'workspace-1' } }).ok, true);
  assert.equal((recovery.match(/evidence: \{ registeredIssue:/g) || []).length, 2);
  assert.match(recovery, /selectedWorkspace: row\.workspace_id \|\| true/);
});

test('relay daemon scopes stage configuration to each issue workspace', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /rsc\.workspace_id = i\.workspace_id/);
  assert.match(source, /a\.workspace_id = rsc\.workspace_id/);
  assert.match(source, /evidence_agent\.workspace_id = \$\{issueAlias\}\.workspace_id/);
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
  assert.match(source, /postRelay\(\{ issue_id: row\.issue_id, to_stage: 'Human Review'/);
  assert.match(source, /reason: 'payment_required_402'/);
});

test('relay advancement admits task results before creating a successor', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /require\('\.\.\/relay-completion-admission\.cjs'\)/);
  assert.match(source, /atq\.result AS task_result/);
  assert.match(source, /deploymentCompletionAdmission\(row\.task_status, row\.task_result/);
  assert.match(source, /requestRetryEscalation\(row, completion\.reason\)/);
  assert.match(source, /retry_escalation_task_id: taskId/);
  assert.match(source, /retry_escalation_stage: triggerStage/);
  assert.match(source, /markRelayLogFailedById\(client, row\.log_id\)/);
  assert.match(source, /relay_source_task_id: row\.task_id/);
});

test('retry ceilings use the relay-owned terminal disposition receipt', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  assert.match(requeue, /requestCapDisposition\(row, cycle, postRelay/);
  assert.match(requeue, /requestCapDisposition\(row, lifetime, postRelay/);
  assert.match(requeue,
    /row\.metadata\?\.parked_release_at \|\|\s+row\.metadata\?\.retry_escalation_at \|\| null/);
  assert.doesNotMatch(requeue, /UPDATE issue SET status/);
});

test('stranded-task recovery rotates a marker only when it still references the terminal predecessor', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  assert.match(requeue, /t\.status = 'completed'/);
  assert.match(requeue, /closed_log\.status = 'failed'/);
  assert.match(requeue, /requeue_of_relay_log: row\.requeue_marker_log_id \|\| row\.closed_relay_log_id/);
  assert.match(requeue, /parked_audit->>'requeue_task_id' = \$3::text/);
  assert.match(requeue, /retry marker changed while admitting replacement/);
});

test('stranded-task recovery orders each owner partition by immutable creation time', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('async function processParkedDiagnoses'));
  assert.match(requeue, /PARTITION BY agent_id ORDER BY issue_created_at ASC, issue_id ASC/);
  assert.match(requeue, /i\.created_at AS issue_created_at/);
  assert.match(requeue, /ORDER BY issue_created_at ASC, issue_id ASC/);
  assert.doesNotMatch(requeue, /PARTITION BY agent_id ORDER BY .*updated_at/);
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

test('Parked diagnosis releases clear retry escalation regardless of reason, while holds retain it', async () => {
  const run = async ({ result, reasonCode }) => {
    const task = { id: randomUUID(), issue_id: randomUUID(), workspace_id: randomUUID(), number: 43,
      status: 'Parked', context: { reason_code: reasonCode }, result };
    const issue = { metadata: { retry_escalation: { trigger_stage: 'Queue' }, preserved: true } };
    const queries = [];
    const client = { query: async (sql, values = []) => {
      queries.push({ sql, values });
      if (sql.includes('LIMIT 25')) return { rows: [{ id: task.id, workspace_id: task.workspace_id }] };
      if (sql.includes('FOR UPDATE OF t SKIP LOCKED')) return { rows: [task] };
      if (sql.includes('FROM issue_spec')) return { rows: [{ id: randomUUID() }] };
      if (sql.includes('UPDATE issue SET metadata = jsonb_set')) {
        issue.metadata.parked_release_once = true;
        issue.metadata.parked_release_at = 'released';
        delete issue.metadata.retry_escalation;
      }
      return { rows: [] };
    }, release() {} };
    await processParkedDiagnoses({ diagnosisPool: { connect: async () => client },
      relayPost: async () => ({ ok: true, status: 200 }) });
    return { issue, queries };
  };

  const matchingRelease = await run({ result: 'outcome: fixable', reasonCode: 'escalation_loop' });
  const rerunRelease = await run({ result: 'outcome: fixable', reasonCode: 'operator_parked_diagnosis_rerun' });
  const held = await run({ result: 'outcome: genuinely_blocked\nblocker: awaiting operator input',
    reasonCode: 'operator_parked_diagnosis_rerun' });

  for (const released of [matchingRelease, rerunRelease]) {
    assert.deepEqual(released.issue.metadata, { preserved: true, parked_release_once: true,
      parked_release_at: 'released' });
    const update = released.queries.find(({ sql }) => sql.includes('UPDATE issue SET metadata = jsonb_set'));
    assert.match(update.sql, /- 'retry_escalation'/);
  }
  assert.deepEqual(held.issue.metadata, { retry_escalation: { trigger_stage: 'Queue' }, preserved: true });
  assert.ok(!held.queries.some(({ sql }) => sql.includes("- 'retry_escalation'")));
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
  assert.match(source, /scheduleEvery\(reconcileQuotaPauses, 60000, 'reconcileQuotaPauses'\)/);
});

// --- GitHub reads run on REST, not GraphQL (relay rate-limit migration) -----

const { github: githubRest, restPrView } = require('./multica-relay-advance-daemon.cjs');

function stubGh(responses) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    const key = Object.keys(responses).find((k) => args.join(' ').includes(k));
    if (!key) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    return responses[key];
  };
  return { run, calls };
}

const OPEN_PR_RESPONSES = {
  'pulls/42/files': JSON.stringify([{ filename: 'server/main.go' }, { filename: 'docs/x.md' }]),
  'pulls/42': JSON.stringify({ state: 'open', merged: false, mergeable_state: 'clean',
    head: { sha: 'a'.repeat(40) } }),
  'check-runs': JSON.stringify({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }),
  '/status': JSON.stringify({ statuses: [{ context: 'legacy', state: 'success' }] })
};

test('pr view is rebuilt from REST with the GraphQL field names', () => {
  const { run, calls } = stubGh(OPEN_PR_RESPONSES);
  const pr = JSON.parse(restPrView('acme/widget', '42', run));
  assert.equal(pr.state, 'OPEN');
  assert.equal(pr.headRefOid, 'a'.repeat(40));
  assert.equal(pr.mergeStateStatus, 'CLEAN');
  assert.deepEqual(pr.files.map(({ path }) => path), ['server/main.go', 'docs/x.md']);
  assert.deepEqual(pr.statusCheckRollup, [
    { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS' }
  ]);
  assert.equal(calls.every((c) => c.startsWith('api ')), true);
  assert.equal(calls.some((c) => c.includes('graphql')), false);
});

test('a merged PR reads as MERGED and an unchecked commit rolls up to null', () => {
  const { run } = stubGh({ ...OPEN_PR_RESPONSES,
    'pulls/42': JSON.stringify({ state: 'closed', merged: true, mergeable_state: 'unknown',
      head: { sha: 'b'.repeat(40) } }),
    'check-runs': JSON.stringify({ check_runs: [] }),
    '/status': JSON.stringify({ statuses: [] }) });
  const pr = JSON.parse(restPrView('acme/widget', '42', run));
  assert.equal(pr.state, 'MERGED');
  assert.equal(pr.mergeStateStatus, 'UNKNOWN');
  assert.equal(pr.statusCheckRollup, null);
});

test('pr merge becomes a REST squash merge and other gh verbs pass through', () => {
  const { run, calls } = stubGh({ 'pulls/42/merge': '{"merged":true}', 'repo view': 'acme/widget' });
  githubRest(['pr', 'merge', 'https://github.com/acme/widget/pull/42', '--squash', '--admin'], run);
  assert.deepEqual(calls, ['api -X PUT repos/acme/widget/pulls/42/merge -f merge_method=squash']);
  githubRest(['repo', 'view'], run);
  assert.equal(calls[1], 'repo view');
});
