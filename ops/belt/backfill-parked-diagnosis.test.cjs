const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const {
  MAX_BATCH, MAX_SCAN_WINDOW, NONTERMINAL, parseArgs, inspect, run
} = require('./backfill-parked-diagnosis.cjs');

test('batch size is bounded at 25 and mode is explicit', () => {
  assert.equal(parseArgs(['--dry-run']).batch, 25);
  assert.equal(parseArgs(['--apply', '--batch-size', '25']).batch, 25);
  assert.throws(() => parseArgs(['--apply', '--batch-size', '26']), /1 to 25/);
  assert.throws(() => parseArgs(['--batch-size', '1']), /exactly one/);
  assert.throws(() => parseArgs(['--dry-run', '--apply']), /exactly one/);
  assert.equal(MAX_BATCH, 25);
});

test('selection allows temporary blockers and retryable diagnoses before the batch limit', async () => {
  const ids = ['eligible'];
  const pool = {
    query: async (sql) => {
      assert.match(sql, /NOT EXISTS \([\s\S]*agent_task_queue d/);
      assert.match(sql, /NOT IN \('failed', 'cancelled'\)/);
      assert.doesNotMatch(sql, /parked_blocker/);
      return { rows: ids.map((id) => ({ id, workspace_id: 'w', status: 'Parked', priority: 'low', metadata: {} })), rowCount: ids.length };
    }
  };
  const result = await run(pool, parseArgs(['--dry-run', '--batch-size', '1']));
  assert.deepEqual(result.ids.would_queue, ['eligible']);
  assert.equal(result.counts.scanned, 1);
});

test('inspection permits temporary blockers and blocks nonterminal diagnosis tasks', async () => {
  const blocked = await inspect({ query: async () => ({ rowCount: 0, rows: [] }) },
    { id: 'i', metadata: { parked_blocker: 'owner' } });
  assert.equal(blocked.kind, 'eligible');
  assert.equal(blocked.previous_blocker, 'owner');
  const client = { query: async (sql) => sql.includes('agent_task_queue')
    ? { rowCount: 1, rows: [{ id: 't' }] } : { rowCount: 0, rows: [] } };
  assert.equal((await inspect(client, { id: 'i', metadata: {} })).reason,
    'nonterminal_parked_diagnosis');
  assert.deepEqual(NONTERMINAL, ['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred']);
});

test('terminal failed and cancelled diagnosis history is reported truthfully', async () => {
  for (const [status, reason] of [
    ['failed', 'failed_parked_diagnosis'],
    ['cancelled', 'cancelled_parked_diagnosis']
  ]) {
    const client = { query: async (sql) => sql.includes('agent_task_queue')
      ? { rowCount: 1, rows: [{ id: `task-${status}`, status }] }
      : { rowCount: 0, rows: [] } };
    const decision = await inspect(client, { id: 'i', metadata: {} });
    assert.equal(decision.kind, 'eligible');
    assert.equal(decision.retrying, reason);
    assert.equal(decision.status, status);
  }
});

test('bounded selection interleaves 25+ rows from one workspace with another', async () => {
  const listedRows = [
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `w1-${index}`, workspace_id: 'w1', status: 'Parked', priority: 'low', metadata: {}
    })),
    { id: 'w2-0', workspace_id: 'w2', status: 'Parked', priority: 'low', metadata: {} }
  ];
  const pool = {
    query: async (sql, values) => {
      assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY i\.workspace_id/);
      assert.match(sql, /LIMIT \$2/);
      assert.equal(values[1], 25);
      return { rows: listedRows, rowCount: listedRows.length };
    },
    connect: async () => ({
      query: async (sql, values) => sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT'
        ? { rowCount: 0, rows: [] }
        : sql.includes('FROM issue')
          ? { rowCount: 1, rows: listedRows.filter((row) => row.id === values[0]) }
          : { rowCount: 0, rows: [] },
      release() {}
    })
  };
  const result = await run(pool, parseArgs(['--dry-run']));
  assert.equal(result.counts.would_queue, 25);
  assert.ok(result.ids.would_queue.includes('w2-0'));
  assert.ok(result.ids.would_queue.some((id) => id.startsWith('w1-')));
  assert.ok(result.counts.scanned <= MAX_SCAN_WINDOW);
});

test('apply locks one eligible batch and commits it as one transaction', () => {
  const source = fs.readFileSync(require.resolve('./backfill-parked-diagnosis.cjs'), 'utf8');
  assert.match(source, /FOR UPDATE OF i SKIP LOCKED/);
  assert.match(source, /await client\.query\('BEGIN'\);[\s\S]*await client\.query\('COMMIT'\);/);
  assert.match(source, /await client\.query\('ROLLBACK'\)\.catch/);
});

