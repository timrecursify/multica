"use strict";
// Typed stage outcomes (GSP-1826). One row per (issue, stage): what the last agent
// run concluded and the hash of the inputs it saw. The reconciler re-dispatches a
// stage only when no outcome exists or the input hash changed.

const OUTCOMES = new Set(["ADVANCED", "BLOCKED", "NO_OP", "FAILED"]);
const BLOCKED_ON = new Set(["ci", "human", "sha", "dependency", "quota", "checkout"]);
// `blocked_on=` is the documented form (WORKER_COMMON.md). Workers also emit the
// reason as a bare token ("OUTCOME: BLOCKED sha"); accept both so a naming slip
// does not drop the run onto the legacy heuristics.
const LINE = /^\s*OUTCOME:\s*(ADVANCED|BLOCKED|NO_OP|FAILED)(?:\s+(?:blocked_on=)?([a-z_]+))?\s*$/i;

// Contract: the last non-empty output line is `OUTCOME: <kind>[ blocked_on=<why>]`.
// Legacy heuristics keep pre-contract output useful; anything else is FAILED.
function parseOutcome(output) {
  const text = String(output || "");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(-5).reverse()) {
    const m = LINE.exec(line);
    if (m) {
      const outcome = m[1].toUpperCase();
      const blockedOn = m[2] ? m[2].toLowerCase() : null;
      // A checkout timeout is an infrastructure blocker, never an inter-ticket
      // dependency. Correct the common worker mistake at the parsing boundary
      // so it cannot strand a flight under the wrong terminal reason.
      const checkoutTimeout = /checkout[\s_-]*(?:wait|tim(?:e|ed)[\s_-]*out)|(?:wait|tim(?:e|ed)[\s_-]*out)[\s_-]*checkout/i.test(text);
      const normalized = outcome === "BLOCKED" && checkoutTimeout && blockedOn === "dependency" ? "checkout" : blockedOn;
      return { outcome, blockedOn: outcome === "BLOCKED" && BLOCKED_ON.has(normalized) ? normalized : null, typed: true };
    }
  }
  return { ...legacyOutcome(text), typed: false };
}

function legacyOutcome(text) {
  if (/"qualifying"\s*:\s*true/.test(text) || /"verdict"\s*:\s*"(PASS|FAIL)"/.test(text)) return { outcome: "ADVANCED", blockedOn: null };
  // A transition_denied response is idempotent (the issue may already be in
  // the requested stage), but evidence_missing is a hard relay rejection:
  // required evidence was not supplied and the stage did not move.
  if (/relay transition .* denied \(409 transition_denied\)|BUILD-READY posted|specification posted.*now in Queue/i.test(text)) return { outcome: "ADVANCED", blockedOn: null };
  if (/relay rejected .* evidence_missing/i.test(text)) return { outcome: "FAILED", blockedOn: null };
  if (/QC-BLOCKED NO-SHA|no implementation (pull request|commit)/i.test(text)) return { outcome: "BLOCKED", blockedOn: "sha" };
  if (/blocked by (queued|pending|running) CI|waiting (on|for) CI/i.test(text)) return { outcome: "BLOCKED", blockedOn: "ci" };
  if (/usage limit|provider_quota_limit/i.test(text)) return { outcome: "BLOCKED", blockedOn: "quota" };
  if (/checkout[\s_-]*(?:wait|tim(?:e|ed)[\s_-]*out)|(?:wait|tim(?:e|ed)[\s_-]*out)[\s_-]*checkout/i.test(text)) return { outcome: "BLOCKED", blockedOn: "checkout" };
  if (/already[- ]merged|already deployed|nothing to do/i.test(text)) return { outcome: "NO_OP", blockedOn: null };
  if (/https:\/\/github\.com\/[^\s]+\/pull\/\d+/.test(text)) return { outcome: "ADVANCED", blockedOn: null };
  if (/^\s*(Blocked|Unable|Cannot|Could not|Failed|Error)\b/i.test(text) || /\bblocked\b.*\b(fail-closed|checkout|session expired|filesystem)/i.test(text)) return { outcome: "FAILED", blockedOn: null };
  if (/\b(BUILD-READY|QC PASS|verified|validated|implemented|posted|merged|tests? pass)\b/i.test(text)) return { outcome: "ADVANCED", blockedOn: null };
  return { outcome: "FAILED", blockedOn: null };
}

