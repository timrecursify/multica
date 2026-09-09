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
process.env.SK_COMMAND = '/usr/bin/false';
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

function activationReceipt(target = 'gsp-belt', sourceSha = sha) {
  const owners = {
    'gsp-belt': 'ops/belt/deploy.sh',
    'gsp-multica': 'multica-application-deployer'
  };
  return {
    schema_version: 1, repository: 'timrecursify/multica', target,
    deployment_owner: owners[target], source_sha: sourceSha,
    activation: { status: 'activated', activated_at: '2026-09-07T14:00:00Z',
      process_sha: sourceSha, release: `/releases/${sourceSha}` },
    health: { status: 'ok', checked_at: '2026-09-07T14:00:05Z', probe: 'service-health' }
  };
}

function dependencies({ receipt, verdict = pass, gh = greenGh }) {
  const calls = [];
  worker.setTestDependencies({
    pool: { query: async () => ({ rows: verdict ? [verdict] : [] }) },
    relay: async (...args) => calls.push(args), gh,
    readChangedPaths: () => ['ops/belt/multica-cicd-worker.cjs'],
    readReceipt: (_repo, target) => {
      if (!receipt) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
      return activationReceipt(target, receipt.source_sha);
    }
  });
  return calls;
}

test('relay closure requires an explicit successful response', () => {
  assert.deepStrictEqual(worker.parseRelayResponse('{"success":true,"relay_log_id":7}', 'Done'),
    { success: true, relay_log_id: 7 });
  assert.throws(() => worker.parseRelayResponse('{"error":"evidence_missing"}', 'Done'),
    /relay rejected Done: evidence_missing/);
  assert.throws(() => worker.parseRelayResponse('not-json', 'Done'), /relay malformed response/);
});

test('Done relay carries the locally evaluated shipped evidence', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const calls = dependencies({ receipt });
  await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][5].ciSuccess, true);
  assert.equal(calls[0][5].mergeDeployReceipt.kind, 'activation_receipts');
  assert.deepStrictEqual(calls[0][5].mergeDeployReceipt.targets, ['gsp-belt']);
  assert.equal(calls[0][5].reviewedSha, sha);
});

test('eligible pending CI reaches Done with truthful retroactive evidence', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const gh = (args) => {
    const path = args[1] || '';
    if (path.includes('/actions/runs?head_sha=')) return JSON.stringify({ workflow_runs: [{ status: 'queued', conclusion: null }] });
    if (path.includes('/pulls/17/files')) return JSON.stringify([{ filename: 'src/worker.js' }]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt, gh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, num: '17' });
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][5].ciSuccess, 'retroactive');
  assert.equal(calls[0][5].retroactiveMerge, true);
});

test('risk-path pending CI remains held', async () => {
  const gh = (args) => {
    const path = args[1] || '';
    if (path.includes('/actions/runs?head_sha=')) return JSON.stringify({ workflow_runs: [{ status: 'queued', conclusion: null }] });
    if (path.includes('/pulls/17/files')) return JSON.stringify([{ filename: 'migrations/001.sql' }]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh });
  const result = await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, num: '17' });
  assert.equal(result.status, 'returned');
  assert.equal(calls.length, 0);
});

test('merged cancelled-only risk-path CI proceeds to deploy handling', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const gh = (args) => {
    const path = args[1] || '';
    if (path.includes('/actions/runs?head_sha=')) {
      return JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'cancelled', name: 'CI' }] });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt, gh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, num: '17' });
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][5].ciSuccess, 'retroactive');
});

test('merged no-checks risk-path CI proceeds without retroactive risk approval', async () => {
  const receipt = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  const gh = (args) => {
    const path = args[1] || '';
    if (path.includes('/actions/runs?head_sha=')) return JSON.stringify({ workflow_runs: [] });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt, gh });
  await worker.routeFinishedPR(issue, 'merged', sha, { ...pr, num: '17' });
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][5].ciSuccess, 'retroactive');
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
  assert.equal(calls[0][5].ciSuccess, true);
  assert.equal(calls[0][5].mergeDeployReceipt.kind, 'activation_receipts');
  assert.equal(calls[0][5].reviewedSha, sha);
  assert.equal(calls[0][5].qualifyingPass, false);
  assert.equal(calls[0][5].noVerdict, true);
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

