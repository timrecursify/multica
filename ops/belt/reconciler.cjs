"use strict";
const { stageEligibility } = require("./stage-outcome.cjs");
const { execFileSync } = require("child_process");
const { resolveBuilderRoute } = require("./guardrails.cjs");
const { completionAdmission } = require("./relay-completion-admission.cjs");

const DISPATCHABLE = new Set(["Spec", "Queue", "In Progress", "In Review", "CI/CD & Deploy"]);
const LIVE = ["queued", "dispatched", "running", "waiting_local_directory", "deferred"];
const UNSTARTED = ["queued", "dispatched", "waiting_local_directory", "deferred"];
const ADVISORY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('v3-reconciler:' || $1::text))";

// A rollup (an issue that still has a non-terminal child) is dispositioned by
// its children, not by a builder of its own. A leaf dispatches whether or not it
// has a parent: bundling children under a MEGA starved them permanently.
const OPEN_CHILD_SQL = `NOT EXISTS (SELECT 1 FROM issue c
   WHERE c.parent_issue_id = i.id AND c.status NOT IN ('Done', 'Archived', 'Cancelled'))`;

function issueCandidatesSql() {
  return `SELECT i.id, i.workspace_id, i.status, i.priority, i.metadata, i.qc_fail_count
            FROM issue i WHERE i.status = ANY($1::text[]) AND ${OPEN_CHILD_SQL} ORDER BY i.id`;
}

function isLeafSql() {
  return `SELECT ${OPEN_CHILD_SQL} AS is_leaf FROM issue i WHERE i.id = $1::uuid`;
}

function liveTasksSql() {
  return `SELECT id, status, context FROM agent_task_queue
            WHERE issue_id = $1::uuid AND status = ANY($2::text[]) FOR UPDATE`;
}

function ownerSql() {
  return `SELECT pool.agent_id, a.name AS agent_name, a.model, a.runtime_config,
                   COALESCE(own_runtime.provider, online_runtime.provider) AS selected_runtime_provider,
                   COALESCE(own_runtime.id, online_runtime.id) AS selected_runtime_id
            FROM relay_stage_agent_pool pool
            JOIN relay_stage_pool policy ON policy.workspace_id = pool.workspace_id
             AND policy.stage_name = pool.stage_name AND policy.enabled = true
            JOIN agent a ON a.id = pool.agent_id AND a.workspace_id = pool.workspace_id
            LEFT JOIN agent_runtime own_runtime ON own_runtime.id = a.runtime_id
             AND own_runtime.workspace_id = pool.workspace_id AND own_runtime.status = 'online'
            LEFT JOIN LATERAL (
              SELECT ar.id, ar.provider FROM agent_runtime ar
               WHERE ar.workspace_id = pool.workspace_id
                 AND ar.status = 'online'
                 AND ar.provider = CASE WHEN a.model LIKE 'claude%' THEN 'claude' ELSE 'codex' END
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
    failedTtlMinutes: positive(options.failedTtlMinutes ?? process.env.MULTICA_FAILED_TTL_MINUTES, 15),
    typedOutcomes: options.typedOutcomes ?? process.env.RECONCILE_TYPED_OUTCOMES === "1",
    humanReviewRouting: options.humanReviewRouting ?? process.env.RECONCILE_HUMAN_REVIEW_ROUTING !== "0",
    maxHumanReviewPerCycle: positive(options.maxHumanReviewPerCycle ?? process.env.RECONCILE_MAX_HUMAN_REVIEW_PER_CYCLE, 5),
    skipStages: new Set(String(options.skipStages ?? process.env.RECONCILE_SKIP_STAGES ?? "").split(",").map((v) => v.trim()).filter(Boolean)),
    budget: options.budget || { created: 0, humanReview: 0, byAgent: new Map() }
  };
}

// Routes a stuck issue off its stage and onto a human's board. transition-policy
// lists every `* -> Human Review` row with actors ['operator'], so this asks as
// the operator the belt is acting for; 'system' was refused as actor_denied.
async function moveToHumanReview(client, issue, reason, options) {
  const verdict = policyFor(options)({
    from: issue.status, to: "Human Review", actor: "operator", evidence: { blocker: reason }
  });
  if (!verdict?.ok) throw new Error(`reconcile policy rejected Human Review: ${reason} (${verdict?.code})`);
  await client.query("SELECT set_config('multica.relay_authorized', 'on', true)");
  await client.query("UPDATE issue SET status = 'Human Review', updated_at = NOW() WHERE id = $1::uuid", [issue.id]);
  await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
     VALUES ($1::uuid, $2, 'Human Review', 'pending', jsonb_build_object('reason', $3::text))`,
    [issue.id, issue.status, reason]
  );
  return { action: "human_review", reason };
}