function applyPool(issueCount, failOnTask = null) {
  const state = {
    issues: Array.from({ length: issueCount }, (_, index) => ({
      id: `issue-${index + 1}`, workspace_id: 'workspace-1', status: 'Parked', priority: 'low', metadata: {}
    })), tasks: [], pending: [], events: []
  };
  const client = { query: async (sql, values) => {
    if (sql === 'BEGIN') { state.events.push('BEGIN'); state.pending = []; return { rows: [], rowCount: 0 }; }
    if (sql === 'COMMIT') { state.events.push('COMMIT'); state.tasks.push(...state.pending); state.pending = []; return { rows: [], rowCount: 0 }; }
    if (sql === 'ROLLBACK') { state.events.push('ROLLBACK'); state.pending = []; return { rows: [], rowCount: 0 }; }
    if (sql.includes('WITH ranked AS')) {
      const selected = state.issues.filter((issue) => !state.tasks.some((task) => task.issue_id === issue.id &&
        !['failed', 'cancelled'].includes(task.status))).slice(0, values.at(-1));
      return { rows: selected, rowCount: selected.length };
    }
    if (sql.includes('SELECT id, status FROM agent_task_queue')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT 1 FROM comment') || sql.includes('SELECT failure_reason, error') ||
        sql.includes('SELECT verdict FROM qc_verdict')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM agent a')) return { rows: [{
      id: 'agent-1', name: 'gsp-parked-diagnosis-sol-low-1', model: 'gpt-5.6-sol', runtime_id: 'runtime-1',
      instructions: 'Parked diagnosis: fixable, already_fixed, duplicate, genuinely_blocked.',
      runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' }
    }], rowCount: 1 };
    if (sql.includes('INSERT INTO agent_task_queue')) {
      const next = state.pending.length + state.tasks.length + 1;
      if (failOnTask === next) throw new Error('injected task insert failure');
      const task = { id: `task-${next}`, issue_id: values[1], status: 'queued' };
      state.pending.push(task);
      return { rows: [task], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }, release() {} };
  return { state, connect: async () => client };
}

test('successive apply batches progress beyond 100 tickets without duplicates', async () => {
  const pool = applyPool(125);
  for (let batch = 0; batch < 5; batch += 1) {
    const result = await run(pool, parseArgs(['--apply', '--batch-size', '25']));
    assert.equal(result.counts.queued, 25);
  }
  assert.equal(pool.state.tasks.length, 125);
  assert.equal(new Set(pool.state.tasks.map((task) => task.issue_id)).size, 125);
  assert.equal(pool.state.events.filter((event) => event === 'COMMIT').length, 5);
});

test('injected mid-batch failure rolls back every diagnosis task', async () => {
  const pool = applyPool(3, 2);
  await assert.rejects(run(pool, parseArgs(['--apply', '--batch-size', '3'])), /injected task insert failure/);
  assert.deepEqual(pool.state.tasks, []);
  assert.deepEqual(pool.state.pending, []);
  assert.deepEqual(pool.state.events, ['BEGIN', 'ROLLBACK']);
});

test('default selection covers both workspaces and emits stable dry-run IDs', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [
      { id: 'a', workspace_id: 'w1', status: 'Parked', priority: 'low', metadata: {} },
      { id: 'b', workspace_id: 'w2', status: 'Parked', priority: 'low', metadata: {} }
    ], rowCount: 2 };
  }, connect: async () => ({
    query: async (sql, values) => sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT'
      ? { rowCount: 0, rows: [] } : sql.includes('FROM issue')
        ? { rowCount: 1, rows: [{ id: values[0], workspace_id: values[0] === 'a' ? 'w1' : 'w2', status: 'Parked', priority: 'low', metadata: {} }] }
        : { rowCount: 0, rows: [] }, release() {}
  }) };
  const result = await run(pool, parseArgs(['--dry-run']));
  assert.equal(result.counts.would_queue, 2);
  assert.deepEqual(result.ids.would_queue, ['a', 'b']);
  assert.doesNotMatch(calls[0].sql, /workspace_id = \$2/);
});

test('backfill cannot dispatch builders or release work', () => {
  const source = fs.readFileSync(require.resolve('./backfill-parked-diagnosis.cjs'), 'utf8');
  const contract = fs.readFileSync(require.resolve('./parked-diagnosis.cjs'), 'utf8');
  assert.match(contract, /no_builder: true/);
  assert.match(source, /recordParkAndQueueDiagnosis/);
  assert.doesNotMatch(source, /release Queue/i);
});

test('apply path is row-locked and delegates idempotency to the shared insert guard', () => {
  const source = fs.readFileSync(require.resolve('./backfill-parked-diagnosis.cjs'), 'utf8');
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /status = 'Parked'/g);
  const contract = fs.readFileSync(require.resolve('./parked-diagnosis.cjs'), 'utf8');
  assert.match(contract, /WHERE NOT EXISTS \([\s\S]*context->>'kind' = \$7/);
  assert.match(contract, /ON CONFLICT DO NOTHING/);
});
