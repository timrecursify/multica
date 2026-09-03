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
  assert.throws(() => parseArgs(['--dry-run', '--retry-runtime-evidence']), /requires --apply/);
  assert.equal(parseArgs(['--apply', '--retry-runtime-evidence']).retryRuntimeEvidence, true);
  assert.deepEqual(parseArgs(['--apply', '--recover-runtime-evidence-issue',
    '123e4567-e89b-12d3-a456-426614174000']).recoverRuntimeEvidenceIssues,
  ['123e4567-e89b-12d3-a456-426614174000']);
  assert.throws(() => parseArgs(['--apply', '--recover-runtime-evidence-issue', 'bad']), /requires a UUID/);
  assert.throws(() => parseArgs(['--dry-run', '--recover-runtime-evidence-issue',
    '123e4567-e89b-12d3-a456-426614174000']), /requires --apply/);
  assert.equal(MAX_BATCH, 25);
});

test('runtime-evidence correction retry admits exactly the completed held class', async () => {
  const classes = [
    [{ parked_blocker: 'runtime_evidence_unverified' }, 'completed', false, 'eligible'],
    [{ parked_blocker: 'other' }, 'completed', false, 'skip'],
    [{ parked_blocker: 'runtime_evidence_unverified' }, 'running', false, 'skip'],
    [{ parked_blocker: 'runtime_evidence_unverified' }, 'failed', false, 'eligible'],
    [{ parked_blocker: 'runtime_evidence_unverified' }, 'cancelled', false, 'eligible'],
    [{ parked_blocker: 'runtime_evidence_unverified' }, 'completed', true, 'skip'],
    [{}, 'completed', false, 'skip'],
    [{ parked_blocker: 'runtime_evidence_unverified' }, null, false, 'eligible']
  ];
  for (const [metadata, status, priorRetry, expected] of classes) {
    const client = { query: async (sql) => {
      if (sql.includes("evidence_correction_retry")) return { rowCount: priorRetry ? 1 : 0, rows: [] };
      if (sql.includes('agent_task_queue')) return status == null
        ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 'prior', status }] };
      return { rowCount: 0, rows: [] };
    } };
    const decision = await inspect(client, { id: 'issue', metadata }, { retryRuntimeEvidence: true });
    assert.equal(decision.kind, expected, `${JSON.stringify({ metadata, status, priorRetry })}`);
  }
});

test('correction mode has an explicit held-completed candidate predicate and one-shot guard', async () => {
  const seen = [];
  const query = async (sql) => {
    seen.push(sql); return { rows: [], rowCount: 0 };
  };
  await run({ query, connect: async () => ({ query, release() {} }) },
    parseArgs(['--apply', '--retry-runtime-evidence']));
  const sql = seen.find((statement) => statement.includes('WITH ranked AS'));
  assert.match(sql, /i\.metadata->>'parked_blocker' = 'runtime_evidence_unverified'/);
  assert.match(sql, /LOWER\(completed\.status\) = 'completed'/);
  assert.match(sql, /retried\.context->>'evidence_correction_retry' = 'true'/);
});

