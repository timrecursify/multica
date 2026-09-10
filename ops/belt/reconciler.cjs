"use strict";
const { stageEligibility } = require("./stage-outcome.cjs");
const { execFileSync } = require("child_process");
const { resolveBuilderRoute } = require("./guardrails.cjs");
const { completionAdmission } = require("./relay-completion-admission.cjs");
const { buildTaskAdmission } = require("./build-admission.cjs");
const { classifyHumanReviewRequest, decisionRevision, humanReviewRoutingDecision,
  latestQcBlockerEvidence } = require("./human-review-routing.cjs");
const { activeAdjudicationHold, persistTrustedAstraAssessment, recordAstraAdjudication,
  trustedAstraAssessment } = require("./astra-adjudication.cjs");
const { recordParkedEntry } = require("./parked-entry-audit.cjs");

const DISPATCHABLE = new Set(["Spec", "Queue", "In Progress", "In Review", "CI/CD & Deploy"]);
const LIVE = ["queued", "dispatched", "running", "waiting_local_directory", "deferred"];
const UNSTARTED = ["queued", "dispatched", "waiting_local_directory", "deferred"];
const ADVISORY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1), hashtext('build'))";

// A rollup (an issue that still has a non-terminal child) is dispositioned by
// its children, not by a builder of its own. A leaf dispatches whether or not it
// has a parent: bundling children under a MEGA starved them permanently.
const OPEN_CHILD_SQL = `NOT EXISTS (SELECT 1 FROM issue c
   WHERE c.parent_issue_id = i.id AND c.status NOT IN ('Done', 'Archived', 'Cancelled'))`;

function issueCandidatesSql() {
  return `SELECT i.id, i.workspace_id, i.status, i.priority, i.metadata, i.qc_fail_count
            FROM issue i WHERE (i.status = ANY($1::text[])
              OR (i.status = 'Parked' AND i.metadata ? 'lifetime_budget_hold'))
              AND ${OPEN_CHILD_SQL} ORDER BY i.id`;
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
                   COALESCE(own_runtime.id, online_runtime.id) AS selected_runtime_id,
                   a.max_concurrent_tasks - COALESCE(running.task_count, 0) AS available_capacity
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
            LEFT JOIN LATERAL (
              SELECT count(*)::int AS task_count FROM agent_task_queue task
               WHERE task.agent_id = pool.agent_id AND task.status = 'running'
            ) running ON true
           WHERE pool.workspace_id = $1::uuid AND pool.stage_name = $2
             AND pool.enabled = true
             AND a.archived_at IS NULL AND a.status IN ('idle', 'working')
             AND COALESCE(own_runtime.id, online_runtime.id) IS NOT NULL
             AND COALESCE(running.task_count, 0) < a.max_concurrent_tasks
           ORDER BY pool.last_selected_at NULLS FIRST, pool.agent_id LIMIT 1`;
}

// The budget is per stage entry, not per lifetime. Counting every task an issue
// ever had retired tickets permanently for outages that were never theirs: on
// 2026-09-06 a revoked provider credential and an unreachable board burned six
// attempts on 59 tickets in a single morning, and no later fix could return
// them to the belt. Counting from the issue's most recent arrival in its
// current stage keeps the guard that matters — a stage cannot spin on paid
// tasks forever — and lets a stage change, including an operator returning the
// issue, grant a fresh budget.
//
// Only an arrival opens a window. Every dispatch also writes a relay_run_log row
// with from_stage = to_stage, so a window keyed on to_stage alone would restart
// on each dispatch and the count would never exceed one, which is the guard
// switched off.
//
// A Parked or Human Review release also opens a window. The bridge already
// counts from parked_release_at / human_review_release_at (humanReleaseAt);
// a release that is followed by a direct Queue -> In Progress hand-off writes
// no arrival row, and without this the old In Progress arrival still counts.
function stageEntryWindowSql() {
  return `created_at >= GREATEST(
                   COALESCE(
                     (SELECT max(created_at) FROM relay_run_log
                       WHERE issue_id = $1::uuid AND to_stage = $2
                         AND from_stage IS DISTINCT FROM to_stage),
                     '-infinity'::timestamptz),
                   COALESCE((SELECT GREATEST(
                       NULLIF(metadata->>'parked_release_at', '')::timestamptz,
                       NULLIF(metadata->>'human_review_release_at', '')::timestamptz,
                       NULLIF(metadata->>'mechanical_retry_release_at', '')::timestamptz)
                     FROM issue WHERE id = $1::uuid), '-infinity'::timestamptz))`;
}

function lifetimeTasksSql() {
  return `SELECT count(*)::int AS count
            FROM agent_task_queue
           WHERE issue_id = $1::uuid AND trigger_comment_id IS NULL
             AND ${stageEntryWindowSql()}`;
}

function stageAttemptsSql() {
  return `SELECT COALESCE(max(attempt), 0)::int AS attempt,
                 COALESCE(max(max_attempts), $3::int)::int AS max_attempts
           FROM agent_task_queue
           WHERE issue_id = $1::uuid AND context->>'to_stage' = $2
             AND trigger_comment_id IS NULL
             AND NOT (status = 'completed' AND failure_reason IS NULL)
             AND ${stageEntryWindowSql()}`;
}

function stageAttemptBudget(attempt, configuredMax, fallbackMax) {
  const maxAttempts = Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : fallbackMax;
  return { attempt: Number(attempt || 0) + 1, maxAttempts };
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
    mechanicalRetryMinutes: positive(options.mechanicalRetryMinutes ?? process.env.RECONCILE_MECHANICAL_RETRY_MINUTES, 720),
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
  // The UPDATE below performs the advance itself, so the relay row is audit-only
  // and records 'completed', like every other audit-only writer (parked-entry-
  // audit.cjs, the merged-PR no-op below, operator respec, ensureCompletedRelayLog).
  // Written 'pending' it was unclosable: findAndAdvanceTasks inner-joins
  // agent_task_queue on rrl.task_id, which is NULL here; closeDeadRelayRows closes
  // only to_stage IN (Done, Cancelled, Archived); and cleanupStalePendingRows needs
  // the issue past Human Review, which is exactly what it was parked to wait for.
  await client.query("SELECT set_config('multica.relay_authorized', 'on', true)");
  await client.query("UPDATE issue SET status = 'Human Review', updated_at = NOW() WHERE id = $1::uuid", [issue.id]);
  await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
     VALUES ($1::uuid, $2, 'Human Review', 'completed', jsonb_build_object('reason', $3::text))`,
    [issue.id, issue.status, reason]
  );
  return { action: "human_review", reason };
}

