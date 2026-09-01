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
  assert.equal(completionAdmission({ output: 'Blocked on verification: no Go toolchain; no commit or PR' }).reason,
    'completion_blocked');
});

test('holds QC-BLOCKED completion evidence', () => {
  assert.equal(completionAdmission({ output: 'QC-BLOCKED: checkout unavailable' }).reason,
    'completion_qc_blocked');
  assert.equal(completionAdmission({ output: 'QC-BLOCKED' }).reason,
    'completion_qc_blocked');
});

test('holds explicit FAIL completion evidence', () => {
  assert.equal(completionAdmission({ output: 'QC VERDICT: FAIL\nMissing required fixture.' }).reason,
    'completion_failed');
  assert.equal(completionAdmission({ output: 'FAIL' }).reason, 'completion_failed');
});

test('holds missing result and explicit no-work-product result', () => {
  assert.equal(completionAdmission(null).reason, 'missing_result');
  assert.equal(completionAdmission({ output: 'No work product' }).reason,
    'completion_no_work_product');
});

test('does not reject prose that mentions an earlier blocker', () => {
  assert.deepEqual(completionAdmission({
    output: 'The previous attempt was blocked, but this run produced a commit and passed verification.'
  }), { ok: true });
});