test('mismatched SHA receipt refuses Done and returns to build', async () => {
  const calls = dependencies({ receipt: { source_sha: 'c'.repeat(40), release: '/bad', health: 'ok' } });
  await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(calls[0][1], 'In Progress');
  assert.match(calls[0][3], /deployment evidence failed.*activation_receipt_invalid/);
});

test('closure stall returns to Spec with system retry-escalation evidence', async () => {
  const calls = [];
  worker.setTestDependencies({
    watchdog: {
      observe: () => ({ stage: 'CI/CD & Deploy', first_seen_at: new Date(0).toISOString(),
        last_error: 'deploy pending', correlation_key: 'corr-1' }),
      stalled: () => true,
      markAlerted: row => row
    },
    relay: async (...args) => calls.push(args)
  });
  const alerted = await worker.closureWatchdog(issue, { status: 'pending' }, sha);
  assert.equal(alerted, true);
  assert.equal(calls[0][1], 'Spec');
  assert.equal(calls[0][5].retry_escalation, true);
  assert.equal(calls[0][5].trigger_reason, 'closure_stalled');
  assert.equal(calls[0][5].correlation_key, 'corr-1');
  assert.match(calls[0][3], /^retry_escalation:closure_stalled/);
  worker.setTestDependencies({ watchdog: require('./cicd-watchdog.cjs').createWatchdog({
    file: require('path').join(require('os').tmpdir(), `cicd-watchdog-test-${process.pid}.json`)
  }), relay: async (...args) => calls.push(args) });
});

test('closure discovery outage returns to configured Spec instead of Human Review', async () => {
  const calls = [];
  worker.setTestDependencies({
    watchdog: {
      observe: () => ({ stage: 'CI/CD & Deploy', first_seen_at: new Date(0).toISOString(),
        last_error: 'discovery_auth_failure', correlation_key: 'corr-auth' }),
      stalled: () => true,
      markAlerted: row => row
    },
    relay: async (...args) => calls.push(args)
  });
  const alerted = await worker.closureWatchdog(issue, {
    status: 'pending', outcome: 'discovery_auth_failure', retryEligible: true,
    blocker: { type: 'discovery_auth_failure', retry_eligible: true }
  }, sha);
  assert.equal(alerted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'Spec');
  assert.equal(calls[0][5].retry_escalation, true);
  assert.doesNotMatch(calls[0][3], /Human Review/);
});

test('retryable deploy blocker remains observable to the closure watchdog', async () => {
  const calls = [];
  const observations = [];
  worker.setTestDependencies({
    watchdog: {
      observe: (...args) => observations.push(args),
      stalled: () => false
    },
    relay: async (...args) => calls.push(args)
  });
  const alerted = await worker.closureWatchdog(issue, {
    status: 'pending', outcome: 'discovery_unavailable', retryEligible: true,
    blocker: { type: 'changed_path_discovery_unavailable' }
  }, sha);
  assert.equal(alerted, false);
  assert.equal(calls.length, 0);
  assert.deepStrictEqual(observations[0][1], {
    sha, outcome: 'discovery_unavailable', error: 'changed_path_discovery_unavailable'
  });
  worker.setTestDependencies({ watchdog: require('./cicd-watchdog.cjs').createWatchdog({
    file: require('path').join(require('os').tmpdir(), `cicd-watchdog-test-${process.pid}.json`)
  }) });
});

