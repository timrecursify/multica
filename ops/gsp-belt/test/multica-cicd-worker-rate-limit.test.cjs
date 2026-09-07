'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorker } = require('../worker/multica-cicd-worker.cjs');

const issue = { id: 'i', number: 1 };
const sha = 'a'.repeat(40);
const prText = 'PR: https://github.com/acme/repo/pull/7';

function harness(gh, clock = { value: 1_000_000_000_000 }) {
  let ledgerReason = null;
  let calls = 0;
  const pool = { query: async (sql, params) => {
    if (sql.includes("FROM issue WHERE")) return { rows: [issue] };
    if (sql.includes('FROM comment')) return { rows: [{ content: prText }] };
    if (sql.includes('FROM qc_attempt')) return { rows: [{ verdict: 'PASS', qualifying: true, model: 'gpt-5.6-sol', effort: 'low', bound_sha: sha }] };
    if (sql.includes("reason LIKE 'rate_limit%")) return { rows: ledgerReason ? [{ reason: ledgerReason }] : [] };
    if (sql.includes('INSERT INTO cicd_deploy_attempt')) { ledgerReason = params && params[2]; return { rows: [] }; }
    return { rows: [] };
  } };
  const wrappedGh = args => { calls++; return gh(args); };
  const worker = createWorker({ pool, gh: wrappedGh, now: () => clock.value, random: () => 0, rateLimitBaseMs: 100, rateLimitMaxMs: 1000, log: () => {} });
  return { worker, clock, get calls() { return calls; }, get reason() { return ledgerReason; } };
}

test('rate limits from PR metadata and Actions hold without merge/requeue and record reset-aware cooldown', async () => {
  for (const stage of ['pr', 'api']) {
    const h = harness(args => { if ((stage === 'pr' && args[0] === 'pr') || (stage === 'api' && args[0] === 'api')) throw new Error('gh: API rate limit exceeded; reset at 1000000100'); return JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: sha }); });
    await h.worker.sweep();
    assert.match(h.reason, /rate_limit/);
    assert.match(h.reason, /reset_at=1000000100000/);
    assert.match(h.reason, /cooldown_until=/);
  }
});

test('repeated sweep during cooldown makes no GitHub calls, then resumes after expiry', async () => {
  const h = harness(args => {
    if (args[0] === 'pr') {
      if (h.calls === 1) throw new Error('HTTP 403 rate limit reset 1000001');
      return JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: sha });
    }
    return JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
  });
  await h.worker.sweep();
  const first = h.calls;
  await h.worker.sweep();
  assert.equal(h.calls, first);
  h.clock.value += 1001;
  await h.worker.sweep();
  assert.ok(h.calls > first);
});

test('ordinary red and mixed CI remain held as CI failures', async () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const h = harness(args => args[0] === 'pr' ? JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: sha }) : JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion }] }));
    await h.worker.sweep();
    assert.match(h.reason, /ci=red/);
  }
});
