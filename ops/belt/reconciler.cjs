"use strict";

const DISPATCHABLE = new Set(["Spec", "Queue", "In Progress", "In Review", "CI/CD & Deploy"]);
const LIVE = ["queued", "dispatched", "running", "waiting_local_directory", "deferred"];
const UNSTARTED = ["queued", "dispatched", "waiting_local_directory", "deferred"];
const ADVISORY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('v3-reconciler:' || $1::text))";

function issueCandidatesSql() {
  return `SELECT id, workspace_id, status, priority, metadata, qc_fail_count
            FROM issue WHERE status = ANY($1::text[]) AND parent_issue_id IS NULL ORDER BY id`;
}

function liveTasksSql() {
  return `SELECT id, status, context FROM agent_task_queue
            WHERE issue_id = $1::uuid AND status = ANY($2::text[]) FOR UPDATE`;
}

function ownerSql() {
  return `SELECT pool.agent_id,
                   COALESCE(own_runtime.id, online_runtime.id) AS selected_runtime_id
            FROM relay_stage_agent_pool pool
            JOIN relay_stage_pool policy ON policy.workspace_id = pool.workspace_id
             AND policy.stage_name = pool.stage_name AND policy.enabled = true
            JOIN agent a ON a.id = pool.agent_id AND a.workspace_id = pool.workspace_id
            LEFT JOIN agent_runtime own_runtime ON own_runtime.id = a.runtime_id
             AND own_runtime.provider = 'codex' AND own_runtime.status = 'online'
            LEFT JOIN LATERAL (
              SELECT ar.id FROM agent_runtime ar
               WHERE ar.workspace_id = pool.workspace_id
                 AND ar.provider = 'codex' AND ar.status = 'online'
               ORDER BY ar.updated_at DESC LIMIT 1
            ) online_runtime ON true
           WHERE pool.workspace_id = $1::uuid AND pool.stage_name = $2
             AND pool.enabled = true
             AND a.archived_at IS NULL AND a.status IN ('idle', 'working')
             AND COALESCE(own_runtime.id, online_runtime.id) IS NOT NULL
           ORDER BY pool.last_selected_at NULLS FIRST, pool.agent_id LIMIT 1`;
}

function lifetimeTasksSql() {
  return "SELECT count(*)::int AS count FROM agent_task_queue WHERE issue_id = $1::uuid AND trigger_comment_id IS NULL";
}

function stageAttemptsSql() {
  return `SELECT COALESCE(max(attempt), 0)::int AS attempt,
                 COALESCE(max(max_attempts), $3)::int AS max_attempts
            FROM agent_task_queue
           WHERE issue_id = $1::uuid AND context->>'to_stage' = $2
             AND trigger_comment_id IS NULL`;
}

function taskContext(stage) {
  return { source: "reconcile", kind: "stage_task", to_stage: stage };
}

function policyFor(options) {
  if (options.evaluate) return options.evaluate;
  return require("./transition-policy.cjs").evaluate;
}

function settingsFor(options = {}) {
  const positive = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  return {
    ...options,
    maxCreatePerCycle: positive(options.maxCreatePerCycle || process.env.RECONCILE_MAX_CREATE_PER_CYCLE, 25),
    maxCreatePerAgent: positive(options.maxCreatePerAgent || process.env.RECONCILE_MAX_CREATE_PER_AGENT, 3),
    lifetimeTaskLimit: positive(options.lifetimeTaskLimit || process.env.RECONCILE_LIFETIME_TASK_LIMIT, 6),
    defaultMaxAttempts: positive(options.defaultMaxAttempts || process.env.RECONCILE_DEFAULT_MAX_ATTEMPTS, 2),
    budget: options.budget || { created: 0, byAgent: new Map() }
  };
}

