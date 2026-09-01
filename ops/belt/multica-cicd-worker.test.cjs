#!/usr/bin/env node
const assert = require('assert');
const worker = require('./multica-cicd-worker.cjs');

async function testFinishedRoutes() {
  const calls = [];
  const queries = [];
  worker.setTestDependencies({
    pool: { query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('FROM qc_verdict')) return { rows: [{ verdict: 'FAIL', work_product_md5: 'stale' }] };
      return { rows: [] };
    } },
    relay: async (...args) => calls.push(args),
  });
  await worker.routeFinishedPR({ id: 'issue-1', number: 1 }, 'PR merged');
  assert.deepStrictEqual(calls, [['issue-1', 'Parked']]);
  assert.match(queries[1].sql, /context->>'to_stage'='CI\/CD & Deploy'/);

  calls.length = 0;
  worker.setTestDependencies({
    pool: { query: async (sql) => sql.includes('FROM qc_verdict')
      ? { rows: [{ verdict: 'PASS', work_product_md5: 'md5' }] }
      : { rows: [] } },
  });
  await worker.routeFinishedPR({ id: 'issue-2', number: 2 }, 'PR merged');
  assert.deepStrictEqual(calls, [['issue-2', 'Done', 'md5']]);

  calls.length = 0;
  await worker.escalateCi(
    { id: 'issue-3', number: 3 },
    { repo: 'owner/repo', num: '7' },
    'red',
  );
  assert.deepStrictEqual(calls, [['issue-3', 'Parked']]);

  calls.length = 0;
  await worker.returnToBuild(
    { id: 'issue-4', number: 4 },
    { repo: 'owner/repo', num: '8' },
    'merge conflict; verify master..merge diff after rebase',
  );
  assert.deepStrictEqual(calls, [[
    'issue-4', 'In Progress', null,
    'RETURN:In Progress — owner/repo#8 merge conflict; verify master..merge diff after rebase',
  ]]);
}

function testConsecutiveFailures() {
  const issue = { id: 'issue-3' };
  const pr = { repo: 'owner/repo', num: '7' };
  assert.equal(worker.countCiFailure(issue, pr, 'sha-1', 'red'), 1);
  assert.equal(worker.countCiFailure(issue, pr, 'sha-1', 'unknown'), 2);
  assert.equal(worker.countCiFailure(issue, pr, 'sha-1', 'mixed'), 3);
  assert.equal(worker.countCiFailure(issue, pr, 'sha-1', 'pending'), 0);
  assert.equal(worker.countCiFailure(issue, pr, 'sha-1', 'red'), 1);
  assert.equal(worker.countCiFailure(issue, pr, 'sha-2', 'red'), 1);
}

function testAbsentCi() {
  worker.setTestDependencies({ gh: () => JSON.stringify({ workflow_runs: [] }) });
  const now = Date.parse('2026-09-01T14:30:00Z');
  assert.equal(worker.ciState('owner/repo', 'sha', '2026-09-01T14:00:00Z', now), 'absent');
  assert.equal(worker.ciState('owner/repo', 'sha', '2026-09-01T14:20:00Z', now), 'pending');
  worker.setTestDependencies({ gh: () => JSON.stringify({ workflow_runs: [
    { status: 'completed', conclusion: 'success' },
    { status: 'in_progress', conclusion: null },
  ] }) });
  assert.equal(worker.ciState('owner/repo', 'sha', '2026-09-01T14:00:00Z', now), 'pending');
}

(async () => {
  await testFinishedRoutes();
  testConsecutiveFailures();
  testAbsentCi();
  console.log('multica-cicd-worker tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
