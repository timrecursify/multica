'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

// Make the first failure immediately eligible for escalation, and disable the
// irreversible merge action while exercising sweep continuity.
process.env.CICD_SENTINEL_MS = '0';
process.env.CICD_MERGE_ENABLED = '0';
// Without an override, the watchdog persists to the real receipt root and a
// prior run's alerted state leaks into the next: a re-run then sees
// `alerted: true` and skips straight to the retry-exhausted branch. Redirect
// to a scratch file, matching multica-cicd-worker.test.cjs.
process.env.CICD_WATCHDOG_STATE = require('path')
  .join(require('os').tmpdir(), `cicd-watchdog-sweep-test-${process.pid}.json`);
const worker = require('./multica-cicd-worker.cjs');

test('an escalation failure is isolated so later tickets are still processed', async () => {
  const issues = [
    { id: 'issue-first', number: 1, title: 'first', workspace_id: 'gsp', metadata: {} },
    { id: 'issue-later', number: 2, title: 'later', workspace_id: 'gsp', metadata: {} },
  ];
  const logs = [];
  const pool = { query: async (sql, params) => {
    if (sql.includes("FROM issue WHERE")) return { rows: issues };
    if (sql.includes('FROM comment')) {
      const issue = issues.find(candidate => candidate.id === params[0]);
      return { rows: [{ content: `PR: https://github.com/acme/repo/pull/${issue.number}` }] };
    }
    if (sql.includes('FROM qc_verdict')) return { rows: [] };
    return { rows: [] };
  } };
  const relay = async () => { throw new Error('409 actor_denied\nextra details'); };
  const gh = args => {
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '1') throw new Error('forced PR lookup failure');
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
      state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'a'.repeat(40), createdAt: new Date().toISOString(),
    });
    if (args[0] === 'api') return JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };

  worker.setTestDependencies({ pool, relay, gh, log: (...args) => logs.push(args.join(' ')) });
  await assert.doesNotReject(worker.sweep());

  assert.ok(logs.some(line => line.includes('ESCALATE-FAIL #1: 409 actor_denied')));
  assert.ok(logs.some(line => line.includes('ERR #1: forced PR lookup failure')));
  assert.ok(logs.some(line => line.includes('HOLD #2') && line.includes('merging disabled')));
  assert.ok(!logs.some(line => line.includes('[sweep] error:')));
});

test('a stalled deploy escalates directly to Spec as system, not Human Review', async () => {
  const issue = { id: 'issue-watchdog-spec', number: 99 };
  const sha = 'c'.repeat(40);
  const calls = [];
  worker.setTestDependencies({ relay: async (...args) => { calls.push(args); return '{}'; }, log: () => {} });

  const result = await worker.watchdogFailure(issue, 'deploy timed out', sha);

  assert.equal(result.stalled, true);
  assert.equal(calls.length, 1);
  const [issueId, toStage, workProductMd5, reason, parkedAudit, evidence] = calls[0];
  assert.equal(issueId, issue.id);
  assert.equal(toStage, 'Spec');
  assert.equal(workProductMd5, null);
  assert.equal(parkedAudit, null);
  assert.equal(evidence.retry_escalation, true);
  assert.ok(reason.startsWith(`deploy_stalled issue=${issue.id} stage=CI/CD & Deploy`));
  assert.match(reason, /correlation_key=([0-9a-f]{32})/);
  const correlationKey = reason.match(/correlation_key=([0-9a-f]{32})/)[1];
  assert.equal(result.audit.correlation_key, correlationKey);
});
