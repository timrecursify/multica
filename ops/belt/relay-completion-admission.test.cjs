'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { completionAdmission, deploymentCompletionAdmission } = require('./relay-completion-admission.cjs');

test('deployment admission rejects cancelled and null-result tasks', () => {
  assert.equal(deploymentCompletionAdmission('cancelled', null).ok, false);
  assert.equal(deploymentCompletionAdmission('completed', null).reason, 'missing_result');
  assert.deepEqual(deploymentCompletionAdmission('completed', { output: 'deployed successfully' }), { ok: true });
});

test('admits a completed work-product result', () => {
  assert.deepEqual(completionAdmission({
    output: '## What changed\nAdded the guarded relay transition.\n## Verification\nnode --test'
  }), { ok: true });
});

test('holds explicit blocked completion evidence', () => {
  assert.deepEqual(completionAdmission({ output: 'Blocked on verification: no Go toolchain; no commit or PR' }),
    { ok: false, reason: 'completion_blocked', disposition: 'Spec', escalation: 'sol_low_respec' });
});

test('holds QC-BLOCKED completion evidence', () => {
  for (const output of ['QC-BLOCKED: checkout unavailable', 'QC-BLOCKED']) {
    assert.deepEqual(completionAdmission({ output }),
      { ok: false, reason: 'completion_qc_blocked', disposition: 'Spec', escalation: 'sol_low_respec' });
  }
});

test('holds explicit FAIL completion evidence', () => {
  for (const output of ['QC VERDICT: FAIL\nMissing required fixture.', 'FAIL']) {
    assert.deepEqual(completionAdmission({ output }),
      { ok: false, reason: 'completion_failed', disposition: 'Spec', escalation: 'sol_low_respec' });
  }
});

test('holds missing result and explicit no-work-product result', () => {
  assert.deepEqual(completionAdmission(null),
    { ok: false, reason: 'missing_result', disposition: 'Spec', escalation: 'sol_low_respec' });
  assert.deepEqual(completionAdmission({ output: 'No work product' }),
    { ok: false, reason: 'completion_no_work_product', disposition: 'Spec', escalation: 'sol_low_respec' });
});

test('does not reject prose that mentions an earlier blocker', () => {
  assert.deepEqual(completionAdmission({
    output: 'The previous attempt was blocked, but this run produced a commit and passed verification.'
  }), { ok: true });
});
