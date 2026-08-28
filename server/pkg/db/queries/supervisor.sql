-- name: ClaimBuildRunForTask :one
-- Mint exactly one immutable run identity for an already-dispatched reasonix
-- issue task.  The agent join rejects a missing/null registration, the open
-- issue budget is mandatory, and the partial unique index rejects a second
-- live run for the same issue.
WITH candidate AS (
    SELECT atq.id AS task_id, atq.issue_id, atq.agent_id, a.workspace_id
    FROM agent_task_queue atq
    JOIN agent a ON a.id = atq.agent_id
    WHERE atq.id = sqlc.arg('task_id')
      AND atq.agent_id = sqlc.arg('agent_id')
      AND atq.status = 'dispatched'
      AND atq.issue_id IS NOT NULL
      AND atq.build_run_id IS NULL
), budget AS (
    SELECT b.id
    FROM build_budget b
    JOIN candidate c
      ON b.scope = 'issue' AND b.scope_ref = c.issue_id::text
    WHERE b.state = 'open'
    LIMIT 1
), next_number AS (
    SELECT COALESCE(MAX(r.run_number), 0) + 1 AS run_number
    FROM build_run r
    JOIN candidate c ON c.issue_id = r.issue_id
)
INSERT INTO build_run (
    workspace_id, issue_id, task_id, agent_id, lane, run_number,
    lease_holder, lease_expires_at, budget_id, deadline_at, detail
)
SELECT
    c.workspace_id, c.issue_id, c.task_id, c.agent_id, 'reasonix', n.run_number,
    sqlc.arg('lease_holder'),
    now() + make_interval(secs => sqlc.arg('lease_ttl_secs')::double precision),
    b.id,
    now() + make_interval(secs => sqlc.arg('deadline_secs')::double precision),
    jsonb_build_object('runtime_id', sqlc.arg('runtime_id')::uuid)
FROM candidate c
CROSS JOIN budget b
CROSS JOIN next_number n
RETURNING *;

-- name: BindAgentTaskBuildRun :one
UPDATE agent_task_queue
SET build_run_id = sqlc.arg('build_run_id')
WHERE id = sqlc.arg('task_id')
  AND agent_id = sqlc.arg('agent_id')
  AND status = 'dispatched'
  AND build_run_id IS NULL
RETURNING *;

-- name: GetBuildRunForTask :one
SELECT * FROM build_run
WHERE task_id = $1
ORDER BY claimed_at DESC
LIMIT 1;

-- name: ExtendFencedAgentTaskLease :one
-- The build-run heartbeat remains live after StartAgentTask clears the short
-- prepare lease.  A stale fence updates zero rows and therefore cannot revive
-- or mutate the restarted runtime's successor.
WITH heartbeat AS (
    UPDATE build_run AS run
    SET heartbeat_at = now(),
        lease_expires_at = now() + make_interval(secs => sqlc.arg('lease_secs')::double precision)
    WHERE run.id = sqlc.arg('build_run_id')
      AND run.fence = sqlc.arg('fence')
      AND run.task_id = sqlc.arg('task_id')
      AND run.state = 'running'
      AND run.deadline_at > now()
    RETURNING run.id
)
UPDATE agent_task_queue atq
SET prepare_lease_expires_at = CASE
        WHEN atq.started_at IS NULL
            THEN now() + make_interval(secs => sqlc.arg('lease_secs')::double precision)
        ELSE atq.prepare_lease_expires_at
    END
WHERE atq.id = sqlc.arg('task_id')
  AND atq.runtime_id = sqlc.arg('runtime_id')
  AND atq.build_run_id = (SELECT id FROM heartbeat)
  AND atq.status IN ('dispatched', 'waiting_local_directory', 'running')
RETURNING atq.*;

-- name: CompleteFencedAgentTask :one
WITH terminal AS (
    UPDATE build_run AS run
    SET state = 'completed', ended_at = now(), terminal_reason = 'ok',
        detail = detail || sqlc.arg('run_detail')::jsonb
    WHERE run.id = sqlc.arg('build_run_id')
      AND run.fence = sqlc.arg('fence')
      AND run.task_id = sqlc.arg('task_id')
      AND run.state = 'running'
    RETURNING run.id
)
UPDATE agent_task_queue atq
SET status = 'completed', completed_at = now(), result = sqlc.arg('result'),
    session_id = CASE WHEN sqlc.arg('session_rollout_missing') THEN NULL ELSE sqlc.narg('session_id') END,
    work_dir = sqlc.narg('work_dir'),
    session_rollout_missing = sqlc.arg('session_rollout_missing'),
    retired_session_id = COALESCE(sqlc.narg('retired_session_id'), retired_session_id),
    prepare_lease_expires_at = NULL
WHERE atq.id = sqlc.arg('task_id')
  AND atq.status = 'running'
  AND atq.build_run_id = (SELECT id FROM terminal)
RETURNING atq.*;

