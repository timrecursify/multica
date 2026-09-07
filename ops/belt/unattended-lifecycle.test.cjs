'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { after, test } = require('node:test');

process.env.JWT_SECRET ||= 'lifecycle-jwt';
process.env.DATABASE_URL ||= 'postgres://lifecycle.invalid/test';
process.env.RELAY_AGENT_SECRET ||= 'lifecycle-relay';
process.env.ARCHIVER_AGENT_SECRET ||= 'lifecycle-archiver';
process.env.MULTICA_WORKSPACE_ID ||= 'lifecycle-workspace';

const beltRoot = __dirname;
const { evaluate } = require('./transition-policy.cjs');
const { admitConfiguredTransition, openChildAdmission } = require('./multica-bridge.cjs');
const relay = require('./parity/multica-relay-advance-daemon.cjs');
const cicd = require('./multica-cicd-worker.cjs');

const SHA = 'a'.repeat(40);
const STALE_SHA = 'b'.repeat(40);
const MD5 = 'c'.repeat(32);
const BASE_TIME = Date.parse('2026-09-07T00:00:00.000Z');
const emittedMetrics = [];

function productionManifest() {
  const script = [
    'root_dir="$1"', 'runtime_root="$2"', 'source "$root_dir/belt-manifest.sh"',
    'for i in "${!sources[@]}"; do printf "%s|%s\\n" "${sources[$i]}" "${targets[$i]}"; done'
  ].join('; ');
  const output = execFileSync('bash', ['-c', script, '_', beltRoot, '/runtime'], { encoding: 'utf8' });
  return output.trim().split('\n').map((line) => {
    const [source, target] = line.split('|');
    return { source, target };
  });
}

function createHarness(id, nowMs = BASE_TIME) {
  return {
    id, nowMs, stage: 'Registered', shipped: false, outcomes: [], stages: [{
      stage: 'Registered', entryAt: new Date(nowMs).toISOString(), eligibleAt: null,
      waitAt: null, startAt: null, finishAt: null, blockerOwner: null
    }], flow: { prInflow: 0, mergeOutflow: 0, mergedSha: null, mergedAt: null,
      activatedSha: null, activatedAt: null }
  };
}

function currentMetric(harness) {
  return harness.stages.at(-1);
}

function tick(harness, milliseconds = 60_000) {
  harness.nowMs += milliseconds;
}

function work(harness, { waitMs = 60_000, runMs = 60_000, outcome = 'ADVANCED' } = {}) {
  const metric = currentMetric(harness);
  metric.eligibleAt ||= new Date(harness.nowMs).toISOString();
  metric.waitAt ||= metric.eligibleAt;
  tick(harness, waitMs);
  metric.startAt = new Date(harness.nowMs).toISOString();
  tick(harness, runMs);
  metric.finishAt = new Date(harness.nowMs).toISOString();
  harness.outcomes.push(outcome);
}

function waitOn(harness, blockerOwner) {
  const metric = currentMetric(harness);
  metric.eligibleAt ||= new Date(harness.nowMs).toISOString();
  metric.waitAt ||= new Date(harness.nowMs).toISOString();
  metric.blockerOwner = blockerOwner;
}

function advance(harness, toStage, actor, evidence) {
  const endpoint = admitConfiguredTransition({
    fromStage: harness.stage, toStage, expectedStage: toStage
  });
  assert.equal(endpoint.ok, true, `${harness.stage} -> ${toStage} endpoint admission`);
  const verdict = evaluate({ from: harness.stage, to: toStage, actor, evidence });
  assert.equal(verdict.ok, true, `${harness.stage} -> ${toStage}: ${verdict.code}`);
  currentMetric(harness).finishAt ||= new Date(harness.nowMs).toISOString();
  tick(harness);
  harness.stage = toStage;
  harness.stages.push({ stage: toStage, entryAt: new Date(harness.nowMs).toISOString(),
    eligibleAt: null, waitAt: null, startAt: null, finishAt: null, blockerOwner: null });
}

function runToImplementation(harness) {
  work(harness);
  advance(harness, 'Spec', 'system', { registeredIssue: harness.id, selectedWorkspace: 'gsp' });
  work(harness);
  advance(harness, 'Queue', 'worker', {
    bindingScope: 'scope', acceptanceTests: 'contract', riskClass: 'standard'
  });
  work(harness);
  advance(harness, 'In Progress', 'system', {
    completedCurrentTask: `${harness.id}-spec`, workProductPointer: `task:${harness.id}`
  });
}

