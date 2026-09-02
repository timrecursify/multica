#!/usr/bin/env node
const assert = require('assert');
const worker = require('./multica-cicd-worker.cjs');
const sha = 'a'.repeat(40);
const issue = { id: 'issue-1', number: 1 };
const pass = { verdict: 'PASS', work_product_md5: 'b'.repeat(32), bound_sha: sha };

async function routeWith({ receipt, verdict = pass }) {
  const calls = [];
  worker.setTestDependencies({
    pool: { query: async () => ({ rows: verdict ? [verdict] : [] }) },
    relay: async (...args) => calls.push(args),
    readReceipt: () => { if (!receipt) throw new Error('missing'); return receipt; }
  });
  await worker.routeFinishedPR(issue, 'merged', sha);
  return calls;
}

(async () => {
  const matching = { source_sha: sha, release: `/releases/${sha}`, health: 'ok' };
  let calls = await routeWith({ receipt: matching });
  assert.deepStrictEqual(calls, [['issue-1', 'Done', pass.work_product_md5]);
  calls = await routeWith({ receipt: null });
  assert.deepStrictEqual(calls, [['issue-1', 'Human Review', null,
    'merged; exact-SHA release receipt at reviewed SHA is required']]);
  calls = await routeWith({ receipt: { ...matching, source_sha: 'c'.repeat(40) } });
  assert.equal(calls[0][1], 'Human Review');
  calls = await routeWith({ receipt: matching, verdict: { ...pass, bound_sha: 'd'.repeat(40) } });
  assert.equal(calls[0][1], 'Human Review');
  const source = require('fs').readFileSync(require.resolve('./multica-cicd-worker.cjs'), 'utf8');
  assert.doesNotMatch(source, /execFileSync\('bash'|gh\(\['pr', 'merge'|gh\(\['pr', 'comment'/);
  assert.doesNotMatch(source, /UPDATE |INSERT INTO /);
  assert.match(source, /transition-policy\.cjs/);
  console.log('multica-cicd-worker tests passed');
})().catch(error => { console.error(error); process.exit(1); });
