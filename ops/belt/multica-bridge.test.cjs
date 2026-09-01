const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET || 'test-relay-secret';
process.env.RELAY_OPERATOR_SECRET = process.env.RELAY_OPERATOR_SECRET || 'test-operator-secret';
process.env.MULTICA_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'test-workspace';

const {
  existingStageTask,
  replaceStageTask,
  ownerStageForTransition,
  ensureCompletedRelayLog,
  completedTerminalRelayLog,
  isBookkeepingTransition,
  recordBookkeepingHandoff,
  validateRelayVerdict,
  latestCompletedSolLowQcTask,
  qcTaskEvidenceMismatch,
  relayVerdict,
  setTestClientFactory,
  isCicdReturn,
  consumeCicdReturnAuthorization,
  authorizeCicdReturnCapBypass,
  selectPoolOwner,
  selectStageOwner,
  applyDisposition,
  consumeParkedQcRecovery,
  isNoArtifactQcBlock,
  operatorRescopeIssueId,
  issueImplementationArtifact,
  noArtifactRescopeAdmission,
  consumeNoArtifactRescope,
  latestQcNoArtifactSignal,
  retryEscalationReason,
  verifiedRetryEscalation,
  retryEscalationSourceTask,
  authorizeRelayStatusWrites,
  rerunParkedDiagnosis,
  isTerminalStage
} = require('./multica-bridge.cjs');

test('Parked diagnosis rerun is idempotent and refuses a non-Parked issue', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM issue WHERE')) return { rowCount: 1, rows: [{ id: '123e4567-e89b-42d3-a456-426614174000', workspace_id: 'w', status: 'Parked', priority: 'low' }] };
    if (sql.includes("operator_rerun_idem_key")) return { rowCount: 1, rows: [{ id: 'existing-task' }] };
    return { rowCount: 0, rows: [] };
  } };
  const result = await rerunParkedDiagnosis(client, { issue_id: '123e4567-e89b-42d3-a456-426614174000', idempotency_key: 'rerun-0001' });
  assert.deepEqual(result, { ok: true, replay: true, task_id: 'existing-task' });
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
});

test('relay status authority is transaction-local', async () => {
  const calls = [];
  await authorizeRelayStatusWrites({ query: async (sql) => calls.push(sql) });
  assert.deepEqual(calls, ["SELECT set_config('multica.relay_authorized', 'on', true)"]);
});

test('relay advance authorizes status writes after beginning its transaction', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const relay = source.slice(source.indexOf('async function relayAdvance'));
  assert.match(relay, /await client\.query\("BEGIN"\);\s+await authorizeRelayStatusWrites\(client\);/);
});

test('status authority migration rejects non-relay changes and is reversible', () => {
  const up = fs.readFileSync(require.resolve('../../server/migrations/297_relay_status_authority.up.sql'), 'utf8');
  const down = fs.readFileSync(require.resolve('../../server/migrations/297_relay_status_authority.down.sql'), 'utf8');
  assert.match(up, /BEFORE UPDATE OF status ON issue/);
  assert.match(up, /current_setting\('multica\.relay_authorized', true\) IS DISTINCT FROM 'on'/);
  assert.match(up, /ERRCODE = '42501'/);
  assert.match(down, /DROP TRIGGER IF EXISTS issue_status_relay_authority ON issue/);
  assert.match(down, /DROP FUNCTION IF EXISTS require_relay_status_authority/);
});

test('retry escalation accepts only named bounded triggers', () => {
  assert.equal(retryEscalationReason('retry_escalation:completion_failed'), 'completion_failed');
  assert.equal(retryEscalationReason('retry_escalation:stage_cycle_limit'), 'stage_cycle_limit');
  assert.equal(retryEscalationReason('retry_escalation:delete_everything'), null);
  assert.equal(retryEscalationReason('completion_failed'), null);
});

test('completion escalation is bound to one exact completed failed task', async () => {
  const taskId = '223e4567-e89b-42d3-a456-426614174000';
  const issue = { id: '123e4567-e89b-42d3-a456-426614174000',
    workspace_id: '323e4567-e89b-42d3-a456-426614174000', status: 'In Review', metadata: {} };
  const client = { query: async (sql, values) => {
    assert.match(sql, /t\.context->>'to_stage' = \$4::text OR EXISTS/);
    assert.match(sql, /r\.task_id = t\.id AND r\.issue_id = t\.issue_id/);
    assert.deepEqual(values, [taskId, issue.id, issue.workspace_id, issue.status]);
    return { rows: [{ status: 'completed', result: { output: 'QC VERDICT: FAIL' }, error: null }] };
  } };
  const result = await verifiedRetryEscalation(client, issue, {
    to_stage: 'Spec', reason: 'retry_escalation:completion_failed',
    retry_escalation_task_id: taskId, retry_escalation_stage: issue.status
  });
  assert.deepEqual(result, { reason: 'completion_failed', trigger_stage: 'In Review',
    source_task_id: taskId });
});

test('retry escalation refuses a consumed source task', async () => {
  const taskId = '223e4567-e89b-42d3-a456-426614174000';
  const issue = { id: '123e4567-e89b-42d3-a456-426614174000',
    workspace_id: '323e4567-e89b-42d3-a456-426614174000', status: 'In Review',
    metadata: { retry_escalation: { source_task_id: taskId } } };
  const client = { query: async () => { throw new Error('must not query'); } };
  assert.equal(await verifiedRetryEscalation(client, issue, {
    to_stage: 'Spec', reason: 'retry_escalation:completion_failed',
    retry_escalation_task_id: taskId, retry_escalation_stage: issue.status
  }), false);
});

test('cap escalation binds one exact active source task in the current stage', async () => {
  const taskId = '223e4567-e89b-42d3-a456-426614174000';
  const issue = { id: '123e4567-e89b-42d3-a456-426614174000',
    workspace_id: '323e4567-e89b-42d3-a456-426614174000', status: 'In Review' };
  const client = { query: async (sql, values) => {
    assert.match(sql, /t\.status IN \('queued','dispatched','running','waiting_local_directory','deferred'\)/);
    assert.match(sql, /t\.context->>'to_stage' = \$3::text/);
    assert.match(sql, /LIMIT 2 FOR UPDATE OF t/);
    assert.deepEqual(values, [issue.id, issue.workspace_id, issue.status, taskId]);
    return { rows: [{ id: taskId }] };
  } };
  assert.equal(await retryEscalationSourceTask(client, issue, taskId), taskId);
});

