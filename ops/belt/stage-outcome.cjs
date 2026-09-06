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

// Inputs the agent could have acted on: PR head sha, CI rollup, operator comment
// content, dependency states, spec/description body. Any change re-opens the stage.
//
// Comments contribute the md5 set of DISTINCT operator comment bodies
// (source_task_id IS NULL), never a comment id. Hashing the newest id let a
// builder's own blocker comment mutate the hash and re-dispatch the stage that
// had just reported BLOCKED, so a permanently blocked ticket rebuilt every
// cooldown window. Content excludes belt output; the DISTINCT set also makes a
// repeated identical operator note (the CI/CD worker re-posts one each poll) a
// no-op, while genuinely new operator text still re-opens the stage.
function stageInputHashSql() {
  return `
    WITH pr AS (
      SELECT p.id, p.head_sha, p.checks_rollup_state
      FROM issue_pull_request ipr JOIN github_pull_request p ON p.id = ipr.pull_request_id
      WHERE ipr.issue_id = $1::uuid ORDER BY p.updated_at DESC NULLS LAST LIMIT 1)
    SELECT md5(concat_ws('|',
      (SELECT head_sha FROM pr), (SELECT checks_rollup_state FROM pr),
      (SELECT string_agg(s.suite_id::text || ':' || s.status || ':' || coalesce(s.conclusion, ''), ',' ORDER BY s.suite_id)
         FROM github_pull_request_check_suite s
        WHERE s.pr_id = (SELECT id FROM pr) AND s.head_sha = (SELECT head_sha FROM pr)),
      (SELECT md5(string_agg(DISTINCT md5(c.content), ',' ORDER BY md5(c.content)))
         FROM comment c WHERE c.issue_id = i.id AND c.source_task_id IS NULL),
      (SELECT string_agg(d.depends_on_issue_id::text || ':' || di.status, ',' ORDER BY d.depends_on_issue_id)
         FROM issue_dependency d JOIN issue di ON di.id = d.depends_on_issue_id WHERE d.issue_id = i.id),
      md5(coalesce(i.description, '')))) AS input_hash,
    i.status AS issue_status
    FROM issue i WHERE i.id = $1::uuid`;
}

function outcomeForStageSql() {
  return "SELECT outcome, blocked_on, input_hash, task_id, outcome_at FROM issue_stage_outcome WHERE issue_id = $1::uuid AND stage = $2::text";
}

function upsertOutcomeSql() {
  return `INSERT INTO issue_stage_outcome (issue_id, stage, outcome, blocked_on, task_id, input_hash, outcome_at)
    VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::text, NOW())
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
             t.result->>'output' AS output, t.completed_at
      FROM agent_task_queue t
      WHERE t.status = 'completed' AND t.completed_at > NOW() - ($1::int * interval '1 minute')
        AND t.context->>'to_stage' IS NOT NULL AND t.issue_id IS NOT NULL
        AND t.completed_at > COALESCE((SELECT max(l.created_at) FROM relay_run_log l
          WHERE l.issue_id = t.issue_id AND l.to_stage = t.context->>'to_stage'
            AND l.from_stage <> l.to_stage), '-infinity')
      ORDER BY t.issue_id, t.context->>'to_stage', t.completed_at DESC)
    SELECT latest.id, latest.issue_id, latest.stage, latest.output
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
async function recordStageOutcomes(client, { windowMinutes = 180, logger = console } = {}) {
  const rows = (await client.query(unrecordedCompletionsSql(), [windowMinutes])).rows;
  let recorded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      recorded += await recordOneOutcome(client, row, logger);
    } catch (error) {
      failed += 1;
      logger.log(`[stage-outcome] record failed task=${row.id} stage=${row.stage}: ${error?.message || error}`);
    }
  }
  return { scanned: rows.length, recorded, failed };
}

async function recordOneOutcome(client, row, logger) {
  const parsed = parseOutcome(row.output);
  // An In Progress completion is the implementation handoff. It cannot be
  // advanced without a linked PR and bound head SHA, so do not persist a
  // misleading terminal ADVANCED outcome when that evidence is absent.
  if (parsed.outcome === "ADVANCED" && row.stage === "In Progress") {
    const evidence = (await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM issue_pull_request ipr
         JOIN github_pull_request p ON p.id = ipr.pull_request_id
         WHERE ipr.issue_id = $1::uuid AND NULLIF(p.head_sha, '') IS NOT NULL
       ) AS has_review_evidence`, [row.issue_id])).rows[0];
    if (!evidence?.has_review_evidence) {
      parsed.outcome = "FAILED";
      parsed.blockedOn = null;
      logger.log(`[stage-outcome] rejected unsupported ADVANCED task=${row.id} stage=${row.stage}: missing review evidence`);
    }
  }
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
async function stageEligibility(client, issueId, stage, { failedTtlMinutes = Number.parseInt(process.env.MULTICA_FAILED_TTL_MINUTES || "15", 10), now = Date.now(), attempt, maxAttempts } = {}) {
  const prior = (await client.query(outcomeForStageSql(), [issueId, stage])).rows[0];
  if (!prior) return { eligible: true, reason: "no_outcome" };
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
  if (prior.outcome === "FAILED" && Number.isFinite(ttl) && ttl > 0 && Number.isFinite(outcomeAt) &&
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
  upsertOutcomeSql, unrecordedCompletionsSql, recordStageOutcomes, stageEligibility };
