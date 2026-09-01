// Shared parking contract. Parking is a bounded diagnosis hand-off, never a
// second paid build attempt. The database helpers stay small and transaction
// friendly so both bridge entry points apply the same rules.

const PARK_REASON_MARKER = '<!-- multica-park-reason -->';
const PARK_DIAGNOSIS_KIND = 'parked_diagnosis';
const DIAGNOSIS_OUTCOMES = new Set([
  'fixable', 'already_fixed', 'duplicate', 'genuinely_blocked'
]);
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const PRIORITY = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

function formatParkReason({ reason, stage, attempts, ceiling, lastError, qcVerdict }) {
  const detail = lastError || qcVerdict || 'not recoverable';
  return [
    PARK_REASON_MARKER,
    '**Parked diagnosis required**',
    `reason_code: ${reason || 'unknown'}`,
    `failed_stage: ${stage || 'unknown'}`,
    `attempts: ${attempts == null ? 'unknown' : attempts}/${ceiling == null ? 'unknown' : ceiling}`,
    `last_error_or_qc_verdict: ${String(detail).slice(0, 1000)}`,
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
  const model = String((agent && agent.model) || '').toLowerCase();
  const configuredModel = cfg.model == null ? model : String(cfg.model).toLowerCase();
  const role = [agent && agent.name, cfg.role, cfg.lane, cfg.agent_role]
    .filter(Boolean).join(' ').toLowerCase();
  const solLowModel = model === 'gpt-5.6-sol' && configuredModel === 'gpt-5.6-sol' &&
    cfg.reasoning_effort === 'low';
  return solLowModel && /qc|scop|diagnos/.test(role) &&
    cfg.parked_diagnosis !== false;
}

function isBuilderDispatchAllowed(context) {
  return !(context && context.no_builder === true);
}

async function verifyRuntimeEvidence(client, issueId, evidence, excludeTaskId = null) {
  const text = String(evidence || '').trim();
  const match = text.match(/\b(task|qc|activity):([0-9a-f-]{8,})\b/i);
  if (!match) return false;
  const kind = match[1].toLowerCase();
  const id = match[2];
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
  await client.query(
    `INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type)
     SELECT $1, $2, 'system', $3, $4, 'system'
      WHERE NOT EXISTS (
        SELECT 1 FROM comment WHERE issue_id = $1 AND content LIKE $5
          AND content LIKE $6
      )`,
    [issue.id, issue.workspace_id, ZERO_UUID, content, `${PARK_REASON_MARKER}%`,
      `%reason_code: ${evidence.reason || evidence.reason_code || 'unknown'}%`]
  );

  const owner = await client.query(
    `SELECT a.id, a.name, a.model, a.runtime_config, a.runtime_id
       FROM agent a
      WHERE a.workspace_id = $1 AND a.archived_at IS NULL
        AND a.status IN ('idle', 'working')
        AND (a.name ILIKE '%sol%' OR a.model ILIKE '%gpt-5.5%'
             OR a.runtime_config::text ILIKE '%sol%')
      ORDER BY (a.status = 'idle') DESC, a.updated_at ASC
      LIMIT 20`,
    [issue.workspace_id]
  );
  const ownerRow = owner.rows.find(isSolLowDiagnosisAgent);
  if (!ownerRow) {
    console.warn(JSON.stringify({ event: 'parked_diagnosis_unassigned', issue_id: issue.id,
      workspace_id: issue.workspace_id, reason: evidence.reason || evidence.reason_code }));
    return null;
  }
  const context = diagnosisContext({ reason: evidence.reason || evidence.reason_code,
    stage: issue.status, attempts, ceiling: evidence.ceiling });
  const task = await client.query(
    `INSERT INTO agent_task_queue (
       agent_id, issue_id, status, priority, runtime_id, context,
       trigger_summary, force_fresh_session, originator_source,
       trigger_evidence_kind, attempt, max_attempts
     )
     SELECT $1, $2, 'queued', $3, $4, $5::jsonb,
            'Sol-low parked-ticket diagnosis (no builder dispatch)', TRUE,
            'unattributed', 'relay_disposition', 1, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_task_queue
         WHERE issue_id = $2 AND context->>'kind' = $6
           AND status IN ('queued', 'dispatched', 'running', 'completed')
      )
      ON CONFLICT DO NOTHING
      RETURNING id`,
    [ownerRow.id, issue.id,
      PRIORITY[String(issue.priority || 'none').toLowerCase()] ?? (Number(issue.priority) || 0),
      ownerRow.runtime_id,
      JSON.stringify(context), PARK_DIAGNOSIS_KIND]
  );
  return task.rows[0]?.id || null;
}

module.exports = {
  DIAGNOSIS_OUTCOMES,
  PARK_DIAGNOSIS_KIND,
  PARK_REASON_MARKER,
  diagnosisContext,
  diagnosisEvidence,
  formatParkReason,
  isBuilderDispatchAllowed,
  isConcreteRuntimeEvidence,
  isSolLowDiagnosisAgent,
  namedBlocker,
  parseDiagnosisOutcome,
  recordParkAndQueueDiagnosis,
  verifyRuntimeEvidence
};
