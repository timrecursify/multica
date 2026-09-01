const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { qcCompletionAdvance } = require('./multica-relay-advance-daemon.cjs');

const QC_ROW = {
  task_id: '11111111-1111-4111-8111-111111111111',
  to_stage: 'In Review',
  next_stage: 'CI/CD & Deploy',
  task_status: 'completed',
  task_agent_id: 'qc-agent',
  task_agent_model: 'gpt-5.6-sol',
  task_agent_effort: 'low',
  task_started_at: '2026-09-01T19:05:39Z',
  task_completed_at: '2026-09-01T19:08:18Z',
  task_result: { output: 'QC PASS exact SHA c909401ef7a4a438348eb5ceda33839211721524' },
  qc_verdict_checker_id: 'qc-agent',
  qc_verdict: 'PASS',
  qc_verdict_work_product_md5: '76becea4ab970644b7a21220665a1619',
  qc_verdict_notes: 'Native Sol-low QC PASS; observed SHA c909401ef7a4a438348eb5ceda33839211721524',
  qc_verdict_created_at: '2026-09-01T19:07:38Z'
};

test('completed legacy Sol-low PASS replays its exact SHA and artifact MD5', () => {
  assert.deepEqual(qcCompletionAdvance(QC_ROW), {
    ok: true,
    workProductMd5: '76becea4ab970644b7a21220665a1619',
    boundSha: 'c909401ef7a4a438348eb5ceda33839211721524',
    evidenceTaskId: '11111111-1111-4111-8111-111111111111'
  });
});

test('legacy PASS binds to the completed Sol-low task that recorded the verdict', () => {
  const row = { ...QC_ROW,
    task_id: '22222222-2222-4222-8222-222222222222',
    task_started_at: '2026-09-01T19:20:00Z',
    task_completed_at: '2026-09-01T19:25:00Z',
    task_result: { output: 'later QC did not record a verdict' },
    qc_evidence_tasks: [{
      task_id: QC_ROW.task_id,
      task_status: 'completed',
      task_agent_id: 'qc-agent',
      task_agent_model: 'gpt-5.6-sol',
      task_agent_effort: 'low',
      task_started_at: QC_ROW.task_started_at,
      task_completed_at: QC_ROW.task_completed_at,
      task_result: QC_ROW.task_result
    }]
  };
  assert.equal(qcCompletionAdvance(row).evidenceTaskId, QC_ROW.task_id);
});

test('strict relay attempt must bind PASS to one observed SHA and artifact MD5', () => {
  const row = { ...QC_ROW,
    qc_attempt_verdict: 'PASS',
    qc_attempt_work_product_md5: QC_ROW.qc_verdict_work_product_md5,
    qc_attempt_bound_sha: 'c909401ef7a4a438348eb5ceda33839211721524',
    qc_attempt_observed_sha: 'c909401ef7a4a438348eb5ceda33839211721524',
    qc_attempt_qualifying: true,
    qc_attempt_model: 'gpt-5.6-sol',
    qc_attempt_effort: 'low',
    qc_attempt_evidence_task_id: '33333333-3333-4333-8333-333333333333',
    qc_attempt_evidence_agent_id: 'qc-agent'
  };
  assert.equal(qcCompletionAdvance(row).ok, true);
  assert.equal(qcCompletionAdvance(row).evidenceTaskId,
    '33333333-3333-4333-8333-333333333333');
  assert.equal(qcCompletionAdvance({ ...row,
    qc_attempt_observed_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...row,
    qc_verdict_checker_id: 'different-agent' }).ok, false);
});

test('post-completion QC replay fails closed on stale, mismatched, or non-low evidence', () => {
  assert.equal(qcCompletionAdvance({ ...QC_ROW,
    qc_verdict_created_at: '2026-09-01T18:00:00Z' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...QC_ROW,
    qc_verdict_notes: 'QC PASS SHA aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...QC_ROW,
    qc_verdict_work_product_md5: 'not-an-md5' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...QC_ROW, task_agent_effort: 'high' }).ok, false);
  assert.equal(qcCompletionAdvance({ ...QC_ROW, qc_verdict: 'FAIL' }).ok, false);
});

test('non-QC gated stages remain manual', () => {
  assert.deepEqual(qcCompletionAdvance({ ...QC_ROW, next_stage: 'Done' }),
    { ok: false, reason: 'manual_gated_stage' });
});

test('relay daemon scopes stage configuration to each issue workspace', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /rsc\.workspace_id = i\.workspace_id/);
  assert.match(source, /a\.workspace_id = rsc\.workspace_id/);
});

test('routing recovery hold logs bounded routing details', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /event: 'relay_requeue_held'/);
  assert.match(source, /actual_model: preflight\.model/);
  assert.match(source, /expected_effort: preflight\.expected_effort/);
});

test('Registered discovery covers every configured workspace', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /EXISTS \(SELECT 1 FROM relay_stage_config rsc/);
  assert.doesNotMatch(source, /i\.workspace_id = \$2/);
  assert.doesNotMatch(source, /\) < \$3/);
  assert.match(source, /client\.query\(query, \['Registered', STAGE_CYCLE_LIMIT\]\)/);
});

