"use strict";
const { stageEligibility } = require("./stage-outcome.cjs");

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
                 COALESCE(max(max_attempts), $3::int)::int AS max_attempts
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
    maxCreatePerCycle: (() => { const value = options.maxCreatePerCycle ?? process.env.RECONCILE_MAX_CREATE_PER_CYCLE; return Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 25; })(),
    maxCreatePerAgent: positive(options.maxCreatePerAgent ?? process.env.RECONCILE_MAX_CREATE_PER_AGENT, 3),
    lifetimeTaskLimit: positive(options.lifetimeTaskLimit ?? process.env.RECONCILE_LIFETIME_TASK_LIMIT, 6),
    defaultMaxAttempts: positive(options.defaultMaxAttempts ?? process.env.RECONCILE_DEFAULT_MAX_ATTEMPTS, 2),
    issueCooldownMinutes: positive(options.issueCooldownMinutes ?? process.env.RECONCILE_ISSUE_COOLDOWN_MINUTES, 30),
    completedStageCooldownMinutes: positive(options.completedStageCooldownMinutes ?? process.env.RECONCILE_COMPLETED_STAGE_COOLDOWN_MINUTES, 720),
    typedOutcomes: options.typedOutcomes ?? process.env.RECONCILE_TYPED_OUTCOMES === "1",
    skipStages: new Set(String(options.skipStages ?? process.env.RECONCILE_SKIP_STAGES ?? "").split(",").map((v) => v.trim()).filter(Boolean)),
    budget: options.budget || { created: 0, byAgent: new Map() }
  };
}

async function moveToHumanReview(client, issue, reason, options) {
  const verdict = policyFor(options)({
    from: issue.status, to: "Human Review", actor: "system", evidence: { blocker: reason }
  });
  if (!verdict?.ok) throw new Error(`reconcile policy rejected Human Review: ${reason}`);
  await client.query("SELECT set_config('multica.relay_authorized', 'on', true)");
  await client.query("UPDATE issue SET status = 'Human Review', updated_at = NOW() WHERE id = $1::uuid", [issue.id]);
  await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
     VALUES ($1::uuid, $2, 'Human Review', 'pending', jsonb_build_object('reason', $3::text))`,
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
    if (options.skipStages.has(issue.status)) {
      // Operator-disabled stage (e.g. Spec handled off-belt). No task, no state change.
      await client.query("COMMIT");
      return { action: "skipped", reason: "stage_disabled" };
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
      const extras = current.filter((task) => UNSTARTED.includes(task.status)).slice(current.some((t) => t.status === "running") ? 0 : 1);
      if (extras.length) await client.query(
        "UPDATE agent_task_queue SET status = 'cancelled', completed_at = NOW(), failure_reason = 'reconcile_duplicate' WHERE id = ANY($1::uuid[])",
        [extras.map((task) => task.id)]
      );
      await client.query("COMMIT");
      return { action: "already_live", taskId: current[0].id, cancelledDuplicates: extras.length };
    }
    if (current.length === 1) {
      await client.query("COMMIT");
      return { action: "already_live", taskId: current[0].id };
    }
    // Burn guard: never re-dispatch the same stage of one issue inside the cooldown window (GSP-1826).
    const recent = (await client.query(
      `SELECT id, status FROM agent_task_queue WHERE issue_id = $1::uuid AND context->>'to_stage' = $2::text
         AND (created_at > NOW() - ($3::int * interval '1 minute')
           OR (status = 'completed' AND completed_at > NOW() - ($4::int * interval '1 minute')))
       ORDER BY created_at DESC LIMIT 1`,
      [issue.id, issue.status, options.issueCooldownMinutes, options.completedStageCooldownMinutes]
    )).rows[0];
    if (recent) {
      await client.query("COMMIT");
      const reason = recent.status === "completed" ? "completed_stage_cooldown" : "issue_cooldown";
      return { action: "skipped", reason, taskId: recent.id };
    }
    if (options.typedOutcomes) {
      // GSP-1826: a recorded outcome for this stage with unchanged inputs is final until the inputs change.
      const eligibility = await stageEligibility(client, issue.id, issue.status);
      if (!eligibility.eligible) {
        await client.query("COMMIT");
        return { action: "skipped", reason: eligibility.reason };
      }
    }
    const stageAttempts = await client.query(stageAttemptsSql(), [issue.id, issue.status, options.defaultMaxAttempts]);
    const attempt = Number(stageAttempts.rows[0]?.attempt || 0);
    const maxAttempts = Math.max(Number(stageAttempts.rows[0]?.max_attempts || 0), options.defaultMaxAttempts, attempt + 1);
    if (issue.status === "CI/CD & Deploy") {
      // The CI/CD worker owns this stage's exit; a desk task here buys nothing.
      await client.query("COMMIT");
      return { action: "skipped", reason: "worker_owned_stage" };
    }
    if (issue.status === "In Progress") {
      // A completed Queue build is the work product. Hand it to the relay
      // completion loop through its ledger row instead of paying for a rebuild.
      const build = (await client.query(
        `SELECT id, agent_id FROM agent_task_queue
          WHERE issue_id = $1::uuid AND context->>'to_stage' = 'Queue' AND status = 'completed'
            AND completed_at >= (SELECT updated_at - interval '10 minutes' FROM issue WHERE id = $1::uuid)
          ORDER BY completed_at DESC NULLS LAST LIMIT 1`, [issue.id])).rows[0];
      if (build) {
        const logged = await client.query(
          `SELECT status FROM relay_run_log WHERE task_id = $1::uuid AND to_stage = 'In Progress' LIMIT 1`, [build.id]);
        if (logged.rows.length === 0) {
          await client.query(
            `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, agent_id, task_id, status)
             VALUES ($1::uuid, 'Queue', 'In Progress', $2::uuid, $3::uuid, 'pending')`,
            [issue.id, build.agent_id, build.id]);
          await client.query("COMMIT");
          return { action: "handoff", taskId: build.id };
        }
        if (logged.rows[0].status === "pending") {
          await client.query("COMMIT");
          return { action: "skipped", reason: "handoff_pending" };
        }
      }
    }
    const owner = (await client.query(ownerSql(), [issue.workspace_id, issue.status])).rows[0];
    if (!owner) {
      await client.query("COMMIT");
      return { action: "skipped", reason: "unresolved_owner" };
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
  const counts = { created: 0, skipped: 0, humanReview: 0, alreadyLive: 0, error: 0 };
  const results = [];
  for (const issue of rows) {
    let result;
    try {
      result = await reconcileIssue(client, issue.id, settings);
    } catch (error) {
      result = { action: "error", issueId: issue.id, message: error.message };
      console.error(`Reconcile issue error: issue=${issue.id} status=${issue.status} ${error.message}`);
    }
    results.push(result);
    if (result.action === "created") counts.created += 1;
    else if (result.action === "human_review") counts.humanReview += 1;
    else if (result.action === "already_live") counts.alreadyLive += 1;
    else if (result.action === "handoff") counts.handoff = (counts.handoff || 0) + 1;
    else if (result.action === "error") counts.error += 1;
    else counts.skipped += 1;
  }
  console.log(`Reconcile cycle: created=${counts.created} alreadyLive=${counts.alreadyLive} skipped=${counts.skipped} humanReview=${counts.humanReview} handoff=${counts.handoff || 0} error=${counts.error}`);
  return results;
}

module.exports = { ADVISORY_LOCK_SQL, DISPATCHABLE, LIVE, issueCandidatesSql, liveTasksSql, ownerSql, lifetimeTasksSql, stageAttemptsSql, taskContext, reconcileIssue, reconcileCycle };
