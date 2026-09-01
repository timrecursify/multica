const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET || 'test-relay-secret';
process.env.MULTICA_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'test-workspace';

const { qcBounceDecision } = require('../multica-bridge.cjs');
const { enqueuePassWithoutRelayRows, findAndAdvanceTasks } = require('./multica-relay-advance-daemon.cjs');
const { parseArgs, recover } = require('../recover-stranded-qc-pass.cjs');

const SHA = 'c909401ef7a4a438348eb5ceda33839211721524';
const MD5 = '76becea4ab970644b7a21220665a1619';

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

function advanceHarness(row, currentPass = { verdict: 'PASS', work_product_md5: MD5 }) {
  const queries = [];
  const logs = [];
  const payloads = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
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
  assert.ok(!harness.queries.some(({ sql }) => sql.includes("SET status = 'completed'")));
});

test('PASS bounce deploys or holds, and never selects Spec', () => {
  assert.deepEqual(qcBounceDecision({ verdict: 'PASS', work_product_md5: MD5 },
    'CI/CD & Deploy'), { action: 'deploy', toStage: 'CI/CD & Deploy' });
  assert.deepEqual(qcBounceDecision({ verdict: 'PASS', work_product_md5: 'invalid' },
    'CI/CD & Deploy'), { action: 'hold', reason: 'pass_deploy_evidence_invalid' });
  assert.deepEqual(qcBounceDecision({ verdict: 'FAIL', work_product_md5: MD5 },
    'CI/CD & Deploy'), { action: 'escalate' });
  const source = fs.readFileSync(require.resolve('../multica-bridge.cjs'), 'utf8');
  const guard = source.slice(source.indexOf('if (issue.status === "In Review" && to_stage === "Spec")'),
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
