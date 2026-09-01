// Shared parking contract. Parking is a bounded diagnosis hand-off, never a
// second paid build attempt. The database helpers stay small and transaction
// friendly so both bridge entry points apply the same rules.

const PARK_REASON_MARKER = '<!-- multica-park-reason -->';
const PARK_BLOCKER_MARKER = '<!-- multica-park-diagnosis-blocker -->';
const PARK_DIAGNOSIS_KIND = 'parked_diagnosis';
const DIAGNOSIS_OUTCOMES = new Set([
  'fixable', 'already_fixed', 'duplicate', 'genuinely_blocked'
]);
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const PRIORITY = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

function formatParkReason({ reason, stage, attempts, ceiling, lastError, qcVerdict }) {
  const detail = lastError || qcVerdict || 'unrecoverable_after_bounded_lookup';
  return [
    PARK_REASON_MARKER,
    '**Parked diagnosis required**',
    `reason_code: ${reason || 'unknown'}`,
    `failed_stage: ${stage || 'unknown'}`,
    `attempts: ${attempts == null ? 'unknown' : attempts}/${ceiling == null ? 'unknown' : ceiling}`,
    `last_error_or_qc_verdict: ${String(detail).slice(0, 1000)}`,
    'causal_lookup: bounded task history and QC verdict evidence',
    'A Sol-low diagnosis must classify this as fixable, already_fixed, duplicate, or genuinely_blocked.'
  ].join('\n');
}

function diagnosisContext({ reason, stage, attempts, ceiling }) {
  return {
    kind: PARK_DIAGNOSIS_KIND,
    to_stage: 'Parked',
    from_stage: stage || null,
    reason_code: reason || 'unknown',
    attempts: attempts == null ? null : Number(attempts),
    ceiling: ceiling == null ? null : Number(ceiling),
    no_builder: true,
    outcomes: [...DIAGNOSIS_OUTCOMES]
  };
}

