#!/usr/bin/env node
const assert = require('assert');
const test = require('node:test');
// RETRO_REPOS and the watchdog state path are read once at module load, so both
// are set before the require. The watchdog is redirected to a scratch file to
// keep the suite off the live receipt root.
process.env.CICD_RETROACTIVE_REPOS = 'timrecursify/multica';
// Pinned so an operator shell exporting CICD_MERGE_ENABLED=0 cannot turn the
// retro test's merge assertion into a 'green but merging disabled' hold.
process.env.CICD_MERGE_ENABLED = '1';
process.env.CICD_DEPLOY_CANCEL_RETRY_LIMIT = '3';
process.env.CICD_WATCHDOG_STATE = require('path')
  .join(require('os').tmpdir(), `cicd-watchdog-test-${process.pid}.json`);
const worker = require('./multica-cicd-worker.cjs');
const sha = 'a'.repeat(40);
const issue = { id: 'issue-1', number: 1 };
const pass = { verdict: 'PASS', work_product_md5: 'b'.repeat(32), bound_sha: sha };
const pr = { repo: 'timrecursify/multica', headSha: sha, createdAt: new Date().toISOString() };
// setTestDependencies replaces the module-global log; the sweep tests restore
// this so a test appended after them does not log into a dead array.
const defaultLog = (...a) => console.log(new Date().toISOString(), ...a);

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

test('merged PR whose runs are all cancelled continues through deploy evidence', async () => {
  const calls = dependencies({ receipt: null, gh: () => JSON.stringify({ workflow_runs: [
    { status: 'completed', conclusion: 'cancelled', name: 'CI', path: '.github/workflows/ci.yml' },
  ] }) });
  const result = await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(result.status, 'done');
  assert.equal(calls[0][1], 'Done');
});

test('merged PR whose CI lookup throws is held without returning to build', async () => {
  const lines = [];
  const calls = dependencies({ receipt: null, gh: () => { throw new Error('rate limited'); } });
  worker.setTestDependencies({ log: (...a) => lines.push(a.join(' ')) });
  const result = await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(result.status, 'returned');
  assert.equal(calls.length, 0);
  assert.ok(lines.some(line => line.includes('HOLD #1 merged') && line.includes('ci=unknown')));
  assert.ok(lines.some(line => line.includes('CI-UNKNOWN') && line.includes('rate limited')));
  worker.setTestDependencies({ log: defaultLog });
});

test('cancelled deploy superseded by a later success containing the merge reaches Done', async () => {
  const laterSha = 'b'.repeat(40);
  const cancelled = { path: '.github/workflows/deploy-billing-server.yml', conclusion: 'cancelled',
    created_at: '2026-09-04T01:00:00Z', id: 7 };
  const superseding = { path: cancelled.path, conclusion: 'success', head_sha: laterSha,
    created_at: '2026-09-04T02:00:00Z', id: 8 };
  let deployLookup = 0;
  const reruns = [];
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
    if (path.includes('/compare/')) return JSON.stringify({ status: 'ahead' });
    if (args[0] === 'api' && args[1] === '-X') { reruns.push(args); return ''; }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, mergedAt: '2026-09-04T00:00:00Z' });
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][5].mergeDeployReceipt.kind, 'github_deploy_run_superseded');
  assert.equal(reruns.length, 0);
});

test('cancelled deploy without qualifying later success is held as undeployed', async () => {
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
    if (path.includes('/actions/runs?status=success')) return JSON.stringify({ workflow_runs: [{
      path: '.github/workflows/deploy-billing-server.yml', conclusion: 'success',
      head_sha: 'b'.repeat(40), created_at: '2026-09-04T02:00:00Z', id: 9
    }] });
    if (path.includes('/compare/')) return JSON.stringify({ status: 'behind' });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, mergedAt: '2026-09-04T00:00:00Z' });
  assert.equal(calls.length, 0);
});

test('cancelled deploy reruns by run id and caps repeated rerun failures', async () => {
  const retryIssue = { id: 'retry-issue', number: 77 };
  const updates = [];
  const ghCalls = [];
  worker.setTestDependencies({
    pool: { query: async (_sql, params) => { updates.push(params); return { rows: [] }; } },
    gh: (args) => { ghCalls.push(args); throw new Error('rerun unavailable'); },
    log: () => {}
  });
  const cancelled = [{ id: 321, path: '.github/workflows/deploy-billing-server.yml' }];
  for (let i = 0; i < 3; i += 1) {
    const result = await worker.retriggerCancelledDeploys(retryIssue, 'timrecursify/ppp', sha, cancelled);
    assert.equal(result.capped, i === 2 ? 1 : 0);
  }
  const capped = await worker.retriggerCancelledDeploys(retryIssue, 'timrecursify/ppp', sha, cancelled);
  assert.equal(capped.capped, 1);
  assert.equal(ghCalls.length, 3);
  assert.deepEqual(ghCalls[0], ['api', '-X', 'POST', 'repos/timrecursify/ppp/actions/runs/321/rerun']);
  const persisted = updates.filter(params => params.length === 3);
  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.map(params => params[2]), [1, 2, 3]);
  worker.setTestDependencies({ log: defaultLog });
});

