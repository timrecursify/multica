const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { Pool } = require('pg');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET || 'test-relay-secret';
process.env.MULTICA_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'test-workspace';

const { qcBounceDecision } = require('../multica-bridge.cjs');
const { enqueuePassWithoutRelayRows, findAndAdvanceTasks } = require('./multica-relay-advance-daemon.cjs');
const { parseArgs, recover } = require('../recover-stranded-qc-pass.cjs');
const { closeDeadRelayRows, convertCompletedQcEvidence,
  rescopeCompletedNoArtifactQc } = require('./relay-dead-rows.cjs');

const SHA = 'c909401ef7a4a438348eb5ceda33839211721524';
const MD5 = '76becea4ab970644b7a21220665a1619';

function marker(overrides = {}) {
  return { verdict: 'PASS', work_product_md5: MD5, bound_sha: SHA, observed_sha: SHA,
    failure_class: 'none', qualifying: true, model: 'gpt-5.6-sol', effort: 'low', ...overrides };
}

test('completed valid QC marker converts once and preserves its relay task identity', async () => {
  const task = { id: '11111111-1111-4111-8111-111111111111', issue_id: 'issue-1', number: 42,
    agent_name: 'qc-sol-low', result: { output: `QC_EVIDENCE_JSON=${JSON.stringify(marker())}` } };
  const payloads = [];
  const client = { query: async () => ({ rows: [task] }) };
  const converted = await convertCompletedQcEvidence(client, {
    postRelay: async (payload) => { payloads.push(payload); return { status: 201 }; }, logger: { log() {} }
  });
  assert.deepEqual([...converted], [task.id]);
  assert.equal(payloads[0].qc_task_id, task.id);
  assert.equal(payloads[0].idem_key, `qc-42-${SHA}-PASS`);
});

test('single-backtick and fenced QC markers convert', async () => {
  const evidence = JSON.stringify(marker());
  const tasks = [
    { id: 'backtick-task', issue_id: 'backtick-issue', number: 43, agent_name: 'qc',
      result: { output: `\`QC_EVIDENCE_JSON=${evidence}\`` } },
    { id: 'fenced-task', issue_id: 'fenced-issue', number: 44, agent_name: 'qc',
      result: { output: `\`\`\`\nQC_EVIDENCE_JSON=${evidence}\n\`\`\`` } }
  ];
  const payloads = [];
  const converted = await convertCompletedQcEvidence({ query: async () => ({ rows: tasks }) }, {
    postRelay: async (payload) => { payloads.push(payload); return { status: 201 }; }, logger: { log() {} }
  });
  assert.deepEqual([...converted], ['backtick-task', 'fenced-task']);
  assert.equal(payloads.length, 2);
});

test('malformed, schema-invalid, and duplicate markers skip with one diagnostic each', async () => {
  const invalid = [
    { id: 'missing-task', issue_id: 'missing', result: { output: '' }, agent_name: 'qc', number: 0 },
    { id: 'malformed-task', issue_id: 'a', result: { output: 'QC_EVIDENCE_JSON={bad json}' }, agent_name: 'qc', number: 1 },
    { id: 'schema-task', issue_id: 'b', result: { output: `QC_EVIDENCE_JSON=${JSON.stringify(marker({ observed_sha: '0123456789012345678901234567890123456789' }))}` }, agent_name: 'qc', number: 2 },
    { id: 'duplicate-task', issue_id: 'c', result: { output: `QC_EVIDENCE_JSON=${JSON.stringify(marker())}\nQC_EVIDENCE_JSON=${JSON.stringify(marker())}` }, agent_name: 'qc', number: 3 }
  ];
  const payloads = [];
  const logs = [];
  const client = { query: async () => ({ rows: invalid }) };
  assert.deepEqual([...await convertCompletedQcEvidence(client, {
    postRelay: async (payload) => { payloads.push(payload); return { status: 201 }; },
    logger: { log: (line) => logs.push(line) }
  })], []);
  assert.equal(payloads.length, 0);
  for (const [taskId, reason] of [['missing-task', 'missing-marker'], ['malformed-task', 'invalid-json'],
    ['schema-task', 'invalid-evidence'], ['duplicate-task', 'duplicate-marker']]) {
    assert.equal(logs.filter((line) => line.includes(`[qc-evidence-skipped] task=${taskId} reason=${reason}`)).length, 1);
  }
});

