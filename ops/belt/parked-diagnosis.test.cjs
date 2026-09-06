const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  diagnosisContext,
  formatParkReason,
  parseDiagnosisOutcome,
  diagnosisEvidence,
  parseRuntimeEvidenceReference,
  namedBlocker,
  isConcreteRuntimeEvidence,
  currentPassWorkProductMD5,
  verifyRuntimeEvidence,
  recordParkAndQueueDiagnosis,
  diagnosisOutcomeAction,
  isSolLowDiagnosisAgent,
  selectDiagnosisOwner,
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

test('validated Parked outcomes map to bounded state actions', () => {
  assert.deepEqual(diagnosisOutcomeAction({ outcome: 'fixable' }),
    { action: 'release', status: 'Parked', nextStage: 'Queue' });
  assert.deepEqual(diagnosisOutcomeAction({ outcome: 'already_fixed', evidenceVerified: true }),
    { action: 'close', status: 'Done' });
  assert.deepEqual(diagnosisOutcomeAction({ outcome: 'already_fixed', evidenceVerified: false, needsQC: true }),
    { action: 'release', status: 'Parked', nextStage: 'In Review' });
  assert.deepEqual(diagnosisOutcomeAction({ outcome: 'duplicate', duplicateIssueId: 'survivor' }),
    { action: 'close', status: 'Cancelled', duplicateIssueId: 'survivor' });
  assert.deepEqual(diagnosisOutcomeAction({ outcome: 'genuinely_blocked', blocker: 'billing' }),
    { action: 'hold', status: 'Parked', blocker: 'Sol-low diagnosis: billing' });
  assert.equal(diagnosisOutcomeAction({ outcome: 'fixable' }).action, 'release');
  assert.equal(diagnosisOutcomeAction({ outcome: 'fixable' }).status, 'Parked');
  assert.deepEqual(diagnosisOutcomeAction({ outcome: 'fixable', hasBindingSpec: false }),
    { action: 'release', status: 'Parked', nextStage: 'Spec' });
});

test('invalid already-fixed diagnosis preserves its named blocker', () => {
  assert.deepEqual(diagnosisOutcomeAction({ outcome: 'already_fixed', blocker: 'missing durable task evidence',
    invalidAlreadyFixed: true }), {
    action: 'hold', status: 'Parked',
    blocker: 'Sol-low diagnosis: missing durable task evidence; rejected: runtime_evidence_unverified'
  });
});

test('diagnosis evidence and owner validation fail closed', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(diagnosisEvidence('outcome: already_fixed\nruntime_evidence: task:' + uuid), 'task:' + uuid);
  assert.equal(namedBlocker('outcome: genuinely_blocked\nblocker: billing hold'), 'billing hold');
  assert.equal(isConcreteRuntimeEvidence('task:' + uuid), true);
  assert.equal(isConcreteRuntimeEvidence('QC:21235'), true);
  assert.equal(isConcreteRuntimeEvidence('QC:' + uuid.toUpperCase()), true);
  assert.equal(isConcreteRuntimeEvidence('activity:' + uuid), true);
  assert.equal(isConcreteRuntimeEvidence('relay.log:42'), false);
  assert.equal(isConcreteRuntimeEvidence('looks good'), false);
  const parkedInstructions = 'Parked diagnosis role: classify fixable, already_fixed, duplicate, or genuinely_blocked outcomes.';
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-parked-diagnosis-sol-low-1', model: 'gpt-5.6-sol', instructions: parkedInstructions, runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' } }), true);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-parked-diagnosis-luna-low-1', model: 'gpt-5.6-luna', instructions: parkedInstructions, runtime_config: { model: 'gpt-5.6-luna', reasoning_effort: 'low', role: 'diagnosis' } }), true);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-qc-sol-low-1', model: 'gpt-5.6-sol', instructions: parkedInstructions, runtime_config: {} }), false);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-parked-diagnosis-sol-low-1', model: 'gpt-5.6-sol', instructions: 'diagnosis only', runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' } }), false);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-qc-sol-1', model: 'gpt-5.6-sol', runtime_config: {} }), false);
  assert.equal(isSolLowDiagnosisAgent({ name: 'fake-qc-sol-low-01', model: 'gpt-5.6-sol', runtime_config: {} }), false);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-qc-sol-low-1', model: 'gpt-5.5', runtime_config: { reasoning_effort: 'low', role: 'qc' } }), false);
  assert.equal(isSolLowDiagnosisAgent({ name: 'gsp-build-terra-low-1', model: 'gpt-5.6-terra', runtime_config: { role: 'build' } }), false);
});

