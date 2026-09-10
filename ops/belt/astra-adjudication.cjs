"use strict";

const ASTRA_MODEL = "gpt-6-astra";
const ASTRA_ADJUDICATION_KIND = "astra_adjudication";
const ASTRA_OUTCOMES = new Set([
  "technical_scope", "bounded_repair", "duplicate_noop", "human_approval"
]);
const LIVE = ["queued", "dispatched", "running", "waiting_local_directory", "deferred"];

function resultText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  return [result.output, result.comment, result.text].filter((value) => typeof value === "string").join("\n");
}

function parseAstraOutcome(result) {
  const lines = resultText(result).split(/\r?\n/)
    .filter((value) => /^ASTRA_ADJUDICATION_JSON=/.test(value.trim()));
  if (lines.length !== 1) return null;
  let parsed;
  try {
    parsed = JSON.parse(lines[0].trim().slice("ASTRA_ADJUDICATION_JSON=".length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !ASTRA_OUTCOMES.has(parsed.outcome)) return null;
  if (typeof parsed.decision_revision !== "string" || !parsed.decision_revision) return null;
  if (typeof parsed.evidence !== "string" || !parsed.evidence.trim()) return null;
  if (["technical_scope", "bounded_repair"].includes(parsed.outcome) &&
      (typeof parsed.next_owner !== "string" || !parsed.next_owner.trim())) return null;
  if (parsed.outcome === "human_approval" &&
      !["money", "structural"].includes(parsed.category)) return null;
  if (["technical_scope", "bounded_repair", "duplicate_noop"].includes(parsed.outcome) &&
      parsed.category !== "technical") return null;
  if (parsed.outcome === "human_approval" &&
      (typeof parsed.rationale !== "string" || !parsed.rationale.trim())) return null;
  return parsed;
}

function isAstraAdjudicator(agent) {
  const config = agent?.runtime_config && typeof agent.runtime_config === "object"
    ? agent.runtime_config : {};
  const model = String(config.model || agent?.model || "").toLowerCase();
  const role = [config.role, config.lane, config.agent_role].filter(Boolean).join(" ").toLowerCase();
  const instructions = String(agent?.instructions || "").toLowerCase();
  return model === ASTRA_MODEL && config.astra_adjudication === true &&
    /adjudicat/.test(role) && /human review/.test(instructions) &&
    [...ASTRA_OUTCOMES].every((outcome) => instructions.includes(outcome));
}

function selectAstraAdjudicator(rows) {
  const candidates = (rows || []).filter(isAstraAdjudicator);
  const freeSlots = (row) => Math.max(0, Math.max(1, Number(row.max_concurrent_tasks || 1)) -
    Number(row.active_task_count || 0));
  const available = candidates.filter((row) => freeSlots(row) > 0 && row.runtime_id);
  const owner = available[0] || null;
  return {
    owner,
    reason: owner ? null : (candidates.length
      ? "astra_adjudication_owner_at_capacity" : "astra_adjudication_owner_absent"),
    candidate_count: candidates.length,
    aggregate_free_slots: candidates.reduce((sum, row) => sum + freeSlots(row), 0)
  };
}

function adjudicationContext(request) {
  return {
    kind: ASTRA_ADJUDICATION_KIND,
    purpose: request.purpose,
    decision: request.decision,
    decision_revision: request.decision_revision,
    suggested_category: request.suggestion || null,
    no_builder: true,
    outcomes: [...ASTRA_OUTCOMES],
    ...(request.reason ? { reason_code: request.reason } : {}),
    ...(request.attempts == null ? {} : { attempts: Number(request.attempts) }),
    ...(request.ceiling == null ? {} : { ceiling: Number(request.ceiling) })
  };
}

async function recordAstraAdjudication(client, issue, request) {
  const context = adjudicationContext(request);
  const hold = {
    reason: request.reason,
    purpose: request.purpose,
    decision: request.decision,
    decision_revision: request.decision_revision,
    suggestion: request.suggestion || null,
    provenance: request.provenance || { source: "none" },
    recorded_at: new Date().toISOString()
  };
  await client.query(
    `UPDATE issue
        SET metadata = COALESCE(metadata, '{}'::jsonb) ||
              jsonb_build_object('human_review_hold', $2::jsonb) ||
              CASE WHEN $3::text = 'lifetime_exhaustion'
                THEN jsonb_build_object('lifetime_budget_hold', jsonb_build_object(
                  'reason', 'lifetime_task_limit', 'decision_revision', $4::text,
                  'attempts', $5::int, 'ceiling', $6::int))
                ELSE '{}'::jsonb END,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [issue.id, JSON.stringify(hold), request.purpose, request.decision_revision,
      request.attempts ?? null, request.ceiling ?? null]
  );
  const existing = await client.query(
    `SELECT id, status FROM agent_task_queue
      WHERE issue_id = $1::uuid
        AND context->>'kind' = $2::text
        AND context->>'purpose' = $3::text
        AND context->>'decision_revision' = $4::text
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [issue.id, ASTRA_ADJUDICATION_KIND, request.purpose, request.decision_revision]
  );
  if (existing.rows[0]?.id) {
    const status = String(existing.rows[0].status || "").toLowerCase();
    const reason = status === "completed" ? "astra_adjudication_outcome_invalid"
      : ["failed", "cancelled"].includes(status) ? "astra_adjudication_task_terminal" : null;
    await client.query(reason
      ? `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) ||
           jsonb_build_object('astra_adjudication_blocker', $2::text), updated_at = NOW()
          WHERE id = $1::uuid`
      : `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) - 'astra_adjudication_blocker',
          updated_at = NOW() WHERE id = $1::uuid`, reason ? [issue.id, reason] : [issue.id]);
    return { task_id: existing.rows[0].id, owner: null, reason,
      candidate_count: null, aggregate_free_slots: null, reused: true };
  }
  const agents = await client.query(
    `SELECT a.id, a.name, a.model, a.runtime_config, a.runtime_id, a.instructions,
            a.max_concurrent_tasks,
            (SELECT count(*)::int FROM agent_task_queue active
              WHERE active.agent_id = a.id AND active.status = ANY($2::text[])) AS active_task_count
       FROM agent a
      WHERE a.workspace_id = $1::uuid AND a.archived_at IS NULL
        AND a.status IN ('idle', 'working')
        AND COALESCE(a.runtime_config->>'model', a.model) = $3::text
      ORDER BY a.updated_at ASC`, [issue.workspace_id, LIVE, ASTRA_MODEL]);
  const selection = selectAstraAdjudicator(agents.rows);
  if (!selection.owner) {
    await client.query(
      `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) ||
           jsonb_build_object('astra_adjudication_blocker', $2::text), updated_at = NOW()
        WHERE id = $1::uuid`, [issue.id, selection.reason]);
    return { task_id: null, ...selection };
  }
  const task = await client.query(
    `INSERT INTO agent_task_queue (
       agent_id, runtime_id, issue_id, workspace_id, status, priority, context,
       trigger_summary, force_fresh_session, originator_source,
       trigger_evidence_kind, attempt, max_attempts)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'queued', $5::int, $6::jsonb,
            $7::text, TRUE, 'unattributed', 'relay_disposition', 1, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_task_queue existing
         WHERE existing.issue_id = $3::uuid
           AND existing.context->>'kind' = $8::text
           AND existing.context->>'purpose' = $9::text
           AND existing.context->>'decision_revision' = $10::text)
     ON CONFLICT DO NOTHING RETURNING id`,
    [selection.owner.id, selection.owner.runtime_id, issue.id, issue.workspace_id,
      issue.priority === "urgent" ? 1 : 0, JSON.stringify(context),
      `Astra adjudication required: ${request.reason}`, ASTRA_ADJUDICATION_KIND,
      request.purpose, request.decision_revision]
  );
  await client.query(
    `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) - 'astra_adjudication_blocker',
        updated_at = NOW() WHERE id = $1::uuid`, [issue.id]);
  return { task_id: task.rows[0]?.id || null, ...selection };
}

async function trustedAstraAssessment(client, issue, decisionRevision, purpose) {
  const task = await client.query(
    `SELECT t.id, t.agent_id, t.result, t.completed_at,
            a.name, a.model, a.runtime_config, a.instructions
       FROM agent_task_queue t
       JOIN agent a ON a.id = t.agent_id AND a.workspace_id = t.workspace_id
      WHERE t.issue_id = $1::uuid AND t.status = 'completed'
        AND t.context->>'kind' = $2::text
        AND t.context->>'purpose' = $3::text
        AND t.context->>'decision_revision' = $4::text
      ORDER BY t.completed_at DESC NULLS LAST, t.created_at DESC, t.id DESC LIMIT 1`,
    [issue.id, ASTRA_ADJUDICATION_KIND, purpose, decisionRevision]);
  const row = task.rows[0];
  if (!row || !isAstraAdjudicator(row)) return null;
  const outcome = parseAstraOutcome(row.result);
  if (!outcome || outcome.decision_revision !== decisionRevision) return null;
  return {
    trusted: true,
    category: outcome.category,
    decision_revision: decisionRevision,
    assessor_id: row.agent_id,
    assessor_task_id: row.id,
    assessed_at: row.completed_at || null,
    evidence: outcome.evidence,
    rationale: outcome.rationale,
    outcome: outcome.outcome,
    next_owner: outcome.next_owner || null
  };
}

async function persistTrustedAstraAssessment(client, issue, purpose, assessment) {
  const durable = {
    category: assessment.category,
    decision_revision: assessment.decision_revision,
    assessor_id: assessment.assessor_id,
    assessor_task_id: assessment.assessor_task_id,
    assessed_at: assessment.assessed_at,
    evidence: assessment.evidence,
    rationale: assessment.rationale || null,
    outcome: assessment.outcome,
    next_owner: assessment.next_owner || null
  };
  if (purpose === "lifetime_exhaustion") {
    await client.query(
      `UPDATE issue SET metadata = (COALESCE(metadata, '{}'::jsonb) ||
           jsonb_build_object('lifetime_budget_ruling', $2::jsonb)) - 'astra_adjudication_blocker',
          updated_at = NOW()
        WHERE id = $1::uuid
          AND metadata->'lifetime_budget_hold'->>'decision_revision' = $3::text`,
      [issue.id, JSON.stringify(durable), assessment.decision_revision]);
    return;
  }
  await client.query(
    `UPDATE issue SET metadata = (COALESCE(metadata, '{}'::jsonb) ||
         jsonb_build_object('human_review_assessment', $2::jsonb)) -
         'human_review_hold' - 'astra_adjudication_blocker', updated_at = NOW()
      WHERE id = $1::uuid
        AND metadata->'human_review_hold'->>'decision_revision' = $3::text`,
    [issue.id, JSON.stringify(durable), assessment.decision_revision]);
}

function activeAdjudicationHold(issue) {
  const metadata = issue?.metadata && typeof issue.metadata === "object" ? issue.metadata : {};
  if (metadata.lifetime_budget_hold?.decision_revision) {
    return { ...metadata.lifetime_budget_hold, purpose: "lifetime_exhaustion",
      reason: "lifetime_task_limit", decision: "resolve exhausted lifetime task budget" };
  }
  if (metadata.human_review_hold?.decision_revision) return metadata.human_review_hold;
  return null;
}

module.exports = {
  ASTRA_ADJUDICATION_KIND,
  ASTRA_MODEL,
  ASTRA_OUTCOMES,
  adjudicationContext,
  isAstraAdjudicator,
  parseAstraOutcome,
  persistTrustedAstraAssessment,
  recordAstraAdjudication,
  selectAstraAdjudicator,
  activeAdjudicationHold,
  trustedAstraAssessment
};