test('cap escalation fails closed when source lineage is ambiguous or invalid', async () => {
  const issue = { id: '123e4567-e89b-42d3-a456-426614174000',
    workspace_id: '323e4567-e89b-42d3-a456-426614174000', status: 'In Review' };
  let queries = 0;
  const client = { query: async () => {
    queries += 1;
    return { rows: [{ id: 'one' }, { id: 'two' }] };
  } };
  assert.equal(await retryEscalationSourceTask(client, issue), null);
  assert.equal(await retryEscalationSourceTask(client, issue, 'not-a-uuid'), null);
  assert.equal(queries, 1);
});

test('Parked evidence QC return is a canonical consumed-release-only edge', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /function verifiedParkedEvidenceRelease/);
  assert.match(source, /\^runtime_evidence_verified:/);
  assert.match(source, /parseRuntimeEvidenceReference/);
  assert.match(source, /parked_release_once !== true/);
  assert.match(source, /parkedEvidenceQcRelease/);
  assert.match(source, /parkedRelease \|\| parkedEvidenceQcRelease/);
  assert.match(source, /context->>'kind' IS DISTINCT FROM 'parked_diagnosis'/);
});

test('Parked evidence return selects the canonical In Review QC owner', () => {
  assert.equal(ownerStageForTransition('Parked', 'In Review'), 'In Progress');
  assert.equal(ownerStageForTransition('Parked', 'Spec'), 'Registered');
});

test('exact #23696 recovery marker bypasses one capped QC admission, then is consumed', async () => {
  const issue = { id: '123e4567-e89b-42d3-a456-426614174000', status: 'Parked' };
  const reason = 'runtime_evidence_verified:task:223e4567-e89b-42d3-a456-426614174000';
  let writes = 0;
  const client = { query: async (sql, values) => {
    writes += 1; assert.match(sql, /- 'parked_qc_recovery'/); assert.deepEqual(values, [issue.id, 'task:223e4567-e89b-42d3-a456-426614174000']);
    return { rowCount: writes === 1 ? 1 : 0, rows: writes === 1 ? [{ id: issue.id }] : [] };
  } };
  assert.equal(await consumeParkedQcRecovery(client, issue, 'In Review', reason, true), true);
  assert.equal(await consumeParkedQcRecovery(client, issue, 'In Review', reason, true), false);
  assert.equal(await consumeParkedQcRecovery(client, issue, 'In Review', reason, false), false);
  assert.equal(await consumeParkedQcRecovery(client, issue, 'Queue', reason, true), false);
});

test('ordinary capped Parked to In Review has no recovery bypass', () => {
  const { stageCycleAdmission } = require('./guardrails.cjs');
  assert.equal(stageCycleAdmission(2).ok, false);
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /!cycle\.ok && !cicdReturn && !parkedQcRecovery/);
  assert.match(source, /consumeParkedQcRecovery\(\s*client, issue, to_stage, reason, parkedEvidenceQcRelease/);
});

test('NO-SHA QC block recognises only an artifact-free blocked result', () => {
  assert.equal(isNoArtifactQcBlock(
    'QC-BLOCKED: no implementation SHA or linked PR exists; no immutable tracked-tree artifact is available.'), true);
  assert.equal(isNoArtifactQcBlock('QC-BLOCKED\nNO-SHA: no code change applies.'), true);
  assert.equal(isNoArtifactQcBlock('QC VERDICT: PASS\nNO-SHA'), false);
  assert.equal(isNoArtifactQcBlock('QC-BLOCKED: no implementation SHA\nQC_EVIDENCE_JSON={}'), false);
  assert.equal(isNoArtifactQcBlock(
    'QC-BLOCKED: inspect https://github.com/acme/repo/pull/42 before continuing'), false);
  assert.equal(isNoArtifactQcBlock(
    'QC-BLOCKED: bound SHA 0123456789012345678901234567890123456789 is unavailable'), false);
});

test('operator re-scope request is explicit and bound to one UUID', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(operatorRescopeIssueId(id, null), id);
  assert.equal(operatorRescopeIssueId(null,
    `RETURN:Spec — QC-BLOCKED NO-SHA operator re-scope ${id}`), id);
  assert.equal(operatorRescopeIssueId(null, 'RETURN:Spec — retry this ticket'), null);
});

test('artifact lookup rejects any verdict, builder work product, or issue PR/SHA', async () => {
  for (const field of ['has_qc_verdict', 'has_builder_artifact', 'has_comment_artifact']) {
    const client = { query: async (sql, values) => {
      assert.match(sql, /FROM qc_verdict/);
      assert.match(sql, /context->>'to_stage' = 'Queue'/);
      assert.match(sql, /FROM comment/);
      assert.deepEqual(values, ['issue-1']);
      return { rows: [{ has_qc_verdict: false, has_builder_artifact: false,
        has_comment_artifact: false, [field]: true }] };
    } };
    assert.equal(await issueImplementationArtifact(client, 'issue-1'), true);
  }
});

test('operator re-scope admits only the exact issue UUID and completed Sol-low NO-SHA block', async () => {
  const issue = { id: '123e4567-e89b-42d3-a456-426614174000', workspace_id: 'workspace-1',
    status: 'In Review', metadata: {} };
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM agent_task_queue t')) return { rows: [{ id: 'qc-task', status: 'completed',
      result: { output: 'QC-BLOCKED: no implementation SHA or PR exists.' } }] };
    return { rows: [{ has_qc_verdict: false, has_builder_artifact: false,
      has_comment_artifact: false }] };
  } };
  assert.equal(await noArtifactRescopeAdmission(client, issue, 'Spec', issue.id), true);
  assert.equal(calls.length, 2);
  assert.equal(await noArtifactRescopeAdmission(client, issue, 'Spec',
    '223e4567-e89b-42d3-a456-426614174000'), false);
  assert.equal(await noArtifactRescopeAdmission(client, issue, 'In Progress', issue.id), false);
  assert.equal(calls.length, 2, 'invalid operator requests must do no evidence queries');
  assert.equal(await noArtifactRescopeAdmission(client, { ...issue, status: 'Human Review' },
    'Spec', issue.id), true);
});

test('operator re-scope rejects consumed, artifact-bearing, and PASS/FAIL flights', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const issue = { id, workspace_id: 'workspace-1', status: 'In Review', metadata: {} };
  assert.equal(await noArtifactRescopeAdmission({ query: async () => { throw new Error('queried'); } },
    { ...issue, metadata: { no_artifact_rescope_consumed_at: '2026-09-01T19:00:00Z' } },
    'Spec', id), false);
  const taskClient = (output, artifact = false) => ({ query: async (sql) =>
    sql.includes('FROM agent_task_queue t')
      ? { rows: [{ status: 'completed', result: { output } }] }
      : { rows: [{ has_qc_verdict: artifact, has_builder_artifact: false,
          has_comment_artifact: false }] } });
  assert.equal(await noArtifactRescopeAdmission(taskClient('QC VERDICT: PASS'), issue, 'Spec', id), false);
  assert.equal(await noArtifactRescopeAdmission(
    taskClient('QC-BLOCKED: no implementation SHA exists.', true), issue, 'Spec', id), false);
});