test('cancelled deploy compare errors remain held as undeployed', async () => {
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
    if (path.includes('/actions/runs?status=success')) return JSON.stringify({ workflow_runs: [{
      path: '.github/workflows/deploy-billing-server.yml', conclusion: 'success',
      head_sha: 'b'.repeat(40), created_at: '2026-09-04T02:00:00Z', id: 10
    }] });
    if (path.includes('/compare/')) throw new Error('compare unavailable');
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, mergedAt: '2026-09-04T00:00:00Z' });
  assert.equal(calls.length, 0);
});

test('cancelled deploy reruns the cancelled run by id', async () => {
  const reruns = [];
  const run = { path: '.github/workflows/deploy-billing-server.yml', conclusion: 'cancelled', id: 101 };
  worker.setTestDependencies({ gh: args => {
    if (args[0] === 'api' && args[1] === '-X') { reruns.push(args); return ''; }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  }, pool: { query: async () => ({ rows: [] }) } });
  const result = await worker.retriggerCancelledDeploys({ id: 'rerun-issue', number: 101 }, 'timrecursify/ppp', sha, [run]);
  assert.equal(result.dispatched, 1);
  assert.deepStrictEqual(reruns[0], ['api', '-X', 'POST', 'repos/timrecursify/ppp/actions/runs/101/rerun']);
});

test('cancelled deploy retry failures consume the bounded cap', async () => {
  let attempts = 0;
  worker.setTestDependencies({ gh: () => { attempts += 1; throw new Error('dispatch unavailable'); }, pool: { query: async () => ({ rows: [] }) } });
  const retryIssue = { id: 'cap-issue', number: 102 };
  const run = { path: '.github/workflows/deploy-billing-server.yml', conclusion: 'cancelled', id: 102 };
  await worker.retriggerCancelledDeploys(retryIssue, 'timrecursify/ppp', sha, [run]);
  await worker.retriggerCancelledDeploys(retryIssue, 'timrecursify/ppp', sha, [run]);
  await worker.retriggerCancelledDeploys(retryIssue, 'timrecursify/ppp', sha, [run]);
  const capped = await worker.retriggerCancelledDeploys(retryIssue, 'timrecursify/ppp', sha, [run]);
  assert.equal(attempts, 3);
  assert.equal(capped.capped, 1);
});

test('cancelled deploy retry count is read from and written into nested metadata', async () => {
  const persistedSha = 'd'.repeat(40);
  const key = `persisted-issue:${persistedSha}:deploy-billing-server.yml`;
  const updates = [];
  const reruns = [];
  worker.setTestDependencies({
    pool: { query: async (sql, params) => {
      if (/SELECT metadata/.test(sql)) return { rows: [{ metadata: { deploy_cancel_retries: { [key]: 2 } } }] };
      updates.push({ sql, params });
      return { rows: [] };
    } },
    gh: args => { reruns.push(args); return ''; },
    log: () => {}
  });
  const run = { id: 909, path: '.github/workflows/deploy-billing-server.yml' };
  const result = await worker.retriggerCancelledDeploys({ id: 'persisted-issue', number: 103 }, 'timrecursify/ppp', persistedSha, [run]);
  assert.equal(result.dispatched, 1);
  assert.equal(reruns.length, 1);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params, ['persisted-issue', key, 3]);
  assert.match(updates[0].sql, /COALESCE\(metadata->'deploy_cancel_retries', '\{\}'::jsonb\)/);
  worker.setTestDependencies({ log: defaultLog });
});

