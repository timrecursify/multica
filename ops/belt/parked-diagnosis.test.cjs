const assert = require('node:assert/strict');
const test = require('node:test');

const {
  diagnosisContext,
  formatParkReason,
  parseDiagnosisOutcome,
  PARK_REASON_MARKER,
  PARK_DIAGNOSIS_KIND
} = require('./parked-diagnosis.cjs');

test('park reason comment carries bounded, machine-readable evidence', () => {
  const comment = formatParkReason({
    reason: 'lifetime_task_limit', stage: 'Spec', attempts: 6, ceiling: 6,
    lastError: 'provider 402'
  });
  assert.match(comment, new RegExp(PARK_REASON_MARKER));
  assert.match(comment, /reason_code: lifetime_task_limit/);
  assert.match(comment, /failed_stage: Spec/);
  assert.match(comment, /attempts: 6\/6/);
  assert.match(comment, /last_error_or_qc_verdict: provider 402/);
});

test('diagnosis context explicitly forbids builder dispatch', () => {
  const context = diagnosisContext({ reason: 'stage_cycle_limit', stage: 'Queue', attempts: 2, ceiling: 2 });
  assert.equal(context.kind, PARK_DIAGNOSIS_KIND);
  assert.equal(context.to_stage, 'Parked');
  assert.equal(context.no_builder, true);
  assert.deepEqual(context.outcomes.sort(), ['already_fixed', 'duplicate', 'fixable', 'genuinely_blocked']);
});

test('diagnosis parser accepts only the four bounded outcomes', () => {
  assert.equal(parseDiagnosisOutcome('Outcome: FIXABLE — reset once'), 'fixable');
  assert.equal(parseDiagnosisOutcome('diagnosis=genuinely_blocked; blocker: billing'), 'genuinely_blocked');
  assert.equal(parseDiagnosisOutcome('looks probably fixed'), null);
  assert.equal(parseDiagnosisOutcome('outcome: retry'), null);
});