test('diagnosis prefers an attributable Sol-low scoper, then the dedicated seat', () => {
  const instructions = 'Parked diagnosis: fixable, already_fixed, duplicate, genuinely_blocked.';
  const dedicated = { id: 'dedicated', name: 'gsp-parked-diagnosis-sol-low-1',
    model: 'gpt-5.6-sol', instructions,
    runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' } };
  const scoper = { ...dedicated, id: 'scoper', is_original_scoper: true };
  assert.equal(selectDiagnosisOwner([dedicated, scoper]).owner.id, 'scoper');
  assert.equal(selectDiagnosisOwner([dedicated, { ...scoper, model: 'gpt-5.6-terra' }]).owner.id,
    'dedicated');
});

test('diagnosis processing is workspace-scoped and serializes concurrent ticks', () => {
  const source = fs.readFileSync(require.resolve('./parity/multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /FOR UPDATE OF t SKIP LOCKED/);
  assert.match(source, /WHERE workspace_id = \$1::uuid AND id <> \$2::uuid/);
  assert.match(source, /t\.context->>'kind' = \$2/);
  assert.match(source, /context->>'no_builder'/);
  assert.match(source, /diagnosisOutcomeAction\(\{ outcome/);
  assert.match(source, /action\.action === 'release'/);
  assert.match(source, /hasBindingSpec\(client, task\.issue_id\)/);
  assert.match(source, /action\.action === 'close' \? action\.status : null/);
  assert.match(source, /current_work_product_md5: completionMD5/);
  assert.doesNotMatch(source, /UPDATE issue SET status = 'Done'/);
  assert.doesNotMatch(source, /UPDATE issue SET status = 'Cancelled'/);
  assert.match(source, /SELECT \$1::uuid, \$2::uuid, 'system', \$3::uuid, \$4::text, 'system'/);
  assert.match(source, /jsonb_build_object\('parked_blocker', \$2::text\)/);
});

test('already-fixed completion forwards only the current PASS work-product hash', async () => {
  const pass = await currentPassWorkProductMD5({ query: async () => ({ rows: [
    { verdict: 'PASS', work_product_md5: 'a1b2c3' }
  ] }) }, 'issue-1');
  assert.equal(pass, 'a1b2c3');
  for (const verdict of [
    { verdict: 'FAIL', work_product_md5: 'a1b2c3' },
    { verdict: 'PASS', work_product_md5: '' },
    undefined,
  ]) {
    const hash = await currentPassWorkProductMD5({ query: async () => ({ rows: verdict ? [verdict] : [] }) }, 'issue-1');
    assert.equal(hash, null);
  }
});

test('archiver and duplicate cancellation use relay authority', () => {
  const relay = fs.readFileSync(require.resolve('./parity/multica-relay-advance-daemon.cjs'), 'utf8');
  const archiver = fs.readFileSync(require.resolve('./multica-archiver.cjs'), 'utf8');
  const bridge = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(relay, /action\.action === 'close' \? action\.status : null/);
  assert.match(archiver, /to_stage: 'Archived'/);
  assert.match(archiver, /path: '\/relay\/advance'/);
  assert.match(bridge, /new Set\(\["Parked", "Rejected", "Cancelled"\]\)/);
});

test('runtime evidence must resolve to an issue-scoped durable row', async () => {
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    return { rowCount: values[0] === '123e4567-e89b-12d3-a456-426614174000' ? 1 : 0 };
  } };
  assert.equal(await verifyRuntimeEvidence(client, 'issue-1', 'task:123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(await verifyRuntimeEvidence(client, 'issue-1', 'relay.log:42'), false);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /t\.issue_id = \$2/);
});

test('integer QC verdict evidence is verified with the live serial-id type', async () => {
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    return { rowCount: 1 };
  } };
  assert.equal(await verifyRuntimeEvidence(client, 'issue-1', 'qc:21235'), true);
  assert.match(queries[0].sql, /v\.id = \$1::integer/);
  assert.deepEqual(queries[0].values, [21235, 'issue-1']);
});

test('UUID QC evidence resolves the same-issue QC-gate comment the seat is shown', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    return { rowCount: 1 };
  } };
  assert.equal(await verifyRuntimeEvidence(client, 'issue-1', `QC:${uuid.toUpperCase()}`), true);
  assert.match(queries[0].sql, /FROM comment c WHERE c\.id = \$1::uuid/);
  assert.match(queries[0].sql, /c\.issue_id = \$2::uuid/);
  assert.match(queries[0].sql, /content LIKE '<!-- multica-qc-gate -->%'/);
  assert.deepEqual(queries[0].values, [uuid, 'issue-1']);
});