test('QC evidence conversion flag off is a clean no-op', async () => {
  let queried = false;
  const converted = await convertCompletedQcEvidence({ query: async () => { queried = true; return { rows: [] }; } }, {
    postRelay: async () => ({ status: 201 }), env: { RELAY_QC_EVIDENCE_CONVERSION: 'off' }
  });
  assert.deepEqual([...converted], []);
  assert.equal(queried, false);
});

function noArtifactTask(id = 'no-artifact-task') {
  return { id, issue_id: `issue-${id}`, result: { output:
    'QC-BLOCKED: no implementation SHA or PR exists. NO-SHA.' } };
}

test('QC-BLOCKED no-artifact task posts one In Progress relay return', async () => {
  const posts = [];
  const converted = await rescopeCompletedNoArtifactQc({ query: async () => ({ rows: [noArtifactTask()] }) }, {
    postRelay: async (payload) => { posts.push(payload); return { status: 201 }; }, logger: { log() {} }
  });
  assert.deepEqual([...converted], ['no-artifact-task']);
  assert.deepEqual(posts, [{ issue_id: 'issue-no-artifact-task', to_stage: 'In Progress',
    reason: 'QC-BLOCKED NO-SHA relay return' }]);
});

test('valid QC_EVIDENCE_JSON marker does not take no-artifact rescope path', async () => {
  const task = noArtifactTask();
  task.result.output = `QC_EVIDENCE_JSON=${JSON.stringify(marker())}`;
  const posts = [];
  await rescopeCompletedNoArtifactQc({ query: async () => ({ rows: [task] }) }, {
    postRelay: async (payload) => { posts.push(payload); return { status: 201 }; }, logger: { log() {} }
  });
  assert.deepEqual(posts, []);
});

test('no-artifact rescope treats 409 as a non-retrying skip', async () => {
  let attempts = 0;
  const logs = [];
  await rescopeCompletedNoArtifactQc({ query: async () => ({ rows: [noArtifactTask()] }) }, {
    postRelay: async () => { attempts += 1; return { status: 409 }; },
    logger: { log: (line) => logs.push(line) }
  });
  assert.equal(attempts, 1);
  assert.ok(logs.some((line) => line.includes('status=409')));
});

test('no-artifact rescope 409 logs skipped and never rescoped', async () => {
  const logs = [];
  await rescopeCompletedNoArtifactQc({ query: async () => ({ rows: [noArtifactTask()] }) }, {
    postRelay: async () => ({ status: 409 }), logger: { log: (line) => logs.push(line) }
  });
  assert.deepEqual(logs.filter((line) => line.includes('[qc-no-artifact-skipped]')).length, 1);
  assert.deepEqual(logs.filter((line) => line.includes('[qc-no-artifact-rescoped]')).length, 0);
});

test('no-artifact rescope 2xx logs rescoped exactly once', async () => {
  const logs = [];
  await rescopeCompletedNoArtifactQc({ query: async () => ({ rows: [noArtifactTask()] }) }, {
    postRelay: async () => ({ status: 201 }), logger: { log: (line) => logs.push(line) }
  });
  assert.equal(logs.filter((line) => line.includes('[qc-no-artifact-rescoped]')).length, 1);
});

test('no-artifact rescope respects RELAY_NOARTIFACT_RESCOPE_BATCH', async () => {
  let queryValues;
  const tasks = [noArtifactTask('first'), noArtifactTask('second')];
  const posts = [];
  await rescopeCompletedNoArtifactQc({ query: async (_sql, values) => {
    queryValues = values;
    return { rows: tasks.slice(0, values[0]) };
  } }, {
    postRelay: async (payload) => { posts.push(payload); return { status: 200 }; },
    env: { RELAY_REQUEUE_BATCH: '8', RELAY_NOARTIFACT_RESCOPE_BATCH: '1' }, logger: { log() {} }
  });
  assert.deepEqual(queryValues, [1]);
  assert.equal(posts.length, 1);
});

