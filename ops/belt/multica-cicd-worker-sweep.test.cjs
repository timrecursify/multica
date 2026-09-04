'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

// Make the first failure immediately eligible for escalation, and disable the
// irreversible merge action while exercising sweep continuity.
process.env.CICD_SENTINEL_MS = '0';
process.env.CICD_MERGE_ENABLED = '0';
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