test('runtime evidence accepts only canonical durable-reference grammar', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(parseRuntimeEvidenceReference(`task:${uuid}`), { kind: 'task', id: uuid });
  assert.deepEqual(parseRuntimeEvidenceReference('QC:21235'), { kind: 'qc', id: 21235 });
  assert.deepEqual(parseRuntimeEvidenceReference(`qc:${uuid}`), { kind: 'qc_comment', id: uuid });
  assert.deepEqual(parseRuntimeEvidenceReference(`QC:${uuid.toUpperCase()}`),
    { kind: 'qc_comment', id: uuid });
  for (const invalid of ['task:deadbeef', `task:${uuid} trailing`, `runtime_evidence: task:${uuid}`,
    `note task:${uuid}`, `task:${uuid.replace(/-/g, '')}`, `qc:${uuid} trailing`,
    `qc:${uuid.replace(/-/g, '')}`, 'qc:2147483648', 'relay.log:42']) {
    assert.equal(parseRuntimeEvidenceReference(invalid), null, invalid);
  }
});

test('recovery classifies #1009 and PPP-23696 for QC, and rejects #23734 parked diagnosis evidence', async () => {
  const issueId = '123e4567-e89b-12d3-a456-426614174000';
  const citedTask = '123e4567-e89b-12d3-a456-426614174001';
  const validClient = { query: async (sql) => {
    assert.match(sql, /context->>'kind' IS DISTINCT FROM 'parked_diagnosis'/);
    return { rowCount: 1 };
  } };
  for (const ticket of ['#1009', 'PPP-23696']) {
    assert.equal(await verifyRuntimeEvidence(validClient, issueId, `task:${citedTask}`, 'retry'), true, ticket);
    assert.deepEqual(diagnosisOutcomeAction({ outcome: 'already_fixed', needsQC: true }),
      { action: 'release', status: 'Parked', nextStage: 'In Review' }, ticket);
  }
  const parkedDiagnosisClient = { query: async (sql) => {
    assert.match(sql, /context->>'kind' IS DISTINCT FROM 'parked_diagnosis'/);
    return { rowCount: 0 };
  } };
  assert.equal(await verifyRuntimeEvidence(parkedDiagnosisClient, issueId, `task:${citedTask}`, 'retry'), false,
    'PPP-23734 parked_diagnosis citation');
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
  const selection = await recordParkAndQueueDiagnosis(client, {
    id: 'issue-1', workspace_id: 'workspace-1', status: 'Queue', priority: 'high'
  }, { reason: 'lifetime_task_limit', attempts: 6, ceiling: 6 });
  assert.deepEqual(selection, { task_id: null, owner: null, reason: 'diagnosis_owner_absent',
    candidate_count: 0, aggregate_free_slots: 0 });
  const trace = queries.map(({ sql, values }) => `${sql}\n${JSON.stringify(values)}`).join('\n');
  assert.match(trace, /diagnosis_owner_absent/);
  assert.match(trace, /multica-park-diagnosis-blocker/);
});

