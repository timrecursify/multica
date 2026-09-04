#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

test('PASS verdict with a null work-product MD5 still reaches Done', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const calls = dependencies({ receipt, verdict: { verdict: 'PASS', work_product_md5: null } });
  await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][2], null);
  assert.equal(calls[0][5].qualifyingPass, true);
});

test('FAIL verdict returns the issue to build', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const calls = dependencies({ receipt, verdict: { verdict: 'FAIL', work_product_md5: 'b'.repeat(32) } });
  await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(calls[0][1], 'In Progress');
  assert.match(calls[0][3], /latest QC PASS evidence is absent/);
});

test('no verdict accepts merged green work with no-verdict evidence', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const calls = dependencies({ receipt, verdict: null });
  await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][2], null);
  assert.deepStrictEqual(calls[0][5], {
    ciSuccess: true, mergeDeployReceipt: receipt, reviewedSha: sha,
    qualifyingPass: false, noVerdict: true
  });
});

test('merged CI absent is accepted only when the repo has no workflows or suites', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const noWorkflowGh = (args) => {
    const path = args[1] || '';
    if (path.includes('/actions/runs')) return JSON.stringify({ workflow_runs: [] });
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([]);
    if (path.includes('/check-suites')) return JSON.stringify({ check_suites: [] });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt, gh: noWorkflowGh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, createdAt: '2020-01-01T00:00:00Z' });
  assert.equal(calls[0][1], 'Done');
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
  // Merge is belt-owned since 2026-09-03 (CI/CD & Deploy owned end to end);
  // it must stay gated on a green, MERGEABLE PR. Comments and shell stay out.
  assert.doesNotMatch(source, /execFileSync\('bash'|gh\(\['pr', 'comment'/);
  assert.match(source, /info\.mergeable === 'CONFLICTING'/);
  assert.doesNotMatch(source, /UPDATE |INSERT INTO /);
  assert.match(source, /transition-policy\.cjs/);
});

test('a merge that triggered no deploy workflow ships as merge_is_deploy', async () => {
  const noDeployRunGh = (args) => {
    const path = args[1] || '';
    if (path.includes('/actions/runs')) {
      return JSON.stringify({ workflow_runs: [
        { status: 'completed', conclusion: 'success', name: 'CI', path: '.github/workflows/ci.yml' }
      ] });
    }
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([{ name: 'deploy-billing-server.yml' }]);
    if (args[0] === 'run') return JSON.stringify([]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh: noDeployRunGh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, mergedAt: '2020-01-01T00:00:00Z' });
  assert.equal(calls[0][1], 'Done');
  assert.deepStrictEqual(calls[0][5].mergeDeployReceipt,
    { kind: 'merge_is_deploy', sha, noDeployWorkflowTriggered: true });
});

test('a deploy run on the merge sha keeps the ticket pending until it succeeds', async () => {
  const deployQueuedGh = (args) => {
    const path = args[1] || '';
    if (path.includes('/actions/runs')) {
      return JSON.stringify({ workflow_runs: [
        { status: 'completed', conclusion: 'success', name: 'CI', path: '.github/workflows/ci.yml' },
        { status: 'queued', conclusion: null, name: 'Deploy / billing-server',
          path: '.github/workflows/deploy-billing-server.yml' }
      ] });
    }
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([{ name: 'deploy-billing-server.yml' }]);
    if (args[0] === 'run') return JSON.stringify([]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh: deployQueuedGh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, mergedAt: '2020-01-01T00:00:00Z' });
  assert.equal(calls.length, 0);
});

test('cancelled deploy superseded by an ancestral later success reaches Done', async () => {
  const laterSha = 'b'.repeat(40);
  const cancelled = { path: '.github/workflows/deploy-billing-server.yml', conclusion: 'cancelled',
    created_at: '2026-09-04T01:00:00Z', id: 7 };
  const superseding = { path: cancelled.path, conclusion: 'success', head_sha: laterSha,
    created_at: '2026-09-04T02:00:00Z', id: 8 };
  let deployLookup = 0;
  const gh = (args) => {
    const path = args[1] || '';
    if (args[0] === 'api' && path.includes('/actions/runs?head_sha=')) {
      deployLookup += 1;
      return deployLookup === 1
        ? JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success', name: 'CI' }] })
        : JSON.stringify({ workflow_runs: [cancelled] });
    }
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([{ name: 'deploy-billing-server.yml' }]);
    if (args[0] === 'run') return JSON.stringify([]);
    if (path.includes('/actions/runs?status=success')) return JSON.stringify({ workflow_runs: [superseding] });
    if (path.includes('/compare/')) return JSON.stringify({ status: 'behind' });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, mergedAt: '2026-09-04T00:00:00Z' });
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][5].mergeDeployReceipt.kind, 'github_deploy_run_superseded');
});

