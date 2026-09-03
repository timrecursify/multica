const { QC_LANE_EFFORT, isQcLane, qcLaneModelsSqlArray } = require('./qc-lane.cjs');

// The single deploy-authorising QC evidence contract.
const STRICT_CURRENT_PASS_SQL = `SELECT v.verdict, v.work_product_md5, qa.bound_sha
  FROM qc_verdict v JOIN qc_attempt qa ON qa.issue_id=v.issue_id
    AND qa.work_product_md5=v.work_product_md5 AND qa.verdict=v.verdict AND qa.qualifying=true
    AND qa.bound_sha ~* '^[0-9a-f]{40}$' AND lower(qa.bound_sha)=lower(qa.observed_head)
  JOIN agent_task_queue t ON t.issue_id=qa.issue_id
    AND t.id::text=substring(qa.notes FROM 'relay_task_id=([0-9a-f-]{36})') AND t.status='completed'
  JOIN agent a ON a.id=t.agent_id
  WHERE v.issue_id=$1 AND v.verdict='PASS' AND t.agent_id=v.checker_id
    AND a.model = ANY($2::text[]) AND a.thinking_level = $3::text
    AND (SELECT count(*) FROM qc_attempt qax WHERE qax.issue_id=v.issue_id
      AND qax.work_product_md5=v.work_product_md5 AND qax.verdict=v.verdict AND qax.qualifying=true
      AND qax.bound_sha ~* '^[0-9a-f]{40}$' AND lower(qax.bound_sha)=lower(qax.observed_head))=1
  ORDER BY v.created_at DESC, v.id DESC LIMIT 1`;
async function currentStrictPass(db, issueId) {
  const result = await db.query(STRICT_CURRENT_PASS_SQL, [issueId, qcLaneModelsSqlArray(), QC_LANE_EFFORT]);
  return result.rows[0] || null;
}
function strictEvidenceFromRow(row, verdictMd5) {
  const bound = String(row.qc_attempt_bound_sha || '').toLowerCase();
  const observed = String(row.qc_attempt_observed_sha || '').toLowerCase();
  const md5 = String(row.qc_attempt_work_product_md5 || '').toLowerCase();
  const evidenceAgentId = row.qc_attempt_evidence_agent_id || row.task_agent_id;
  const ok = row.qc_attempt_verdict === 'PASS' && row.qc_attempt_qualifying === true &&
    isQcLane(row.qc_attempt_evidence_agent_model, row.qc_attempt_evidence_agent_effort) &&
    row.qc_verdict_checker_id === evidenceAgentId &&
    /^[0-9a-f]{40}$/.test(bound) && bound === observed && md5 === verdictMd5;
  return ok ? { ok: true, boundSha: bound,
    evidenceTaskId: row.qc_attempt_evidence_task_id || row.task_id }
    : { ok: false, reason: 'qc_attempt_binding_required' };
}
module.exports = { STRICT_CURRENT_PASS_SQL, currentStrictPass, strictEvidenceFromRow };