test('operator re-scope authorization is consumed once in issue metadata', async () => {
  let calls = 0;
  const issue = { id: '123e4567-e89b-42d3-a456-426614174000' };
  const client = { query: async (sql, values) => {
    calls += 1;
    assert.match(sql, /no_artifact_rescope_consumed_at/);
    assert.match(sql, /status IN \('In Review', 'Human Review'\)/);
    assert.deepEqual(values, [issue.id]);
    return { rowCount: calls === 1 ? 1 : 0 };
  } };
  assert.equal(await consumeNoArtifactRescope(client, issue), true);
  assert.equal(await consumeNoArtifactRescope(client, issue), false);
});

test('Human Review guard reads only the latest active-or-completed Sol-low QC flight', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ result: null,
      content: 'QC-BLOCKED: no implementation SHA or linked PR exists.' }] };
  } };
  const issue = { id: 'issue-1', workspace_id: 'workspace-1' };
  assert.equal(await latestQcNoArtifactSignal(client, issue), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /t\.status IN \('queued','dispatched','running'/);
  assert.match(calls[0].sql, /LEFT JOIN LATERAL/);
  assert.match(calls[0].sql, /ORDER BY t\.created_at DESC, t\.id DESC LIMIT 1/);
  assert.deepEqual(calls[0].values, ['issue-1', 'workspace-1']);
});

test('technical QC block cannot route to Human Review and exact re-scope bypasses configured edge and caps', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /technical_human_review_forbidden/);
  assert.match(source, /!noArtifactRescope && !allowedStages\.includes\(to_stage\)/);
  assert.match(source,
    /!cycle\.ok && !cicdReturn && !parkedQcRecovery &&\s+!noArtifactRescope && !retryEscalation/);
  assert.match(source,
    /!lifetime\.ok && !cicdReturn && !noArtifactRescope && !retryEscalation/);
  assert.match(source, /consumeNoArtifactRescope\(client, issue\)/);
  assert.match(source, /operator_rescope_issue_id: issue\.id/);
});

const validVerdict = Object.freeze({
  issue_id: '123e4567-e89b-42d3-a456-426614174000', checker: 'BRAVO-000517',
  verdict: 'PASS', work_product_md5: 'e41d8cd98f00b204e9800998ecf8427e',
  bound_sha: '0123456789012345678901234567890123456789',
  observed_sha: '0123456789012345678901234567890123456789', failure_class: 'none',
  qualifying: true, model: 'gpt-5.6-sol', effort: 'low', idem_key: 'qc-verdict-000517'
});
const qcResult = (evidence = validVerdict) => ({ output: `QC completed\nQC_EVIDENCE_JSON=${JSON.stringify(evidence)}` });

test('verdict validation accepts the sanctioned CLI checker field and rejects forged lane metadata', () => {
  assert.equal(validateRelayVerdict(validVerdict), null);
  assert.equal(validateRelayVerdict({ ...validVerdict, checker: undefined }), 'invalid_checker');
  assert.equal(validateRelayVerdict({ ...validVerdict, observed_sha: 'f123456789012345678901234567890123456789' }), 'sha_binding_mismatch');
  assert.equal(validateRelayVerdict({ ...validVerdict, work_product_md5: 'not-an-md5' }), 'invalid_work_product_md5');
  assert.equal(validateRelayVerdict({ ...validVerdict, model: 'gpt-5.6-terra' }), 'invalid_qc_lane');
  assert.equal(validateRelayVerdict({ ...validVerdict, effort: 'high' }), 'invalid_qc_lane');
  assert.equal(validateRelayVerdict({ ...validVerdict, failure_class: 'invented' }), 'invalid_failure_class');
});

test('routing rejections expose only bounded agent routing fields', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /actual_model: preflight\.model/);
  assert.match(source, /actual_effort: preflight\.effort/);
  assert.match(source, /expected_model: preflight\.expected_model/);
  assert.doesNotMatch(source, /routing:.*runtime_config/s);
});

test('QC evidence parser accepts exactly one structured output marker', () => {
  assert.equal(qcTaskEvidenceMismatch({ result: qcResult() }, validVerdict), null);
  assert.equal(qcTaskEvidenceMismatch({ result: { output: 'QC_EVIDENCE_JSON={bad}' } }, validVerdict), 'qc_task_evidence_required');
  assert.equal(qcTaskEvidenceMismatch({ result: { output: `${qcResult().output}\nQC_EVIDENCE_JSON=${JSON.stringify(validVerdict)}` } }, validVerdict), 'qc_task_evidence_required');
  assert.equal(qcTaskEvidenceMismatch({ result: { output: 'QC VERDICT: PASS' } }, validVerdict), 'qc_task_evidence_required');
});

test('verdict checker identity is selected from the completed same-workspace Sol-low QC task', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: 'task-1', agent_id: 'agent-1', agent_name: 'qc-sol-low', context: { head_sha: validVerdict.bound_sha } }] };
  } };
  const task = await latestCompletedSolLowQcTask(client, 'issue-1', 'workspace-1');
  assert.equal(task.agent_id, 'agent-1');
  assert.deepEqual(calls[0].values, ['issue-1', 'workspace-1']);
  assert.match(calls[0].sql, /i\.workspace_id = t\.workspace_id/);
  assert.match(calls[0].sql, /a\.workspace_id = i\.workspace_id/);
  assert.match(calls[0].sql, /t\.context->>'to_stage' = 'In Review'/);
  assert.match(calls[0].sql, /COALESCE\(a\.model, a\.runtime_config->>'model'\) = 'gpt-5\.6-sol'/);
  assert.match(calls[0].sql, /COALESCE\(a\.thinking_level, a\.runtime_config->>'reasoning_effort'\) = 'low'/);
  assert.match(calls[0].sql, /ORDER BY t\.completed_at DESC NULLS LAST/);
});