async function deadRowsDb() {
  const schema = `relay_dead_rows_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE TABLE ${schema}.relay_run_log (
    id text PRIMARY KEY, issue_id text NOT NULL, task_id text NOT NULL, to_stage text NOT NULL,
    status text NOT NULL, parked_audit jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
  await admin.query(`CREATE TABLE ${schema}.agent_task_queue (
    id text PRIMARY KEY, issue_id text NOT NULL, agent_id text, workspace_id text NOT NULL DEFAULT 'workspace-1',
    status text NOT NULL, context jsonb, result jsonb, completed_at timestamptz, created_at timestamptz NOT NULL)`);
  await admin.query(`CREATE TABLE ${schema}.issue (
  id text PRIMARY KEY, workspace_id text NOT NULL, number integer NOT NULL, status text NOT NULL DEFAULT 'In Review',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb)`);
  await admin.query(`CREATE TABLE ${schema}.agent (
    id text PRIMARY KEY, workspace_id text NOT NULL, name text NOT NULL, model text,
    thinking_level text, runtime_config jsonb)`);
  await admin.query(`CREATE TABLE ${schema}.qc_verdict (
    issue_id text NOT NULL, created_at timestamptz NOT NULL)`);
  await admin.query(`INSERT INTO ${schema}.issue (id, workspace_id, number)
    VALUES ('fixture-issue', 'workspace-1', 1)`);
  await admin.query(`INSERT INTO ${schema}.agent (id, workspace_id, name, model, thinking_level, runtime_config)
    VALUES ('fixture-agent', 'workspace-1', 'fixture-agent', 'gpt-5.6-sol', 'low', '{}'::jsonb)`);
  const dbPool = {
    async connect() {
      const client = await admin.connect();
      await client.query(`SET search_path TO ${schema}, public`);
      return client;
    }
  };
  return { admin, schema, dbPool, async close() {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  } };
}

async function closeDeadRowsTick(dbPool, postRelay) {
  const client = await dbPool.connect();
  try {
    await closeDeadRelayRows(client, {
      terminalStages: ['Done', 'Cancelled', 'Archived'],
      requestRetryEscalation: (row, reason, relay) => relay({ issue_id: row.issue_id, reason }),
      postRelay,
      logger: { log() {} }
    });
  } finally {
    client.release();
  }
}

async function convertQcEvidenceTick(db, postRelay) {
  const client = await db.dbPool.connect();
  try {
    return await convertCompletedQcEvidence(client, { postRelay, logger: { log() {} } });
  } finally { client.release(); }
}

test('QC evidence conversion skips more than 100 marker-less tasks to reach a later marker', async () => {
  const db = await deadRowsDb();
  const posts = [];
  try {
    await db.admin.query(`INSERT INTO ${db.schema}.issue (id, workspace_id, number)
      SELECT 'dead-issue-' || lpad(n::text, 3, '0'), 'workspace-1', n + 10
        FROM generate_series(1, 101) n`);
    await db.admin.query(`INSERT INTO ${db.schema}.agent_task_queue
      (id, issue_id, agent_id, status, context, result, created_at)
      SELECT 'dead-task-' || lpad(n::text, 3, '0'), 'dead-issue-' || lpad(n::text, 3, '0'),
        'fixture-agent', 'completed', '{"to_stage":"In Review"}'::jsonb,
        '{"output":"QC completed without evidence"}'::jsonb, now()
        FROM generate_series(1, 101) n`);
    await db.admin.query(`INSERT INTO ${db.schema}.issue (id, workspace_id, number)
      VALUES ('marker-issue', 'workspace-1', 999)`);
    await db.admin.query(`INSERT INTO ${db.schema}.agent_task_queue
      (id, issue_id, agent_id, status, context, result, created_at)
      VALUES ('marker-task', 'marker-issue', 'fixture-agent', 'completed',
        '{"to_stage":"In Review"}'::jsonb, $1::jsonb, now())`,
    [JSON.stringify({ output: `QC_EVIDENCE_JSON=${JSON.stringify(marker())}` })]);

    assert.deepEqual([...await convertQcEvidenceTick(db, async (payload) => {
      posts.push(payload);
      return { status: 201 };
    })], ['marker-task']);
    assert.deepEqual(posts.map((payload) => payload.issue_id), ['marker-issue']);
  } finally { await db.close(); }
});

async function insertNoArtifactCandidate(db, { id, status = 'In Review', metadata = {} }) {
  await db.admin.query(`INSERT INTO ${db.schema}.issue (id, workspace_id, number, status, metadata)
    VALUES ($1, 'workspace-1', 2, $2, $3::jsonb)`, [id, status, JSON.stringify(metadata)]);
  await db.admin.query(`INSERT INTO ${db.schema}.agent_task_queue
    (id, issue_id, agent_id, status, context, result, created_at)
    VALUES ($1, $2, 'fixture-agent', 'completed', '{"to_stage":"In Review"}'::jsonb,
      '{"output":"QC-BLOCKED: no implementation SHA or PR exists. NO-SHA."}'::jsonb, now())`,
  [`task-${id}`, id]);
}

async function rescopeTick(db, postRelay) {
  const client = await db.dbPool.connect();
  try {
    return await rescopeCompletedNoArtifactQc(client, { postRelay, logger: { log() {} } });
  } finally { client.release(); }
}

test('no-artifact rescope does not select an issue with a consumed rescope marker', async () => {
  const db = await deadRowsDb();
  const posts = [];
  try {
    await insertNoArtifactCandidate(db, { id: 'consumed-issue',
      metadata: { no_artifact_rescope_consumed_at: '2026-09-02T06:03:27Z' } });
    assert.deepEqual([...await rescopeTick(db, async (payload) => { posts.push(payload); return { status: 201 }; })], []);
    assert.deepEqual(posts, []);
  } finally { await db.close(); }
});

test('no-artifact rescope does not select an issue that left In Review', async () => {
  const db = await deadRowsDb();
  const posts = [];
  try {
    await insertNoArtifactCandidate(db, { id: 'moved-issue', status: 'Queue' });
    assert.deepEqual([...await rescopeTick(db, async (payload) => { posts.push(payload); return { status: 201 }; })], []);
    assert.deepEqual(posts, []);
  } finally { await db.close(); }
});

test('persistent dead rows claim once across successive and concurrent ticks', async () => {
  const db = await deadRowsDb();
  const posts = [];
  const postRelay = async (payload) => { posts.push(payload); return { ok: true, status: 200 }; };
  try {
    await db.admin.query(`INSERT INTO ${db.schema}.agent_task_queue (id, issue_id, status, created_at)
      VALUES ('task-1', 'issue-1', 'completed', now())`);
    await db.admin.query(`INSERT INTO ${db.schema}.relay_run_log (id, issue_id, task_id, to_stage, status)
      VALUES ('log-1', 'issue-1', 'task-1', 'In Review', 'pending')`);
    await closeDeadRowsTick(db.dbPool, postRelay);
    await closeDeadRowsTick(db.dbPool, postRelay);
    await Promise.all([closeDeadRowsTick(db.dbPool, postRelay), closeDeadRowsTick(db.dbPool, postRelay)]);
    const persisted = await db.admin.query(`SELECT status, parked_audit->>'reason' AS reason FROM ${db.schema}.relay_run_log WHERE id = 'log-1'`);
    assert.equal(posts.length, 1);
    assert.deepEqual(persisted.rows, [{ status: 'failed', reason: 'qc_verdict_missing_after_task_created' }]);
  } finally { await db.close(); }
});

test('persistent Cancelled and 25 dead rows close without starving a later row', async () => {
  const db = await deadRowsDb();
  const posts = [];
  try {
    await db.admin.query(`INSERT INTO ${db.schema}.agent_task_queue (id, issue_id, status, created_at)
      SELECT 'task-' || n, 'issue-' || n, 'completed', now() FROM generate_series(1, 25) n`);
    await db.admin.query(`INSERT INTO ${db.schema}.relay_run_log (id, issue_id, task_id, to_stage, status)
      SELECT 'log-' || n, 'issue-' || n, 'task-' || n, 'In Review', 'pending' FROM generate_series(1, 25) n`);
    await db.admin.query(`INSERT INTO ${db.schema}.relay_run_log (id, issue_id, task_id, to_stage, status)
      VALUES ('cancelled', 'cancelled-issue', 'cancelled-task', 'Cancelled', 'pending')`);
    await closeDeadRowsTick(db.dbPool, async (payload) => { posts.push(payload); return { status: 200 }; });
    const states = await db.admin.query(`SELECT status, count(*)::int AS count FROM ${db.schema}.relay_run_log GROUP BY status ORDER BY status`);
    assert.deepEqual(states.rows, [{ status: 'completed', count: 1 }, { status: 'failed', count: 25 }]);
    assert.equal(posts.length, 25);
  } finally { await db.close(); }
});

function advanceRow(evidenceResult = `QC PASS exact SHA ${SHA}`) {
  return {
    log_id: 'relay-log-1',
    task_id: '22222222-2222-4222-8222-222222222222',
    issue_id: 'issue-1',
    task_status: 'completed',
    task_result: { output: 'Second QC completed without recording another verdict' },
    task_agent_id: 'qc-agent',
    task_started_at: '2026-09-01T18:22:39Z',
    task_completed_at: '2026-09-01T18:24:59Z',
    qc_verdict_checker_id: 'qc-agent',
    qc_verdict: 'PASS',
    qc_verdict_work_product_md5: MD5,
    qc_verdict_notes: `QC PASS exact SHA ${SHA}`,
    qc_verdict_created_at: '2026-09-01T18:10:26Z',
    qc_evidence_tasks: [{
      task_id: '11111111-1111-4111-8111-111111111111',
      task_status: 'completed',
      task_result: { output: evidenceResult },
      task_agent_id: 'qc-agent',
      task_agent_model: 'gpt-5.6-sol',
      task_agent_effort: 'low',
      task_started_at: '2026-09-01T18:07:51Z',
      task_completed_at: '2026-09-01T18:11:09Z'
    }],
    to_stage: 'In Review',
    next_stage: 'CI/CD & Deploy'
  };
}

function advanceHarness(row, currentPass = { verdict: 'PASS', work_product_md5: MD5 },
  missingVerdicts = []) {
  const queries = [];
  const logs = [];
  const payloads = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('to_stage = ANY($1)')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('qc_verdict_missing_after_task_created')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT 1 FROM qc_verdict verdict')) {
        return { rows: missingVerdicts };
      }
      if (sql.includes('SELECT rrl.id AS log_id')) return { rows: [row] };
      if (sql.includes('SELECT verdict, work_product_md5 FROM qc_verdict')) {
        return { rows: currentPass ? [currentPass] : [] };
      }
      if (sql.includes("atq.status IN ('failed', 'cancelled')")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('qc_evidence_mismatch_count')) {
        return { rows: [{ status: 'rejected', mismatch_count: '3' }] };
      }
      if (sql.includes("SET status = 'completed'")) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
    release() {}
  };
  return {
    queries, logs, payloads,
    run: () => findAndAdvanceTasks({ dbPool: { connect: async () => client },
      postRelay: async (payload) => payloads.push(payload) && ({ ok: true, status: 200 }),
      logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) } })
  };
}

test('PASS written after its completed relay row is enqueued for normal admission', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('INSERT INTO relay_run_log')) {
        return { rowCount: 1, rows: [{ id: 'relay-log-new', issue_id: 'issue-1' }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
    release() {}
  };
  const rows = await enqueuePassWithoutRelayRows({
    dbPool: { connect: async () => client }, logger: { log() {}, error() {} }
  });
  assert.deepEqual(rows, [{ id: 'relay-log-new', issue_id: 'issue-1' }]);
  assert.match(queries[0], /i\.status = 'In Review'/);
  assert.match(queries[0], /qc\."verdict" = 'PASS'/);
  assert.match(queries[0], /qc\."created_at" > COALESCE/);
  assert.match(queries[0], /pending\.status = 'pending'/);
  assert.match(queries[0], /LIMIT 20/);
});

test('older verdict-recording Sol-low task advances the latest PASS to deploy', async () => {
  const harness = advanceHarness(advanceRow());
  await harness.run();
  assert.equal(harness.payloads.length, 1);
  assert.equal(harness.payloads[0].to_stage, 'CI/CD & Deploy');
  assert.equal(harness.payloads[0].relay_source_task_id,
    '11111111-1111-4111-8111-111111111111');
  assert.equal(harness.payloads[0].current_work_product_md5, MD5);
  assert.ok(harness.queries.some(({ sql }) => sql.includes("SET status = 'completed'")));
});

test('PASS replay with matching current work-product MD5 is enqueued', async () => {
  const harness = advanceHarness(advanceRow());
  await harness.run();
  assert.equal(harness.payloads.length, 1);
  assert.ok(harness.queries.some(({ sql }) =>
    sql.includes('SELECT verdict, work_product_md5 FROM qc_verdict')));
});

test('PASS replay with mismatched current work-product MD5 is skipped', async () => {
  const harness = advanceHarness(advanceRow(), {
    verdict: 'PASS', work_product_md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  });
  await harness.run();
  assert.equal(harness.payloads.length, 0);
  assert.ok(harness.logs.some((line) => line.includes('stale_pass_md5_mismatch')));
});

test('PASS replay without a verdict work-product MD5 is skipped', async () => {
  const harness = advanceHarness({ ...advanceRow(), qc_verdict_work_product_md5: '' });
  await harness.run();
  assert.equal(harness.payloads.length, 0);
  assert.ok(harness.logs.some((line) => line.includes('pass_without_md5')));
});

test('dispatch-on-exit closes terminal arrivals without a follow-on relay', async () => {
  const terminal = { ...advanceRow(), to_stage: 'Done', next_stage: 'CI/CD & Deploy' };
  const harness = advanceHarness(terminal);
  await harness.run();
  assert.deepEqual(harness.payloads, []);
  assert.ok(harness.queries.some(({ sql }) => sql.includes("SET status = 'completed'")));
  assert.ok(harness.logs.some((line) => line.includes('TERMINAL:') && line.includes("stage='Done'")));
});

test('terminal-source relay logs are completed without requesting a successor', async () => {
  const terminal = { ...advanceRow(), to_stage: 'Done', next_stage: 'CI/CD & Deploy' };
  const harness = advanceHarness(terminal);
  await harness.run();
  assert.deepEqual(harness.payloads, []);
  assert.ok(harness.queries.some(({ sql }) => sql.includes("SET status = 'completed'")));
  assert.ok(harness.logs.some((line) => line.includes('TERMINAL:')));
});

test('completed In Review task without a later verdict fails and escalates to Spec', async () => {
  const missing = { log_id: 'missing-log', task_id: 'missing-task', issue_id: 'missing-issue',
    to_stage: 'In Review' };
  const harness = advanceHarness(advanceRow(), { verdict: 'PASS', work_product_md5: MD5 }, [missing]);
  await harness.run();
  assert.ok(harness.payloads.some((payload) => payload.issue_id === 'missing-issue' &&
    payload.to_stage === 'Spec' &&
    payload.reason === 'retry_escalation:qc_verdict_missing_after_task_created'));
  const failure = harness.queries.find(({ sql }) =>
    sql.includes('qc_verdict_missing_after_task_created'));
  assert.ok(failure);
  assert.deepEqual(failure.values, ['missing-log']);
});

test('Cancelled relay row closes before issue-status admission', async () => {
  const harness = advanceHarness(advanceRow());
  await harness.run();
  const terminal = harness.queries.find(({ sql }) =>
    sql.includes("to_stage = ANY($1)"));
  assert.ok(terminal);
  assert.deepEqual(terminal.values, [['Done', 'Cancelled', 'Archived']]);
});

test('25 dead In Review rows are excluded before the 20-row advance window', async () => {
  const missing = Array.from({ length: 25 }, (_, index) => ({
    log_id: `missing-${index}`, task_id: `task-${index}`, issue_id: `issue-${index}`,
    to_stage: 'In Review'
  }));
  const harness = advanceHarness(advanceRow(), { verdict: 'PASS', work_product_md5: MD5 }, missing);
  await harness.run();
  assert.equal(harness.payloads.filter((payload) => payload.to_stage === 'Spec').length, 25);
  assert.ok(harness.payloads.some((payload) => payload.to_stage === 'CI/CD & Deploy'));
  const advanceQuery = harness.queries.find(({ sql }) => sql.includes('SELECT rrl.id AS log_id') &&
    sql.includes('LIMIT 20'));
  assert.match(advanceQuery.sql, /rrl\.to_stage = 'In Review'/);
  assert.match(advanceQuery.sql, /missing_verdict\.created_at >= atq\.created_at/);
});

test('permanently mismatched evidence is held after the bounded retry limit', async () => {
  const harness = advanceHarness(advanceRow('QC result contains no bound SHA'));
  await harness.run();
  assert.equal(harness.payloads.length, 0);
  assert.ok(harness.logs.some((line) => line.includes('PENDING:') &&
    line.includes('legacy_qc_evidence_mismatch')), JSON.stringify(harness.logs));
  const hold = harness.queries.find(({ sql }) => sql.includes('qc_evidence_mismatch_count'));
  assert.ok(hold);
  assert.match(hold.sql, /THEN 'rejected'/);
  assert.deepEqual(hold.values, ['relay-log-1', 3]);
  assert.ok(!harness.queries.some(({ sql }) => sql.includes("SET status = 'completed'") &&
    !sql.includes('to_stage = ANY($1)')));
});

test('PASS bounce deploys or holds, and never selects Spec', () => {
  assert.deepEqual(qcBounceDecision({ verdict: 'PASS', work_product_md5: MD5 },
    'CI/CD & Deploy'), { action: 'deploy', toStage: 'CI/CD & Deploy' });
  assert.deepEqual(qcBounceDecision({ verdict: 'PASS', work_product_md5: 'invalid' },
    'CI/CD & Deploy'), { action: 'hold', reason: 'pass_deploy_evidence_invalid' });
  assert.deepEqual(qcBounceDecision({ verdict: 'FAIL', work_product_md5: MD5 },
    'CI/CD & Deploy'), { action: 'escalate' });
  const source = fs.readFileSync(require.resolve('../multica-bridge.cjs'), 'utf8');
  const guard = source.slice(source.indexOf('if (issue.status === "In Review" && to_stage === "Spec"'),
    source.indexOf('// Parked and Rejected are terminal'));
  assert.match(guard, /qc_pass_rescope_suppressed/);
  assert.match(guard, /to_stage = decision\.toStage/);
  assert.match(guard, /retryEscalation = null/);
});

test('recovery is dry-run by default and apply reopens each row once', async () => {
  assert.deepEqual(parseArgs([]), { mode: 'dry-run' });
  const candidate = { relay_log_id: 'log-1', issue_id: 'issue-1', number: 807,
    work_product_md5: MD5 };
  const dryEvents = [];
  const dryClient = { query: async (sql) => {
    dryEvents.push(sql);
    return sql.includes('SELECT DISTINCT') ? { rows: [candidate] } : { rows: [] };
  } };
  const dryResult = await recover(dryClient, parseArgs([]));
  assert.deepEqual(dryResult.reopened, []);
  assert.ok(dryEvents.includes('ROLLBACK'));

  let updateCount = 0;
  const applyClient = { query: async (sql) => {
    if (sql.includes('SELECT DISTINCT')) return { rows: [candidate] };
    if (sql.includes('UPDATE relay_run_log')) {
      updateCount += 1;
      return { rows: updateCount === 1 ? [{ relay_log_id: 'log-1', issue_id: 'issue-1' }] : [] };
    }
    return { rows: [] };
  } };
  const applied = await recover(applyClient, parseArgs(['--apply']));
  assert.equal(applied.reopened.length, 1);
});