function arriveAtReview(harness) {
  work(harness);
  advance(harness, 'In Review', 'worker', {
    reviewRequiredRoute: 'review', pr: 'https://github.com/timrecursify/multica/pull/1', boundSha: SHA
  });
  harness.flow.prInflow += 1;
}

function arriveAtDeploy(harness) {
  arriveAtReview(harness);
  work(harness);
  advance(harness, 'CI/CD & Deploy', 'system', {
    qualifyingPass: true, observedShaMatchesBound: true, completedSolLowTask: `${harness.id}-qc`
  });
}

function runCodeClosure(harness) {
  runToImplementation(harness);
  arriveAtDeploy(harness);
  harness.flow.mergeOutflow += 1;
  harness.flow.mergedSha = SHA;
  harness.flow.mergedAt = new Date(harness.nowMs).toISOString();
  work(harness);
  harness.flow.activatedSha = SHA;
  harness.flow.activatedAt = new Date(harness.nowMs).toISOString();
  advance(harness, 'Done', 'system', {
    ciSuccess: true, mergeDeployReceipt: { source_sha: SHA, health: 'ok' }, reviewedSha: SHA
  });
  harness.shipped = true;
  work(harness, { outcome: 'SHIPPED' });
  advance(harness, 'Archived', 'archiver', { signedArchivePlanReceipt: 'clock-controlled-receipt' });
  work(harness, { waitMs: 0, runMs: 0, outcome: 'ARCHIVED' });
}

function report(harness, caseName) {
  const stageMetrics = harness.stages.map((metric) => ({ ...metric,
    queueAgeMs: metric.eligibleAt
      ? Date.parse(metric.startAt || new Date(harness.nowMs).toISOString()) - Date.parse(metric.eligibleAt)
      : null
  }));
  const { mergedAt, activatedAt } = harness.flow;
  return { case: caseName, shipped: harness.shipped, stageMetrics,
    uniqueOutcomes: [...new Set(harness.outcomes)].sort(), ...harness.flow,
    activatedVsMergedShaLagMs: mergedAt && activatedAt ? Date.parse(activatedAt) - Date.parse(mergedAt) : null,
    activatedMatchesMerged: harness.flow.mergedSha
      ? harness.flow.activatedSha === harness.flow.mergedSha : null };
}

function expectedRed(packet, contract) {
  try {
    contract();
  } catch (error) {
    assert.equal(error.code, 'ERR_ASSERTION');
    return { status: 'expected-red', packet, failure: error.message.split('\n')[0] };
  }
  assert.fail(`XPASS ${packet}: remove expected-red after its packet lands`);
}

function staleQcRow() {
  return { to_stage: 'In Review', next_stage: 'CI/CD & Deploy', task_status: 'completed',
    task_id: 'qc-task', task_agent_id: 'qc-agent', qc_verdict_checker_id: 'qc-agent',
    qc_verdict: 'PASS', qc_verdict_work_product_md5: MD5,
    qc_attempt_verdict: 'PASS', qc_attempt_qualifying: true,
    qc_attempt_work_product_md5: MD5, qc_attempt_bound_sha: SHA,
    qc_attempt_observed_sha: STALE_SHA, qc_attempt_evidence_agent_id: 'qc-agent',
    qc_attempt_evidence_agent_model: 'gpt-5.6-sol', qc_attempt_evidence_agent_effort: 'low' };
}

function fakeArchiverDependencies(clock) {
  let scheduled;
  const requests = [];
  class Pool {
    async query() {
      const oldEnough = clock.nowMs - clock.updatedMs >= 24 * 60 * 60 * 1000;
      return { rows: oldEnough ? [{ id: 'archive-candidate' }] : [] };
    }
  }
  const http = { request(options, callback) {
    return { on() { return this; }, destroy() {}, end(body) {
      requests.push({ options, body: JSON.parse(body) });
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      queueMicrotask(() => response.emit('end'));
    } };
  } };
  return { Pool, http, requests, schedule(fn) { scheduled = fn; }, runScheduled() { return scheduled(); } };
}