// The active work product is the only ownership/input record. Comment prose and
// historical issue-to-PR links are presentation data and cannot re-open a stage.
function stageInputHashSql() {
  return `
    WITH product AS (
      SELECT wp.* FROM issue_work_product wp
      WHERE wp.issue_id = $1::uuid AND wp.status = 'active'
    ), pr AS (
      SELECT gh.id, gh.head_sha, gh.checks_rollup_state
      FROM product wp JOIN issue i ON i.id = wp.issue_id
      JOIN github_pull_request gh ON gh.workspace_id = i.workspace_id
       AND gh.repo_owner || '/' || gh.repo_name = wp.repository
       AND gh.pr_number = wp.pr_number AND gh.head_sha = wp.head_sha
      WHERE wp.kind = 'implementation' LIMIT 1)
    SELECT CASE WHEN wp.issue_id IS NULL THEN NULL ELSE md5(concat_ws('|',
      wp.scope_revision::text, wp.kind, wp.repository, wp.branch,
      wp.pr_number::text, wp.head_sha, wp.consuming_stage,
      md5(wp.acceptance_evidence::text),
      (SELECT checks_rollup_state FROM pr),
      (SELECT string_agg(s.suite_id::text || ':' || s.status || ':' || coalesce(s.conclusion, ''), ',' ORDER BY s.suite_id)
         FROM github_pull_request_check_suite s
        WHERE s.pr_id = (SELECT id FROM pr) AND s.head_sha = (SELECT head_sha FROM pr)),
      (SELECT string_agg(dep.id::text || ':' || dep.status, ',' ORDER BY dep.id)
         FROM unnest(wp.dependency_issue_ids) dependency(dependency_id)
         JOIN issue dep ON dep.id = dependency.dependency_id)
    )) END AS input_hash,
    i.status AS issue_status
    FROM issue i LEFT JOIN product wp ON wp.issue_id = i.id
    WHERE i.id = $1::uuid`;
}

function outcomeForStageSql() {
  return "SELECT outcome, blocked_on, input_hash, task_id, outcome_at FROM issue_stage_outcome WHERE issue_id = $1::uuid AND stage = $2::text";
}

function upsertOutcomeSql() {
  return `INSERT INTO issue_stage_outcome (issue_id, stage, outcome, blocked_on, task_id, input_hash, outcome_at)
    SELECT $1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::text, NOW()
    WHERE EXISTS (SELECT 1 FROM agent_task_queue t
      WHERE t.id = $5::uuid AND t.issue_id = $1::uuid AND t.context->>'to_stage' = $2::text)
    ON CONFLICT (issue_id, stage) DO UPDATE SET outcome = EXCLUDED.outcome, blocked_on = EXCLUDED.blocked_on,
      task_id = EXCLUDED.task_id, input_hash = EXCLUDED.input_hash, outcome_at = NOW()`;
}

// Completed stage tasks not yet recorded. Bounded window keeps the pass cheap.
//
// The table holds one row per (issue, stage), so only the newest completion of a
// stage can survive. Selecting every unrecorded sibling made the pass rewrite the
// same row on every cycle: recording an older run cleared the newer run's task_id,
// which made the newer run "unrecorded" again, so two completions of one stage
// ping-ponged the row for as long as they stayed in the window. DISTINCT ON keeps
// the newest completion per (issue, stage), which is what the row is defined to
// hold, so a recorded stage goes quiet instead of churning.
function unrecordedCompletionsSql() {
  return `WITH latest AS (
      SELECT DISTINCT ON (t.issue_id, t.context->>'to_stage')
             t.id, t.issue_id, t.context->>'to_stage' AS stage,
             t.result->>'output' AS output, t.created_at,
             CASE WHEN (t.context->>'scope_revision') ~ '^[1-9][0-9]*$'
               THEN (t.context->>'scope_revision')::bigint
               ELSE floor(extract(epoch FROM t.created_at) * 1000000)::bigint
             END AS scope_revision,
             t.completed_at
      FROM agent_task_queue t
      WHERE t.status = 'completed' AND t.completed_at > NOW() - ($1::int * interval '1 minute')
        AND t.context->>'to_stage' IS NOT NULL AND t.issue_id IS NOT NULL
        AND t.completed_at > COALESCE((SELECT max(l.created_at) FROM relay_run_log l
          WHERE l.issue_id = t.issue_id AND l.to_stage = t.context->>'to_stage'
            AND l.from_stage <> l.to_stage), '-infinity')
      ORDER BY t.issue_id, t.context->>'to_stage', t.completed_at DESC)
    SELECT latest.id, latest.issue_id, latest.stage, latest.output, latest.scope_revision
    FROM latest
    WHERE NOT EXISTS (SELECT 1 FROM issue_stage_outcome o WHERE o.task_id = latest.id)
    ORDER BY latest.completed_at ASC LIMIT 200`;
}