test('recovery v2 selects only operator-supplied v1-consumed evidence rows', async () => {
  const seen = [];
  const query = async (sql) => {
    seen.push(sql); return { rows: [], rowCount: 0 };
  };
  await run({ query, connect: async () => ({ query, release() {} }) }, parseArgs(['--apply', '--recover-runtime-evidence-issue',
    '123e4567-e89b-12d3-a456-426614174000']));
  const sql = seen.find((statement) => statement.includes('WITH ranked AS'));
  assert.match(sql, /i\.id = ANY\(\$2::uuid\[\]\)/);
  assert.match(sql, /runtime_evidence_recovery_consumed' = 'true'/);
  assert.match(sql, /runtime_evidence_recovery_v2_requested' = 'true'/);
  assert.match(sql, /runtime_evidence_unverified/);
  const source = fs.readFileSync(require.resolve('./backfill-parked-diagnosis.cjs'), 'utf8');
  assert.match(source, /SET context = COALESCE\(context, '\{\}'::jsonb\) \|\|/);
  assert.match(source, /runtime_evidence_recovery_v2_requested/);
});

test('selection allows temporary blockers and retryable diagnoses before the batch limit', async () => {
  const ids = ['eligible'];
  const pool = {
    query: async (sql) => {
      assert.match(sql, /NOT EXISTS \([\s\S]*agent_task_queue d/);
      assert.match(sql, /mega\.id = i\.parent_issue_id/);
      assert.match(sql, /mega\.title LIKE 'MEGA%'/);
      assert.match(sql, /mega\.status NOT IN \('Done', 'Archived', 'Cancelled'\)/);
      assert.match(sql, /NOT IN \('failed', 'cancelled'\)/);
      assert.doesNotMatch(sql, /parked_blocker/);
      return { rows: ids.map((id) => ({ id, workspace_id: 'w', status: 'Parked', priority: 'low', metadata: {} })), rowCount: ids.length };
    }
  };
  const result = await run(pool, parseArgs(['--dry-run', '--batch-size', '1']));
  assert.deepEqual(result.ids.would_queue, ['eligible']);
  assert.equal(result.counts.scanned, 1);
});

test('folded #63 under open MEGA #1029 is skipped and the next candidate commits atomically', async () => {
  const state = { events: [], queued: [] };
  const megaChild = { id: '63', number: 63, workspace_id: 'gsp', status: 'Parked', priority: 'low',
    parent_issue_id: '1029', metadata: { bundled_into: '1029' } };
  const next = { id: '64', number: 64, workspace_id: 'gsp', status: 'Parked', priority: 'low', metadata: {} };
  const client = { query: async (sql, values) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') { state.events.push(sql); return { rows: [], rowCount: 0 }; }
    if (sql.includes('WITH ranked AS')) {
      assert.match(sql, /mega\.id = i\.parent_issue_id/);
      // The fake is the observed result of the SQL predicate: #63 is omitted
      // because its parent #1029 is an open MEGA, so #64 fills this batch slot.
      return { rows: [next], rowCount: 1 };
    }
    if (sql.includes('FROM issue')) return { rows: [next], rowCount: 1 };
    if (sql.includes('SELECT id, status FROM agent_task_queue') || sql.includes('SELECT 1 FROM comment') ||
        sql.includes('SELECT failure_reason, error') || sql.includes('SELECT verdict FROM qc_verdict')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM agent a')) return { rows: [{ id: 'sol', name: 'gsp-parked-diagnosis-sol-low-1',
      model: 'gpt-5.6-sol', runtime_id: 'r', instructions: 'Parked diagnosis: fixable, already_fixed, duplicate, genuinely_blocked.',
      runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' } }], rowCount: 1 };
    if (sql.includes('INSERT INTO agent_task_queue')) { state.queued.push(values[1]); return { rows: [{ id: 'task-64' }], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }, release() {} };
  const result = await run({ query: client.query, connect: async () => client }, parseArgs(['--apply', '--batch-size', '1']));
  assert.equal(megaChild.metadata.bundled_into, '1029');
  assert.deepEqual(result.ids.queued, ['64:task-64']);
  assert.deepEqual(state.queued, ['64']);
  assert.deepEqual(state.events, ['BEGIN', 'COMMIT']);
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

test('apply locks and commits each candidate independently', () => {
  const source = fs.readFileSync(require.resolve('./backfill-parked-diagnosis.cjs'), 'utf8');
  assert.match(source, /WHERE id = \$1 AND status = 'Parked' FOR UPDATE SKIP LOCKED/);
  assert.match(source, /await client\.query\('BEGIN'\);[\s\S]*await client\.query\('COMMIT'\);/);
  assert.match(source, /await client\.query\('ROLLBACK'\)\.catch/);
});

function applyPool(issueCount, failOnTask = null) {
  const state = {
    issues: Array.from({ length: issueCount }, (_, index) => ({
      id: `issue-${index + 1}`, workspace_id: 'workspace-1', status: 'Parked', priority: 'low', metadata: {}
    })), tasks: [], pending: [], events: [], hasFailed: false
  };
  const client = { query: async (sql, values) => {
    if (sql === 'BEGIN') { state.events.push('BEGIN'); state.pending = []; return { rows: [], rowCount: 0 }; }
    if (sql === 'COMMIT') { state.events.push('COMMIT'); state.tasks.push(...state.pending); state.pending = []; return { rows: [], rowCount: 0 }; }
    if (sql === 'ROLLBACK') { state.events.push('ROLLBACK'); state.pending = []; return { rows: [], rowCount: 0 }; }
    if (sql.includes('FROM issue')) {
      const issue = state.issues.find((row) => row.id === values[0]);
      return { rows: issue ? [issue] : [], rowCount: issue ? 1 : 0 };
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
      if (failOnTask === next && !state.hasFailed) {
        state.hasFailed = true;
        throw Object.assign(new Error('bundled child cannot be dispatched'), {
          code: 'bundled_child_no_dispatch'
        });
      }
      const task = { id: `task-${next}`, issue_id: values[1], status: 'queued' };
      state.pending.push(task);
      return { rows: [task], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }, release() {} };
  return { state,
    query: async (sql, values) => {
      assert.match(sql, /WITH ranked AS/);
      const selected = state.issues.filter((issue) => !state.tasks.some((task) => task.issue_id === issue.id &&
        !['failed', 'cancelled'].includes(task.status))).slice(0, values.at(-1));
      return { rows: selected, rowCount: selected.length };
    },
    connect: async () => client };
}

test('successive apply batches progress beyond 100 tickets without duplicates', async () => {
  const pool = applyPool(125);
  for (let batch = 0; batch < 5; batch += 1) {
    const result = await run(pool, parseArgs(['--apply', '--batch-size', '25']));
    assert.equal(result.counts.queued, 25);
  }
  assert.equal(pool.state.tasks.length, 125);
  assert.equal(new Set(pool.state.tasks.map((task) => task.issue_id)).size, 125);
  assert.equal(pool.state.events.filter((event) => event === 'COMMIT').length, 125);
});

test('bundled-child rejection rolls back only that ticket and returns a partial receipt', async () => {
  const pool = applyPool(3, 2);
  const result = await run(pool, parseArgs(['--apply', '--batch-size', '3']));
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(result.ids.failed, [{ issue_id: 'issue-2', reason: 'bundled_child_no_dispatch' }]);
  assert.deepEqual(pool.state.tasks.map((task) => task.issue_id), ['issue-1', 'issue-3']);
  assert.deepEqual(pool.state.pending, []);
  assert.deepEqual(pool.state.events, ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
});

test('apply rejection rolls back, reports a stable reason, and continues the batch', async () => {
  const rows = [
    { id: 'rejected', workspace_id: 'w1', status: 'Parked', priority: 'low', metadata: {} },
    { id: 'eligible', workspace_id: 'w2', status: 'Parked', priority: 'low', metadata: {} }
  ];
  const transactions = new Map(rows.map((row) => [row.id, []]));
  const pool = {
    query: async () => ({ rows, rowCount: rows.length }),
    connect: async () => {
      let issueId;
      const commands = [];
      return {
        query: async (sql, values) => {
          if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') {
            commands.push(sql);
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('FROM issue')) {
            issueId = values[0];
            transactions.set(issueId, commands);
            return { rowCount: 1, rows: [rows.find((row) => row.id === issueId)] };
          }
          if (sql.includes('agent_task_queue') && sql.includes('failure_reason')) {
            if (issueId === 'rejected') {
              throw Object.assign(new Error('bundled child no dispatch'), { code: 'bundled_child_no_dispatch' });
            }
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('qc_verdict')) return { rowCount: 0, rows: [] };
          if (sql.includes('FROM agent a')) return { rowCount: 1, rows: [{
            id: 'owner', runtime_id: 'runtime', name: 'gsp-parked-diagnosis-sol-low', model: 'gpt-5.6-sol',
            runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low' },
            instructions: 'parked diagnosis fixable already_fixed duplicate genuinely_blocked', is_original_scoper: false
          }] };
          if (sql.includes('INSERT INTO comment')) return { rowCount: 1, rows: [] };
          if (sql.includes('INSERT INTO agent_task_queue')) return { rowCount: 1, rows: [{ id: 'task-eligible' }] };
          return { rowCount: 0, rows: [] };
        },
        release() {}
      };
    }
  };
  const result = await run(pool, parseArgs(['--apply', '--batch-size', '2']));
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(result.ids.failed, [{ issue_id: 'rejected', reason: 'bundled_child_no_dispatch' }]);
  assert.deepEqual(result.ids.queued, ['eligible:task-eligible']);
  assert.deepEqual(transactions.get('rejected'), ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(transactions.get('eligible'), ['BEGIN', 'COMMIT']);
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
