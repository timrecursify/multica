'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TRANSITIONS, evaluate } = require('./transition-policy.cjs');

function evidenceFor(fields) {
  return Object.fromEntries(fields.map((field) => [field, field === 'reason' ? 'operator reason' : true]));
}

test('accepts every DESIGN transition table row with its required evidence', () => {
  for (const row of TRANSITIONS) {
    for (const actor of row.actors) {
      const evidence = evidenceFor(row.evidence);
      if (row.evidence.includes('completedSolLowTask')) evidence.completedSolLowTask = true;
      assert.equal(evaluate({ from: row.from, to: row.to, actor, evidence }).ok, true,
        `${row.from} -> ${row.to} by ${actor}`);
    }
  }
});

test('fails closed for unlisted, terminal, and actor-mismatched transitions', () => {
  assert.equal(evaluate({ from: 'Done', to: 'Spec', actor: 'operator' }).code, 'transition_denied');
  assert.equal(evaluate({ from: 'Cancelled', to: 'Spec', actor: 'operator' }).code, 'transition_denied');
  assert.equal(evaluate({ from: 'Archived', to: 'Done', actor: 'archiver' }).code, 'transition_denied');
  assert.equal(evaluate({ from: 'Spec', to: 'Queue', actor: 'system', evidence: evidenceFor(['bindingScope', 'acceptanceTests', 'riskClass']) }).code, 'actor_denied');
});

test('requires evidence and never accepts request booleans as authority', () => {
  assert.equal(evaluate({ from: 'In Review', to: 'CI/CD & Deploy', actor: 'system', evidence: {} }).code, 'evidence_missing');
  assert.equal(evaluate({ from: 'Human Review', to: 'Spec', actor: 'worker', operator_release: true,
    evidence: { recordedDecision: true } }).code, 'request_boolean_authority_denied');
  assert.equal(evaluate({ from: 'Human Review', to: 'Spec', actor: 'worker',
    evidence: { recordedDecision: true, isOperator: true } }).code, 'request_boolean_authority_denied');
});

test('never admits a direct In Progress deploy, even with deploy-shaped evidence', () => {
  assert.equal(evaluate({ from: 'In Progress', to: 'CI/CD & Deploy', actor: 'system', evidence: {
    noReviewRoute: true, pr: true, boundSha: true, qualifyingPass: true,
    observedShaMatchesBound: true, completedSolLowTask: true
  }).code, 'transition_denied');
});

test('allows only system retry escalation from Queue back to Spec', () => {
  assert.equal(evaluate({ from: 'Queue', to: 'Spec', actor: 'system',
    evidence: { retry_escalation: true } }).ok, true);
  assert.equal(evaluate({ from: 'Queue', to: 'Spec', actor: 'worker',
    evidence: { retry_escalation: true } }).code, 'actor_denied');
  assert.equal(evaluate({ from: 'Queue', to: 'Spec', actor: 'system', evidence: {} }).code,
    'evidence_missing');
});

test('permits Human Review only when an operator records a blocker', () => {
  assert.equal(evaluate({ from: 'Queue', to: 'Human Review', actor: 'system', evidence: {} }).ok, false);
  for (const from of ['Spec', 'Queue', 'In Progress', 'In Review', 'CI/CD & Deploy']) {
    assert.equal(evaluate({ from, to: 'Human Review', actor: 'system',
      evidence: { blocker: 'technical_reason' } }).code, 'actor_denied', from);
    assert.equal(evaluate({ from, to: 'Human Review', actor: 'operator',
      evidence: { blocker: 'money_or_destructive_decision' } }).ok, true, from);
  }
});

test('requires destination evidence after Human Review and QC PASS when risk requires it', () => {
  assert.equal(evaluate({ from: 'Human Review', to: 'Queue', actor: 'operator',
    evidence: { recordedDecision: true } }).code, 'evidence_missing');
  assert.equal(evaluate({ from: 'CI/CD & Deploy', to: 'Done', actor: 'system', evidence: {
    ciSuccess: true, mergeDeployReceipt: true, reviewedSha: true, qcRequired: true
  } }).code, 'evidence_missing');
});
