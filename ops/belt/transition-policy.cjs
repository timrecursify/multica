'use strict';

const STAGES = Object.freeze([
  'Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
  'CI/CD & Deploy', 'Human Review', 'Parked', 'Rejected',
  'Done', 'Archived', 'Cancelled'
]);

const EVIDENCE = Object.freeze({
  registered: ['registeredIssue', 'selectedWorkspace'],
  scoped: ['bindingScope', 'acceptanceTests', 'riskClass'],
  queued: ['completedCurrentTask', 'workProductPointer'],
  reviewed: ['reviewRequiredRoute', 'pr', 'boundSha'],
  deploy: ['noReviewRoute', 'pr', 'boundSha'],
  complete: ['noDeployRoute', 'workProductEvidence'],
  pass: ['qualifyingPass', 'observedShaMatchesBound', 'completedSolLowTask'],
  externalPass: ['qualifyingPass', 'observedShaMatchesBound', 'externalReviewReceipt'],
  retry: ['implementationFail', 'retryRemaining'],
  shipped: ['ciSuccess', 'mergeDeployReceipt', 'reviewedSha'],
  return: ['ciFailureOrAbsent', 'mergeConflictEvidence'],
  retryEscalation: ['retry_escalation'],
  review: ['blocker'],
  decision: ['recordedDecision', 'destinationEvidence'],
  cancelled: ['boardOwnerAuthority', 'reason'],
  archived: ['signedArchivePlanReceipt']
});

const TRANSITIONS = Object.freeze([
  ['Registered', 'Spec', ['system', 'operator'], 'registered'],
  ['Spec', 'Queue', ['worker', 'operator'], 'scoped'],
  ['Queue', 'In Progress', ['system'], 'queued'],
  ['In Progress', 'In Review', ['worker', 'system'], 'reviewed'],
  ['In Progress', 'CI/CD & Deploy', ['worker', 'system'], 'deploy'],
  ['In Progress', 'Done', ['worker', 'system'], 'complete'],
  ['In Progress', 'Spec', ['system'], 'retryEscalation'],
  ['In Review', 'CI/CD & Deploy', ['system'], 'pass'],
  ['In Review', 'In Progress', ['system'], 'retry'],
  ['In Review', 'Spec', ['system'], 'retryEscalation'],
  ['CI/CD & Deploy', 'Done', ['system'], 'shipped'],
  ['CI/CD & Deploy', 'In Progress', ['system'], 'return'],
  ['CI/CD & Deploy', 'Parked', ['system'], 'retryEscalation'],
  ['CI/CD & Deploy', 'Spec', ['system'], 'retryEscalation'],
  ['Queue', 'Spec', ['system'], 'retryEscalation'],
  ['Spec', 'Human Review', ['operator'], 'review'],
  ['Queue', 'Human Review', ['operator'], 'review'],
  ['In Progress', 'Human Review', ['operator'], 'review'],
  ['In Review', 'Human Review', ['operator'], 'review'],
  ['CI/CD & Deploy', 'Human Review', ['operator'], 'review'],
  ['Human Review', 'Spec', ['operator'], 'decision'],
  ['Human Review', 'Queue', ['operator'], 'decision'],
  ['Human Review', 'In Progress', ['operator'], 'decision'],
  ['Human Review', 'In Review', ['operator'], 'decision'],
  ['Human Review', 'CI/CD & Deploy', ['operator'], 'decision'],
  ['Parked', 'Spec', ['operator'], 'decision'],
  ['Parked', 'Queue', ['operator'], 'decision'],
  ['Parked', 'In Review', ['operator'], 'decision'],
  ['Rejected', 'Spec', ['operator'], 'decision'],
  ['Rejected', 'Queue', ['operator'], 'decision'],
  ['Rejected', 'In Progress', ['operator'], 'decision'],
  ['Rejected', 'In Review', ['operator'], 'decision'],
  ['Registered', 'Cancelled', ['operator'], 'cancelled'],
  ['Spec', 'Cancelled', ['operator'], 'cancelled'],
  ['Queue', 'Cancelled', ['operator'], 'cancelled'],
  ['In Progress', 'Cancelled', ['operator'], 'cancelled'],
  ['In Review', 'Cancelled', ['operator'], 'cancelled'],
  ['CI/CD & Deploy', 'Cancelled', ['operator'], 'cancelled'],
  ['Human Review', 'Cancelled', ['operator'], 'cancelled'],
  ['Parked', 'Cancelled', ['operator'], 'cancelled'],
  ['Rejected', 'Cancelled', ['operator'], 'cancelled'],
  ['Done', 'Cancelled', ['operator'], 'cancelled'],
  ['Done', 'Archived', ['archiver'], 'archived']
].map(([from, to, actors, evidence]) => Object.freeze({ from, to, actors: Object.freeze(actors), evidence: EVIDENCE[evidence] })));

const LEGACY_AUTHORITY_KEYS = new Set([
  'operator_cap_release', 'operator_cap_bypass', 'operator_terminal_exit',
  'operator_release', 'parked_release_required', 'isOperator', 'isSystem'
]);

function hasLegacyAuthority(input) {
  return Object.keys(input).some((key) => LEGACY_AUTHORITY_KEYS.has(key) && input[key] === true);
}

function evaluate({ from, to, actor, evidence = {}, ...request } = {}) {
  if (hasLegacyAuthority(request) || hasLegacyAuthority(evidence)) {
    return { ok: false, code: 'request_boolean_authority_denied' };
  }
  const transition = TRANSITIONS.find((row) => row.from === from && row.to === to);
  if (!transition) return { ok: false, code: 'transition_denied' };
  if (!transition.actors.includes(actor)) return { ok: false, code: 'actor_denied' };
  const requiredEvidence = transition.evidence.filter((field) => field !== 'completedSolLowTask');
  if (transition.evidence.includes('completedSolLowTask') &&
      !(evidence.completedSolLowTask || evidence.externalReviewReceipt)) {
    return { ok: false, code: 'evidence_missing' };
  }
  if (!requiredEvidence.every((field) => evidence[field] ||
      (field === 'blocker' && evidence.namedBlocker))) {
    return { ok: false, code: 'evidence_missing' };
  }
  if (evidence.qcRequired === true && !evidence.qualifyingPass) {
    return { ok: false, code: 'evidence_missing' };
  }
  return { ok: true, transition: { ...transition, evidence: requiredEvidence } };
}

module.exports = { EVIDENCE, STAGES, TRANSITIONS, evaluate };