async function moveToHumanReview(client, issue, reason, options) {
  const verdict = policyFor(options)({
    from: issue.status, to: "Human Review", actor: "system", evidence: { blocker: reason }
  });
  if (!verdict?.ok) throw new Error(`reconcile policy rejected Human Review: ${reason}`);
  await client.query("UPDATE issue SET status = 'Human Review', updated_at = NOW() WHERE id = $1::uuid", [issue.id]);
  await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
     VALUES ($1::uuid, $2, 'Human Review', 'pending', jsonb_build_object('reason', $3))`,
    [issue.id, issue.status, reason]
  );
  return { action: "human_review", reason };
}

async function reconcileIssue(client, issueId, options = {}) {
  options = settingsFor(options);
  await client.query("BEGIN");
  try {
    await client.query(ADVISORY_LOCK_SQL, [issueId]);
    const locked = await client.query(
      "SELECT id, workspace_id, status, priority, metadata, qc_fail_count, parent_issue_id FROM issue WHERE id = $1::uuid FOR UPDATE",
      [issueId]
    );
    const issue = locked.rows[0];
    if (!issue || issue.parent_issue_id || !DISPATCHABLE.has(issue.status)) {
      await client.query("COMMIT");
      return { action: "skipped" };
    }
    const live = (await client.query(liveTasksSql(), [issue.id, LIVE])).rows;
    const stale = live.filter((task) => UNSTARTED.includes(task.status) && task.context?.to_stage !== issue.status);
    if (stale.length) await client.query(
      "UPDATE agent_task_queue SET status = 'cancelled', completed_at = NOW(), failure_reason = 'reconcile_stale_stage' WHERE id = ANY($1::uuid[])",
      [stale.map((task) => task.id)]
    );
    const current = live.filter((task) => task.context?.to_stage === issue.status);
    const runningStale = live.some((task) => task.status === "running" && task.context?.to_stage !== issue.status);
    if (runningStale) {
      await client.query("COMMIT");
      return { action: "skipped", reason: "stale_stage_running" };
    }
    if (current.length > 1) {
      const result = await moveToHumanReview(client, issue, "duplicate_live_task", options);
      await client.query("COMMIT");
      return result;
    }
    if (current.length === 1) {
      await client.query("COMMIT");
      return { action: "already_live", taskId: current[0].id };
    }
    if (options.isRetryExhausted?.(issue)) {
      const result = await moveToHumanReview(client, issue, "retry_exhausted", options);
      await client.query("COMMIT");
      return result;
    }
    const lifetime = await client.query(lifetimeTasksSql(), [issue.id]);
    if (Number(lifetime.rows[0]?.count || 0) >= options.lifetimeTaskLimit) {
      const result = await moveToHumanReview(client, issue, "lifetime_task_limit", options);
      await client.query("COMMIT");
      return result;
    }
    const stageAttempts = await client.query(stageAttemptsSql(), [issue.id, issue.status, options.defaultMaxAttempts]);
    const attempt = Number(stageAttempts.rows[0]?.attempt || 0);
    const maxAttempts = Number(stageAttempts.rows[0]?.max_attempts || options.defaultMaxAttempts);
    if (attempt >= maxAttempts) {
      const result = await moveToHumanReview(client, issue, "stage_attempt_limit", options);
      await client.query("COMMIT");
      return result;
    }
    const owner = (await client.query(ownerSql(), [issue.workspace_id, issue.status])).rows[0];
    if (!owner) {
      const result = await moveToHumanReview(client, issue, "unresolved_owner", options);
      await client.query("COMMIT");
      return result;
    }
    if (options.budget.created >= options.maxCreatePerCycle ||
        (options.budget.byAgent.get(owner.agent_id) || 0) >= options.maxCreatePerAgent) {
      await client.query("COMMIT");
      return { action: "skipped", reason: "creation_budget" };
    }
    const context = taskContext(issue.status);
    const created = await client.query(
      `INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, workspace_id, status, priority, context,
          trigger_summary, originator_source, attempt, max_attempts)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'queued', $5, $6::jsonb, $7, 'reconcile', $8, $9
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_task_queue active
           WHERE active.issue_id = $3::uuid AND active.status = ANY($10::text[])
             AND active.context->>'to_stage' = $11
        )
       ON CONFLICT DO NOTHING RETURNING id`,
      [owner.agent_id, owner.selected_runtime_id, issue.id, issue.workspace_id, issue.priority === "urgent" ? 1 : 0,
        JSON.stringify(context), `reconcile ${issue.status}`, attempt + 1, maxAttempts, LIVE, issue.status]
    );
    if (created.rows.length === 0) {
      await client.query("COMMIT");
      return { action: "already_live" };
    }
    const taskId = created.rows[0].id;
    await client.query(
      `UPDATE relay_stage_agent_pool SET last_selected_at = NOW()
        WHERE workspace_id = $1::uuid AND stage_name = $2 AND agent_id = $3::uuid`,
      [issue.workspace_id, issue.status, owner.agent_id]
    );
    await client.query(
      `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, agent_id, task_id, status)
       VALUES ($1::uuid, $2, $2, $3::uuid, $4::uuid, 'pending')`,
      [issue.id, issue.status, owner.agent_id, taskId]
    );
    await client.query("COMMIT");
    options.budget.created += 1;
    options.budget.byAgent.set(owner.agent_id, (options.budget.byAgent.get(owner.agent_id) || 0) + 1);
    return { action: "created", taskId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function reconcileCycle(client, options = {}) {
  const settings = settingsFor({ ...options, budget: { created: 0, byAgent: new Map() } });
  const rows = (await client.query(issueCandidatesSql(), [[...DISPATCHABLE]])).rows;
  const counts = { created: 0, skipped: 0, humanReview: 0, alreadyLive: 0 };
  for (const issue of rows) {
    const result = await reconcileIssue(client, issue.id, settings);
    if (result.action === "created") counts.created += 1;
    else if (result.action === "human_review") counts.humanReview += 1;
    else if (result.action === "already_live") counts.alreadyLive += 1;
    else counts.skipped += 1;
  }
  return counts;
}

module.exports = { ADVISORY_LOCK_SQL, DISPATCHABLE, LIVE, issueCandidatesSql, liveTasksSql, ownerSql, lifetimeTasksSql, stageAttemptsSql, taskContext, reconcileIssue, reconcileCycle };