test('completed In Review rerun task is admitted for the QC verdict', async () => {
  const rerunTask = {
    id: 'rerun-qc-task', agent_id: 'qc-agent', status: 'completed',
    context: { to_stage: 'In Review' }, result: { output: 'QC VERDICT: PASS' },
    agent_name: 'qc-sol-low'
  };
  const client = { query: async (sql, values) => {
    assert.deepEqual(values, ['issue-in-review', 'workspace-for-issue']);
    assert.match(sql, /i\.workspace_id = t\.workspace_id/);
    assert.match(sql, /t\.context->>'to_stage' = 'In Review'/);
    return { rows: [rerunTask] };
  } };
  assert.equal(
    await latestCompletedSolLowQcTask(client, 'issue-in-review', 'workspace-for-issue'),
    rerunTask
  );
});

test('verdict route never trusts a caller supplied checker identity', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.doesNotMatch(source, /RELAY_QC_ACTOR_ID/);
  assert.match(source, /checker_id: qcTask\.agent_id/);
  assert.match(source, /payload\.checker/);
  assert.match(source, /qcTask\.agent_name/);
  assert.match(source, /qc_task_sha_mismatch/);
  assert.match(source, /idempotency_conflict/);
});

test('verdict handler binds all evidence to the completed QC task and resists forgery', async () => {
  const attempts = new Map();
  const writes = [];
  let task = {
    id: 'task-1', agent_id: 'agent-1', agent_name: 'qc-sol-low-1',
    context: {}, result: qcResult()
  };
  const client = {
    async connect() {}, async end() {},
    async query(sql, values = []) {
      if (/FROM qc_attempt/.test(sql)) return { rows: attempts.has(values[0]) ? [attempts.get(values[0])] : [] };
      if (/SELECT id, workspace_id FROM issue/.test(sql)) return { rows: [{ id: validVerdict.issue_id, workspace_id: 'workspace-1' }] };
      if (/FROM agent_task_queue t/.test(sql)) return { rows: task ? [task] : [] };
      if (/FROM qc_verdict/.test(sql)) return { rows: [] };
      if (/INSERT INTO qc_attempt/.test(sql)) {
        const [issue_id, checker_name, verdict, work_product_md5, bound_sha, observed_head, failure_class, qualifying, model, effort, idem_key] = values;
        attempts.set(idem_key, { issue_id, checker_name, verdict, work_product_md5, bound_sha, observed_head, failure_class, qualifying, model, effort });
      }
      if (/INSERT INTO qc_verdict/.test(sql)) writes.push(values);
      return { rows: [] };
    }
  };
  setTestClientFactory(() => client);
  const call = async (payload) => {
    const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body = '') { this.body = body; } };
    await relayVerdict({}, res, { agent_token: 'test-relay-secret', ...payload });
    return { ...res, json: JSON.parse(res.body) };
  };
  try {
    let result = await call({ ...validVerdict, checker: 'forged-human-name' });
    assert.equal(result.status, 201);
    assert.equal(writes[0][2], 'qc-sol-low-1', 'checker_name must come from QC agent, not CLI checker');
    result = await call({ ...validVerdict, idem_key: 'qc-verdict-wrong-md5', work_product_md5: 'a41d8cd98f00b204e9800998ecf8427e' });
    assert.equal(result.json.error, 'qc_task_work_product_mismatch');
    task = { ...task, result: qcResult({ ...validVerdict, verdict: 'FAIL', failure_class: 'implementation', qualifying: false }) };
    result = await call({ ...validVerdict, idem_key: 'qc-verdict-fail-pass' });
    assert.equal(result.json.error, 'qc_task_verdict_mismatch');
    task = null;
    result = await call({ ...validVerdict, idem_key: 'qc-verdict-cross-workspace' });
    assert.equal(result.json.error, 'completed_sol_low_qc_required');
    task = { id: 'task-1', agent_id: 'agent-1', agent_name: 'qc-sol-low-1', context: {}, result: qcResult() };
    result = await call({ ...validVerdict, checker: 'replay-forgery' });
    assert.equal(result.status, 200, 'same immutable evidence must replay despite a forged checker string');
    result = await call({ ...validVerdict, verdict: 'FAIL', failure_class: 'implementation', qualifying: false });
    assert.equal(result.json.error, 'idempotency_conflict');
  } finally {
    setTestClientFactory(null);
  }
});

test('only a named CI/CD return is eligible for a repair authorization', () => {
  assert.equal(isCicdReturn('CI/CD & Deploy', 'In Progress',
    'RETURN:In Progress — owner/repo#1 merge conflict; verify master..merge diff after rebase'), true);
  assert.equal(isCicdReturn('CI/CD & Deploy', 'In Progress', ''), false);
  assert.equal(isCicdReturn('In Review', 'In Progress',
    'RETURN:In Progress — retry'), false);
  assert.equal(isCicdReturn('CI/CD & Deploy', 'Queue',
    'RETURN:Queue — retry'), false);
  assert.equal(isCicdReturn('CI/CD & Deploy', 'In Progress',
    'RETURN:In Progress — arbitrary caller text'), false);
  assert.equal(isCicdReturn('CI/CD & Deploy', 'In Progress',
    'RETURN:In Progress — owner/repo#8 no CI runs after 20 minutes'), true);
});

test('CI/CD return authorization is consumed only by a cap bypass after admission', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: calls.length === 1 ? [{ id: 'issue-1' }] : [] };
  } };

  assert.equal(await authorizeCicdReturnCapBypass(client, 'issue-1', false), false);
  assert.equal(await authorizeCicdReturnCapBypass(client, 'issue-1', true), true);
  assert.equal(await authorizeCicdReturnCapBypass(client, 'issue-1', true), false);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /cicd_return_consumed_at/);
  assert.match(calls[0].sql, /NOT \(COALESCE\(metadata, '\{\}'::jsonb\) \? 'cicd_return_consumed_at'\)/);
  assert.deepEqual(calls[0].values, ['issue-1']);
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const admission = source.indexOf('const admission = crossStageExecutionAdmission');
  const authorization = source.indexOf('await authorizeCicdReturnCapBypass');
  assert.ok(admission >= 0 && authorization > admission,
    'the 202 cross-stage admission must precede authorization consumption');
  assert.match(source, /!issue\.metadata\?\.cicd_return_consumed_at/);
});

function scoper(overrides = {}) {
  return {
    agent_id: 'agent-b', agent_name: 'ppp-spec-sol-low-2', owner_id: 'agent-b',
    runtime_id: 'runtime-1', archived_at: null, agent_status: 'idle',
    instructions: 'Own Spec tickets only.', model: 'gpt-5.6-sol', thinking_level: 'low',
    selected_runtime_id: 'runtime-1', active_task_count: 0, max_concurrent_tasks: 1, ...overrides
  };
}

