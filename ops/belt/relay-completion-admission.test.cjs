'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { completionAdmission } = require('./relay-completion-admission.cjs');

test('admits a completed work-product result', () => {
  assert.deepEqual(completionAdmission({
    output: '## What changed\nAdded the guarded relay transition.\n## Verification\nnode --test'
  }), { ok: true });
});

test('holds explicit blocked completion evidence', () => {
  assert.deepEqual(completionAdmission({ output: 'Blocked on verification: no Go toolchain; no commit or PR' }),
    { ok: false, reason: 'completion_blocked', disposition: 'Parked' });
});

test('holds QC-BLOCKED completion evidence', () => {
  for (const output of ['QC-BLOCKED: checkout unavailable', 'QC-BLOCKED']) {
    assert.deepEqual(completionAdmission({ output }),
      { ok: false, reason: 'completion_qc_blocked', disposition: 'Parked' });
  }
});

test('holds explicit FAIL completion evidence', () => {
  for (const output of ['QC VERDICT: FAIL\nMissing required fixture.', 'FAIL']) {
    assert.deepEqual(completionAdmission({ output }),
      { ok: false, reason: 'completion_failed', disposition: 'Parked' });
  }
});

test('holds missing result and explicit no-work-product result', () => {
  assert.deepEqual(completionAdmission(null),
    { ok: false, reason: 'missing_result', disposition: 'Parked' });
  assert.deepEqual(completionAdmission({ output: 'No work product' }),
    { ok: false, reason: 'completion_no_work_product', disposition: 'Parked' });
});

test('does not reject prose that mentions an earlier blocker', () => {
  assert.deepEqual(completionAdmission({
    output: 'The previous attempt was blocked, but this run produced a commit and passed verification.'
  }), { ok: true });
});
