const assert = require('node:assert/strict');
const test = require('node:test');

const {
  diagnosisContext,
  formatParkReason,
  parseDiagnosisOutcome,
  diagnosisEvidence,
  namedBlocker,
  isConcreteRuntimeEvidence,
  verifyRuntimeEvidence,
  recordParkAndQueueDiagnosis,
  isSolLowDiagnosisAgent,
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

test('diagnosis evidence and owner validation fail closed', () => {
  assert.equal(diagnosisEvidence('outcome: already_fixed\nruntime_evidence: relay.log:42'), 'relay.log:42');
  assert.equal(namedBlocker('outcome: genuinely_blocked\nblocker: billing hold'), 'billing hold');
  assert.equal(isConcreteRuntimeEvidence('relay.log:42'), true);
  assert.equal(isConcreteRuntimeEvidence('looks good'), false);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-qc-sol-low-1', model: 'gpt-5.6-sol', runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'qc' } }), true);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-qc-sol-low-1', model: 'gpt-5.5', runtime_config: { reasoning_effort: 'low', role: 'qc' } }), false);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-build-terra-low-1', model: 'gpt-5.6-terra', runtime_config: { role: 'build' } }), false);
});

test('diagnosis processing is workspace-scoped and serializes concurrent ticks', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./parity/multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /FOR UPDATE OF t SKIP LOCKED/);
  assert.match(source, /WHERE workspace_id = \$1 AND id <> \$2/);
  assert.match(source, /t\.context->>'kind' = \$2/);
  assert.match(source, /context->>'no_builder'/);
});

test('runtime evidence must resolve to an issue-scoped durable row', async () => {
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    return { rowCount: values[0] === 'deadbeef' ? 1 : 0 };
  } };
  assert.equal(await verifyRuntimeEvidence(client, 'issue-1', 'task:deadbeef'), true);
  assert.equal(await verifyRuntimeEvidence(client, 'issue-1', 'relay.log:42'), false);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /t\.issue_id = \$2/);
});

test('missing Sol-low owner persists a named blocker instead of parking silently', async () => {
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (/SELECT failure_reason, error/.test(sql)) return { rows: [] };
    if (/SELECT verdict FROM qc_verdict/.test(sql)) return { rows: [] };
    if (/SELECT a\.id, a\.name/.test(sql)) return { rows: [] };
    if (/UPDATE issue/.test(sql)) return { rowCount: 1, rows: [] };
    return { rowCount: 0, rows: [] };
  } };
  const taskId = await recordParkAndQueueDiagnosis(client, {
    id: 'issue-1', workspace_id: 'workspace-1', status: 'Queue', priority: 'high'
  }, { reason: 'lifetime_task_limit', attempts: 6, ceiling: 6 });
  assert.equal(taskId, null);
  const trace = queries.map(({ sql, values }) => `${sql}\n${JSON.stringify(values)}`).join('\n');
  assert.match(trace, /no_sol_low_diagnosis_owner/);
  assert.match(trace, /multica-park-diagnosis-blocker/);
});
