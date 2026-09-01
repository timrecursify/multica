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

test('selection scans blockers and existing diagnoses before filling the batch', async () => {
  const ids = ['blocked', 'existing', 'eligible'];
  const pool = {
    query: async () => ({ rows: ids.map((id) => ({ id, workspace_id: 'w', status: 'Parked', priority: 'low',
      metadata: id === 'blocked' ? { parked_blocker: 'owner' } : {} })), rowCount: ids.length }),
    connect: async () => ({ query: async (sql, values) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM issue')) return { rowCount: 1, rows: [{ id: values[0], workspace_id: 'w', status: 'Parked', priority: 'low',
        metadata: values[0] === 'blocked' ? { parked_blocker: 'owner' } : {} }] };
      if (sql.includes('agent_task_queue')) return values[0] === 'existing' ? { rowCount: 1, rows: [{ id: 't', status: 'completed' }] } : { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    }, release() {} })
  };
  const result = await run(pool, parseArgs(['--dry-run', '--batch-size', '1']));
  assert.deepEqual(result.ids.would_queue, ['eligible']);
  assert.deepEqual(result.ids.skipped_blocker, ['blocked']);
  assert.deepEqual(result.ids.skipped_completed, ['existing']);
});

test('inspection skips blockers and nonterminal diagnosis tasks', async () => {
  assert.equal((await inspect({ query: async () => ({ rowCount: 0, rows: [] }) },
    { id: 'i', metadata: { parked_blocker: 'owner' } })).reason, 'named_parked_blocker');
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
    assert.equal(decision.reason, reason);
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
      assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY workspace_id/);
      assert.match(sql, /LIMIT \$1/);
      assert.equal(values[0], MAX_SCAN_WINDOW);
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

test('stale locked rows are recorded while scanning the bounded window', async () => {
  const rows = [
    { id: 'stale', workspace_id: 'w1', status: 'Parked', priority: 'low', metadata: {} },
    { id: 'live', workspace_id: 'w2', status: 'Parked', priority: 'low', metadata: {} }
  ];
  const pool = {
    query: async () => ({ rows, rowCount: rows.length }),
    connect: async () => ({
      query: async (sql, values) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
        if (sql.includes('FROM issue')) return values[0] === 'stale'
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [rows[1]] };
        return { rowCount: 0, rows: [] };
      },
      release() {}
    })
  };
  const result = await run(pool, parseArgs(['--dry-run', '--batch-size', '1']));
  assert.deepEqual(result.ids.stale, ['stale']);
  assert.equal(result.counts.stale, 1);
  assert.deepEqual(result.ids.would_queue, ['live']);
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
