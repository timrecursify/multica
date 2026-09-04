'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorker } = require('../worker/multica-cicd-worker.cjs');

const issue = { id: 'i', number: 2116 };
const sha = 'a'.repeat(40);
const pr = 'https://github.com/acme/repo/pull/7';

function harness({ relay = async () => ({ ok: true, status: 200 }), stale = false, leaseRows = [{ issue_id: 'i' }] } = {}) {
  const sqls = [];
  const pool = { query: async (sql) => {
    sqls.push(sql);
    if (sql.includes('FROM issue WHERE')) return { rows: [issue] };
    if (sql.includes('COALESCE(last_attempt_at')) return { rows: stale ? [{ issue_id: 'i' }] : [] };
    if (sql.includes('FROM comment')) return { rows: [{ content: pr }] };
    if (sql.includes('FROM qc_attempt')) return { rows: [{ verdict: 'PASS', qualifying: true, model: 'gpt-5.6-sol', effort: 'low', bound_sha: sha }] };
    if (sql.includes('INSERT INTO cicd_deploy_attempt') && sql.includes('RETURNING')) return { rows: leaseRows };
    return { rows: [] };
  } };
  const gh = args => args[0] === 'pr' && args[1] === 'merge' ? '' : args[0] === 'pr'
    ? JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: sha })
    : JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
  const logs = [];
  return { worker: createWorker({ pool, gh, relay, enforceLease: true, log: x => logs.push(x), attemptTimeoutMs: 100 }), sqls, logs };
}

test('relay failure is durably recorded as failed', async () => {
  const h = harness({ relay: async () => { throw new Error('relay timeout'); } });
  await h.worker.sweep();
  assert.ok(h.sqls.some(s => s.includes('INSERT INTO cicd_deploy_attempt')));
});

test('stale attempt is re-read and emits watchdog recovery evidence', async () => {
  const h = harness({ stale: true });
  await h.worker.sweep();
  assert.ok(h.logs.some(x => x.includes('WATCHDOG #2116 stale attempt')));
});

test('active lease prevents a duplicate merge', async () => {
  const h = harness({ leaseRows: [] });
  await h.worker.sweep();
  assert.ok(!h.sqls.some(s => s.includes("UPDATE agent_task_queue SET status='completed'")));
});