// A machine-resolvable blocker returns to the agent-owned Spec stage with the
// same durable audit shape used by the Human Review hold. A ticket already in
// Spec stays there rather than manufacturing a self-transition.
async function moveToAgentDecision(client, issue, reason, options) {
  if (issue.status === "Spec") return null;
  const verdict = policyFor(options)({
    from: issue.status, to: "Spec", actor: "system",
    evidence: { retry_escalation: true, blocker: reason }
  });
  if (!verdict?.ok) throw new Error(`reconcile policy rejected Spec: ${reason} (${verdict?.code})`);
  await client.query("SELECT set_config('multica.relay_authorized', 'on', true)");
  await client.query("UPDATE issue SET status = 'Spec', updated_at = NOW() WHERE id = $1::uuid", [issue.id]);
  await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
     VALUES ($1::uuid, $2, 'Spec', 'completed', jsonb_build_object('reason', $3::text))`,
    [issue.id, issue.status, reason]
  );
  return { action: "agent_decision", reason, status: "Spec" };
}

async function moveToLifetimeHold(client, issue, taskCount, ceiling) {
  const reason = "lifetime_task_limit";
  const decision = "resolve exhausted lifetime task budget";
  const revision = decisionRevision({ ...issue, pending_decision: decision });
  await client.query("SELECT set_config('multica.relay_authorized', 'on', true)");
  const changed = await client.query(
    "UPDATE issue SET status = 'Parked', updated_at = NOW() WHERE id = $1::uuid AND status <> 'Parked' RETURNING id",
    [issue.id]);
  const relayLogId = changed.rowCount !== 0 ? await recordParkedEntry(client, { issueId: issue.id,
    fromStage: issue.status, trigger: reason, intendedStage: issue.status,
    attempts: taskCount, taskCount }) : null;
  const adjudication = await recordAstraAdjudication(client, issue, {
    purpose: "lifetime_exhaustion", reason, decision, decision_revision: revision,
    attempts: taskCount, ceiling, provenance: { source: "reconciler_lifetime_counter" }
  });
  await client.query(
    `UPDATE agent_task_queue SET status = 'cancelled', completed_at = NOW(),
          failure_reason = 'lifetime_task_limit', prepare_lease_expires_at = NULL
      WHERE issue_id = $1::uuid
        AND status IN ('queued','dispatched','waiting_local_directory','deferred')
        AND COALESCE(context->>'kind','') NOT IN ('parked_diagnosis','astra_adjudication')`,
    [issue.id]);
  return { action: "held", reason, status: "Parked", taskId: adjudication.task_id,
    blocker: adjudication.reason, relayLogId };
}

async function enforceLifetimeHold(client, issue, hold) {
  if (issue.status !== "Parked") {
    return moveToLifetimeHold(client, issue, Number(hold.attempts || 0), Number(hold.ceiling || 0));
  }
  const currentRevision = decisionRevision({ ...issue, pending_decision: hold.decision });
  if (currentRevision !== hold.decision_revision) {
    const refreshed = await recordAstraAdjudication(client, issue, {
      ...hold, purpose: "lifetime_exhaustion", reason: "lifetime_task_limit",
      decision_revision: currentRevision,
      provenance: { source: "reconciler_lifetime_hold_scope_change" }
    });
    return { action: "held", reason: "lifetime_ruling_revision_required", status: "Parked",
      decisionRevision: currentRevision, taskId: refreshed.task_id, blocker: refreshed.reason };
  }
  const ruling = await trustedAstraAssessment(
    client, issue, hold.decision_revision, "lifetime_exhaustion");
  if (ruling) {
    await persistTrustedAstraAssessment(client, issue, "lifetime_exhaustion", ruling);
    return { action: "held", reason: ruling.outcome === "human_approval"
      ? "astra_human_approval_recorded" : "lifetime_budget_extension_required",
    status: "Parked", ruling: ruling.outcome };
  }
  const selection = await recordAstraAdjudication(client, issue, {
    ...hold, purpose: "lifetime_exhaustion", reason: "lifetime_task_limit"
  });
  return { action: "held", reason: "lifetime_task_limit", status: "Parked",
    taskId: selection.task_id, blocker: selection.reason };
}

function taskDecisionText(row) {
  if (!row) return null;
  const result = row.result;
  if (typeof result === "string" && result.trim()) return result.trim();
  if (result && typeof result === "object") {
    const text = [result.output, result.comment, result.text, result.error]
      .find((value) => typeof value === "string" && value.trim());
    if (text) return text.trim();
  }
  return typeof row.error === "string" && row.error.trim() ? row.error.trim() : null;
}

async function pendingBlockerDecision(client, prior) {
  if (!prior?.task_id) return "BLOCKED outcome requires a human classification";
  const task = await client.query(
    "SELECT result, error FROM agent_task_queue WHERE id = $1::uuid LIMIT 1", [prior.task_id]);
  return taskDecisionText(task.rows[0]) || "BLOCKED outcome requires a human classification";
}

async function routeClassifiedDecision(client, issue, decision, options) {
  const ticket = { ...issue, pending_decision: decision };
  const pending = classifyHumanReviewRequest(ticket);
  const latestQc = issue.status === "In Review" ? await latestQcBlockerEvidence(client, issue) : null;
  const assessment = await trustedAstraAssessment(
    client, issue, pending.decision_revision, "classification");
  const classification = classifyHumanReviewRequest(ticket, assessment);
  const routing = humanReviewRoutingDecision(classification, {
    latestQc, outcome: assessment?.outcome
  });
  if (routing.action === "no_artifact_rescope") {
    await client.query(
      `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) ||
           jsonb_build_object('human_review_hold', $2::jsonb), updated_at = NOW()
        WHERE id = $1::uuid`, [issue.id, JSON.stringify({
        reason: "no_artifact_rescope_relay_required", purpose: "classification",
        decision, decision_revision: pending.decision_revision,
        provenance: { source: latestQc.provenance, task_id: latestQc.task_id }
      })]);
    return { action: "held", reason: "no_artifact_rescope_relay_required",
      classification: "technical", qcTaskId: latestQc.task_id };
  }
  if (routing.action === "hold") {
    const selection = await recordAstraAdjudication(client, issue, {
      purpose: "classification", reason: "human_review_classification_required",
      decision: pending.decision, decision_revision: pending.decision_revision,
      suggestion: pending.suggestion, provenance: pending.provenance
    });
    return { action: "held", reason: "human_review_classification_required",
      decisionRevision: pending.decision_revision, blocker: selection.reason,
      taskId: selection.task_id };
  }
  if (routing.destination === "Human Review" &&
      options.budget.humanReview >= options.maxHumanReviewPerCycle) {
    return { action: "held", reason: "human_review_cycle_budget",
      decisionRevision: pending.decision_revision, taskId: assessment.assessor_task_id };
  }
  await persistTrustedAstraAssessment(client, issue, "classification", assessment);
  if (routing.action === "no_op") {
    return { action: "no_op", reason: "astra_adjudication_noop", evidence: assessment.evidence };
  }
  if (routing.destination === "Human Review") return moveToHumanReview(client, issue, decision, options);
  if (routing.destination === "Spec") {
    const moved = await moveToAgentDecision(client, issue, decision, options);
    return moved || { action: "adjudicated", reason: "technical_scope_recorded", status: issue.status };
  }
  return { action: "held", reason: "human_review_classification_required" };
}

async function deferMechanicalRetry(client, issue, reason, minutes) {
  await client.query(
    `UPDATE issue
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'mechanical_retry_after', NOW() + ($2::int * interval '1 minute')),
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [issue.id, minutes]
  );
  await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
     VALUES ($1::uuid, $2, $2, 'completed', jsonb_build_object(
       'reason', $3::text, 'mechanical_retry', true, 'retry_after_minutes', $4::int))`,
    [issue.id, issue.status, reason, minutes]
  );
  console.warn(`[reconcile] mechanical retry deferred issue=${issue.id} stage=${issue.status} reason=${reason} minutes=${minutes}`);
  return { action: "deferred", reason, retryAfterMinutes: minutes };
}

// Human Review remains reachable for a genuine human-only decision from every
// executing stage. Technical retry exhaustion uses moveToAgentDecision instead.
const HUMAN_REVIEW_FROM = new Set(["Spec", "Queue", "In Progress", "In Review", "CI/CD & Deploy"]);
const LINK_TABLE = { ci: "issue_pull_request", sha: "issue_pull_request", dependency: "issue_dependency" };

// A recorded BLOCKED outcome is terminal when no machine-observable input remains
// that could ever change the stage input hash and re-open the stage. FAILED/human
// is also terminal because only a person can resolve it:
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
    pr = JSON.parse(await githubCommand(["pr", "view", pointer.url, "--json",
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
    const view = JSON.parse(await (options.githubCommand || ghExec)(["pr", "view", pointer.url,
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
  if (!prior || (prior.outcome !== "BLOCKED" && !(prior.outcome === "FAILED" && prior.blocked_on === "human"))) return null;
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
  const reason = await terminalBlocker(client, issue, prior, options);
  if (!reason) return null;
  try {
    const human = reason === "blocked_human";
    const result = human
      ? await routeClassifiedDecision(client, issue,
        await pendingBlockerDecision(client, prior), options)
      : await moveToAgentDecision(client, issue, reason, options);
    if (!result) return null;
    if (result.action === "human_review") options.budget.humanReview += 1;
    console.log(`[reconcile] ${issue.id} ${issue.status} ${result.action} (${result.reason || reason})`);
    return result;
  } catch (error) {
    console.error(`[reconcile] blocker route failed issue=${issue.id} ${error.message}`);
    return null;
  }
}

async function reconcileIssue(client, issueId, options = {}) {
  options = settingsFor(options);
  await client.query("BEGIN");
  try {
    await client.query(ADVISORY_LOCK_SQL, [issueId]);
    const locked = await client.query(
      "SELECT id, workspace_id, status, title, description, priority, metadata, qc_fail_count, parent_issue_id FROM issue WHERE id = $1::uuid FOR UPDATE",
      [issueId]
    );
    const issue = locked.rows[0];
    if (!issue) {
      await client.query("COMMIT");
      return { action: "skipped" };
    }
    const activeHold = activeAdjudicationHold(issue);
    if (!DISPATCHABLE.has(issue.status) && !activeHold) {
      await client.query("COMMIT");
      return { action: "skipped" };
    }
    if (activeHold?.purpose === "classification") {
      const routed = await routeClassifiedDecision(client, issue, activeHold.decision, options);
      await client.query("COMMIT");
      return routed;
    }
    if (activeHold?.purpose === "lifetime_exhaustion") {
      const held = await enforceLifetimeHold(client, issue, activeHold);
      await client.query("COMMIT");
      return held;
    }
    const mechanicalRetryAfter = issue.metadata?.mechanical_retry_after;
    if (mechanicalRetryAfter) {
      const remainingMs = Date.parse(mechanicalRetryAfter) - Date.now();
      if (Number.isFinite(remainingMs) && remainingMs > 0) {
        await client.query("COMMIT");
        return { action: "deferred", reason: "mechanical_retry_wait", retryAfterMinutes: Math.ceil(remainingMs / 60000) };
      }
      await client.query(
        `UPDATE issue
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb) - 'mechanical_retry_after',
                                    '{mechanical_retry_release_at}', to_jsonb(NOW()), true),
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [issue.id]
      );
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
          if (["ci", "sha", "dependency", "quota"].includes(admission.blockedOn)) {
            await client.query("COMMIT");
            return { action: "skipped", reason: admission.reason,
              blockedOn: admission.blockedOn, taskId: recent.id };
          }
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
    const budget = stageAttemptBudget(attempt, Number(stageAttempts.rows[0]?.max_attempts || 0), options.defaultMaxAttempts);
    const maxAttempts = budget.maxAttempts;
    if (options.typedOutcomes) {
      // GSP-1826: a recorded outcome for this stage with unchanged inputs is final until the inputs change.
      const eligibility = await stageEligibility(client, issue.id, issue.status, {
        failedTtlMinutes: options.failedTtlMinutes,
        attempt,
        maxAttempts,
        releaseAt: issue.metadata?.human_review_release_at
      });
      if (eligibility.eligible && eligibility.reason === "advanced_stall") {
        console.log(`[reconcile] advanced_stall: issue=${issue.id} stage=${issue.status}`);
      }
      if (!eligibility.eligible) {
        if (eligibility.reason === "outcome_missing_input_hash") {
          const deferred = await deferMechanicalRetry(
            client, issue, eligibility.reason, options.mechanicalRetryMinutes);
          await client.query("COMMIT");
          return deferred;
        }
        // Nothing left to observe means the stage needs a durable disposition.
        // Only an explicit human blocker uses Human Review; machine-observable
        // technical blockers return to the agent-owned Spec stage.
        const routed = await routeTerminalBlocker(client, issue, eligibility.prior, options);
        if (!routed && eligibility.reason === "attempt_budget_exhausted") {
          const capReason = `${eligibility.reason}:${attempt}/${maxAttempts}`;
          const deferred = await deferMechanicalRetry(
            client, issue, capReason, options.mechanicalRetryMinutes);
          await client.query("COMMIT");
          return deferred;
        }
        await client.query("COMMIT");
        return routed || { action: "skipped", reason: eligibility.reason };
      }
    }
    // Exhaustion is a durable Parked hold. It never opens a mechanical retry
    // window and never selects an ordinary stage owner.
    const lifetime = await client.query(lifetimeTasksSql(), [issue.id, issue.status]);
    const lifetimeCount = Number(lifetime.rows[0]?.count || 0);
    if (lifetimeCount >= options.lifetimeTaskLimit) {
      const held = await moveToLifetimeHold(
        client, issue, lifetimeCount, options.lifetimeTaskLimit);
      await client.query("COMMIT");
      return held;
    }
    if (issue.status === "CI/CD & Deploy") {
      // The CI/CD worker owns this stage's exit; a desk task here buys nothing.
      await client.query("COMMIT");
      return { action: "skipped", reason: "worker_owned_stage" };
    }
    const admission = await buildTaskAdmission(client, { issueId: issue.id, toStage: issue.status, locked: true });
    if (!admission.admit) {
      if (admission.reason === "completed_build_work_product") {
        // The completed task is the durable build product. Arm its relay row
        // so the normal completion loop records and routes it without another
        // build. A completed row is re-opened only while the current stage
        // outcome still points at a different task.
        const armed = await armCompletedBuildWorkProduct(
          client, issue.id, issue.status, admission.reuseTaskId, options.issueCooldownMinutes);
        if (armed.stalled) {
          const reason = "completed_build_work_product_handoff_stalled";
          const routed = await moveToAgentDecision(client, issue, reason, options);
          if (routed) {
            await client.query("COMMIT");
            return routed;
          }
          await client.query("COMMIT");
          return { action: "skipped", reason, taskId: admission.reuseTaskId };
        }
        await client.query("COMMIT");
        if (armed.rows.length) return { action: "handoff", taskId: admission.reuseTaskId };
        return { action: "reused", taskId: admission.reuseTaskId, reason: admission.reason };
      }
      await client.query("COMMIT");
      return { action: "reused", taskId: admission.reuseTaskId, reason: admission.reason };
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
    const context = { ...taskContext(issue.status), ...(route.route ? { builder_route: route.route } : {}),
      ...(admission.qcAttemptId ? { qc_attempt_id: admission.qcAttemptId } : {}) };
    const retryColumn = admission.retryOfTaskId ? ', retry_of_task_id' : '';
    const retryValue = admission.retryOfTaskId ? ', $12::uuid' : '';
    const created = await client.query(
      `INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, workspace_id, status, priority, context,
          trigger_summary, originator_source, attempt, max_attempts${retryColumn})
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'queued', $5, $6::jsonb, $7, 'reconcile', $8, $9${retryValue}
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_task_queue active
           WHERE active.issue_id = $3::uuid AND active.status = ANY($10::text[])
             AND active.context->>'to_stage' = $11
        )
       ON CONFLICT DO NOTHING RETURNING id`,
      [owner.agent_id, owner.selected_runtime_id, issue.id, issue.workspace_id, issue.priority === "urgent" ? 1 : 0,
        JSON.stringify(context), `reconcile ${issue.status}`, attempt + 1, maxAttempts, LIVE, issue.status,
        ...(admission.retryOfTaskId ? [admission.retryOfTaskId] : [])]
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

async function armCompletedBuildWorkProduct(client, issueId, stage, taskId, staleMinutes = 30) {
  await client.query(
    `UPDATE relay_run_log SET task_id = NULL
      WHERE task_id = $1::uuid AND status = 'completed'
        AND to_stage IS DISTINCT FROM $2::text`,
    [taskId, stage]
  );
  // A completed relay row normally means this task was already consumed at
  // this stage. If the stage outcome still cites another task, however, the
  // completion never became authoritative (for example after the historical
  // refusal writer overwrote the row). Re-open that exact relay row once so
  // the normal completion path can record and route the newest task result.
  const rearmed = await client.query(
    `UPDATE relay_run_log completed SET status = 'pending',
        parked_audit = COALESCE(completed.parked_audit, '{}'::jsonb) ||
          jsonb_build_object('rearmed_reason', 'stage_outcome_task_mismatch')
      WHERE completed.issue_id = $1::uuid AND completed.task_id = $3::uuid
        AND completed.to_stage IS NOT DISTINCT FROM $2::text
        AND completed.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM issue_stage_outcome outcome
           WHERE outcome.issue_id = $1::uuid AND outcome.stage = $2::text
             AND outcome.task_id = $3::uuid)
      RETURNING completed.task_id`,
    [issueId, stage, taskId]
  );
  if (rearmed.rows.length) return rearmed;
  const inserted = await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, agent_id, task_id, status)
     SELECT $1::uuid, $2::text, $2::text, task.agent_id, task.id, 'pending'
       FROM agent_task_queue task
      WHERE task.id = $3::uuid AND task.issue_id = $1::uuid AND task.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM relay_run_log existing
           WHERE existing.task_id = task.id
             AND existing.to_stage IS NOT DISTINCT FROM $2::text
             AND existing.status IN ('pending', 'completed', 'rejected')
        )
     RETURNING task_id`,
    [issueId, stage, taskId]
  );
  if (inserted.rows.length) return inserted;
  const stalled = await client.query(
    `SELECT task_id FROM relay_run_log
      WHERE issue_id = $1::uuid AND task_id = $3::uuid
        AND to_stage IS NOT DISTINCT FROM $2::text AND status = 'pending'
        AND created_at <= NOW() - ($4::int * INTERVAL '1 minute')
      LIMIT 1`,
    [issueId, stage, taskId, staleMinutes]
  );
  return { ...inserted, stalled: stalled.rows.length > 0 };
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
      console.error(
        `Reconcile issue error: issue=${issue.id} status=${issue.status} ${error.message}`,
      );
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

module.exports = { ADVISORY_LOCK_SQL, DISPATCHABLE, LIVE, issueCandidatesSql, isLeafSql, liveTasksSql, ownerSql, lifetimeTasksSql, stageAttemptsSql, stageAttemptBudget, taskContext, moveToHumanReview, moveToAgentDecision, moveToLifetimeHold, enforceLifetimeHold, routeClassifiedDecision, deferMechanicalRetry, terminalBlocker, commentPullRequestUrl, linkObservedPullRequest, mergedPullRequestNoop, armCompletedBuildWorkProduct, reconcileIssue, reconcileCycle };
