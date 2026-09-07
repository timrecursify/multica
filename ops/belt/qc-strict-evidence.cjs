const { QC_LANE_EFFORT, isQcLane, qcLaneModelsSqlArray } = require('./qc-lane.cjs');

// The single deploy-authorising QC evidence contract.
const STRICT_CURRENT_PASS_SQL = `SELECT e.verdict, e.work_product_md5, e.bound_sha
  FROM qc_effective_verdict e
  JOIN agent_task_queue t ON t.issue_id=e.issue_id
    AND t.id=e.evidence_task_id AND t.status='completed'
  JOIN agent a ON a.id=t.agent_id
  WHERE e.issue_id=$1 AND e.verdict='PASS' AND e.qualifying=true
    AND e.bound_sha ~* '^[0-9a-f]{40}$' AND lower(e.bound_sha)=lower(e.observed_head)
    AND t.agent_id=e.checker_id
    AND a.model = ANY($2::text[]) AND a.thinking_level = $3::text
  LIMIT 1`;
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