// RULES allows Spec -> Human Review for the operator actor, which is the actor
// moveToHumanReview declares. Spec must stay routable: a Spec ticket that has
// spent its lifetime task budget can no longer be re-dispatched, and without an
// exit it is re-evaluated every cycle forever instead of reaching a human.
const HUMAN_REVIEW_FROM = new Set(["Spec", "Queue", "In Progress", "In Review", "CI/CD & Deploy"]);
const LINK_TABLE = { ci: "issue_pull_request", sha: "issue_pull_request", dependency: "issue_dependency" };

// A recorded BLOCKED outcome is terminal when no machine-observable input remains
// that could ever change the stage input hash and re-open the stage:
//   human      - definitionally a person's call, never a hash event.
//   ci / sha   - need a linked PR to supply a head sha or a checks rollup.
//   dependency - needs a linked issue_dependency row to supply a state.
// quota is excluded: it clears on its own once the provider window resets.
const PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;

function ghExec(args) {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 90000, maxBuffer: 8e6 }).trim();
}

// The same comment window the advance daemon already reads for a PR pointer
// (parity/multica-relay-advance-daemon.cjs:198). A builder that opened a PR
// records its URL here; that comment IS the machine-observable evidence, so a
// missing link row is a gap in our own bookkeeping, not an unobservable stage.
async function commentPullRequestUrl(client, issue) {
  const comments = await client.query(
    "SELECT content FROM comment WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 40", [issue.id]);
  const match = comments.rows
    .map(({ content }) => String(content || "").match(PR_URL_RE))
    .find(Boolean);
  return match ? { url: match[0], owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}

// Persist the observed PR so the stage input hash (stage-outcome.cjs:51-55) can
// see a head sha and a checks rollup from here on. Every column is copied from
// the GitHub API response; nothing is synthesised. installation_id keeps the
// belt's existing 0 sentinel: the daemon supplies githubCommand, so this row
// is not keyed to whichever installation minted the token that read it.
async function linkObservedPullRequest(client, issue, options = {}) {
  const githubCommand = options.githubCommand || ghExec;
  const pointer = await commentPullRequestUrl(client, issue);
  if (!pointer) return false;
  let pr;
  try {
    pr = JSON.parse(githubCommand(["pr", "view", pointer.url, "--json",
      "number,title,state,url,headRefOid,createdAt,updatedAt,mergedAt,closedAt," +
      "author,headRefName,additions,deletions,changedFiles,mergeable,mergeStateStatus,statusCheckRollup"]));
  } catch (error) {
    // An unreadable PR stays unobservable: leave the park in place.
    console.error(`[reconcile] pr view failed issue=${issue.id} pr=${pointer.url} ${error.message}`);
    return false;
  }
  if (!pr || typeof pr.number !== "number" || !pr.state) return false;
  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const conclusions = rollup.map((check) =>
    String(check.conclusion || check.state || "").toUpperCase()).filter(Boolean);
  const rollupState = conclusions.length === 0 ? null
    : conclusions.some((value) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(value)) ? "FAILURE"
    : conclusions.every((value) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(value)) ? "SUCCESS"
    : "PENDING";
  const inserted = await client.query(
    `INSERT INTO github_pull_request (workspace_id, installation_id, repo_owner, repo_name,
        pr_number, title, state, html_url, branch, author_login, merged_at, closed_at,
        pr_created_at, pr_updated_at, head_sha, additions, deletions, changed_files,
        api_mergeable, api_merge_state_status, checks_rollup_state, snapshot_head_sha, snapshot_fetched_at)
      VALUES ($1::uuid, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $14, NOW())
      ON CONFLICT (workspace_id, repo_owner, repo_name, pr_number) DO UPDATE SET
        state = EXCLUDED.state, head_sha = EXCLUDED.head_sha, merged_at = EXCLUDED.merged_at,
        closed_at = EXCLUDED.closed_at, pr_updated_at = EXCLUDED.pr_updated_at,
        api_mergeable = EXCLUDED.api_mergeable, api_merge_state_status = EXCLUDED.api_merge_state_status,
        checks_rollup_state = EXCLUDED.checks_rollup_state, snapshot_head_sha = EXCLUDED.snapshot_head_sha,
        snapshot_fetched_at = NOW(), updated_at = NOW()
      RETURNING id`,
    [issue.workspace_id, pointer.owner, pointer.repo, pr.number, pr.title || pointer.url,
      String(pr.state).toLowerCase(), pr.url || pointer.url, pr.headRefName || null,
      pr.author?.login || null, pr.mergedAt || null, pr.closedAt || null,
      pr.createdAt, pr.updatedAt, pr.headRefOid || "",
      pr.additions ?? 0, pr.deletions ?? 0, pr.changedFiles ?? 0,
      pr.mergeable || null, pr.mergeStateStatus || null, rollupState]);
  await client.query(
    `INSERT INTO issue_pull_request (issue_id, pull_request_id, linked_by_type, linked_at)
      VALUES ($1::uuid, $2::uuid, 'reconciler', NOW())
      ON CONFLICT (issue_id, pull_request_id) DO NOTHING`,
    [issue.id, inserted.rows[0].id]);
  console.log(`[reconcile] ${issue.id} linked observed PR ${pr.url || pointer.url} state=${pr.state} sha=${pr.headRefOid || "-"}`);
  return true;
}

async function mergedPullRequestNoop(client, issue, options = {}) {
  const pointer = await commentPullRequestUrl(client, issue);
  if (!pointer) return null;
  try {
    const view = JSON.parse((options.githubCommand || ghExec)(["pr", "view", pointer.url,
      "--json", "state,mergedAt,headRefOid,url"]));
    if (String(view.state).toUpperCase() !== "MERGED" && !view.mergedAt) return null;
    const verdict = policyFor(options)({ from: issue.status, to: "Done", actor: "operator",
      evidence: { reason: "merged_pull_request", url: view.url || pointer.url, merged_at: view.mergedAt } });
    if (!verdict?.ok) return null;
    await client.query("SELECT set_config('multica.relay_authorized', 'on', true)");
    await client.query("UPDATE issue SET status = 'Done', updated_at = NOW() WHERE id = $1::uuid", [issue.id]);
    await client.query(`INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
      VALUES ($1::uuid, $2, 'Done', 'completed', jsonb_build_object('reason','merged_pull_request','url',$3::text))`,
      [issue.id, issue.status, view.url || pointer.url]);
    return { action: "no_op", reason: "merged_pull_request", status: "Done" };
  } catch (error) {
    // This used to swallow everything. An unauthenticated `gh` failed here on
    // every cycle and said nothing, so a merged PR never completed its ticket
    // and the cause was invisible in the log.
    console.error(`[reconcile] merged PR check failed issue=${issue.id} pr=${pointer.url} ${error.message}`);
    return null;
  }
}

async function terminalBlocker(client, issue, prior, options = {}) {
  if (!prior || prior.outcome !== "BLOCKED") return null;
  const why = prior.blocked_on;
  if (why === "human") return "blocked_human";
  const table = LINK_TABLE[why];
  if (!table) return null;
  const linked = table === "issue_dependency"
    ? await client.query("SELECT 1 FROM issue_dependency WHERE issue_id = $1::uuid LIMIT 1", [issue.id])
    : await client.query("SELECT 1 FROM issue_pull_request WHERE issue_id = $1::uuid LIMIT 1", [issue.id]);
  if (linked.rows.length) return null;
  // A ci/sha blocker only needs a PR to become observable, and the issue's own
  // comments may already name one. Derive the missing link from that evidence
  // before calling the stage terminal. A dependency blocker is not answered by
  // a PR, so it keeps the original terminal reading.
  if (table === "issue_pull_request" && await linkObservedPullRequest(client, issue, options)) return null;
  return `blocked_${why}_unobservable`;
}

// Returns a human_review result, or null to leave the issue skipped as before.
async function routeTerminalBlocker(client, issue, prior, options) {
  if (!options.humanReviewRouting || !HUMAN_REVIEW_FROM.has(issue.status)) return null;
  if (options.budget.humanReview >= options.maxHumanReviewPerCycle) return null;
  const reason = await terminalBlocker(client, issue, prior, options);
  if (!reason) return null;
  try {
    const result = await moveToHumanReview(client, issue, reason, options);
    options.budget.humanReview += 1;
    console.log(`[reconcile] ${issue.id} ${issue.status} -> Human Review (${reason})`);
    return result;
  } catch (error) {
    console.error(`[reconcile] Human Review route failed issue=${issue.id} ${error.message}`);
    return null;
  }
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
    if (!issue || !DISPATCHABLE.has(issue.status)) {
      await client.query("COMMIT");
      return { action: "skipped" };
    }
    const leaf = (await client.query(isLeafSql(), [issue.id])).rows[0];
    if (!leaf || leaf.is_leaf === false) {
      await client.query("COMMIT");
      return { action: "skipped", reason: "rollup_has_open_children" };
    }
    if (options.skipStages.has(issue.status)) {
      // Operator-disabled stage (e.g. Spec handled off-belt). No task, no state change.
      await client.query("COMMIT");
      return { action: "skipped", reason: "stage_disabled" };
    }
    const mergedNoop = await mergedPullRequestNoop(client, issue, options);
    if (mergedNoop) { await client.query("COMMIT"); return mergedNoop; }
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
      `SELECT id, status, result, error FROM agent_task_queue WHERE issue_id = $1::uuid AND context->>'to_stage' = $2::text
         AND (created_at > NOW() - ($3::int * interval '1 minute')
           OR (status = 'completed' AND completed_at > NOW() - ($4::int * interval '1 minute')))
       ORDER BY created_at DESC LIMIT 1`,
      [issue.id, issue.status, options.issueCooldownMinutes, options.completedStageCooldownMinutes]
    )).rows[0];
    if (recent) {
      // Older daemons could report a failed/no-work-product run through the
      // success callback.  Do not let that poisoned terminal row arm the
      // completed-stage burn guard: make the failure durable and let the
      // normal retry/admission path observe it on the next cycle.
      if (recent.status === "completed") {
        const admission = completionAdmission(recent.result ?? (recent.error ? { error: recent.error } : null));
        if (!admission.ok) {
          await client.query(
            `UPDATE agent_task_queue
                SET status = 'failed', completed_at = COALESCE(completed_at, NOW()),
                    failure_reason = $2, error = COALESCE(error, $3), updated_at = NOW()
              WHERE id = $1::uuid AND status = 'completed'`,
            [recent.id, admission.reason, typeof recent.result === "string" ? recent.result : JSON.stringify(recent.result ?? {})]
          );
          await client.query("COMMIT");
          return { action: "skipped", reason: admission.reason, taskId: recent.id };
        }
      }
      await client.query("COMMIT");
      const reason = recent.status === "completed" ? "completed_stage_cooldown" : "issue_cooldown";
      return { action: "skipped", reason, taskId: recent.id };
    }
    const stageAttempts = await client.query(stageAttemptsSql(), [issue.id, issue.status, options.defaultMaxAttempts]);
    const attempt = Number(stageAttempts.rows[0]?.attempt || 0);
    const maxAttempts = Math.max(Number(stageAttempts.rows[0]?.max_attempts || 0), options.defaultMaxAttempts, attempt + 1);
    if (options.typedOutcomes) {
      // GSP-1826: a recorded outcome for this stage with unchanged inputs is final until the inputs change.
      const eligibility = await stageEligibility(client, issue.id, issue.status, {
        failedTtlMinutes: options.failedTtlMinutes,
        attempt,
        maxAttempts
      });
      if (eligibility.eligible && eligibility.reason === "advanced_stall") {
        console.log(`[reconcile] advanced_stall: issue=${issue.id} stage=${issue.status}`);
      }
      if (!eligibility.eligible) {
        // Nothing left to observe means nothing will ever re-open this stage, so the
        // issue leaves the belt for a human instead of resting invisibly in Queue.
        const routed = await routeTerminalBlocker(client, issue, eligibility.prior, options);
        await client.query("COMMIT");
        return routed || { action: "skipped", reason: eligibility.reason };
      }
    }
    // Lifetime cap is per issue and includes every reconciler-created task,
    // regardless of terminal status.  Stop the paid loop before selecting an
    // owner or inserting another task; route the durable blocker to a human.
    const lifetime = await client.query(lifetimeTasksSql(), [issue.id]);
    const lifetimeCount = Number(lifetime.rows[0]?.count || 0);
    if (lifetimeCount >= options.lifetimeTaskLimit) {
      const capReason = `lifetime_task_limit:${lifetimeCount}/${options.lifetimeTaskLimit}`;
      const routed = options.humanReviewRouting && HUMAN_REVIEW_FROM.has(issue.status) &&
        options.budget.humanReview < options.maxHumanReviewPerCycle
        ? await moveToHumanReview(client, issue, capReason, options) : null;
      if (routed) {
        options.budget.humanReview += 1;
        await client.query("COMMIT");
        return routed;
      }
      await client.query("COMMIT");
      return { action: "skipped", reason: "lifetime_task_limit", count: lifetimeCount };
    }
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
    const route = resolveBuilderRoute(owner, { provider: owner.selected_runtime_provider });
    if (!route.ok) {
      await client.query("COMMIT");
      return { action: "skipped", reason: route.reason };
    }
    const context = { ...taskContext(issue.status), ...(route.route ? { builder_route: route.route } : {}) };
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
  const settings = settingsFor({ ...options, budget: { created: 0, humanReview: 0, byAgent: new Map() } });
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
    else {
      counts.skipped += 1;
      const reason = result.reason || result.action || "unknown";
      counts.skipReasons = counts.skipReasons || {};
      counts.skipReasons[reason] = (counts.skipReasons[reason] || 0) + 1;
    }
  }
  const skipDetail = Object.entries(counts.skipReasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(",");
  console.log(`Reconcile cycle: created=${counts.created} alreadyLive=${counts.alreadyLive} skipped=${counts.skipped} humanReview=${counts.humanReview} handoff=${counts.handoff || 0} error=${counts.error}${skipDetail ? ` skipReasons=${skipDetail}` : ""}`);
  return results;
}

module.exports = { ADVISORY_LOCK_SQL, DISPATCHABLE, LIVE, issueCandidatesSql, isLeafSql, liveTasksSql, ownerSql, lifetimeTasksSql, stageAttemptsSql, taskContext, moveToHumanReview, terminalBlocker, commentPullRequestUrl, linkObservedPullRequest, mergedPullRequestNoop, reconcileIssue, reconcileCycle };
