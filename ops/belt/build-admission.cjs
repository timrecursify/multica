const BUILD_ADMISSION_STAGES = new Set(["Queue", "In Progress"]);
const BUILD_PRODUCT_STAGES = new Set(["In Progress"]);

async function buildTaskAdmission(client, { issueId, toStage, locked = false }) {
  if (!BUILD_ADMISSION_STAGES.has(toStage)) return { admit: true };
  // Queue work scopes the implementation; it never produces the artifact that
  // can satisfy review evidence. Keep dispatch admission separate from the
  // stages whose completed tasks may own a canonical work product.
  if (!BUILD_PRODUCT_STAGES.has(toStage)) return { admit: true };
  if (!locked) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('build'))", [issueId]);
  }
  const prior = (await client.query(
    `SELECT task.id, task.completed_at
       FROM issue_work_product product
       JOIN agent_task_queue task
         ON task.id::text = product.acceptance_evidence->>'task_id'
        AND task.issue_id = product.issue_id
      WHERE product.issue_id=$1::uuid AND product.status='active'
        AND product.consuming_stage='In Review'
        AND product.acceptance_evidence <> '{}'::jsonb
        AND task.status='completed'
        AND task.context->>'to_stage'=ANY($2::text[])
        AND (
          (product.kind='implementation' AND product.repository IS NOT NULL
            AND product.branch IS NOT NULL AND product.pr_number IS NOT NULL
            AND product.head_sha ~ '^[0-9a-f]{40}$')
          OR (product.kind IN ('no_change', 'operational')
            AND product.acceptance_evidence->>'verified'='true')
        )
      ORDER BY task.completed_at DESC NULLS LAST, task.created_at DESC, task.id DESC LIMIT 1`,
    [issueId, [...BUILD_PRODUCT_STAGES]])).rows[0];
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

module.exports = { BUILD_ADMISSION_STAGES, BUILD_PRODUCT_STAGES, buildTaskAdmission };