// One rejected write must never cost the whole pass. The pass reads the oldest
// unrecorded completions first, so a row the database refuses (a blocked_on value
// this deployment's CHECK constraint does not carry, say) would abort the batch,
// be re-read at the head of the next batch, and stall every later completion for
// as long as it stayed in the window. Each row is therefore isolated, and a write
// the database refuses is retried once without blocked_on so the outcome kind
// still lands.
async function recordStageOutcomes(client, { windowMinutes = 180, logger = console, githubCommand } = {}) {
  const rows = (await client.query(unrecordedCompletionsSql(), [windowMinutes])).rows;
  let recorded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      recorded += await recordOneOutcome(client, row, logger, githubCommand);
    } catch (error) {
      failed += 1;
      logger.log(`[stage-outcome] record failed task=${row.id} stage=${row.stage}: ${error?.message || error}`);
    }
  }
  return { scanned: rows.length, recorded, failed };
}

const PR_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/ig;

function uniqueOutputPullRequest(output) {
  const matches = [...String(output || '').matchAll(PR_URL)].map((match) => ({
    repository: `${match[1]}/${match[2]}`, prNumber: Number(match[3]), url: match[0]
  }));
  const unique = [...new Map(matches.map((match) =>
    [`${match.repository.toLowerCase()}#${match.prNumber}`, match])).values()];
  return unique.length === 1 ? unique[0] : null;
}

