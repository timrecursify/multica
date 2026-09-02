#!/usr/bin/env node
const assert = require('assert');
const test = require('node:test');
const worker = require('./multica-cicd-worker.cjs');
const sha = 'a'.repeat(40);
const issue = { id: 'issue-1', number: 1 };
const pass = { verdict: 'PASS', work_product_md5: 'b'.repeat(32), bound_sha: sha };
const pr = { repo: 'timrecursify/multica', headSha: sha, createdAt: new Date().toISOString() };

function greenGh(args) {
  if (args[0] === 'api') return JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
  if (args[0] === 'run') return JSON.stringify([{ databaseId: 42, conclusion: 'success', name: 'deploy' }]);
  throw new Error(`unexpected gh ${args.join(' ')}`);
}

function dependencies({ receipt, verdict = pass, gh = greenGh }) {
  const calls = [];
  worker.setTestDependencies({
    pool: { query: async () => ({ rows: verdict ? [verdict] : [] }) },
    relay: async (...args) => calls.push(args), gh,
    readReceipt: () => { if (!receipt) throw new Error('missing'); return receipt; }
  });
  return calls;
}

test('Done relay carries the locally evaluated shipped evidence', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const calls = dependencies({ receipt });
  await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][5].ciSuccess, true);
  assert.deepStrictEqual(calls[0][5].mergeDeployReceipt, receipt);
  assert.equal(calls[0][5].reviewedSha, sha);
});

test('return relay carries return evidence', async () => {
  const calls = dependencies({ receipt: null, gh: () => JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'failure' }] }) });
  await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(calls[0][1], 'In Progress');
  assert.equal(calls[0][5].ciFailureOrAbsent, true);
  assert.match(calls[0][5].mergeConflictEvidence, /CI is red/);
});

test('receipt mismatch is the only Human Review receipt path', async () => {
  const calls = dependencies({ receipt: { source_sha: 'c'.repeat(40), release: '/bad', health: 'ok' } });
  await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(calls[0][1], 'Human Review');
  assert.equal(calls[0][5].namedBlocker, true);
});

test('worker retains no self-deploy or direct database writes', () => {
  const source = require('fs').readFileSync(require.resolve('./multica-cicd-worker.cjs'), 'utf8');
  assert.doesNotMatch(source, /execFileSync\('bash'|gh\(\['pr', 'merge'|gh\(\['pr', 'comment'/);
  assert.doesNotMatch(source, /UPDATE |INSERT INTO /);
  assert.match(source, /transition-policy\.cjs/);
});
