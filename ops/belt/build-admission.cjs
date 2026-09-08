const BUILD_STAGES = new Set(["In Progress"]);

async function buildTaskAdmission(client, { issueId, toStage, locked = false }) {
  if (!BUILD_STAGES.has(toStage)) return { admit: true };
  if (!locked) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('build'))", [issueId]);
  }
  // The work-product row is the sole evidence of an implementation.  Its
  // producer is recorded in acceptance evidence and must be a completed,
  // same-issue In Progress task; free-text task results are never consulted.
  const prior = (await client.query(
    `SELECT task.id, task.completed_at
       FROM issue_work_product wp
       JOIN agent_task_queue task
         ON task.id = NULLIF(wp.acceptance_evidence->>'source_task_id', '')::uuid
        AND task.issue_id = wp.issue_id
      WHERE wp.issue_id=$1::uuid AND wp.status='active'
        AND wp.kind='implementation' AND wp.consuming_stage='In Review'
        AND wp.repository IS NOT NULL AND wp.branch IS NOT NULL
        AND wp.pr_number IS NOT NULL AND wp.head_sha ~ '^[0-9a-f]{40}$'
        AND jsonb_typeof(wp.acceptance_evidence)='object'
        AND wp.acceptance_evidence->>'source_task_id' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND task.status='completed' AND task.context->>'to_stage'='In Progress'
      GROUP BY task.id, task.completed_at
      HAVING count(*) = 1
      ORDER BY task.completed_at DESC NULLS LAST, task.id DESC LIMIT 1`,
    [issueId])).rows[0];
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