-- name: FailFencedAgentTask :one
WITH terminal AS (
    UPDATE build_run AS run
    SET state = sqlc.arg('run_state'), ended_at = now(),
        terminal_reason = sqlc.arg('terminal_reason'),
        detail = detail || sqlc.arg('run_detail')::jsonb
    WHERE run.id = sqlc.arg('build_run_id')
      AND run.fence = sqlc.arg('fence')
      AND run.task_id = sqlc.arg('task_id')
      AND run.state = 'running'
    RETURNING run.id
)
UPDATE agent_task_queue atq
SET status = 'failed', completed_at = now(), error = sqlc.arg('error'),
    failure_reason = sqlc.arg('failure_reason'),
    session_id = CASE WHEN sqlc.arg('session_rollout_missing') THEN NULL ELSE COALESCE(sqlc.narg('session_id'), session_id) END,
    work_dir = COALESCE(sqlc.narg('work_dir'), work_dir),
    session_rollout_missing = sqlc.arg('session_rollout_missing'),
    retired_session_id = COALESCE(sqlc.narg('retired_session_id'), retired_session_id),
    prepare_lease_expires_at = NULL
WHERE atq.id = sqlc.arg('task_id')
  AND atq.status IN ('dispatched', 'running', 'waiting_local_directory')
  AND atq.build_run_id = (SELECT id FROM terminal)
RETURNING atq.*;

-- name: GetIssueBuildPRState :one
WITH linked AS (
    SELECT pr.state
    FROM github_pull_request pr
    JOIN issue_pull_request ipr ON ipr.pull_request_id = pr.id
    WHERE ipr.issue_id = $1 AND NOT ipr.reference_only
    UNION ALL
    SELECT pr.state
    FROM vcs_pull_request pr
    JOIN issue_vcs_pull_request ipr ON ipr.pull_request_id = pr.id
    WHERE ipr.issue_id = $1 AND NOT ipr.reference_only
)
SELECT
    COUNT(*) FILTER (WHERE state IN ('open', 'draft'))::bigint AS open_count,
    COUNT(*) FILTER (WHERE state = 'merged')::bigint AS merged_count
FROM linked;

-- name: ReconcileIssueForExistingPR :one
-- Open work belongs in review; fully merged work is done.  Terminal issue
-- states remain terminal and an in-review issue is never demoted to Queue.
UPDATE issue
SET status = CASE
        WHEN status IN ('done', 'cancelled') THEN status
        WHEN sqlc.arg('merged')::boolean THEN 'done'
        ELSE 'in_review'
    END,
    updated_at = now()
WHERE id = sqlc.arg('issue_id')
RETURNING *;

-- name: CompleteReconciledBuildRunAndTask :one
WITH terminal AS (
    UPDATE build_run AS run
    SET state = 'completed', ended_at = now(), terminal_reason = 'ok',
        detail = detail || sqlc.arg('run_detail')::jsonb
    WHERE run.id = sqlc.arg('build_run_id')
      AND run.fence = sqlc.arg('fence')
      AND run.task_id = sqlc.arg('task_id')
      AND run.state = 'running'
    RETURNING run.id
)
UPDATE agent_task_queue atq
SET status = 'completed', completed_at = now(),
    result = sqlc.arg('result'), prepare_lease_expires_at = NULL
WHERE atq.id = sqlc.arg('task_id')
  AND atq.status = 'dispatched'
  AND atq.build_run_id = (SELECT id FROM terminal)
RETURNING atq.*;

-- name: IncrementIssueBuildAttempts :one
UPDATE issue
SET metadata = jsonb_set(
        metadata,
        '{build_attempts}',
        to_jsonb(
            CASE
                WHEN COALESCE(metadata->>'build_attempts', '') ~ '^[0-9]+$'
                    THEN (metadata->>'build_attempts')::integer + 1
                ELSE 1
            END
        ),
        true
    ),
    updated_at = now()
WHERE id = $1
RETURNING metadata;

-- name: MoveIssueToHumanReviewUnlessInReview :one
-- The source vocabulary uses blocked; PPP's canonical-status trigger maps it
-- to Human Review.  Never demote an issue that already reached in_review.
UPDATE issue
SET status = CASE WHEN status = 'in_review' THEN status ELSE 'blocked' END,
    updated_at = now()
WHERE id = $1
RETURNING status;

-- name: MarkBuildRetryPolicy :one
UPDATE agent_task_queue
SET force_fresh_session = TRUE,
    escalation_for_task_id = CASE
        WHEN sqlc.arg('stronger_runtime')::boolean THEN sqlc.arg('parent_task_id')
        ELSE NULL
    END,
    context = context || jsonb_build_object(
        'wp4_retry_kind',
        CASE WHEN sqlc.arg('stronger_runtime')::boolean THEN 'stronger_runtime' ELSE 'fresh' END
    )
WHERE id = sqlc.arg('task_id')
RETURNING *;
