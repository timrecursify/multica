// Deterministic, no-model verification lane for already-fixed Parked work.
// It never queues an agent task: durable issue-scoped evidence is the only
// input and a failed lookup deliberately leaves the ticket Parked.
const { PARK_DIAGNOSIS_KIND, parseDiagnosisOutcome, verifyRuntimeEvidence,
  currentPassWorkProductMD5 } = require('./parked-diagnosis.cjs');

const PARK_RUNTIME_VERIFICATION_KIND = 'parked_runtime_verification';
const DEFAULT_BATCH = 25;

async function firstDurableEvidence(client, issueId) {
  const rows = await client.query(
    `SELECT ref FROM (
       SELECT 'task:' || t.id::text AS ref, 1 AS rank, t.completed_at AS created_at
         FROM agent_task_queue t WHERE t.issue_id = $1::uuid AND t.status = 'completed'
           AND t.context->>'kind' IS DISTINCT FROM $2::text
       UNION ALL SELECT 'qc:' || v.id::text, 2, v.created_at
         FROM qc_verdict v WHERE v.issue_id = $1::uuid
       UNION ALL SELECT 'activity:' || a.id::text, 3, a.created_at
         FROM activity_log a WHERE a.issue_id = $1::uuid
     ) evidence ORDER BY rank, created_at DESC NULLS LAST, ref LIMIT 1`,
    [issueId, PARK_DIAGNOSIS_KIND]);
  return rows.rows[0]?.ref || null;
}

async function processParkedRuntimeVerifications({ verificationPool, relayPost, batch = DEFAULT_BATCH } = {}) {
  const client = await verificationPool.connect();
  try {
    const candidates = await client.query(
      `SELECT i.id, i.workspace_id FROM issue i
       WHERE i.status = 'Parked' AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified'
         AND NOT EXISTS (SELECT 1 FROM agent_task_queue v WHERE v.issue_id = i.id
           AND v.context->>'verification_kind' = $1::text AND v.context->>'verification_processed' = 'true')
         AND EXISTS (SELECT 1 FROM agent_task_queue d WHERE d.issue_id = i.id AND d.status = 'completed'
           AND d.context->>'kind' = $2::text AND lower(COALESCE(d.result::text, '')) ~ 'already_fixed')
       ORDER BY i.updated_at ASC, i.id ASC LIMIT $3`, [PARK_RUNTIME_VERIFICATION_KIND, PARK_DIAGNOSIS_KIND, batch]);
    for (const candidate of candidates.rows) {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT i.id, i.workspace_id FROM issue i WHERE i.id = $1::uuid AND i.workspace_id = $2::uuid
           AND i.status = 'Parked' AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified'
           FOR UPDATE SKIP LOCKED`, [candidate.id, candidate.workspace_id]);
      if (!locked.rowCount) { await client.query('ROLLBACK'); continue; }
      const diagnosis = await client.query(
        `SELECT id, result FROM agent_task_queue WHERE issue_id = $1::uuid AND status = 'completed'
          AND context->>'kind' = $2::text ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1`,
        [candidate.id, PARK_DIAGNOSIS_KIND]);
      if (parseDiagnosisOutcome(JSON.stringify(diagnosis.rows[0]?.result || '')) !== 'already_fixed') {
        await client.query('ROLLBACK'); continue;
      }
      const evidence = await firstDurableEvidence(client, candidate.id);
      const verified = evidence && await verifyRuntimeEvidence(client, candidate.id, evidence,
        diagnosis.rows[0]?.id);
      if (!verified) {
        await client.query(`UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) ||
          jsonb_build_object('parked_blocker', 'runtime_evidence_unverified_no_durable_reference'), updated_at = NOW()
          WHERE id = $1::uuid`, [candidate.id]);
        await client.query('COMMIT'); continue;
      }
      const md5 = await currentPassWorkProductMD5(client, candidate.id);
      await client.query(`UPDATE issue SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'parked_blocker') ||
          jsonb_build_object('runtime_evidence_verified', $2::text, 'parked_release_once', true), updated_at = NOW()
          WHERE id = $1::uuid`, [candidate.id, evidence]);
      await client.query(`UPDATE agent_task_queue SET context = COALESCE(context, '{}'::jsonb) ||
          jsonb_build_object('verification_kind', $2::text, 'verification_processed', true, 'verification_evidence', $3::text)
          WHERE id = $1::uuid`, [diagnosis.rows[0].id, PARK_RUNTIME_VERIFICATION_KIND, evidence]);
      await client.query('COMMIT');
      try {
        const response = await relayPost({ issue_id: candidate.id, to_stage: md5 ? 'Done' : 'In Review',
          ...(md5 ? { current_work_product_md5: md5 } : { reason: `runtime_evidence_verified:${evidence}` }) });
        if (!response.ok) throw new Error(`relay rejected verified evidence: ${response.status}`);
      } catch (error) {
        // Preserve the verified reference but make the relay hand-off replayable.
        await client.query(`UPDATE agent_task_queue SET context = COALESCE(context, '{}'::jsonb) -
          'verification_processed' WHERE id = $1::uuid`, [diagnosis.rows[0].id]);
        console.error(`[parked-runtime-verification] ${candidate.id}: ${error.message}`);
      }
    }
  } finally { client.release(); }
}

module.exports = { DEFAULT_BATCH, PARK_RUNTIME_VERIFICATION_KIND, firstDurableEvidence, processParkedRuntimeVerifications };