test('worker retains no self-deploy or direct database writes', () => {
  const source = require('fs').readFileSync(require.resolve('./multica-cicd-worker.cjs'), 'utf8');
  // Merge is belt-owned since 2026-09-03 (CI/CD & Deploy owned end to end);
  // it must stay gated on a green, MERGEABLE PR. Comments and shell stay out.
  assert.doesNotMatch(source, /execFileSync\('bash'|gh\(\['pr', 'comment'/);
  assert.match(source, /info\.mergeable === 'CONFLICTING'/);
  assert.doesNotMatch(source, /UPDATE |INSERT INTO /);
  assert.match(source, /transition-policy\.cjs/);
  assert.match(source, /DEFAULT_SK_COMMAND = '\/opt\/gsp\/.sk\/bin\/sk'/);
  assert.match(source, /await execFileAsync\(SK_COMMAND, \['multica', 'comment'/);
});

test('SK_COMMAND defaults safely and honors an explicit override', () => {
  assert.equal(worker.resolveSkCommand({}), '/opt/gsp/.sk/bin/sk');
  assert.equal(worker.resolveSkCommand({ SK_COMMAND: '/custom/bin/sk' }), '/custom/bin/sk');
});

test('watchdog escalation forwards producing CI/CD task id', async () => {
  const calls = [];
  worker.setTestDependencies({
    watchdog: { observe: () => ({ stage: 'CI/CD & Deploy', first_seen_at: new Date(0).toISOString(), last_error: 'x', correlation_key: 'c' }), stalled: () => true, markAlerted: r => r },
    relay: async (...args) => calls.push(args)
  });
  await worker.closureWatchdog({ id: 'i', number: 1, cicd_task_id: '223e4567-e89b-42d3-a456-426614174000' }, { status: 'pending' }, 'a'.repeat(40));
  assert.equal(calls[0][6], '223e4567-e89b-42d3-a456-426614174000');
});

test('missing receipt refuses Done even when no deploy workflow ran', async () => {
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
  const result = await worker.routeFinishedPR(issue, 'merged', sha,
    { ...pr, mergedAt: '2020-01-01T00:00:00Z' });
  assert.equal(calls.length, 0);
  assert.equal(result.outcome, 'pending');
  assert.equal(result.blocker.type, 'activation_receipt_missing');
  assert.equal(result.retryEligible, true);
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

test('cancelled workflows cannot substitute for activation evidence', async () => {
  const calls = dependencies({ receipt: null, gh: () => JSON.stringify({ workflow_runs: [
    { status: 'completed', conclusion: 'cancelled', name: 'CI', path: '.github/workflows/ci.yml' },
  ] }) });
  const result = await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(result.status, 'pending');
  assert.equal(result.outcome, 'pending');
  assert.equal(calls.length, 0);
});

test('merged PR whose CI lookup throws is held as a typed transport failure', async () => {
  const lines = [];
  const calls = dependencies({ receipt: null, gh: () => { throw new Error('rate limited'); } });
  worker.setTestDependencies({ log: (...a) => lines.push(a.join(' ')) });
  const result = await worker.routeFinishedPR(issue, 'merged', sha, pr);
  assert.equal(result.status, 'pending');
  assert.equal(result.outcome, 'discovery_transport_failure');
  assert.equal(result.blocker.type, 'discovery_transport_failure');
  assert.equal(result.retryEligible, true);
  assert.equal(calls.length, 0);
  assert.ok(lines.some(line => line.includes('HOLD #1 merged') && line.includes('ci=discovery_transport_failure')));
  assert.ok(lines.some(line => line.includes('CI-UNKNOWN') && line.includes('rate limited')));
  worker.setTestDependencies({ log: defaultLog });
});

test('CI discovery distinguishes authorization from transport failures', async () => {
  worker.setTestDependencies({ gh: () => { const e = new Error('HTTP 403 Forbidden'); throw e; } });
  const auth = await worker.ciState('acme/widget', sha, new Date().toISOString());
  assert.equal(auth.status, 'discovery_auth_failure');
  worker.setTestDependencies({ gh: () => { throw new Error('socket hang up'); } });
  const transport = await worker.ciState('acme/widget', sha, new Date().toISOString());
  assert.equal(transport.status, 'discovery_transport_failure');
});

test('watchdog acknowledgement is not latched when escalation relay rejects', async () => {
  let marked = 0;
  worker.setTestDependencies({
    watchdog: { observe: () => ({ stage: 'CI/CD & Deploy', first_seen_at: new Date(0).toISOString(), attempts: 1, last_error: 'x', correlation_key: 'c' }),
      stalled: () => true, markAlerted: () => { marked += 1; } },
    relay: async () => { throw new Error('relay rejected'); }
  });
  await assert.rejects(() => worker.watchdogFailure({ id: 'latch', number: 1 }, new Error('x'), sha));
  assert.equal(marked, 0);
});

test('a superseding successful workflow cannot substitute for activation evidence', async () => {
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
  const result = await worker.routeFinishedPR(issue, 'merged', sha,
    { ...pr, mergedAt: '2026-09-04T00:00:00Z' });
  assert.equal(result.outcome, 'pending');
  assert.equal(calls.length, 0);
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

test('routeFinishedPR does not rerun workflows as activation evidence', async () => {
  let deployLookup = 0;
  const reruns = [];
  const gh = (args) => {
    const path = args[1] || '';
    if (args[0] === 'api' && args[1] === '-X') { reruns.push(args); return ''; }
    if (args[0] === 'api' && path.includes('/actions/runs?head_sha=')) {
      deployLookup += 1;
      return deployLookup === 1
        ? JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success', name: 'CI' }] })
        : JSON.stringify({ workflow_runs: [{ id: 555, path: '.github/workflows/deploy-billing-server.yml', conclusion: 'cancelled', created_at: '2026-09-04T01:00:00Z' }] });
    }
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([{ name: 'deploy-billing-server.yml' }]);
    if (args[0] === 'run') return JSON.stringify([]);
    if (path.includes('/actions/runs?status=success')) return JSON.stringify({ workflow_runs: [] });
    if (path.includes('/compare/')) return JSON.stringify({ status: 'behind' });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const calls = dependencies({ receipt: null, gh });
  const result = await worker.routeFinishedPR({ id: 'passthrough-issue', number: 555 }, 'merged', sha,
    { ...pr, mergedAt: '2026-09-04T00:00:00Z' });
  assert.equal(result.status, 'pending');
  assert.equal(calls.length, 0);
  assert.equal(reruns.length, 0);
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

test('a just-merged sha stays pending inside the deploy trigger grace window', async () => {
  worker.setTestDependencies({ gh: () => JSON.stringify({ workflow_runs: [] }) });
  assert.equal(await worker.noDeployRunTriggered('timrecursify/ppp', sha, new Date().toISOString()), false);
  assert.equal(await worker.noDeployRunTriggered('timrecursify/ppp', sha, undefined), false);
});

test('wrongly named successful workflow cannot substitute for a deploy marker', async () => {
  const gh = (args) => {
    const path = args[1] || '';
    if (path.includes('/git/ref/deploy/billing-server')) return JSON.stringify({ object: { sha: 'c'.repeat(40) } });
    if (path.includes('/compare/')) return JSON.stringify({ status: 'behind' });
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([{ name: 'deploy-billing-server.yml' }]);
    if (path.includes('/actions/runs?head_sha=')) return JSON.stringify({ workflow_runs: [{
      id: 41, path: '.github/workflows/release-production.yml', event: 'workflow_dispatch', conclusion: 'success'
    }] });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  worker.setTestDependencies({ readReceipt: () => { throw new Error('missing'); }, gh });
  const result = await worker.mergeDeployEvidence('timrecursify/ppp', sha,
    { changedPaths: ['apps/billing/server/index.js'] });
  assert.equal(result.outcome, 'pending');
  assert.equal(result.blocker.type, 'deploy_marker_missing');
  worker.setTestDependencies({ log: defaultLog });
});

test('workflow with zero jobs cannot substitute for a deploy marker', async () => {
  const gh = (args) => {
    const path = args[1] || '';
    if (path.includes('/git/ref/deploy/billing-server')) return JSON.stringify({ object: { sha: 'c'.repeat(40) } });
    if (path.includes('/compare/')) return JSON.stringify({ status: 'behind' });
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([{ name: 'deploy-billing-server.yml' }]);
    if (path.includes('/actions/runs?head_sha=')) return JSON.stringify({ workflow_runs: [{
      id: 42, path: '.github/workflows/deploy-billing-server.yml', event: 'workflow_dispatch', conclusion: 'cancelled'
    }] });
    if (path.includes('/actions/runs/42/jobs')) return JSON.stringify({ jobs: [] });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  worker.setTestDependencies({ readReceipt: () => { throw new Error('missing'); }, gh });
  const result = await worker.mergeDeployEvidence('timrecursify/ppp', sha,
    { changedPaths: ['apps/billing/server/index.js'] });
  assert.equal(result.outcome, 'pending');
});

test('skipped dispatch deploy cannot substitute for a deploy marker', async () => {
  const gh = (args) => {
    const path = args[1] || '';
    if (path.includes('/git/ref/deploy/billing-server')) return JSON.stringify({ object: { sha: 'c'.repeat(40) } });
    if (path.includes('/compare/')) return JSON.stringify({ status: 'behind' });
    if (path.includes('/contents/.github/workflows')) return JSON.stringify([{ name: 'deploy-billing-server.yml' }]);
    if (path.includes('/actions/runs?head_sha=')) return JSON.stringify({ workflow_runs: [{
      id: 43, path: '.github/workflows/deploy-billing-server.yml', event: 'workflow_dispatch', conclusion: 'success'
    }] });
    if (path.includes('/actions/runs/43/jobs')) return JSON.stringify({ jobs: [
      { name: 'test / billing-server (deploy gate)', conclusion: 'failure' },
      { name: 'deploy / billing-server', conclusion: 'skipped' }
    ] });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  worker.setTestDependencies({ readReceipt: () => { throw new Error('missing'); }, gh });
  const result = await worker.mergeDeployEvidence('timrecursify/ppp', sha,
    { changedPaths: ['apps/billing/server/index.js'] });
  assert.equal(result.outcome, 'pending');
  assert.equal(result.blocker.type, 'deploy_marker_missing');
});

test('PPP workflow path selects its per-app deploy marker', () => {
  assert.deepStrictEqual(worker.deploymentRequirements('timrecursify/ppp', ['apps/lead-api/src/index.ts']), [{
    target: 'lead-api', owner: 'refs/deploy/lead-api', writer: 'deploy_marker'
  }]);
  assert.deepStrictEqual(worker.deploymentRequirements('timrecursify/ppp', ['packages/core/src/index.ts'])
    .map(item => item.target), [
    'ambassador-web', 'auth', 'billing-server', 'editor', 'editors', 'lead-api', 'mcp-server',
    'ops', 'quotes-web', 'sentinel', 'vendor'
  ]);
});

test('PPP marker containing the merge SHA is accepted with auditable marker evidence', async () => {
  const markerSha = 'b'.repeat(40);
  worker.setTestDependencies({ gh: args => {
    const path = args[1] || '';
    if (path.endsWith('/git/ref/deploy/lead-api')) return JSON.stringify({ object: { sha: markerSha } });
    if (path.endsWith(`/compare/${sha}...${markerSha}`)) return JSON.stringify({ status: 'ahead' });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  } });
  const result = await worker.mergeDeployEvidence('timrecursify/ppp', sha,
    { changedPaths: ['apps/lead-api/src/index.ts'] });
  assert.equal(result.outcome, 'deployed');
  assert.equal(result.evidence.kind, 'deploy_markers');
  assert.equal(result.evidence.markers[0].marker_sha, markerSha);
  assert.equal(result.evidence.markers[0].comparison_status, 'ahead');
});

test('PPP marker not containing the merge SHA is refused', async () => {
  const markerSha = 'b'.repeat(40);
  worker.setTestDependencies({ gh: args => {
    const path = args[1] || '';
    if (path.endsWith('/git/ref/deploy/lead-api')) return JSON.stringify({ object: { sha: markerSha } });
    if (path.endsWith(`/compare/${sha}...${markerSha}`)) return JSON.stringify({ status: 'behind' });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  } });
  const result = await worker.mergeDeployEvidence('timrecursify/ppp', sha,
    { changedPaths: ['apps/lead-api/src/index.ts'] });
  assert.equal(result.outcome, 'pending');
  assert.equal(result.blocker.type, 'deploy_marker_missing');
  assert.deepStrictEqual(result.blocker.missing_targets, ['lead-api']);
});

test('target without a deployment writer routes once to configured Spec', async () => {
  const calls = dependencies({ receipt: null });
  const result = await worker.routeFinishedPR(issue, 'merged', sha, {
    ...pr, repo: 'timrecursify/sk-cli', changedPaths: ['cmd/sk/main.go']
  });
  assert.equal(result.status, 'respec');
  assert.equal(result.retryEligible, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'Spec');
  assert.match(calls[0][3], /deployment_owner_absent target=fleet-sk-cli/);
});

test('ownerless deployment blocker is never counted as a watchdog retry', async () => {
  let observed = false;
  worker.setTestDependencies({ watchdog: { observe: () => { observed = true; } } });
  const alerted = await worker.closureWatchdog(issue, {
    status: 'pending', retryEligible: false,
    blocker: { type: 'deployment_owner_absent', retry_eligible: false, target: 'fleet-sk-cli' }
  }, sha);
  assert.equal(alerted, false);
  assert.equal(observed, false);
});

test('GitHub changed-path outage is retryable and refuses Done', async () => {
  worker.setTestDependencies({ readChangedPaths: () => { throw new Error('GitHub unavailable'); } });
  const result = await worker.mergeDeployEvidence('timrecursify/multica', sha, { num: 17 });
  assert.equal(result.outcome, 'discovery_unavailable');
  assert.equal(result.blocker.type, 'changed_path_discovery_unavailable');
  assert.equal(result.blocker.retry_eligible, true);
});

test('one receipt for several applicable deploy targets refuses Done', async () => {
  worker.setTestDependencies({ readReceipt: (_repo, target) => {
    if (target === 'gsp-belt') return activationReceipt(target);
    const error = new Error('missing'); error.code = 'ENOENT'; throw error;
  } });
  const result = await worker.mergeDeployEvidence('timrecursify/multica', sha,
    { changedPaths: ['ops/belt/worker.cjs', 'server/main.go'] });
  assert.equal(result.outcome, 'pending');
  assert.deepStrictEqual(result.blocker.missing_targets, ['gsp-multica']);
});

test('non-exact source SHA refuses Done before receipt lookup', async () => {
  worker.setTestDependencies({ readReceipt: () => { throw new Error('receipt lookup must not run'); } });
  const result = await worker.mergeDeployEvidence('timrecursify/multica', 'A'.repeat(40),
    { changedPaths: ['ops/belt/worker.cjs'] });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.blocker.type, 'source_sha_invalid');
});

test('health recorded before activation invalidates the receipt', async () => {
  const receipt = activationReceipt();
  receipt.health.checked_at = '2026-09-07T13:59:59Z';
  worker.setTestDependencies({ readReceipt: () => receipt });
  const result = await worker.mergeDeployEvidence('timrecursify/multica', sha,
    { changedPaths: ['ops/belt/worker.cjs'] });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.blocker.field, 'health');
});

test('docs-only manifest completes Done as verified not applicable', async () => {
  const calls = dependencies({ receipt: null });
  const result = await worker.routeFinishedPR(issue, 'merged', sha,
    { ...pr, changedPaths: ['README.md', 'docs/runbook.md'] });
  assert.equal(result.status, 'done');
  assert.equal(calls[0][1], 'Done');
  assert.equal(calls[0][5].mergeDeployReceipt.classification, 'docs_only');
});

test('valid receipt for every applicable target permits Done', async () => {
  const calls = dependencies({ receipt: { source_sha: sha } });
  const result = await worker.routeFinishedPR(issue, 'merged', sha,
    { ...pr, changedPaths: ['ops/belt/worker.cjs', 'server/main.go'] });
  assert.equal(result.status, 'done');
  assert.equal(calls[0][1], 'Done');
  assert.deepStrictEqual(calls[0][5].mergeDeployReceipt.targets, ['gsp-belt', 'gsp-multica']);
  assert.equal(calls[0][5].mergeDeployReceipt.receipts.length, 2);
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
    pool: { query: async (sql) => {
      if (/FROM issue WHERE/.test(sql)) {
        return { rows: [{ id: 'issue-retro', number: 4242, title: 't', workspace_id: 'w', metadata: {} }] };
      }
      if (/FROM agent_task_queue/.test(sql)) return { rows: [{ id: 'task-retro' }] };
      if (/FROM issue_work_product/.test(sql)) return { rows: [{ scope_revision: 1,
        kind: 'implementation', repository: repo, branch: 'belt/retro', pr_number: 77,
        head_sha: headSha, acceptance_evidence: { verified: true } }] };
      throw new Error(`unexpected SQL ${sql}`);
    } },
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
  const headSha = 'd'.repeat(40);
  const lines = [];
  worker.setTestDependencies({
    log: (...a) => lines.push(a.join(' ')),
    pool: { query: async (sql) => {
      if (/FROM issue WHERE/.test(sql)) {
        return { rows: [{ id: 'issue-hold', number: 4243, title: 't', workspace_id: 'w', metadata: {} }] };
      }
      if (/FROM agent_task_queue/.test(sql)) return { rows: [{ id: 'task-hold' }] };
      if (/FROM issue_work_product/.test(sql)) return { rows: [{ scope_revision: 1,
        kind: 'implementation', repository: repo, branch: 'belt/hold', pr_number: 78,
        head_sha: headSha, acceptance_evidence: { verified: true } }] };
      throw new Error(`unexpected SQL ${sql}`);
    } },
    relay: async () => { throw new Error('sweep must not relay on the hold path'); },
    gh: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: headSha,
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

test('an unauthenticated gh failure escalates on the first attempt, not after the retry budget', async () => {
  const issue = { id: 'issue-gh-auth', number: 4242 };
  const sha = 'd'.repeat(40);
  const calls = [];
  const lines = [];
  // An earlier test leaves a stubbed watchdog in place, so bind a real one:
  // this asserts the attempt count the fail-fast path reports.
  worker.setTestDependencies({
    watchdog: require('./cicd-watchdog.cjs').createWatchdog({
      file: require('path').join(require('os').tmpdir(), `cicd-watchdog-ghauth-${process.pid}.json`)
    }),
    relay: async (...args) => { calls.push(args); return '{}'; },
    log: (...args) => lines.push(args.join(' ')),
  });

  const error = new Error('Command failed: gh api -i repos/timrecursify/sk-cli/pulls/1582\n'
    + 'To get started with GitHub CLI, please run: gh auth login');
  const result = await worker.watchdogFailure(issue, error, sha);

  assert.equal(result.stalled, true);
  assert.equal(result.audit.attempts, 1);
  assert.equal(result.audit.outcome, 'deploy_unauthenticated');
  assert.equal(calls.length, 1);
  const [issueId, toStage, workProductMd5, reason] = calls[0];
  assert.equal(issueId, issue.id);
  assert.equal(toStage, 'Spec');
  assert.equal(workProductMd5, null);
  assert.ok(reason.startsWith(`deploy_unauthenticated issue=${issue.id}`), reason);
  assert.match(reason, /attempts=1 /);
  assert.ok(lines.some(line => line.includes('TERMINAL #4242') && line.includes('credential unavailable')),
    lines.join(' | '));
  worker.setTestDependencies({ log: defaultLog });
});

test('CICD read keys bind repository and full SHA for both gh argument forms', () => {
  const head = 'e'.repeat(40);
  assert.match(worker.githubReadKey(['run', 'list', '--repo', 'acme/widget', '--commit', head]),
    new RegExp(`^acme/widget@${head}:`));
  assert.match(worker.githubReadKey(['api', `repos/acme/widget/contents/a.js?ref=${head}`]),
    new RegExp(`^acme/widget@${head}:`));
});

test('merge operations serialize per repository without blocking another repository', async () => {
  const started = [];
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const first = worker.withRepoMergeLock('acme/widget', async () => {
    started.push('first');
    await firstBlocked;
  });
  const sameRepo = worker.withRepoMergeLock('acme/widget', async () => started.push('same-repo'));
  const otherRepo = worker.withRepoMergeLock('acme/other', async () => started.push('other-repo'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.sort(), ['first', 'other-repo']);
  releaseFirst();
  await Promise.all([first, sameRepo, otherRepo]);
  assert.ok(started.includes('same-repo'));
});
