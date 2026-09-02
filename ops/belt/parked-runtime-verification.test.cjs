const assert = require('node:assert/strict');
const test = require('node:test');
const { processParkedRuntimeVerifications, firstDurableEvidence } = require('./parked-runtime-verification.cjs');
const { verifyRuntimeEvidence } = require('./parked-diagnosis.cjs');
const { run } = require('./backfill-parked-runtime-verification.cjs');

function fixture(count = 1) {
  const items = Array.from({ length: count }, (_, n) => ({ id: `issue-${n + 1}`, processed: false }));
  const state = { items, tasks: [], issueUpdates: [], begins: 0, commits: 0 };
  const client = { async query(sql, values = []) {
    if (sql === 'BEGIN') { state.begins++; return { rows: [], rowCount: 0 }; }
    if (sql === 'COMMIT') { state.commits++; return { rows: [], rowCount: 0 }; }
    if (sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('ORDER BY i.updated_at')) { const ids = values[1]; const rows = items.filter(x => !x.processed && (!ids || ids.includes(x.id))).slice(0, values[4]); return { rows, rowCount: rows.length }; }
    if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [{ id: values[0] }], rowCount: 1 };
    if (sql.includes("context->>'kind' = $3::text") && sql.includes('ORDER BY completed_at')) return { rows: [{ id: 'diagnosis', agent_id: 'agent', result: 'outcome: already_fixed' }], rowCount: 1 };
    if (sql.startsWith('SELECT ref FROM')) return { rows: [{ ref: 'qc:1' }], rowCount: 1 };
    if (sql.includes('SELECT 1 FROM qc_verdict')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (sql.includes('SELECT verdict, work_product_md5')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO agent_task_queue')) { const item = items.find(x => x.id === values[1]); if (item.processed) return { rows: [], rowCount: 0 }; item.processed = true; const id = `verify-${values[1]}`; state.tasks.push(id); return { rows: [{ id }], rowCount: 1 }; }
    if (sql.startsWith('UPDATE issue SET')) { state.issueUpdates.push(values[0]); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith('UPDATE agent_task_queue SET')) return { rows: [], rowCount: 1 };
    if (sql.includes('ORDER BY i.id LIMIT $2')) { const rows = items.filter(x => !x.processed).slice(0, values[1]); return { rows, rowCount: rows.length }; }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  }, release() {} };
  return { state, client, pool: { connect: async () => client, query: (...args) => client.query(...args) } };
}

function dependencies({ verified = true, pass = null } = {}) {
  return { findEvidence: async (_client, id) => `qc:${id.slice(6) || 1}`, verifyEvidence: async () => verified, findPassMD5: async () => pass };
}

test('concurrent ticks reserve one distinct verification task and release once', async () => {
  const f = fixture(); const relays = [];
  const opts = { verificationPool: f.pool, workspaceId: 'workspace', relayPost: async p => { relays.push(p); return { ok: true }; }, ...dependencies() };
  const [left, right] = await Promise.all([processParkedRuntimeVerifications(opts), processParkedRuntimeVerifications(opts)]);
  assert.equal(left.writes + right.writes, 1); assert.deepEqual(f.state.tasks, ['verify-issue-1']); assert.equal(relays.length, 1); assert.equal(relays[0].to_stage, 'In Review');
});

test('verified PASS evidence takes terminal route; absent PASS takes QC route', async () => {
  for (const [pass, stage] of [['abc123', 'Done'], [null, 'In Review']]) {
    const f = fixture(); const relays = [];
    await processParkedRuntimeVerifications({ verificationPool: f.pool, workspaceId: 'workspace', relayPost: async p => { relays.push(p); return { ok: true }; }, ...dependencies({ pass }) });
    assert.equal(relays[0].to_stage, stage); if (pass) assert.equal(relays[0].current_work_product_md5, pass); else assert.match(relays[0].reason, /^runtime_evidence_verified:qc:/);
  }
});

test('unverified evidence fails closed without a relay release', async () => {
  const f = fixture(); const relays = [];
  const result = await processParkedRuntimeVerifications({ verificationPool: f.pool, workspaceId: 'workspace', relayPost: async p => { relays.push(p); return { ok: true }; }, ...dependencies({ verified: false }) });
  assert.equal(result.writes, 1); assert.equal(relays.length, 0); assert.equal(f.state.issueUpdates.length, 1);
});

test('cohort is workspace-scoped and excludes non-parked, non-exact blockers, and diagnosis evidence', async () => {
  const f = fixture();
  let candidateSql = '';
  f.client.query = async (sql, values = []) => {
    candidateSql = sql;
    if (sql.includes('ORDER BY i.updated_at')) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
  const result = await processParkedRuntimeVerifications({
    verificationPool: f.pool, workspaceId: 'workspace', relayPost: async () => ({ ok: true })
  });
  assert.equal(result.writes, 0);
  assert.match(candidateSql, /i\.workspace_id = \$1::uuid/);
  assert.match(candidateSql, /i\.status = 'Parked'/);
  assert.match(candidateSql, /parked_blocker' = 'runtime_evidence_unverified'/);
  assert.match(candidateSql, /context->>'kind' = \$4::text/);
  const diagnosisQueries = [];
  const evidenceClient = { query: async (sql) => {
    diagnosisQueries.push(sql);
    return { rows: [{ '?column?': 1 }], rowCount: 1 };
  } };
  assert.equal(await verifyRuntimeEvidence(evidenceClient, 'issue', 'task:00000000-0000-0000-0000-000000000001'), true);
  assert.match(diagnosisQueries[0], /IS DISTINCT FROM 'parked_diagnosis'/);
  assert.equal(await verifyRuntimeEvidence(evidenceClient, 'issue', 'task:not-a-uuid'), false);
  assert.equal(await verifyRuntimeEvidence(evidenceClient, 'issue', 'prose claiming fixed'), false);
});

test('durable evidence selection never uses diagnosis or verification task rows', async () => {
  let sql = '';
  const client = { query: async (statement) => { sql = statement; return { rows: [], rowCount: 0 }; } };
  assert.equal(await firstDurableEvidence(client, 'issue'), null);
  assert.match(sql, /context->>'kind' IS DISTINCT FROM \$2::text/);
  assert.match(sql, /context->>'kind' IS DISTINCT FROM \$3::text/);
  assert.match(sql, /qc_verdict/);
  assert.match(sql, /activity_log/);
});

test('malformed evidence remains parked and performs no release', async () => {
  const f = fixture(); const relays = [];
  const result = await processParkedRuntimeVerifications({
    verificationPool: f.pool, workspaceId: 'workspace',
    relayPost: async payload => { relays.push(payload); return { ok: true }; },
    findEvidence: async () => 'not-runtime-proof'
  });
  assert.equal(result.writes, 1);
  assert.equal(relays.length, 0);
  assert.equal(f.state.issueUpdates.length, 1);
});

test('backfill dry run is write-free and apply processes 46 tickets in replay-safe 25/21 batches', async () => {
  const f = fixture(46); const relays = [];
  const dry = await run(f.pool, { mode: 'dry-run', workspace: 'workspace', batch: 25 }, async () => ({ ok: true }));
  assert.equal(dry.counts.selected, 25); assert.equal(dry.counts.writes, 0); assert.equal(f.state.tasks.length, 0);
  const one = await run(f.pool, { mode: 'apply', workspace: 'workspace', batch: 25 }, async p => { relays.push(p); return { ok: true }; });
  const two = await run(f.pool, { mode: 'apply', workspace: 'workspace', batch: 25 }, async p => { relays.push(p); return { ok: true }; });
  const replay = await run(f.pool, { mode: 'apply', workspace: 'workspace', batch: 25 }, async p => { relays.push(p); return { ok: true }; });
  assert.deepEqual([one.counts.writes, two.counts.writes, replay.counts.writes], [25, 21, 0]);
  assert.equal(f.state.tasks.length, 46); assert.equal(new Set(f.state.tasks).size, 46); assert.equal(relays.length, 46); assert.equal(f.state.begins, 46); assert.equal(f.state.commits, 46);
});