test('third return for the same reason escalates once instead of looping', async () => {
  const loopIssue = { id: 'loop-issue', number: 99, workspace_id: 'gsp' };
  const calls = dependencies({ receipt: { source_sha: sha, release: '/r', health: 'ok' } });
  await worker.returnToBuild(loopIssue, { repo: 'timrecursify/multica', num: 1 }, 'deploy run failed for sha (deploy.yml=failure)');
  await worker.returnToBuild(loopIssue, { repo: 'timrecursify/multica', num: 1 }, 'deploy run failed for sha (deploy.yml=failure)');
  await worker.returnToBuild(loopIssue, { repo: 'timrecursify/multica', num: 1 }, 'deploy run failed for sha (deploy.yml=failure)');
  assert.deepEqual(calls.map(call => call[1]), ['In Progress', 'In Progress', 'Parked']);
});

test('a just-merged sha stays pending inside the deploy trigger grace window', () => {
  worker.setTestDependencies({ gh: () => JSON.stringify({ workflow_runs: [] }) });
  assert.equal(worker.noDeployRunTriggered('timrecursify/ppp', sha, new Date().toISOString()), false);
  assert.equal(worker.noDeployRunTriggered('timrecursify/ppp', sha, undefined), false);
});

// Fix A renamed the all-cancelled CI state to 'cancelled_only'. The retroactive
// merge gate in sweep() must recognise the new name, or an open PR whose runs
// were all cancelled matches no arm and holds forever with no escalation path:
// countCiFailure only counts red and mixed, and ci is not 'absent'.
test('sweep sends an all-cancelled open PR in a retroactive repo down the retro path', async () => {
  const repo = 'timrecursify/multica';
  const headSha = 'c'.repeat(40);
  const lines = [];
  const ghCalls = [];
  worker.setTestDependencies({
    log: (...a) => lines.push(a.join(' ')),
    pool: { query: async (sql) => (/FROM issue/.test(sql)
      ? { rows: [{ id: 'issue-retro', number: 4242, title: 't', workspace_id: 'w', metadata: {} }] }
      : { rows: [{ content: `built in https://github.com/${repo}/pull/77` }] }) },
    relay: async () => { throw new Error('sweep must not relay on the retro path'); },
    gh: (args) => {
      ghCalls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: headSha,
          createdAt: new Date().toISOString(), mergedAt: null, mergeCommit: null });
      }
      if (args[0] === 'api' && args[1].includes('/actions/runs?head_sha=')) {
        return JSON.stringify({ workflow_runs: [
          { status: 'completed', conclusion: 'cancelled', name: 'CI' },
          { status: 'completed', conclusion: 'cancelled', name: 'reviewer-gate' },
        ] });
      }
      if (args[0] === 'api' && args[1].includes('/pulls/77/files')) {
        return JSON.stringify([{ filename: 'ops/belt/multica-cicd-worker.cjs' }]);
      }
      if (args[0] === 'pr' && args[1] === 'merge') return '';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    }
  });

  await worker.sweep();

  assert.ok(!lines.some(l => l.startsWith('HOLD ')), `unexpected HOLD: ${lines.join(' | ')}`);
  const retro = lines.find(l => l.startsWith('RETRO #4242'));
  assert.ok(retro, `no RETRO line: ${lines.join(' | ')}`);
  assert.match(retro, /ci=cancelled_only/);
  assert.ok(ghCalls.some(c => c.startsWith(`pr merge 77 -R ${repo}`)), 'PR was never merged');
  worker.setTestDependencies({ log: defaultLog });
});

// The same state in a repo outside CICD_RETROACTIVE_REPOS must still hold: the
// retro path is opt-in per repository and must not merge ahead of CI elsewhere.
test('sweep holds an all-cancelled open PR in a non-retroactive repo', async () => {
  const repo = 'timrecursify/other';
  const lines = [];
  worker.setTestDependencies({
    log: (...a) => lines.push(a.join(' ')),
    pool: { query: async (sql) => (/FROM issue/.test(sql)
      ? { rows: [{ id: 'issue-hold', number: 4243, title: 't', workspace_id: 'w', metadata: {} }] }
      : { rows: [{ content: `built in https://github.com/${repo}/pull/78` }] }) },
    relay: async () => { throw new Error('sweep must not relay on the hold path'); },
    gh: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'd'.repeat(40),
          createdAt: new Date().toISOString(), mergedAt: null, mergeCommit: null });
      }
      if (args[0] === 'api' && args[1].includes('/actions/runs?head_sha=')) {
        return JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'cancelled', name: 'CI' }] });
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    }
  });

  await worker.sweep();

  const hold = lines.find(l => l.startsWith('HOLD #4243'));
  assert.ok(hold, `no HOLD line: ${lines.join(' | ')}`);
  assert.match(hold, /ci=cancelled_only/);
  assert.match(hold, /retro=repo not retroactive/);
  worker.setTestDependencies({ log: defaultLog });
});