test('scoper pool selects the least-loaded eligible Sol-low owner', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    return { rows: [scoper({ agent_id: 'agent-b', active_task_count: 0 }),
      scoper({ agent_id: 'agent-a', active_task_count: 1 })] };
  } };
  const owner = await selectStageOwner(client, 'workspace-1', 'Registered', 'Spec');
  assert.equal(owner.agent_id, 'agent-b');
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(calls[1].sql, /ORDER BY active_task_count, p\.last_selected_at NULLS FIRST, p\.agent_id/);
  assert.deepEqual(calls[0].values, ['workspace-1', 'Spec']);
  assert.deepEqual(calls[1].values, ['workspace-1', 'Spec']);
});

test('configured stage pool fails closed when its members are incompatible', async () => {
  const client = { query: async (sql) => /pg_advisory_xact_lock/.test(sql)
    ? { rows: [] } : { rows: [scoper({ instructions: 'Own Queue tickets only.' })] } };
  await assert.rejects(() => selectStageOwner(client, 'workspace-1', 'Registered', 'Spec'),
    /No eligible stage owner in pool/);
});

test('configured stage pool queues on the least-loaded member when every member is at capacity', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    return { rows: [
      scoper({ agent_id: 'more-loaded', active_task_count: 3, max_concurrent_tasks: 3 }),
      scoper({ agent_id: 'least-loaded', active_task_count: 2, max_concurrent_tasks: 2,
        last_selected_at: '2026-01-01T00:00:00Z' })
    ] };
  } };
  const owner = await selectStageOwner(client, 'workspace-1', 'Registered', 'Spec');
  assert.equal(owner.agent_id, 'least-loaded');
  assert.match(calls[2].sql, /SET last_selected_at = NOW/);
});

test('empty stage pool preserves the canonical relay owner fallback', async () => {
  const calls = [];
  const fallback = { agent_id: 'canonical-agent' };
  const client = { query: async (sql) => {
    calls.push(sql);
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/FROM relay_stage_agent_pool/.test(sql)) return { rows: [] };
    return { rows: [fallback] };
  } };
  assert.equal(await selectStageOwner(client, 'workspace-1', 'Registered', 'Spec'), fallback);
  assert.match(calls[2], /FROM relay_stage_config/);
});

test('pool selection applies to Queue and rotates equal-load agents', async () => {
  const calls = [];
  const builders = [
    scoper({ agent_id: 'builder-older', agent_name: 'build-a', model: 'gpt-5.6-terra',
      instructions: 'Use this runbook when the issue is in Queue.', last_selected_at: '2026-01-01T00:00:00Z' }),
    scoper({ agent_id: 'builder-newer', agent_name: 'build-b', model: 'gpt-5.6-terra',
      instructions: 'Use this runbook when the issue is in Queue.', last_selected_at: '2026-02-01T00:00:00Z' })
  ];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/FROM relay_stage_agent_pool/.test(sql)) return { rows: builders };
    return { rows: [] };
  } };
  const selected = await selectPoolOwner(client, 'workspace-1', 'Spec', 'Queue');
  assert.equal(selected.agent_id, 'builder-older');
  assert.match(calls[1].sql, /ORDER BY active_task_count, p\.last_selected_at NULLS FIRST, p\.agent_id/);
  assert.match(calls[2].sql, /SET last_selected_at = NOW/);
  assert.deepEqual(calls[2].values, ['workspace-1', 'Queue', 'builder-older']);
});

test('pool selection chooses the older Date-valued rotation timestamp', async () => {
  const builders = [
    scoper({ agent_id: 'builder-sunday', active_task_count: 0,
      instructions: 'Own Queue tickets only.',
      last_selected_at: new Date('2026-08-30T10:00:00Z') }),
    scoper({ agent_id: 'builder-monday', active_task_count: 0,
      instructions: 'Own Queue tickets only.',
      last_selected_at: new Date('2026-08-31T09:00:00Z') })
  ];
  const client = { query: async (sql) => {
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/FROM relay_stage_agent_pool/.test(sql)) return { rows: builders };
    return { rows: [] };
  } };
  const selected = await selectPoolOwner(client, 'workspace-1', 'Spec', 'Queue');
  assert.equal(selected.agent_id, 'builder-sunday');
});

test('nine one-slot builders fill fairly and a tenth waits until capacity frees', async () => {
  const agents = Array.from({ length: 9 }, (_, index) => ({
    agent_id: `builder-${index + 1}`,
    agent_name: `gsp-build-terra-low-${String(index + 1).padStart(2, '0')}`,
    owner_id: `builder-${index + 1}`,
    agent_status: 'idle', archived_at: null, instructions: 'Queue allowed',
    max_concurrent_tasks: 1, active_task_count: 0,
    selected_runtime_id: 'runtime-1', selected_runtime_provider: 'codex',
    last_selected_at: null
  }));
  const active = new Set();
  const client = { query: async (sql, values = []) => {
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/FROM relay_stage_agent_pool p/.test(sql)) {
      return { rows: agents.map((agent) => ({ ...agent,
        active_task_count: active.has(agent.agent_id) ? 1 : 0,
        last_selected_at: active.has(agent.agent_id) ? new Date().toISOString() : null
      })) };
    }
    if (/UPDATE relay_stage_agent_pool SET last_selected_at/.test(sql)) {
      active.add(values[2]);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }};
  const selected = [];
  for (let index = 0; index < 9; index += 1) {
    selected.push((await selectPoolOwner(client, 'workspace-1', 'Spec', 'Queue')).agent_id);
  }
  assert.equal(new Set(selected).size, 9);
  assert.equal((await selectPoolOwner(client, 'workspace-1', 'Spec', 'Queue')).agent_id, selected[0]);
  active.delete(selected[0]);
  assert.equal((await selectPoolOwner(client, 'workspace-1', 'Spec', 'Queue')).agent_id, selected[0]);
});

