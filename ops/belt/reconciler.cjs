"use strict";

const DISPATCHABLE = new Set(["Spec", "Queue", "In Progress", "In Review", "CI/CD & Deploy"]);
const LIVE = ["queued", "dispatched", "running", "waiting_local_directory", "deferred"];
const UNSTARTED = ["queued", "dispatched", "waiting_local_directory", "deferred"];

function issueCandidatesSql() {
  return `SELECT id, workspace_id, status, priority, metadata, qc_fail_count
            FROM issue WHERE status = ANY($1::text[]) ORDER BY id`;
}

function liveTasksSql() {
  return `SELECT id, status, context FROM agent_task_queue
            WHERE issue_id = $1::uuid AND status = ANY($2::text[]) FOR UPDATE`;
}

function ownerSql() {
  return `SELECT pool.agent_id FROM relay_stage_agent_pool pool
            JOIN relay_stage_pool policy ON policy.workspace_id = pool.workspace_id
             AND policy.stage_name = pool.stage_name AND policy.enabled = true
           WHERE pool.workspace_id = $1::uuid AND pool.stage_name = $2
             AND pool.enabled = true
           ORDER BY pool.last_selected_at NULLS FIRST, pool.agent_id LIMIT 1`;
}

function taskContext(stage) {
  return { source: "reconcile", kind: "stage_task", to_stage: stage };
}

function policyFor(options) {
  if (options.evaluate) return options.evaluate;
  return require("./transition-policy.cjs").evaluate;
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
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [issueId]);
    const locked = await client.query(
      "SELECT id, workspace_id, status, priority, metadata, qc_fail_count FROM issue WHERE id = $1::uuid FOR UPDATE",
      [issueId]
    );
    const issue = locked.rows[0];
    if (!issue || !DISPATCHABLE.has(issue.status)) {
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
    if (runningStale || current.length > 1) {
      const result = await moveToHumanReview(client, issue, runningStale ? "stale_stage_running" : "duplicate_live_task", options);
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
    const owner = (await client.query(ownerSql(), [issue.workspace_id, issue.status])).rows[0];
    if (!owner) {
      const result = await moveToHumanReview(client, issue, "unresolved_owner", options);
      await client.query("COMMIT");
      return result;
    }
    const context = taskContext(issue.status);
    const created = await client.query(
      `INSERT INTO agent_task_queue (agent_id, issue_id, workspace_id, status, priority, context,
          trigger_summary, originator_source)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'queued', $4, $5::jsonb, $6, 'reconcile') RETURNING id`,
      [owner.agent_id, issue.id, issue.workspace_id, issue.priority === "urgent" ? 1 : 0,
        JSON.stringify(context), `reconcile ${issue.status}`]
    );
    const taskId = created.rows[0].id;
    await client.query(
      `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, agent_id, task_id, status)
       VALUES ($1::uuid, $2, $2, $3::uuid, $4::uuid, 'pending')`,
      [issue.id, issue.status, owner.agent_id, taskId]
    );
    await client.query("COMMIT");
    return { action: "created", taskId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function reconcileCycle(client, options = {}) {
  const rows = (await client.query(issueCandidatesSql(), [[...DISPATCHABLE]])).rows;
  const results = [];
  for (const issue of rows) results.push(await reconcileIssue(client, issue.id, options));
  return results;
}

module.exports = { DISPATCHABLE, LIVE, issueCandidatesSql, liveTasksSql, ownerSql, taskContext, reconcileIssue, reconcileCycle };
