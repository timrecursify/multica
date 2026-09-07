const BUILD_STAGES = new Set(["Queue", "In Progress"]);

async function buildTaskAdmission(client, { issueId, toStage, locked = false }) {
  if (!BUILD_STAGES.has(toStage)) return { admit: true };
  if (!locked) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('build'))", [issueId]);
  }
  const prior = (await client.query(
    `SELECT task.id, task.completed_at FROM agent_task_queue task
      WHERE task.issue_id=$1::uuid AND task.status='completed'
        AND task.context->>'to_stage'=ANY($2::text[])
        AND COALESCE(to_jsonb(task)->>'result', '')
          ~* '(https?://[^[:space:]]+/pull/[0-9]+|bound[ _-]?sha|[a-f0-9]{40})'
      ORDER BY task.completed_at DESC NULLS LAST, task.created_at DESC, task.id DESC LIMIT 1`,
    [issueId, [...BUILD_STAGES]])).rows[0];
  if (!prior) return { admit: true };
  const failure = (await client.query(
    `SELECT id FROM qc_effective_verdict WHERE issue_id=$1::uuid AND verdict='FAIL'
       AND failure_class='implementation' AND qualifying IS TRUE AND created_at>$2::timestamptz
     ORDER BY created_at DESC, id DESC LIMIT 1`, [issueId, prior.completed_at])).rows[0];
  if (!failure) {
    // A builder can report a work-product pointer and still fail before QC is
    // able to write any verdict.  Reusing that completion can only replay the
    // same failed handoff forever.  Admit its correlated FAILED stage outcome
    // as a retry; reconcileIssue has already enforced the lifetime task limit
    // before reaching this admission check.
    const unreviewedFailure = (await client.query(
      `SELECT outcome.task_id FROM issue_stage_outcome outcome
        WHERE outcome.issue_id=$1::uuid AND outcome.stage=$2::text
          AND outcome.outcome='FAILED' AND outcome.blocked_on IS DISTINCT FROM 'human'
          AND outcome.task_id=$3::uuid
          AND NOT EXISTS (
            SELECT 1 FROM qc_effective_verdict verdict WHERE verdict.issue_id=$1::uuid)
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