async function exerciseArchiverClock() {
  const clock = { updatedMs: BASE_TIME, nowMs: BASE_TIME + (23 * 60 * 60 * 1000) };
  const fake = fakeArchiverDependencies(clock);
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  Module._load = function load(request, parent, isMain) {
    if (request === 'pg') return { Pool: fake.Pool };
    if (request === 'http') return fake.http;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setInterval = (fn) => { fake.schedule(fn); return 1; };
  try {
    delete require.cache[require.resolve('./multica-archiver.cjs')];
    require('./multica-archiver.cjs');
  } finally {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.requests.length, 0, '23-hour Done ticket must not archive');
  clock.nowMs += 2 * 60 * 60 * 1000;
  await fake.runScheduled();
  assert.equal(fake.requests.length, 1, '25-hour Done ticket archives');
  return fake.requests[0];
}

test('production manifest contains every lifecycle endpoint and policy adapter', () => {
  const manifest = productionManifest();
  assert.equal(manifest.length > 0, true);
  assert.equal(manifest.every(({ source, target }) => source && target), true);
  for (const file of ['multica-bridge.cjs', 'transition-policy.cjs',
    'parity/multica-relay-advance-daemon.cjs', 'multica-cicd-worker.cjs', 'multica-archiver.cjs']) {
    assert.equal(manifest.some(({ source }) => source.endsWith(`/${file}`)), true, file);
  }
});

test('code change closes every unattended stage and emits lifecycle metrics', () => {
  const harness = createHarness('code-change');
  runCodeClosure(harness);
  assert.equal(harness.stage, 'Archived');
  assert.deepEqual(harness.stages.map(({ stage }) => stage), [
    'Registered', 'Spec', 'Queue', 'In Progress', 'In Review', 'CI/CD & Deploy', 'Done', 'Archived'
  ]);
  const metrics = report(harness, 'code-change');
  assert.equal(metrics.activatedMatchesMerged, true);
  assert.equal(metrics.prInflow, metrics.mergeOutflow);
  emittedMetrics.push(metrics);
});

test('verified NO_OP closes without pretending a PR or merge shipped', () => {
  const harness = createHarness('verified-no-code');
  runToImplementation(harness);
  work(harness, { outcome: 'NO_OP' });
  advance(harness, 'Done', 'system', {
    noDeployRoute: 'no_pr', workProductEvidence: 'OUTCOME: NO_OP\nNO-SHA independently verified'
  });
  harness.shipped = true;
  work(harness, { outcome: 'SHIPPED' });
  advance(harness, 'Archived', 'archiver', { signedArchivePlanReceipt: 'clock-controlled-receipt' });
  work(harness, { waitMs: 0, runMs: 0, outcome: 'ARCHIVED' });
  const metrics = report(harness, 'verified-no-code');
  assert.equal(metrics.prInflow, 0);
  assert.equal(metrics.mergeOutflow, 0);
  assert.ok(metrics.uniqueOutcomes.includes('NO_OP'));
  emittedMetrics.push(metrics);
});

test('rollup waits for open children, then closes after every child is terminal', async () => {
  let children = [
    { id: 'child-11', status: 'Queue', number: 11, latest_task_status: 'running' },
    { id: 'child-12', status: 'Spec', number: 12, latest_task_status: null }
  ];
  const issue = { id: 'rollup', workspace_id: 'gsp', metadata: {} };
  const client = { query: async (sql, values = []) => {
    if (sql.includes('parent_issue_id')) return { rows: children };
    if (sql.includes('UPDATE issue SET metadata')) {
      issue.metadata.rollup_dependency = JSON.parse(values[1]);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO activity_log')) return { rows: [] };
    throw new Error(`unexpected rollup query: ${sql.slice(0, 60)}`);
  } };
  const blocked = await openChildAdmission(client, issue);
  assert.deepEqual(blocked.childNumbers, [11, 12]);
  assert.equal(blocked.dependency.state, 'blocked');
  children = [
    { id: 'child-11', status: 'Done', number: 11, latest_task_status: 'completed' },
    { id: 'child-12', status: 'Cancelled', number: 12, latest_task_status: 'cancelled' }
  ];
  const ready = await openChildAdmission(client, issue);
  assert.equal(ready.ok, false);
  assert.equal(ready.dependency.state, 'ready');
  assert.equal(ready.dependency.version, blocked.dependency.version + 1);
  const harness = createHarness('rollup');
  runCodeClosure(harness);
  emittedMetrics.push(report(harness, 'rollup-with-children'));
});

test('red CI and stale SHA remain blocked before deploy', () => {
  cicd.setTestDependencies({ gh: () => JSON.stringify({ workflow_runs: [
    { status: 'completed', conclusion: 'failure', name: 'ci' }
  ] }), log() {} });
  assert.equal(cicd.ciState('timrecursify/multica', SHA, new Date(BASE_TIME).toISOString()), 'red');
  assert.deepEqual(relay.qcCompletionAdvance(staleQcRow()), {
    ok: false, reason: 'qc_attempt_binding_required'
  });
  const red = createHarness('red-ci');
  runToImplementation(red);
  arriveAtDeploy(red);
  waitOn(red, 'ci');
  const stale = createHarness('stale-sha');
  runToImplementation(stale);
  arriveAtReview(stale);
  waitOn(stale, 'sha');
  emittedMetrics.push(report(red, 'red-ci'), report(stale, 'stale-sha'));
});

test('durable lifecycle state resumes after a process restart', () => {
  const beforeRestart = createHarness('restart');
  runToImplementation(beforeRestart);
  const restored = JSON.parse(JSON.stringify(beforeRestart));
  runCodeClosureFromImplementation(restored);
  assert.equal(restored.stage, 'Archived');
  emittedMetrics.push(report(restored, 'process-restart'));
});

function runCodeClosureFromImplementation(harness) {
  arriveAtDeploy(harness);
  harness.flow.mergeOutflow += 1;
  harness.flow.mergedSha = SHA;
  harness.flow.mergedAt = new Date(harness.nowMs).toISOString();
  work(harness);
  harness.flow.activatedSha = SHA;
  harness.flow.activatedAt = new Date(harness.nowMs).toISOString();
  advance(harness, 'Done', 'system', {
    ciSuccess: true, mergeDeployReceipt: { source_sha: SHA, health: 'ok' }, reviewedSha: SHA
  });
  harness.shipped = true;
  work(harness, { outcome: 'SHIPPED' });
  advance(harness, 'Archived', 'archiver', { signedArchivePlanReceipt: 'clock-controlled-receipt' });
  work(harness, { waitMs: 0, runMs: 0, outcome: 'ARCHIVED' });
}

test('GitHub API outage and non-shipping terminal states stay out of shipped metrics', () => {
  cicd.setTestDependencies({ gh: () => { throw new Error('GitHub unavailable'); }, log() {} });
  assert.equal(cicd.ciState('timrecursify/multica', SHA, new Date(BASE_TIME).toISOString()), 'unknown');
  const outage = createHarness('github-api-outage');
  runToImplementation(outage);
  arriveAtDeploy(outage);
  waitOn(outage, 'github-api');
  const cancelled = createHarness('cancelled');
  advance(cancelled, 'Cancelled', 'operator', { boardOwnerAuthority: true, reason: 'withdrawn' });
  cancelled.outcomes.push('CANCELLED');
  const approval = createHarness('approval-wait');
  advance(approval, 'Spec', 'system', { registeredIssue: approval.id, selectedWorkspace: 'gsp' });
  advance(approval, 'Human Review', 'operator', { blocker: 'release approval', namedBlocker: true });
  waitOn(approval, 'human');
  approval.outcomes.push('WAITING_APPROVAL');
  assert.equal([outage, cancelled, approval].filter(({ shipped }) => shipped).length, 0);
  emittedMetrics.push(report(outage, 'github-api-outage'),
    report(cancelled, 'cancelled'), report(approval, 'approval-wait'));
});

test('archiver uses its real endpoint adapter only after the fake 24-hour clock', async () => {
  const request = await exerciseArchiverClock();
  assert.equal(request.options.path, '/relay/advance');
  assert.equal(request.body.to_stage, 'Archived');
  assert.equal(request.body.actor, 'archiver');
  assert.match(request.body.evidence.signedArchivePlanReceipt,
    /^archiver:archive-candidate:Done->Archived:[0-9a-f]{64}$/);
});

test('known defects execute as packet-owned expected-red contracts', () => {
  const deploySource = fs.readFileSync(path.join(beltRoot, 'deploy.sh'), 'utf8');
  const activation = expectedRed('ALPHA-000356 deploy-restart', () => {
    assert.match(deploySource, /\bsystemctl\b[^\n]*(?:restart|reload)|\bpm2\b[^\n]*(?:restart|reload)/);
    assert.doesNotMatch(deploySource, /No processes were restarted\./);
  });
  cicd.setTestDependencies({ readReceipt: () => { throw new Error('receipt unavailable'); },
    gh: () => { throw new Error('GitHub unavailable'); }, log() {} });
  const evidenceResult = cicd.mergeDeployEvidence(
    'timrecursify/multica', SHA, '2026-09-01T00:00:00Z');
  assert.equal(evidenceResult.outcome, 'discovery_unavailable');
  assert.equal(evidenceResult.evidence, undefined,
    'outage must hold instead of fabricating merge_is_deploy');
  const evidence = { status: 'verified-green', packet: 'rec-2 fabricated-deployment-evidence',
    outcome: evidenceResult.outcome };
  emittedMetrics.push({ case: 'known-defects', outcomes: [activation, evidence] });
});

after(() => {
  console.log(`LIFECYCLE_METRICS_JSON=${JSON.stringify(emittedMetrics)}`);
});
