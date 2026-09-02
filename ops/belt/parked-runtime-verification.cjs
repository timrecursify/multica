// Deterministic, no-model verification lane. A distinct task row reserves and
// records this work; diagnosis tasks are never reused as verification state.
const { PARK_DIAGNOSIS_KIND, parseDiagnosisOutcome, verifyRuntimeEvidence, currentPassWorkProductMD5 } = require('./parked-diagnosis.cjs');
const PARK_RUNTIME_VERIFICATION_KIND = 'parked_runtime_verification';
const DEFAULT_BATCH = 25;

async function firstDurableEvidence(client, issueId) {
  const rows = await client.query(`SELECT ref FROM (
    SELECT 'task:' || t.id::text AS ref, 1 AS rank, t.completed_at AS created_at FROM agent_task_queue t
      WHERE t.issue_id = $1::uuid AND t.status = 'completed' AND t.context->>'kind' IS DISTINCT FROM $2::text
        AND t.context->>'kind' IS DISTINCT FROM $3::text
    UNION ALL SELECT 'qc:' || v.id::text, 2, v.created_at FROM qc_verdict v WHERE v.issue_id = $1::uuid
    UNION ALL SELECT 'activity:' || a.id::text, 3, a.created_at FROM activity_log a WHERE a.issue_id = $1::uuid
  ) evidence ORDER BY rank, created_at DESC NULLS LAST, ref LIMIT 1`, [issueId, PARK_DIAGNOSIS_KIND, PARK_RUNTIME_VERIFICATION_KIND]);
  return rows.rows[0]?.ref || null;
}

async function processParkedRuntimeVerifications({ verificationPool, relayPost, workspaceId, batch = DEFAULT_BATCH, issueIds = null } = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const client = await verificationPool.connect(); let writes = 0;
  try {
    const candidates = await client.query(`SELECT i.id FROM issue i WHERE i.workspace_id = $1::uuid AND i.status = 'Parked'
      AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified' AND ($2::uuid[] IS NULL OR i.id = ANY($2::uuid[]))
      AND NOT EXISTS (SELECT 1 FROM agent_task_queue v WHERE v.issue_id = i.id AND v.context->>'kind' = $3::text AND v.context->>'verification_processed' = 'true')
      AND EXISTS (SELECT 1 FROM agent_task_queue d WHERE d.issue_id = i.id AND d.status = 'completed' AND d.context->>'kind' = $4::text AND lower(COALESCE(d.result::text, '')) ~ 'already_fixed')
      ORDER BY i.updated_at ASC, i.id ASC LIMIT $5`, [workspaceId, issueIds, PARK_RUNTIME_VERIFICATION_KIND, PARK_DIAGNOSIS_KIND, batch]);
    for (const row of candidates.rows) {
      await client.query('BEGIN');
      try {
        const locked = await client.query(`SELECT id FROM issue WHERE id = $1::uuid AND workspace_id = $2::uuid AND status = 'Parked'
          AND metadata->>'parked_blocker' = 'runtime_evidence_unverified' FOR UPDATE SKIP LOCKED`, [row.id, workspaceId]);
        if (!locked.rowCount) { await client.query('ROLLBACK'); continue; }
        const diagnosis = await client.query(`SELECT id, result, agent_id FROM agent_task_queue WHERE issue_id = $1::uuid AND workspace_id = $2::uuid
          AND status = 'completed' AND context->>'kind' = $3::text ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1`, [row.id, workspaceId, PARK_DIAGNOSIS_KIND]);
        if (parseDiagnosisOutcome(JSON.stringify(diagnosis.rows[0]?.result || '')) !== 'already_fixed') { await client.query('ROLLBACK'); continue; }
        const reserved = await client.query(`INSERT INTO agent_task_queue (agent_id, issue_id, workspace_id, status, priority, context, trigger_summary)
          SELECT $1::uuid, $2::uuid, $3::uuid, 'running', 0, jsonb_build_object('kind', $4::text, 'no_builder', true, 'no_diagnosis', true, 'verification_requested', true, 'verification_processed', false), 'deterministic parked runtime verification'
          WHERE NOT EXISTS (SELECT 1 FROM agent_task_queue v WHERE v.issue_id = $2::uuid AND v.context->>'kind' = $4::text AND v.context->>'verification_processed' <> 'true') RETURNING id`, [diagnosis.rows[0].agent_id, row.id, workspaceId, PARK_RUNTIME_VERIFICATION_KIND]);
        const taskId = reserved.rows[0]?.id; if (!taskId) { await client.query('ROLLBACK'); continue; }
        const evidence = await firstDurableEvidence(client, row.id);
        const verified = evidence && await verifyRuntimeEvidence(client, row.id, evidence, taskId);
        if (!verified) {
          await client.query(`UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('parked_blocker', 'runtime_evidence_unverified_no_durable_reference'), updated_at = NOW() WHERE id = $1::uuid`, [row.id]);
          await client.query(`UPDATE agent_task_queue SET status = 'completed', completed_at = NOW(), context = context || jsonb_build_object('verification_processed', true, 'verification_result', 'unverified') WHERE id = $1::uuid`, [taskId]);
          await client.query('COMMIT'); writes++; continue;
        }
        const md5 = await currentPassWorkProductMD5(client, row.id);
        await client.query(`UPDATE issue SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'parked_blocker') || jsonb_build_object('runtime_evidence_verified', $2::text, 'parked_release_once', true), updated_at = NOW() WHERE id = $1::uuid`, [row.id, evidence]);
        await client.query(`UPDATE agent_task_queue SET status = 'completed', completed_at = NOW(), context = context || jsonb_build_object('verification_processed', true, 'verification_evidence', $2::text, 'verification_result', 'verified') WHERE id = $1::uuid`, [taskId, evidence]);
        await client.query('COMMIT'); writes++;
        try { const response = await relayPost({ issue_id: row.id, to_stage: md5 ? 'Done' : 'In Review', ...(md5 ? { current_work_product_md5: md5 } : { reason: `runtime_evidence_verified:${evidence}` }) }); if (!response.ok) throw new Error(`relay rejected verified evidence: ${response.status}`); }
        catch (error) { console.error(`[parked-runtime-verification] ${row.id}: ${error.message}`); }
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    return { writes };
  } finally { client.release(); }
}
module.exports = { DEFAULT_BATCH, PARK_RUNTIME_VERIFICATION_KIND, firstDurableEvidence, processParkedRuntimeVerifications };
