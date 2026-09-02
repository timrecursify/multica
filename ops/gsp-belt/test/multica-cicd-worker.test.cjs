#!/usr/bin/env node
const assert = require('assert');
const worker = require('../worker/multica-cicd-worker.cjs');

const head = 'a'.repeat(40);
const stale = 'b'.repeat(40);
const issue = { id: '00000000-0000-4000-8000-000000000001', number: 1543 };

async function runCase(name, verdict, expectedMerges) {
  const calls = [];
  worker.setTestDependencies({
    pool: { query: async (sql) => {
      if (sql.includes("FROM issue WHERE status='CI/CD & Deploy'")) return { rows: [issue] };
      if (sql.includes('FROM comment')) return { rows: [{ content: 'https://github.com/timrecursify/multica/pull/99' }] };
      if (sql.includes('FROM qc_verdict')) return { rows: verdict ? [verdict] : [] };
      return { rows: [] };
    } },
    gh: (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: head });
      if (args[0] === 'api') return JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
      if (args[0] === 'pr' && args[1] === 'merge') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    },
    relay: async () => {},
  });
  await worker.sweep();
  assert.equal(calls.filter(args => args[0] === 'pr' && args[1] === 'merge').length, expectedMerges, name);
}

(async () => {
  await runCase('green CI without PASS holds', null, 0);
  await runCase('green CI with stale PASS holds', {
    verdict: 'PASS', qualifying: true, model: 'gpt-5.6-sol', effort: 'low', bound_sha: stale,
  }, 0);
  await runCase('green CI with exact qualifying Sol-low PASS merges once', {
    verdict: 'PASS', qualifying: true, model: 'gpt-5.6-sol', effort: 'low', bound_sha: head,
  }, 1);
  console.log('gsp multica-cicd-worker admission tests: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
