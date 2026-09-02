// The single deploy-authorising QC evidence contract.
const STRICT_CURRENT_PASS_SQL = `SELECT v.verdict, v.work_product_md5, qa.bound_sha
  FROM qc_verdict v JOIN qc_attempt qa ON qa.issue_id=v.issue_id
    AND qa.work_product_md5=v.work_product_md5 AND qa.verdict=v.verdict AND qa.qualifying=true
    AND qa.bound_sha ~* '^[0-9a-f]{40}$' AND lower(qa.bound_sha)=lower(qa.observed_head)
  JOIN agent_task_queue t ON t.issue_id=qa.issue_id
    AND t.id::text=substring(qa.notes FROM 'relay_task_id=([0-9a-f-]{36})') AND t.status='completed'
  JOIN agent a ON a.id=t.agent_id
  WHERE v.issue_id=$1 AND v.verdict='PASS' AND t.agent_id=v.checker_id
    AND a.model='gpt-5.6-sol' AND a.thinking_level='low'
    AND (SELECT count(*) FROM qc_attempt qax WHERE qax.issue_id=v.issue_id
      AND qax.work_product_md5=v.work_product_md5 AND qax.verdict=v.verdict AND qax.qualifying=true
      AND qax.bound_sha ~* '^[0-9a-f]{40}$' AND lower(qax.bound_sha)=lower(qax.observed_head))=1
  ORDER BY v.created_at DESC, v.id DESC LIMIT 1`;
async function currentStrictPass(db, issueId) {
  const result = await db.query(STRICT_CURRENT_PASS_SQL, [issueId]);
  return result.rows[0] || null;
}
module.exports = { STRICT_CURRENT_PASS_SQL, currentStrictPass };
