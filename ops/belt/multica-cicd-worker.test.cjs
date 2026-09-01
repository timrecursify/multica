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
  assert.deepStrictEqual(calls, [[
    'issue-1', 'In Progress', null,
    'RETURN:In Progress — PR merged; latest QC is FAIL',
  ]]);
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
  assert.deepStrictEqual(calls, [[
    'issue-3', 'In Progress', null,
    'RETURN:In Progress — owner/repo#7 ci=red for 3 consecutive polls',
  ]]);

  calls.length = 0;
  await worker.escalateCi(
    { id: 'issue-3', number: 3 },
    { repo: 'owner/repo', num: '7' },
    'mixed',
  );
  assert.deepStrictEqual(calls, [[
    'issue-3', 'In Progress', null,
    'RETURN:In Progress — owner/repo#7 ci=mixed for 3 consecutive polls',
  ]]);

  calls.length = 0;
  await worker.escalateCi(
    { id: 'issue-3', number: 3 },
    { repo: 'owner/repo', num: '7' },
    'pending',
  );
  assert.deepStrictEqual(calls, [[
    'issue-3', 'In Progress', null,
    'RETURN:In Progress — owner/repo#7 ci=pending for 3 consecutive polls',
  ]]);

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
  assert.equal(worker.countCiFailure(issue, pr, 'sha-1', 'pending'), 4);
  assert.equal(worker.countCiFailure(issue, pr, 'sha-1', 'no_checks'), 0);
  assert.equal(worker.countCiFailure(issue, pr, 'sha-1', 'red'), 1);
  assert.equal(worker.countCiFailure(issue, pr, 'sha-2', 'red'), 1);
}

function testAbsentCi() {
  worker.setTestDependencies({ gh: () => JSON.stringify({ workflow_runs: [] }) });
  const now = Date.parse('2026-09-01T14:30:00Z');
  assert.equal(worker.ciState('owner/repo', 'sha', '2026-09-01T14:00:00Z', now), 'absent');
  assert.equal(worker.ciState('owner/repo', 'sha', '2026-09-01T14:20:00Z', now), 'no_checks');
  worker.setTestDependencies({ gh: () => JSON.stringify({ workflow_runs: [
    { status: 'completed', conclusion: 'success' },
    { status: 'in_progress', conclusion: null },
  ] }) });
  assert.equal(worker.ciState('owner/repo', 'sha', '2026-09-01T14:00:00Z', now), 'pending');
}

function testHumanReviewIsNotDispatchable() {
  const source = require('fs').readFileSync(require.resolve('./multica-cicd-worker.cjs'), 'utf8');
  const sweep = source.slice(source.indexOf('async function sweep()'), source.indexOf('async function main()'));
  assert.match(sweep, /WHERE status='CI\/CD & Deploy'/);
  assert.doesNotMatch(sweep, /Human Review/);
}

async function testCompletionAdmission() {
  const calls = [];
  const retries = new Map();
  let issue = { id: 'closed', number: 11, workspace_id: 'gsp' };
  const setup = (content, state, deployed = false) => worker.setTestDependencies({
    pool: { query: async (sql, params) => {
      if (sql.includes("FROM issue WHERE status")) return { rows: [issue] };
      if (sql.includes('FROM comment')) return { rows: [{ content }] };
      if (sql.includes('FROM qc_verdict')) return { rows: [{ verdict: 'PASS', work_product_md5: 'md5' }] };
      if (sql.includes('relay_stage_config')) return { rows: [] };
      if (sql.includes('cicd_deploy_wait_polls')) {
        const count = (retries.get(params[0]) || 0) + 1;
        retries.set(params[0], count);
        return { rows: [{ count: String(count) }] };
      }
      return { rows: [] };
    } }, relay: async (...args) => calls.push(args),
    gh: () => JSON.stringify({ state, mergeable: 'MERGEABLE', headRefOid: 'head', createdAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-01T01:00:00Z', mergeCommit: { oid: 'merge' } }),
    deployed: () => deployed,
  });
  setup('', 'MERGED');
  await worker.sweep();
  assert.equal(calls[0][1], 'Parked'); // no PR -> Parked
  calls.length = 0;
  setup('https://github.com/timrecursify/sk-cli/pull/1', 'CLOSED');
  await worker.sweep();
  assert.equal(calls[0][1], 'Parked'); // CLOSED -> Parked
  calls.length = 0; issue = { id: 'wait', number: 12, workspace_id: 'gsp' };
  setup('https://github.com/timrecursify/sk-cli/pull/2', 'MERGED', false);
  await worker.sweep();
  assert.equal(calls.length, 0); // merged without evidence waits
  setup('https://github.com/timrecursify/sk-cli/pull/2', 'MERGED', true);
  await worker.sweep();
  assert.deepStrictEqual(calls[0].slice(0, 3), ['wait', 'Done', 'md5']);
  calls.length = 0; issue = { id: 'ppp', number: 13, workspace_id: 'prod' };
  setup('https://github.com/timrecursify/ppp/pull/3', 'MERGED', false);
  await worker.sweep(); await worker.sweep(); await worker.sweep();
  assert.equal(calls.at(-1)[1], 'Parked'); // retry ceiling -> Parked
}

(async () => {
  await testFinishedRoutes();
  testConsecutiveFailures();
  testAbsentCi();
  testHumanReviewIsNotDispatchable();
  await testCompletionAdmission();
  console.log('multica-cicd-worker tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