async function produceImplementationWorkProduct(client, row, githubCommand) {
  if (typeof githubCommand !== 'function') return false;
  await client.query("SELECT id FROM issue WHERE id = $1::uuid FOR UPDATE", [row.issue_id]);
  const active = (await client.query(
    `SELECT scope_revision, kind, repository, branch, pr_number
       FROM issue_work_product
      WHERE issue_id = $1::uuid AND status = 'active' FOR UPDATE`, [row.issue_id])).rows;
  if (active.length > 1 || (active[0] && active[0].kind !== 'implementation')) return false;

  const outputPr = uniqueOutputPullRequest(row.output);
  if (active[0] && outputPr &&
      (active[0].repository.toLowerCase() !== outputPr.repository.toLowerCase() ||
       Number(active[0].pr_number) !== outputPr.prNumber)) return false;
  const selectedRepository = active[0]?.repository || outputPr?.repository || null;
  const selectedPrNumber = active[0]?.pr_number || outputPr?.prNumber || null;
  const linked = (await client.query(
    `SELECT DISTINCT p.repo_owner || '/' || p.repo_name AS repository, p.pr_number,
            p.branch, p.html_url
       FROM issue_pull_request ipr
       JOIN github_pull_request p ON p.id = ipr.pull_request_id
       JOIN issue i ON i.id = ipr.issue_id AND i.workspace_id = p.workspace_id
      WHERE ipr.issue_id = $1::uuid
        AND ($2::text IS NULL OR lower(p.repo_owner || '/' || p.repo_name) = lower($2::text))
        AND ($3::int IS NULL OR p.pr_number = $3::int)
      `, [row.issue_id, selectedRepository, selectedPrNumber])).rows;
  if (linked.length !== 1) return false;
  const candidate = linked[0];
  if (active[0] && (active[0].repository.toLowerCase() !== candidate.repository.toLowerCase() ||
      Number(active[0].pr_number) !== Number(candidate.pr_number))) return false;

  let view;
  try {
    view = JSON.parse(await githubCommand(['pr', 'view', candidate.html_url, '--json',
      'number,url,headRefName,headRefOid'], { fresh: true }));
  } catch (_) { return false; }
  const sha = String(view?.headRefOid || '').toLowerCase();
  const branch = String(view?.headRefName || '');
  if (Number(view?.number) !== Number(candidate.pr_number) ||
      String(view?.url || '').toLowerCase() !== String(candidate.html_url).toLowerCase() ||
      !branch || !/^[0-9a-f]{40}$/.test(sha) ||
      (candidate.branch && candidate.branch !== branch) ||
      (active[0] && active[0].branch !== branch)) return false;

  const evidence = JSON.stringify({ source: 'github_api', task_id: row.id,
    pull_request_url: view.url, head_sha: sha });
  if (active[0]) {
    const updated = await client.query(
      `UPDATE issue_work_product SET head_sha = $2, acceptance_evidence = $3::jsonb,
          consuming_stage = 'In Review', updated_at = NOW()
        WHERE issue_id = $1::uuid AND status = 'active' AND kind = 'implementation'
          AND repository = $4 AND branch = $5 AND pr_number = $6::int
        RETURNING issue_id`, [row.issue_id, sha, evidence, active[0].repository,
        active[0].branch, active[0].pr_number]);
    return updated.rowCount === 1;
  }
  const inserted = await client.query(
    `INSERT INTO issue_work_product (issue_id, scope_revision, kind, repository, branch,
        pr_number, head_sha, acceptance_evidence, replaces_scope_revision,
        consuming_stage, dependency_issue_ids, status)
      VALUES ($1::uuid, $2::bigint, 'implementation', $3, $4, $5::int, $6,
        $7::jsonb, NULL, 'In Review', '{}'::uuid[], 'active') RETURNING issue_id`,
    [row.issue_id, row.scope_revision, candidate.repository, branch, candidate.pr_number, sha, evidence]);
  return inserted.rowCount === 1;
}

