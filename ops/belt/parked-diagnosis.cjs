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

async function recordParkAndQueueDiagnosis(client, issue, evidence = {}) {
  const attempts = evidence.historical_tasks ?? evidence.rejection_count ?? evidence.attempt_count;
  const content = formatParkReason({
    reason: evidence.reason || evidence.reason_code,
    stage: issue.status,
    attempts,
    ceiling: evidence.ceiling,
    lastError: evidence.last_error || evidence.failure_reason || evidence.error,
    qcVerdict: evidence.qc_verdict
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
    `SELECT a.id, a.runtime_id
       FROM agent a
      WHERE a.workspace_id = $1 AND a.archived_at IS NULL
        AND a.name ILIKE '%sol-low%'
        AND a.status IN ('idle', 'working')
      ORDER BY (a.status = 'idle') DESC, a.updated_at ASC
      LIMIT 1`,
    [issue.workspace_id]
  );
  if (owner.rows.length === 0) {
    console.warn(JSON.stringify({ event: 'parked_diagnosis_unassigned', issue_id: issue.id,
      workspace_id: issue.workspace_id, reason: evidence.reason || evidence.reason_code }));
    return null;
  }
  const ownerRow = owner.rows[0];
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
  formatParkReason,
  parseDiagnosisOutcome,
  recordParkAndQueueDiagnosis
};