test('cancelled deploy without qualifying later success returns to build', async () => {
  let deployLookup = 0;
  const gh = (args) => {
    const path = args[1] || '';
    if (args[0] === 'api' && path.includes('/actions/runs?head_sha=')) {
      deployLookup += 1;
      return deployLookup === 1
        ? JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success', name: 'CI' }] })
        : JSON.stringify({ workflow_runs: [{ path: '.github/workflows/deploy-billing-server.yml', conclusion: 'cancelled', created_at: '2026-09-04T01:00:00Z' }] });
    }
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([{ name: 'deploy-billing-server.yml' }]);
    if (args[0] === 'run') return JSON.stringify([]);
    if (path.includes('/actions/runs?status=success')) return JSON.stringify({ workflow_runs: [] });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, mergedAt: '2026-09-04T00:00:00Z' });
  assert.equal(calls[0][1], 'In Progress');
  assert.match(calls[0][3], /deploy run failed/);
});

test('a just-merged sha stays pending inside the deploy trigger grace window', () => {
  worker.setTestDependencies({ gh: () => JSON.stringify({ workflow_runs: [] }) });
  assert.equal(worker.noDeployRunTriggered('timrecursify/ppp', sha, new Date().toISOString()), false);
  assert.equal(worker.noDeployRunTriggered('timrecursify/ppp', sha, undefined), false);
});

test('sweep continues when Human Review escalation is denied', async () => {
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-cicd-worker-'));
  const oldSentinel = process.env.CICD_SENTINEL_MS;
  const oldReceiptRoot = process.env.MULTICA_RECEIPT_ROOT;
  try {
    process.env.CICD_SENTINEL_MS = '0';
    process.env.MULTICA_RECEIPT_ROOT = receiptRoot;
    delete require.cache[require.resolve('./cicd-watchdog.cjs')];
    delete require.cache[require.resolve('./multica-cicd-worker.cjs')];
    const sweepWorker = require('./multica-cicd-worker.cjs');
    const viewed = [];
    const relayed = [];
    sweepWorker.setTestDependencies({
      pool: { query: async (sql, params) => {
        if (sql.startsWith('SELECT id, number')) return { rows: [
          { id: 'issue-escalation', number: 1 }, { id: 'issue-later', number: 2 }
        ] };
        return { rows: [{ content: `https://github.com/timrecursify/multica/pull/${params[0] === 'issue-escalation' ? 1 : 2}` }] };
      } },
      gh: (args) => {
        const number = args[2];
        viewed.push(number);
        if (number === '1') throw new Error('original ticket failure');
        return JSON.stringify({ state: 'CLOSED', mergeable: 'MERGEABLE' });
      },
      relay: async (_id, stage) => {
        if (stage === 'Human Review') throw new Error('409 {"error":"actor_denied"}');
        relayed.push(stage);
      }
    });

    await sweepWorker.sweep();
    assert.deepStrictEqual(viewed, ['1', '2']);
    assert.deepStrictEqual(relayed, ['In Progress']);
  } finally {
    if (oldSentinel === undefined) delete process.env.CICD_SENTINEL_MS;
    else process.env.CICD_SENTINEL_MS = oldSentinel;
    if (oldReceiptRoot === undefined) delete process.env.MULTICA_RECEIPT_ROOT;
    else process.env.MULTICA_RECEIPT_ROOT = oldReceiptRoot;
    fs.rmSync(receiptRoot, { recursive: true, force: true });
  }
});