async function recordOneOutcome(client, row, logger, githubCommand) {
  const parsed = parseOutcome(row.output);
  // Every implementation, no-change, and operational handoff has one explicit
  // active product with verified evidence. Free text cannot supply ownership.
  if (parsed.outcome === "ADVANCED" && row.stage === "In Progress") {
    await client.query('BEGIN');
    try {
      const productProduced = await produceImplementationWorkProduct(client, row, githubCommand);
      const evidence = (await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM issue_work_product wp
           WHERE wp.issue_id = $1::uuid AND wp.status = 'active'
             AND wp.consuming_stage = 'In Review'
             AND wp.acceptance_evidence <> '{}'::jsonb
             AND (
               (wp.kind = 'implementation' AND wp.repository IS NOT NULL
                 AND wp.branch IS NOT NULL AND wp.pr_number IS NOT NULL
                 AND wp.head_sha ~ '^[0-9a-f]{40}$')
               OR (wp.kind IN ('no_change', 'operational')
                 AND wp.acceptance_evidence->>'verified' = 'true')
             )
         ) AS has_review_evidence`, [row.issue_id])).rows[0];
      if (!productProduced || !evidence?.has_review_evidence) {
        parsed.outcome = "FAILED";
        parsed.blockedOn = null;
        logger.log(`[stage-outcome] rejected unsupported ADVANCED task=${row.id} stage=${row.stage}: missing review evidence`);
      }
      const result = await persistOutcome(client, row, parsed, logger);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  return persistOutcome(client, row, parsed, logger);
}

async function persistOutcome(client, row, parsed, logger) {
  const hash = (await client.query(stageInputHashSql(), [row.issue_id])).rows[0]?.input_hash || null;
  try {
    await client.query(upsertOutcomeSql(), [row.issue_id, row.stage, parsed.outcome, parsed.blockedOn, row.id, hash]);
  } catch (error) {
    if (!parsed.blockedOn) throw error;
    logger.log(`[stage-outcome] blocked_on=${parsed.blockedOn} refused task=${row.id} stage=${row.stage}: ${error?.message || error}`);
    await client.query(upsertOutcomeSql(), [row.issue_id, row.stage, parsed.outcome, null, row.id, hash]);
  }
  if (!parsed.typed) logger.log(`[stage-outcome] legacy parse task=${row.id} stage=${row.stage} -> ${parsed.outcome}${parsed.blockedOn ? "/" + parsed.blockedOn : ""}`);
  return 1;
}

// Reconciler eligibility: dispatch only when nothing is recorded for this stage or
// the inputs changed since. BLOCKED/human never re-opens without a hash change.
// FAILED is retryable after a bounded TTL; callers may pass a clock/config for tests.
async function stageEligibility(client, issueId, stage, { failedTtlMinutes = Number.parseInt(process.env.MULTICA_FAILED_TTL_MINUTES || "15", 10), now = Date.now(), attempt, maxAttempts, releaseAt } = {}) {
  const prior = (await client.query(outcomeForStageSql(), [issueId, stage])).rows[0];
  if (!prior) return { eligible: true, reason: "no_outcome" };
  // An authenticated operator release starts a new decision epoch. Outcomes
  // recorded before that release cannot immediately replay the same Human
  // Review escalation; a genuinely new task result records a fresh outcome.
  const releaseTime = Date.parse(releaseAt || "");
  const priorTime = Date.parse(prior.outcome_at || "");
  if (Number.isFinite(releaseTime) && Number.isFinite(priorTime) && priorTime < releaseTime) {
    return { eligible: true, reason: "operator_release_epoch", prior };
  }
  const currentRow = (await client.query(stageInputHashSql(), [issueId])).rows[0] || {};
  const current = currentRow.input_hash || null;
  // A recorded outcome belongs only to the stage that recorded it. Once the
  // issue has moved on, never re-open that historical stage—even if another
  // input changed later.
  if (currentRow.issue_status && currentRow.issue_status !== stage) {
    return { eligible: false, reason: `stage_moved_on:${currentRow.issue_status}`, prior };
  }
  if (current && prior.input_hash && current !== prior.input_hash) return { eligible: true, reason: "input_changed", prior };
  if (Number.isInteger(attempt) && Number.isInteger(maxAttempts) && attempt >= maxAttempts) {
    return { eligible: false, reason: "attempt_budget_exhausted", prior };
  }
  const ttl = Number(failedTtlMinutes);
  const outcomeAt = Date.parse(prior.outcome_at);
  // A human blocker is terminal, not a transient builder failure.  Let the
  // reconciler route it to Human Review instead of reopening it after the
  // generic failure TTL and reaching build admission first.
  if (prior.outcome === "FAILED" && prior.blocked_on !== "human" &&
      Number.isFinite(ttl) && ttl > 0 && Number.isFinite(outcomeAt) &&
      Number(now) - outcomeAt >= ttl * 60 * 1000) {
    return { eligible: true, reason: "failed_ttl_expired", prior };
  }
  if (prior.outcome === "ADVANCED") {
    const configured = Number(process.env.MULTICA_ADVANCED_STALL_TTL_MINUTES);
    const ttlMinutes = Number.isFinite(configured) && configured > 0 ? configured : 15;
    const outcomeAt = Date.parse(prior.outcome_at);
    if (currentRow.issue_status === stage && Number.isFinite(outcomeAt) &&
        Number(now) - outcomeAt >= ttlMinutes * 60 * 1000) {
      return { eligible: true, reason: "advanced_stall", prior };
    }
  }
  return { eligible: false, reason: `outcome_unchanged:${prior.outcome}${prior.blocked_on ? "/" + prior.blocked_on : ""}`, prior };
}

module.exports = { OUTCOMES, BLOCKED_ON, parseOutcome, legacyOutcome, stageInputHashSql, outcomeForStageSql,
  upsertOutcomeSql, unrecordedCompletionsSql, recordStageOutcomes, stageEligibility,
  uniqueOutputPullRequest, produceImplementationWorkProduct };