function parseDiagnosisOutcome(text) {
  const match = String(text || '').match(/(?:outcome|diagnosis)\s*[:=]\s*(fixable|already_fixed|duplicate|genuinely_blocked)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function diagnosisEvidence(text) {
  const match = String(text || '').match(/(?:evidence|runtime_evidence)\s*[:=]\s*([^\n]+)/i);
  return match && match[1].trim() ? match[1].trim() : null;
}

function parseRuntimeEvidenceReference(value) {
  const match = String(value || '').trim().match(/^(task|qc|activity):([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i);
  return match ? { kind: match[1].toLowerCase(), id: match[2].toLowerCase() } : null;
}

function isConcreteRuntimeEvidence(value) {
  const evidence = String(value || '').trim();
  return evidence.length >= 8 && (
    /(?:^|\s)[\w./-]+:\d+(?:\s|$)/.test(evidence) ||
    /\b(?:sha|commit|status|http|output|command)\s*[=:]/i.test(evidence)
  );
}

function namedBlocker(text) {
  const match = String(text || '').match(/blocker\s*[:=]\s*([^\n]+)/i);
  return match && match[1].trim() ? match[1].trim() : null;
}

function isSolLowDiagnosisAgent(agent) {
  const cfg = agent && agent.runtime_config && typeof agent.runtime_config === 'object'
    ? agent.runtime_config : {};
  const name = String((agent && agent.name) || '').toLowerCase();
  const model = String((agent && agent.model) || '').toLowerCase();
  const instructions = String((agent && agent.instructions) || '').toLowerCase();
  const configuredModel = cfg.model == null ? model : String(cfg.model).toLowerCase();
  const configuredEffort = cfg.reasoning_effort == null
    ? (/(?:^|-)sol-low(?:-|$)/.test(name) ? 'low' : '')
    : String(cfg.reasoning_effort).toLowerCase();
  const role = [name, cfg.role, cfg.lane, cfg.agent_role]
    .filter(Boolean).join(' ').toLowerCase();
  const solLowModel = model === 'gpt-5.6-sol' && configuredModel === 'gpt-5.6-sol' &&
    configuredEffort === 'low';
  // Parked diagnosis is deliberately a dedicated seat. Existing QC/spec seats
  // are scoped to In Review/Spec and reject Parked tasks, which silently burns
  // diagnosis calls without producing an actionable outcome.
  const dedicatedParkedSeat = /^(?:gsp|ppp)-parked-diagnosis-sol-low(?:-|$)/.test(name);
  const permitsParked = /\bparked\b/.test(instructions) &&
    /diagnos/.test(instructions) &&
    /(?:fixable|already[_ ]fixed|duplicate|genuinely[_ ]blocked)/.test(instructions);
  return dedicatedParkedSeat && solLowModel && /diagnos/.test(role) && permitsParked &&
    cfg.parked_diagnosis !== false;
}

function isBuilderDispatchAllowed(context) {
  return !(context && context.no_builder === true);
}

// Prefer the original Spec owner when that owner is also explicitly admitted
// to the Sol-low diagnosis lane. Attribution must never widen authority: an
// ordinary scoper cannot receive a diagnosis task.
function selectDiagnosisOwner(rows) {
  const eligible = (rows || []).filter(isSolLowDiagnosisAgent);
  return eligible.find((row) => row.is_original_scoper === true) || eligible[0] || null;
}

// Convert a validated diagnosis into one bounded state action. Keeping this
// mapping explicit prevents a completed diagnosis from being treated as an
// ordinary QC result (or from falling through to a builder dispatch).
function diagnosisOutcomeAction({ outcome, evidenceVerified = false, duplicateIssueId = null,
  blocker = null, missingOutcome = false, invalidAlreadyFixed = false,
  invalidDuplicate = false, hasBindingSpec = true }) {
  if (outcome === 'fixable') {
    return { action: 'release', status: 'Parked', nextStage: hasBindingSpec ? 'Queue' : 'Spec' };
  }
  if (outcome === 'already_fixed' && evidenceVerified) return { action: 'close', status: 'Done' };
  if (outcome === 'duplicate' && duplicateIssueId) {
    return { action: 'close', status: 'Cancelled', duplicateIssueId };
  }
  const holdReason = missingOutcome ? 'Sol-low diagnosis response omitted an explicit outcome'
    : invalidAlreadyFixed ? 'runtime_evidence_unverified'
      : invalidDuplicate ? 'duplicate response did not resolve a same-workspace duplicate_of target'
        : outcome === 'genuinely_blocked' && !blocker
          ? 'genuinely_blocked response omitted a named blocker'
          : `Sol-low diagnosis: ${blocker || outcome}`;
  return { action: 'hold', status: 'Parked', blocker: holdReason };
}

async function verifyRuntimeEvidence(client, issueId, evidence, excludeTaskId = null) {
  const reference = parseRuntimeEvidenceReference(evidence);
  if (!reference) return false;
  const { kind, id } = reference;
  const queries = {
    task: `SELECT 1 FROM agent_task_queue t JOIN issue i ON i.id = t.issue_id
             WHERE t.id = $1 AND t.issue_id = $2 AND t.id IS DISTINCT FROM $3
               AND t.context->>'kind' IS DISTINCT FROM 'parked_diagnosis'
               AND t.status = 'completed'`,
    qc: `SELECT 1 FROM qc_verdict v WHERE v.id = $1 AND v.issue_id = $2`,
    activity: `SELECT 1 FROM activity_log WHERE id = $1 AND issue_id = $2`
  };
  const values = kind === 'task' ? [id, issueId, excludeTaskId] : [id, issueId];
  const result = await client.query(queries[kind], values);
  return result.rowCount > 0;
}

async function currentPassWorkProductMD5(client, issueId) {
  const result = await client.query(
    `SELECT verdict, work_product_md5 FROM qc_verdict
      WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1`, [issueId]);
  const verdict = result.rows[0];
  if (verdict?.verdict !== 'PASS' || typeof verdict.work_product_md5 !== 'string' ||
      !verdict.work_product_md5.trim()) return null;
  return verdict.work_product_md5;
}

async function recordParkAndQueueDiagnosis(client, issue, evidence = {}) {
  const attempts = evidence.historical_tasks ?? evidence.rejection_count ?? evidence.attempt_count;
  const history = await client.query(
    `SELECT failure_reason, error FROM agent_task_queue
      WHERE issue_id = $1
        AND status IN ('failed', 'cancelled', 'completed')
        AND (failure_reason IS NOT NULL OR error IS NOT NULL)
        AND failure_reason IS DISTINCT FROM 'relay_stage_transition_superseded'
      ORDER BY created_at DESC LIMIT 1`, [issue.id]);
  const verdict = await client.query(
    `SELECT verdict FROM qc_verdict WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1`, [issue.id]);
  const lastError = evidence.last_error || evidence.failure_reason || evidence.error ||
    history.rows[0]?.failure_reason || history.rows[0]?.error;
  const qcVerdict = evidence.qc_verdict || verdict.rows[0]?.verdict;
  const content = formatParkReason({
    reason: evidence.reason || evidence.reason_code,
    stage: issue.status,
    attempts,
    ceiling: evidence.ceiling,
    lastError,
    qcVerdict
  });
  // System comments use the documented zero UUID (migration 107). The marker
  // makes a repeated rejection idempotent without hiding the first diagnosis.
  if (!evidence.skip_reason_comment) await client.query(
    `INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type)
     SELECT $1::uuid, $2::uuid, 'system', $3::uuid, $4::text, 'system'
      WHERE NOT EXISTS (
        SELECT 1 FROM comment WHERE issue_id = $1::uuid AND content LIKE $5::text
          AND content LIKE $6::text
      )`,
    [issue.id, issue.workspace_id, ZERO_UUID, content, `${PARK_REASON_MARKER}%`,
      `%reason_code: ${evidence.reason || evidence.reason_code || 'unknown'}%`]
  );

  const owner = await client.query(
    `SELECT a.id, a.name, a.model, a.runtime_config, a.runtime_id, a.instructions,
             EXISTS (
               SELECT 1 FROM agent_task_queue prior
                WHERE prior.issue_id = $2::uuid AND prior.agent_id = a.id
                  AND prior.context->>'to_stage' = 'Spec'
             ) AS is_original_scoper
       FROM agent a
      WHERE a.workspace_id = $1 AND a.archived_at IS NULL
        AND a.status IN ('idle', 'working')
        AND (a.name ILIKE '%sol%' OR a.model ILIKE '%gpt-5.5%'
             OR a.runtime_config::text ILIKE '%sol%')
      ORDER BY (a.status = 'idle') DESC, a.updated_at ASC
      LIMIT 20`,
    [issue.workspace_id, issue.id]
  );
  const ownerRow = selectDiagnosisOwner(owner.rows);
  if (!ownerRow) {
    const blocker = 'no_sol_low_diagnosis_owner';
    await client.query(
      `UPDATE issue
          SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object('parked_blocker', $2::text),
              updated_at = NOW()
        WHERE id = $1::uuid AND status = 'Parked'`,
      [issue.id, blocker]
    );
    await client.query(
      `INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type)
       SELECT $1::uuid, $2::uuid, 'system', $3::uuid, $4::text, 'system'
        WHERE NOT EXISTS (
          SELECT 1 FROM comment
           WHERE issue_id = $1::uuid AND content LIKE $5::text
        )`,
      [issue.id, issue.workspace_id, ZERO_UUID,
        `${PARK_BLOCKER_MARKER}\nparked_diagnosis_blocker: ${blocker}\n` +
        'No eligible Sol-low diagnosis owner is active in this workspace; operator assignment is required.',
        `${PARK_BLOCKER_MARKER}%`]
    );
    console.warn(JSON.stringify({ event: 'parked_diagnosis_unassigned', issue_id: issue.id,
      workspace_id: issue.workspace_id, blocker }));
    return null;
  }
  // A previous no-owner hold is temporary once a qualifying diagnosis seat is
  // available. Keep genuinely-blocked tickets protected by their completed
  // diagnosis task, not by a stale metadata flag.
  await client.query(
    `UPDATE issue
        SET metadata = COALESCE(metadata, '{}'::jsonb) - 'parked_blocker',
            updated_at = NOW()
      WHERE id = $1::uuid AND status = 'Parked'`, [issue.id]);
  const context = {
    ...diagnosisContext({ reason: evidence.reason || evidence.reason_code,
      stage: issue.status, attempts, ceiling: evidence.ceiling }),
    owner_selection: ownerRow.is_original_scoper === true ? 'original_scoper' : 'dedicated_sol_low'
  };
  if (evidence.evidence_correction_retry === true) {
    context.evidence_correction_retry = true;
    context.retry_of_task_id = evidence.retry_of_task_id;
  }
  const task = await client.query(
    `INSERT INTO agent_task_queue (
       agent_id, issue_id, workspace_id, status, priority, runtime_id, context,
       trigger_summary, force_fresh_session, originator_source,
       trigger_evidence_kind, attempt, max_attempts
     )
     SELECT $1::uuid, $2::uuid, $3::uuid, 'queued', $4::integer, $5::uuid, $6::jsonb,
            $8::text, TRUE,
            'unattributed', 'relay_disposition', 1, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_task_queue
        WHERE issue_id = $2::uuid AND context->>'kind' = $7::text
          AND (
            (COALESCE($9::boolean, FALSE) = FALSE
              AND COALESCE(LOWER(status), '') NOT IN ('failed', 'cancelled'))
            OR (COALESCE($9::boolean, FALSE) = TRUE
              AND context->>'evidence_correction_retry' = 'true')
          )
      )
      ON CONFLICT DO NOTHING
      RETURNING id`,
    [ownerRow.id, issue.id, issue.workspace_id,
      PRIORITY[String(issue.priority || 'none').toLowerCase()] ?? (Number(issue.priority) || 0),
      ownerRow.runtime_id,
      JSON.stringify(context), PARK_DIAGNOSIS_KIND,
      evidence.evidence_correction_retry === true
        ? 'Sol-low parked-ticket evidence correction diagnosis; use runtime_evidence: task:<uuid>, qc:<uuid>, or activity:<uuid>.'
        : 'Sol-low parked-ticket diagnosis (no builder dispatch)',
      evidence.evidence_correction_retry === true]
  );
  return task.rows[0]?.id || null;
}

module.exports = {
  DIAGNOSIS_OUTCOMES,
  PARK_DIAGNOSIS_KIND,
  PARK_BLOCKER_MARKER,
  PARK_REASON_MARKER,
  diagnosisContext,
  diagnosisEvidence,
  formatParkReason,
  isBuilderDispatchAllowed,
  diagnosisOutcomeAction,
  isConcreteRuntimeEvidence,
  isSolLowDiagnosisAgent,
  selectDiagnosisOwner,
  currentPassWorkProductMD5,
  namedBlocker,
  parseDiagnosisOutcome,
  parseRuntimeEvidenceReference,
  recordParkAndQueueDiagnosis,
  verifyRuntimeEvidence
};
