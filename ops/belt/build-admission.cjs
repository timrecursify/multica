// Queue is scoping/triage and can never be implementation evidence.
const BUILD_STAGES = new Set(["In Progress"]);

async function buildTaskAdmission(client, { issueId, toStage, locked = false }) {
  if (!BUILD_STAGES.has(toStage)) return { admit: true };
  if (!locked) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('build'))", [issueId]);
  }
  const products = (await client.query(
    `SELECT kind, consuming_stage, repository, branch, pr_number, head_sha,
            acceptance_evidence->>'task_id' AS producer_task_id
       FROM issue_work_product
      WHERE issue_id=$1::uuid AND status='active' FOR UPDATE`, [issueId])).rows;
  if (products.length !== 1) return { admit: true };
  const product = products[0];
  const valid = product.kind === 'implementation' && product.consuming_stage === 'In Review' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(product.repository || '')) &&
    typeof product.branch === 'string' && product.branch.length > 0 &&
    Number.isInteger(Number(product.pr_number)) && Number(product.pr_number) > 0 &&
    /^[0-9a-f]{40}$/.test(String(product.head_sha || '')) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(product.producer_task_id || ''));
  if (!valid) return { admit: true, reason: 'invalid_implementation_work_product' };
  const prior = (await client.query(
    `SELECT id, completed_at FROM agent_task_queue
      WHERE id=$1::uuid AND issue_id=$2::uuid AND status='completed'
        AND context->>'to_stage'='In Progress'`, [product.producer_task_id, issueId])).rows[0];
  if (!prior) return { admit: true, reason: 'missing_producer_task' };
  if (!prior) return { admit: true };
  const failure = (await client.query(
    `SELECT id FROM qc_effective_verdict WHERE issue_id=$1::uuid AND verdict='FAIL'
       AND failure_class='implementation' AND qualifying IS TRUE AND created_at>$2::timestamptz
     ORDER BY created_at DESC, id DESC LIMIT 1`, [issueId, prior.completed_at])).rows[0];
  if (!failure) {
    // A builder can report a work-product pointer and still fail before a
    // qualifying implementation QC failure is recorded. Historical and
    // non-qualifying verdicts do not review this stage attempt. Admit its
    // correlated FAILED outcome as a bounded retry; reconcileIssue has already
    // enforced the lifetime task limit before reaching this check.
    const unreviewedFailure = (await client.query(
      `SELECT outcome.task_id FROM issue_stage_outcome outcome
        WHERE outcome.issue_id=$1::uuid AND outcome.stage=$2::text
          AND outcome.outcome='FAILED' AND outcome.blocked_on IS DISTINCT FROM 'human'
          AND outcome.task_id=$3::uuid
        LIMIT 1`, [issueId, toStage, prior.id])).rows[0];
    if (unreviewedFailure) return { admit: true, retryOfTaskId: prior.id };
    return { admit: false, reuseTaskId: prior.id, reason: "completed_build_work_product" };
  }
  const successor = (await client.query(
    `SELECT id FROM agent_task_queue WHERE issue_id=$1::uuid AND retry_of_task_id=$2::uuid
       AND context->>'qc_attempt_id'=$3::text ORDER BY created_at DESC, id DESC LIMIT 1`,
    [issueId, prior.id, String(failure.id)])).rows[0];
  if (successor) return { admit: false, reuseTaskId: successor.id, reason: "implementation_retry_exists" };
  return { admit: true, retryOfTaskId: prior.id, qcAttemptId: String(failure.id) };
}

module.exports = { BUILD_STAGES, buildTaskAdmission };