test('twenty concurrent stage retries create one active successor task', async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl === 'postgres://test') {
    return t.skip('integration test requires a real DATABASE_URL');
  }
  const { Client } = require('pg');
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const schema = `relay_pool_retry_${Date.now()}`;
  const issueId = '11111111-1111-1111-1111-111111111111';
  const agentId = '22222222-2222-2222-2222-222222222222';
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(`CREATE TABLE agent_task_queue (
      id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text))::uuid, agent_id uuid NOT NULL,
      issue_id uuid NOT NULL, workspace_id uuid NOT NULL, status text NOT NULL,
      priority integer NOT NULL, runtime_id uuid, context jsonb NOT NULL,
      trigger_summary text, force_fresh_session boolean, originator_source text,
      trigger_evidence_kind text, completed_at timestamptz, prepare_lease_expires_at timestamptz,
      failure_reason text, created_at timestamptz NOT NULL DEFAULT now()
    ); CREATE TABLE relay_run_log (
      id serial PRIMARY KEY, issue_id uuid NOT NULL, from_stage text,
      to_stage text, agent_id uuid, task_id uuid, status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    const task = {
      issueId, workspaceId: '33333333-3333-3333-3333-333333333333',
      fromStage: 'Spec', toStage: 'Queue', agentId,
      priority: 1, runtimeId: null,
      serialize: true,
      context: JSON.stringify({ source: 'relay-advance', to_stage: 'Queue' }),
      triggerSummary: 'concurrency test'
    };
    const retry = async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`SET search_path TO ${schema}`);
        await client.query('BEGIN');
        const result = await replaceStageTask(client, task);
        await client.query('COMMIT');
        return result;
      } finally { await client.end(); }
    };
    await Promise.all(Array.from({ length: 20 }, retry));
    const { rows } = await admin.query(`SELECT count(*)::int AS count
      FROM agent_task_queue WHERE issue_id=$1::uuid AND status='queued'`, [issueId]);
    assert.equal(rows[0].count, 1);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('twenty concurrent Queue entries through both routes rotate across equal-load pool agents', async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl === 'postgres://test') {
    return t.skip('integration test requires a real DATABASE_URL');
  }
  const { Client } = require('pg');
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const schema = `relay_pool_queue_${Date.now()}`;
  const workspaceId = '33333333-3333-3333-3333-333333333333';
  const runtimeId = '44444444-4444-4444-4444-444444444444';
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(`CREATE TABLE relay_stage_pool (
      workspace_id uuid NOT NULL, stage_name text NOT NULL, enabled boolean NOT NULL
    ); CREATE TABLE relay_stage_agent_pool (
      workspace_id uuid NOT NULL, stage_name text NOT NULL, agent_id uuid NOT NULL,
      enabled boolean NOT NULL, last_selected_at timestamptz
    ); CREATE TABLE agent (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, name text NOT NULL, runtime_id uuid,
      archived_at timestamptz, status text NOT NULL, instructions text, model text,
      thinking_level text, max_concurrent_tasks integer NOT NULL, runtime_config jsonb
    ); CREATE TABLE agent_runtime (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, provider text NOT NULL, status text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    ); CREATE TABLE agent_task_queue (agent_id uuid NOT NULL, status text NOT NULL)`);
    await admin.query(`INSERT INTO relay_stage_pool (workspace_id, stage_name, enabled)
      VALUES ($1::uuid, 'Queue', true)`, [workspaceId]);
    await admin.query(`INSERT INTO agent_runtime (id, workspace_id, provider, status)
      VALUES ($1::uuid, $2::uuid, 'codex', 'online')`, [runtimeId, workspaceId]);
    for (let index = 1; index <= 20; index += 1) {
      const agentId = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
      await admin.query(`INSERT INTO agent
        (id, workspace_id, name, runtime_id, status, instructions, max_concurrent_tasks)
        VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'idle', 'read RUNBOOK_BUILD_WORKER.md', 1)`,
      [agentId, workspaceId, `builder-${index}`, runtimeId]);
      await admin.query(`INSERT INTO relay_stage_agent_pool
        (workspace_id, stage_name, agent_id, enabled) VALUES ($1::uuid, 'Queue', $2::uuid, true)`,
      [workspaceId, agentId]);
    }
    const select = async (fromStage) => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`SET search_path TO ${schema}`);
        await client.query('BEGIN');
        const selected = await selectStageOwner(client, workspaceId,
          ownerStageForTransition(fromStage, 'Queue'), 'Queue');
        await client.query('COMMIT');
        return selected.agent_id;
      } finally { await client.end(); }
    };
    const selected = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      select(index % 2 === 0 ? 'Spec' : 'In Progress')));
    assert.equal(new Set(selected).size, 20);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('Queue -> In Progress is bookkeeping and never a paid builder dispatch', () => {
  assert.equal(isBookkeepingTransition('Queue', 'In Progress'), true);
  assert.equal(isBookkeepingTransition('Spec', 'Queue'), false);
  assert.equal(isBookkeepingTransition('In Progress', 'In Review'), false);
});

test('bookkeeping handoff links the existing builder task to the QC trigger', async () => {
  const calls = [];
  const replies = [
    { rows: [{ id: 'builder-task', agent_id: 'builder-agent', status: 'completed',
      result: { output: 'Implemented the fix; work product: PR #123' } }] },
    { rows: [{ id: 'handoff-log' }] }
  ];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return replies.shift();
  } };

  const result = await recordBookkeepingHandoff(client, 'issue-1');

  assert.deepEqual(result, { taskId: 'builder-task', relayLogId: 'handoff-log' });
  assert.match(calls[0].sql, /context->>'to_stage' = 'Queue'/);
  assert.match(calls[0].sql, /status = 'completed'/);
  assert.match(calls[0].sql, /SELECT id, agent_id, status, result/);
  assert.match(calls[1].sql, /INSERT INTO relay_run_log/);
  assert.deepEqual(calls[1].values, ['issue-1', 'builder-agent', 'builder-task']);
  assert.doesNotMatch(calls.map(({ sql }) => sql).join('\n'), /INSERT INTO agent_task_queue/);
});

test('bookkeeping handoff rejects a running predecessor even if a mock returns it', async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    return { rows: [{ id: 'running-builder', agent_id: 'builder-agent', status: 'running',
      result: { output: 'work product: PR #123' } }] };
  } };

  assert.equal(await recordBookkeepingHandoff(client, 'issue-running'), null);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls.join('\n'), /INSERT INTO relay_run_log/);
});

test('bookkeeping handoff rejects a failed predecessor and missing work product', async () => {
  for (const task of [
    { id: 'failed-builder', agent_id: 'builder-agent', status: 'completed', result: { output: 'FAILED: tests' } },
    { id: 'empty-builder', agent_id: 'builder-agent', status: 'completed', result: null }
  ]) {
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      return { rows: [task] };
    } };
    assert.equal(await recordBookkeepingHandoff(client, 'issue-invalid'), null);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls.join('\n'), /INSERT INTO relay_run_log/);
  }
});

test('bookkeeping handoff replay reuses the existing correlated relay row', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length % 2 === 1
      ? { rows: [{ id: 'builder-task', agent_id: 'builder-agent', status: 'completed',
          result: { output: 'work product: PR #123' } }] }
      : { rows: [{ id: 'handoff-log' }] };
  } };

  const first = await recordBookkeepingHandoff(client, 'issue-replay');
  const second = await recordBookkeepingHandoff(client, 'issue-replay');
  assert.deepEqual(first, { taskId: 'builder-task', relayLogId: 'handoff-log' });
  assert.deepEqual(second, { taskId: 'builder-task', relayLogId: 'handoff-log' });
  assert.equal(calls.filter(({ sql }) => /INSERT INTO relay_run_log/.test(sql)).length, 2);
  assert.match(calls[1].sql, /WHERE NOT EXISTS/);
});

test('bookkeeping handoff refuses a Queue shortcut without a builder predecessor', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [] };
  } };

  assert.equal(await recordBookkeepingHandoff(client, 'issue-without-build'), null);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql, /INSERT INTO relay_run_log/);
});

test('relay dispatch gates bypass paid admission only for the bookkeeping hop', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /isExecutionStage\(to_stage\) && !parkedRelease && !bookkeepingTransition/);
  assert.match(source, /isExecutionStage\(to_stage\) && !bookkeepingTransition/);
  assert.match(source, /if \(bookkeepingTransition\) \{[\s\S]*relayLogId = bookkeepingHandoff\.relayLogId/);
});

test('transition owner selection preserves forward lanes and routes backward branches to lane owners', () => {
  assert.equal(ownerStageForTransition('Spec', 'Queue'), 'Spec');
  assert.equal(ownerStageForTransition('In Progress', 'In Review'), 'In Progress');
  assert.equal(ownerStageForTransition('In Review', 'In Progress'), 'Queue');
  assert.equal(ownerStageForTransition('Human Review', 'In Review'), 'In Progress');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'Queue'), 'Queue');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'In Progress'), 'Queue');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'Spec'), 'Registered');
  assert.equal(ownerStageForTransition('Queue', 'Spec'), 'Registered');
  assert.equal(ownerStageForTransition('Parked', 'Spec'), 'Registered');
});

function transition() {
  return {
    issueId: 'issue-1', fromStage: 'In Progress', toStage: 'In Review',
    workspaceId: 'workspace-1',
    agentId: 'agent-1', priority: 3, runtimeId: 'runtime-1',
    context: JSON.stringify({ from_stage: 'In Progress', to_stage: 'In Review' }),
    triggerSummary: 'Relay stage transition: In Progress -> In Review'
  };
}

test('stage transition supersedes stale work before enqueuing and logging its successor', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [{ id: 'task-new' }] }, { rows: [{ id: 'log-new' }] }];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return replies.shift();
  } };

  const result = await replaceStageTask(client, transition());

  assert.deepEqual(result, { taskId: 'task-new', relayLogId: 'log-new' });
  assert.match(calls[0].sql, /failure_reason = 'relay_stage_transition_superseded'/);
  assert.deepEqual(calls[0].values, ['issue-1',
    ['queued', 'dispatched', 'waiting_local_directory', 'deferred'], 'In Review']);
  assert.match(calls[0].sql, /context \? 'to_stage'/);
  assert.match(calls[0].sql, /NOT LIKE 'manual%'/);
  assert.match(calls[0].sql, /'Human Review', 'Parked', 'Rejected'/);
  assert.match(calls[1].sql, /WHERE NOT EXISTS/);
  assert.match(calls[1].sql, /agent_id, issue_id, workspace_id/);
  assert.equal(calls[1].values[2], 'workspace-1');
  assert.match(calls[2].sql, /INSERT INTO relay_run_log/);
  assert.deepEqual(calls[2].values, ['issue-1', 'In Progress', 'In Review', 'agent-1', 'task-new']);
});

test('stage transition never cancels an active paid predecessor', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [{ id: 'task-new' }] }, { rows: [{ id: 'log-new' }] }];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return replies.shift();
  } };
  await replaceStageTask(client, transition());
  assert.doesNotMatch(calls[0].sql, /status IN \([^)]*'running'/);
  assert.deepEqual(calls[0].values[1],
    ['queued', 'dispatched', 'waiting_local_directory', 'deferred']);
});

test('relay dispositions preserve already-running paid work', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const disposition = source.slice(source.indexOf('async function applyDisposition'),
    source.indexOf('// The spec agent'));
  assert.doesNotMatch(disposition, /status IN \([^)]*'running'/);
  assert.match(disposition, /status IN \('queued','dispatched','waiting_local_directory','deferred'\)/);
});

test('cross-stage admission returns a bounded defer for active predecessors', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /res\.writeHead\(202, \{ 'Content-Type': 'application\/json', 'Retry-After': '15' \}\)/);
  assert.match(source, /retry_after_seconds: 15/);
  assert.match(source, /message: 'a prior relay execution is still active/);
});

test('stage transition fails before commit when no successor task exists', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [] }, { rows: [] }];
  const client = { query: async (sql) => {
    calls.push(sql);
    return replies.shift();
  } };

  await assert.rejects(() => replaceStageTask(client, transition()),
    /relay successor task was not created/);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls.join('\n'), /INSERT INTO relay_run_log/);
});

test('builder dispatcher rejects diagnosis tasks marked no_builder', async () => {
  const { replaceStageTask } = require('./multica-bridge.cjs');
  let queries = 0;
  await assert.rejects(() => replaceStageTask({ query: async () => { queries++; } }, {
    ...transition(), context: JSON.stringify({ kind: 'parked_diagnosis', no_builder: true })
  }), /no_builder diagnosis task/);
  assert.equal(queries, 0);
});

test('an already-created matching successor is linked instead of permitting a taskless transition', async () => {
  const replies = [{ rows: [] }, { rows: [] }, { rows: [{ id: 'task-existing' }] }, { rows: [] }];
  const client = { query: async () => replies.shift() };

  const result = await replaceStageTask(client, transition());

  assert.deepEqual(result, { taskId: 'task-existing', relayLogId: null });
});

test('an already-applied transition locates its existing live successor task', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: 'task-existing' }] };
  } };

  const taskId = await existingStageTask(client, 'issue-1', 'In Review');

  assert.equal(taskId, 'task-existing');
  assert.match(calls[0].sql, /status::text = ANY/);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.deepEqual(calls[0].values, ['issue-1',
    ['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'], 'In Review']);
});

test('deploy close upgrades one oldest pending relay row', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 1 ? { rows: [{ id: 41 }, { id: 42 }] } : { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-1', 'CI/CD & Deploy', 'Done');

  assert.equal(id, 41);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ORDER BY created_at, id\s+LIMIT 1/);
});

test('deploy close inserts one completed relay row when no pending row exists', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 2 ? { rows: [{ id: 42 }] } : { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-2', 'CI/CD & Deploy', 'Done');

  assert.equal(id, 42);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /INSERT INTO relay_run_log/);
});

test('terminal close retry reuses the existing completed row', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 3 ? { rows: [{ id: 43 }] } : { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-3', 'CI/CD & Deploy', 'Done');

  assert.equal(id, 43);
  assert.equal(calls.length, 3);
  assert.match(calls[2].sql, /status = 'completed'/);
});

test('terminal already-applied replay returns its completed relay log ID', async () => {
  const client = { query: async () => ({ rows: [{ id: 44 }] }) };
  assert.equal(await completedTerminalRelayLog(client, 'issue-4', 'Cancelled'), 44);
});

test('release admission is explicit, one-use, and resets task history by time', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /parked_release_once === true/);
  assert.match(source,
    /if \(!retryEscalation && !parkedRelease && !parkedEvidenceQcRelease &&\s+!parkedDiagnosisDone && !noArtifactRescope && !allowedStages\.includes/);
  assert.match(source, /reason: "parked_release_required"/);
  assert.match(source, /created_at >= \$3/);
  assert.match(source, /created_at >= \$2/);
  assert.match(source, /'parked_release_once'.*'\{parked_release_at\}'/s);
  assert.match(source, /\["Queue", "Spec"\]\.includes\(to_stage\)/);
  assert.match(source, /if \(!bindingSpec && parkedRelease\) \{[\s\S]*?to_stage = "Spec"/);
});

test('lifetime ceiling emits a named, deadline-bound re-spec escalation', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /event: "relay_retry_escalated",\s+reason: lifetime\.reason/);
  assert.match(source, /escalation_owner: stage\.agent_name/);
  assert.match(source, /deadline: retryEscalation\.deadline/);
  assert.match(source, /action, details\)\s+VALUES \(\$1::uuid, \$2::uuid, 'system', 'relay_retry_escalated'/);
});

test('parking records a reason and hands off one Sol-low diagnosis', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /recordParkAndQueueDiagnosis/);
  assert.match(source, /disposition === 'Parked'/);
  assert.match(source, /context->>'kind', ''\) <> 'parked_diagnosis'/);
});

test('Parked dispositions create a dedicated relay audit row before diagnosis', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('UPDATE issue SET status')) {
      return { rowCount: 1, rows: [{ id: 'issue-1' }] };
    }
    if (sql.includes('INSERT INTO relay_run_log')) return { rows: [{ id: 'parked-log' }] };
    if (sql.includes('FROM agent a')) return { rows: [] };
    return { rows: [] };
  } };
  const moved = await applyDisposition(client, { id: 'issue-1', workspace_id: 'workspace-1',
    status: 'In Review', priority: 'high' }, 'Parked', 'stage_cycle_limit', {
    target_stage: 'In Progress', historical_tasks: 2
  });

  assert.equal(moved, true);
  assert.match(calls[1].sql, /parked_audit/);
  assert.deepEqual(JSON.parse(calls[1].values[2]), {
    trigger: 'stage_cycle_limit', intended_stage: 'In Progress', attempts: 2, task_count: 2
  });
});

test('every direct Parked transition is routed through the dedicated audit writer', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /if \(to_stage === "Parked" && result\.rowCount > 0\)/);
  assert.match(source, /trigger: parkedAudit\?\.trigger \|\| "relay_advance"/);
});

test('QC bounce ceiling changes hands to an exact Sol-low Spec task, never Parked', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const bounce = source.slice(source.indexOf('// A QC FAIL sends the ticket back'),
    source.indexOf('// Enforcement point: no deploy, no Done.'));
  assert.match(bounce, /reason: "qc_bounce_ceiling"/);
  assert.match(bounce, /source_task_id: sourceTaskId/);
  assert.match(bounce, /to_stage = "Spec"/);
  assert.match(bounce, /retry_escalation_source_task_required/);
  assert.doesNotMatch(bounce, /to_stage = "Parked"/);
});

test('retry escalation requires an explicit Sol-low owner and never stores null lineage', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /owner\.model !== "gpt-5\.6-sol" \|\| owner\.thinking_level !== "low"/);
  assert.doesNotMatch(source, /source_task_id: null/);
});

test('relay request maps snake-case stage into successor task input', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /replaceStageTask\(client, \{[\s\S]*toStage: to_stage,/);
  assert.doesNotMatch(source, /\n\s*toStage,\n/);
});

test('relay stage lookups bind configuration and owners to the issue workspace', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /workspace_id = \$1 AND stage_name = \$2/);
  assert.match(source, /a\.workspace_id = rsc\.workspace_id/);
  assert.match(source, /Relay owner workspace mismatch/);
  assert.match(source, /ORDER BY rsc\.workspace_id, rsc\.id/);
});

test('terminal relay transitions are logged and Parked Done remains relay-only and PASS-gated', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.equal(isTerminalStage('Done'), true);
  assert.equal(isTerminalStage('Cancelled'), true);
  assert.equal(isTerminalStage('Archived'), true);
  assert.match(source, /const parkedDiagnosisDone = issue\.status === "Parked" && to_stage === "Done"/);
  assert.match(source, /to_stage === "Done"/);
  assert.match(source, /work_product_mismatch/);
  assert.match(source, /if \(isTerminalStage\(to_stage\)\)/);
  assert.match(source, /ensureCompletedRelayLog\(\s*client, issue_id, issue\.status, to_stage/s);
});

test('Parked and In Review arrivals at Done return before task dispatch', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const terminalArrival = source.slice(source.indexOf('if (isTerminalStage(to_stage))'),
    source.indexOf('// A bundled child'));
  for (const fromStage of ['Parked', 'In Review']) {
    assert.equal(isTerminalStage('Done'), true, `${fromStage} -> Done is terminal`);
  }
  assert.match(terminalArrival, /task_id: null/);
  assert.match(terminalArrival, /relay_log_id: relayLogId/);
  assert.match(terminalArrival, /return;/);
  assert.doesNotMatch(terminalArrival, /replaceStageTask/);
});

test('terminal exits preserve the configured archiver path and require an authenticated operator marker otherwise', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const guard = source.slice(source.indexOf('const issue = issueResult.rows[0];'),
    source.indexOf('const noArtifactRescope'));
  assert.doesNotMatch(guard, /terminal_stage/);
  assert.match(source, /sourceStageResult\.rows\[0\]\?\.next_stage === to_stage/);
  assert.match(source, /operator_terminal_exit === true/);
  assert.match(source, /RELAY_OPERATOR_SECRET/);
  assert.match(source, /x-relay-operator-secret/);
  assert.match(source, /reason\.trim\(\) !== ""/);
  assert.match(source, /terminal_stage_operator_marker_required/);
  assert.match(source, /terminal_exit: \{ operator_marker: true, reason: reason\.trim\(\) \}/);
  assert.match(source, /parked_audit/);
});