test('all parity dispositions use relay authority rather than direct issue status writes', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.doesNotMatch(source, /UPDATE issue SET status/);
  assert.match(source, /postToRelay\(\{ issue_id: row\.issue_id, to_stage: 'Human Review'/);
  assert.match(source, /reason: 'payment_required_402'/);
});

test('relay advancement admits task results before creating a successor', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /require\('\.\.\/relay-completion-admission\.cjs'\)/);
  assert.match(source, /atq\.result AS task_result/);
  assert.match(source, /completionAdmission\(row\.task_result/);
  assert.match(source, /requestRetryEscalation\(row, completion\.reason\)/);
  assert.match(source, /retry_escalation_task_id: taskId/);
  assert.match(source, /retry_escalation_stage: triggerStage/);
  assert.match(source, /markRelayLogFailedById\(client, row\.log_id\)/);
  assert.match(source, /relay_source_task_id: row\.task_id/);
});

test('retry ceilings leave the daemon through relay authority instead of direct status writes', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const requeue = source.slice(source.indexOf('async function requeueStrandedTasks'),
    source.indexOf('function diagnosisText'));
  assert.match(requeue, /requestRetryEscalation\(row, cycle\.reason\)/);
  assert.match(requeue, /requestRetryEscalation\(row, lifetime\.reason\)/);
  assert.match(requeue,
    /row\.metadata\?\.parked_release_at \|\|\s+row\.metadata\?\.retry_escalation_at \|\| null/);
  assert.doesNotMatch(requeue, /applyDisposition\(client, row, cycle\.disposition/);
  assert.doesNotMatch(requeue, /applyDisposition\(client, row, lifetime\.disposition/);
});

test('stranded-task recovery does not retry a semantically blocked completion', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /t\.result AS dead_task_result/);
  assert.match(source, /row\.dead_task_status === 'completed'/);
  assert.match(source, /completed predecessor failed completion admission/);
});

test('Registered recovery applies the same completion gate', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const recovery = source.slice(source.indexOf('async function recoveryAdvanceTasks'),
    source.indexOf('function postToRelay'));
  assert.match(recovery, /atq\.result AS task_result/);
  assert.match(recovery, /completionAdmission\(row\.task_result/);
  assert.match(recovery, /reason=task_not_completed/);
});

test('runtime-evidence recovery is one-shot, typed, and stays on relay authority', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const diagnosis = source.slice(source.indexOf('async function processParkedDiagnoses'),
    source.indexOf('function startDaemon'));
  assert.match(diagnosis, /t\.context->>'evidence_correction_retry' = 'true'/);
  assert.match(diagnosis, /i\.metadata->>'parked_blocker' = 'runtime_evidence_unverified'/);
  assert.match(diagnosis, /runtime_evidence_recovery_consumed/);
  assert.match(diagnosis, /t\.id = \$1::uuid/);
  assert.match(diagnosis, /t\.context->>'kind' = \$2::text/);
  assert.match(diagnosis, /i\.workspace_id = \$3::uuid/);
  assert.match(diagnosis, /postToRelay\(\{ issue_id: task\.issue_id, to_stage: nextStage/);
  assert.match(diagnosis, /const needsQC = outcome === 'already_fixed' && evidenceVerified && !completionMD5/);
  assert.match(diagnosis, /runtime_evidence_verified:\$\{evidence\}/);
  assert.match(diagnosis, /WHERE id = \$1::uuid/);
  assert.doesNotMatch(diagnosis, /UPDATE issue SET status/);
});

test('evidence recovery replays only an unchanged 409 release rejection', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /!response\.ok && response\.status === 409/);
  assert.match(source, /context - 'diagnosis_processed'\s*- 'runtime_evidence_recovery_v2_consumed'/);
});

test('canonical evidence rejects a parked-diagnosis citation', () => {
  const contract = fs.readFileSync(require.resolve('../parked-diagnosis.cjs'), 'utf8');
  assert.match(contract, /t\.context->>'kind' IS DISTINCT FROM 'parked_diagnosis'/);
  assert.match(contract, /t\.id = \$1::uuid AND t\.issue_id = \$2::uuid/);
});

test('quota pause flips are timestamped and stale unbudgeted pauses self-clear', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /'quota_paused_at', to_jsonb\(NOW\(\)\)/);
  const pause = source.slice(source.indexOf('async function pauseQuotaLane'),
    source.indexOf('function logQuotaPauseFlip'));
  assert.doesNotMatch(pause, /console\.warn/);
  assert.match(source, /if \(quotaPause\) \{\s+logQuotaPauseFlip/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /b\.scope = 'workspace'/);
  assert.match(source, /b\.state = 'closed'/);
  assert.match(source, /b\.spent_ticks \+ b\.reserved_ticks >= b\.limit_ticks/);
  assert.match(source, /committedFlips\.push\(\{ agent_name: agent\.agent_name, timestamp, paused: false \}\)/);
  assert.match(source, /await client\.query\('COMMIT'\);\s+for \(const flip of committedFlips\) onFlip\(flip\)/);
  assert.match(source, /setInterval\(reconcileQuotaPauses, 60000\)/);
});
