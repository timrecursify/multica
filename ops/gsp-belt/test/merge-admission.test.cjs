'use strict';
const assert = require('assert/strict');
const { admit } = require('../worker/merge-admission.cjs');
const head = 'a'.repeat(40);
const info = { state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: head };
const green = [{ status: 'completed', conclusion: 'success' }];
const pass = { verdict: 'PASS', qualifying: true, model: 'gpt-5.6-sol', effort: 'low', bound_sha: head };
(async () => {
  assert.equal((await admit({ info, runs: green, verdict: null })).ok, false);
  assert.equal((await admit({ info, runs: green, verdict: { ...pass, bound_sha: 'b'.repeat(40) } })).ok, false);
  assert.equal((await admit({ info, runs: green, verdict: pass })).ok, true);
  assert.equal((await admit({ info, runs: [...green, { status: 'in_progress', conclusion: null }], verdict: pass })).ok, false);
  assert.equal((await admit({ info: { ...info, mergeable: 'UNKNOWN' }, runs: green, verdict: pass })).ok, false);
  console.log('gsp merge admission tests: ok (three required cases plus incomplete/non-mergeable holds)');
})();