test('queued diagnosis task is scoped to the issue workspace', async () => {
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (/SELECT failure_reason, error/.test(sql)) return { rows: [] };
    if (/SELECT verdict FROM qc_verdict/.test(sql)) return { rows: [] };
    if (/SELECT a\.id, a\.name/.test(sql)) return { rows: [{
      id: 'agent-1', name: 'gsp-parked-diagnosis-sol-low-1', model: 'gpt-5.6-sol',
      runtime_id: 'runtime-1', instructions: 'Parked diagnosis: fixable, already_fixed, duplicate, genuinely_blocked.',
      runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' },
      is_original_scoper: false
    }] };
    if (/INSERT INTO agent_task_queue/.test(sql)) return { rows: [{ id: 'task-1' }] };
    return { rowCount: 0, rows: [] };
  } };
  const selection = await recordParkAndQueueDiagnosis(client, {
    id: 'issue-1', workspace_id: 'workspace-1', status: 'Parked', priority: 'medium'
  }, { reason: 'stage_cycle_limit', attempts: 2, ceiling: 2 });
  assert.equal(selection.task_id, 'task-1');
  const insert = queries.find(({ sql }) => /INSERT INTO agent_task_queue/.test(sql));
  assert.ok(insert, 'diagnosis INSERT was executed');
  assert.match(insert.sql, /agent_id, issue_id, workspace_id, status/);
  assert.equal(insert.values[2], 'workspace-1');
  assert.match(insert.values[5], /"owner_selection":"dedicated_sol_low"/);
});

test('diagnosis owner selection respects an active-task concurrency cap', () => {
  const row = { id: 'agent-1', name: 'gsp-parked-diagnosis-sol-low-1', model: 'gpt-5.6-sol',
    instructions: 'Parked diagnosis: fixable, already_fixed, duplicate, genuinely_blocked.',
    runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' },
    max_concurrent_tasks: 1, active_task_count: 1 };
  assert.deepEqual(selectDiagnosisOwner([row]), { owner: null, reason: 'diagnosis_owner_at_capacity',
    candidate_count: 1, aggregate_free_slots: 0 });
});

test('diagnosis owner selection reports mixed-seat aggregate free slots', () => {
  const base = { name: 'gsp-parked-diagnosis-sol-low-1', model: 'gpt-5.6-sol',
    instructions: 'Parked diagnosis: fixable, already_fixed, duplicate, genuinely_blocked.',
    runtime_config: { model: 'gpt-5.6-sol', reasoning_effort: 'low', role: 'diagnosis' } };
  const selection = selectDiagnosisOwner([
    { ...base, id: 'full', max_concurrent_tasks: 2, active_task_count: 2 },
    { ...base, id: 'free', max_concurrent_tasks: 3, active_task_count: 1 }
  ]);
  assert.equal(selection.owner.id, 'free');
  assert.equal(selection.aggregate_free_slots, 2);
  assert.equal(selection.candidate_count, 2);
});

test('INSERT SELECT parameters carry explicit PostgreSQL types', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./parked-diagnosis.cjs'), 'utf8');
  assert.match(source, /SELECT \$1::uuid, \$2::uuid, 'system', \$3::uuid, \$4::text, 'system'/);
  assert.match(source, /agent_id, issue_id, workspace_id, status, priority, runtime_id, context/);
  assert.match(source, /SELECT \$1::uuid, \$2::uuid, \$3::uuid, 'queued', \$4::integer, \$5::uuid, \$6::jsonb/);
  assert.match(source, /issue_id = \$2::uuid AND context->>'kind' = \$7::text/);
});
