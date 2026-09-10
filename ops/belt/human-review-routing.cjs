"use strict";

const { createHash } = require("node:crypto");
const { qcLaneModelsSqlArray, QC_LANE_EFFORT } = require("./qc-lane.cjs");

const HUMAN_REVIEW_CATEGORIES = new Set(["money", "structural"]);
const CLASSIFICATIONS = new Set(["money", "structural", "technical"]);
const MONEY_TERMS = [
  "real money", "client charge", "charge client", "issue refund", "client refund",
  "change client pricing", "invoice amount", "make payout", "client billed",
  "customer billed", "payment amount"
];
const STRUCTURAL_TERMS = [
  "expensive to reverse", "no migration back",
  "retire canonical", "replace canonical", "canonical component", "fleet contract",
  "fundamental architecture", "structural architecture"
];
const STRUCTURAL_RATIONALE = /\b(?:fundamental|canonical(?:[ -]data|[ -]store|[ -]source|[ -]copy)?|source of truth|retention contract|rollback contract)\b/i;

function metadataObject(ticket) {
  return ticket?.metadata && typeof ticket.metadata === "object" && !Array.isArray(ticket.metadata)
    ? ticket.metadata : {};
}

function pendingDecision(ticket) {
  const metadata = metadataObject(ticket);
  const value = ticket?.pending_decision ?? ticket?.reason ?? metadata.human_review_decision;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scopeRevision(ticket) {
  const metadata = metadataObject(ticket);
  for (const value of [metadata.human_review_scope_revision, metadata.scope_revision,
    metadata.binding_spec_revision, metadata.work_product_md5]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function decisionRevision(ticket, decision = pendingDecision(ticket)) {
  const canonical = JSON.stringify({
    issue_id: ticket?.id == null ? null : String(ticket.id),
    title: typeof ticket?.title === "string" ? ticket.title : "",
    description: typeof ticket?.description === "string" ? ticket.description : "",
    decision,
    scope_revision: scopeRevision(ticket)
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function noArtifactQcText(value) {
  if (typeof value !== "string" || !/^\s*QC[- ]BLOCKED\b/im.test(value)) return false;
  if (/^\s*QC\s+VERDICT\s*:\s*(?:PASS|FAIL)\b/im.test(value) || /QC_EVIDENCE_JSON=/m.test(value)) return false;
  if (/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.test(value) || /\b[0-9a-f]{40}\b/i.test(value)) return false;
  return /\bNO-SHA\b/i.test(value) ||
    /\bno\s+(?:(?:implementation|bound|reviewable)\s+)?SHA\b/i.test(value) ||
    /\bno\s+(?:linked\s+)?PR\b/i.test(value) ||
    /\bno\s+immutable\s+tracked-tree\s+artifact\b/i.test(value);
}

// The ORDER BY is part of the safety contract: stale QC prose must never
// override the newest eligible QC task/result/comment.
async function latestQcBlockerEvidence(client, issue) {
  const latest = await client.query(
    `SELECT t.id, t.status, t.result, c.content
       FROM agent_task_queue t
       JOIN agent a ON a.id = t.agent_id AND a.workspace_id = t.workspace_id
       LEFT JOIN LATERAL (
         SELECT content FROM comment
          WHERE issue_id = t.issue_id AND author_type = 'agent' AND author_id = t.agent_id
            AND created_at >= t.created_at
          ORDER BY created_at DESC, id DESC LIMIT 1
       ) c ON true
      WHERE t.issue_id = $1 AND t.workspace_id = $2
        AND t.context->>'to_stage' = 'In Review'
        AND t.status IN ('queued','dispatched','running','waiting_local_directory','deferred','completed')
        AND COALESCE(a.model, a.runtime_config->>'model') = ANY($3::text[])
        AND COALESCE(a.thinking_level, a.runtime_config->>'reasoning_effort') = $4::text
      ORDER BY t.created_at DESC, t.id DESC LIMIT 1`,
    [issue.id, issue.workspace_id, qcLaneModelsSqlArray(), QC_LANE_EFFORT]);
  const row = latest.rows[0];
  if (!row) return null;
  const output = typeof row.result === "string" ? row.result
    : row.result && typeof row.result === "object" ? row.result.output : null;
  if (!noArtifactQcText(output) && !noArtifactQcText(row.content)) return null;
  return { kind: "no_artifact", task_id: row.id, status: row.status,
    provenance: "latest_eligible_qc_task" };
}

// Phrase matching is a queueing hint only. In particular, it cannot prove that
// a request is technical, and therefore can never authorize an execution stage.
function suggestedCategory(ticket, decision = pendingDecision(ticket)) {
  const text = [decision, ticket?.title, ticket?.description]
    .filter((value) => typeof value === "string").join("\n").toLowerCase();
  if (includesAny(text, MONEY_TERMS)) return "money";
  if (includesAny(text, STRUCTURAL_TERMS)) return "structural";
  const metadata = metadataObject(ticket);
  const legacy = String(metadata.human_review_category || "").trim().toLowerCase();
  if (HUMAN_REVIEW_CATEGORIES.has(legacy)) return legacy;
  if (legacy === "irreversible_production" && STRUCTURAL_RATIONALE.test(
    String(metadata.human_review_rationale || metadata.structural_rationale || ""))) {
    return "structural";
  }
  return null;
}

function normalizedAssessmentCategory(assessment) {
  const raw = String(assessment?.category || "").trim().toLowerCase();
  if (CLASSIFICATIONS.has(raw)) return raw;
  if (raw === "irreversible_production" &&
      STRUCTURAL_RATIONALE.test(String(assessment?.rationale || ""))) return "structural";
  return null;
}

function trustedAssessment(ticket, assessment, revision) {
  const category = normalizedAssessmentCategory(assessment);
  if (!category || assessment?.trusted !== true || assessment?.decision_revision !== revision ||
      typeof assessment?.assessor_id !== "string" || !assessment.assessor_id ||
      typeof assessment?.assessor_task_id !== "string" || !assessment.assessor_task_id) return null;
  if ((category === "money" || category === "structural") &&
      typeof assessment?.rationale !== "string") return null;
  return { ...assessment, category };
}

// Tri-state classification. Only a trusted, current Astra task assessment can
// resolve the classification. Request metadata and phrases retain provenance as
// suggestions so the adjudicator has context, but neither is an admission token.
function classifyHumanReviewRequest(ticket, assessment = null) {
  const decision = pendingDecision(ticket);
  const revision = decisionRevision(ticket, decision);
  const trusted = trustedAssessment(ticket, assessment, revision);
  if (trusted) {
    return {
      category: trusted.category,
      decision,
      decision_revision: revision,
      provenance: {
        source: "trusted_astra_task",
        assessor_id: trusted.assessor_id,
        assessor_task_id: trusted.assessor_task_id,
        assessed_at: trusted.assessed_at || null,
        evidence: trusted.evidence || null
      },
      suggestion: suggestedCategory(ticket, decision)
    };
  }
  const suggestion = suggestedCategory(ticket, decision);
  return {
    category: "unclassified",
    decision,
    decision_revision: revision,
    provenance: { source: suggestion ? "phrase_or_metadata_suggestion" : "none" },
    suggestion
  };
}

function humanReviewCategory(ticket, assessment = null) {
  return classifyHumanReviewRequest(ticket, assessment).category;
}

function isHumanReviewEligible(ticket, assessment = null) {
  return HUMAN_REVIEW_CATEGORIES.has(humanReviewCategory(ticket, assessment));
}

function humanReviewDestination(ticket, assessment = null) {
  const category = humanReviewCategory(ticket, assessment);
  if (HUMAN_REVIEW_CATEGORIES.has(category)) return "Human Review";
  if (category === "technical") return "Spec";
  return null;
}

function humanReviewRoutingDecision(classification, { latestQc = null, outcome = null } = {}) {
  if (latestQc?.kind === "no_artifact" &&
      !HUMAN_REVIEW_CATEGORIES.has(classification.category)) {
    return { action: "no_artifact_rescope", category: "technical",
      provenance: latestQc.provenance, qc_task_id: latestQc.task_id };
  }
  if (classification.category === "unclassified") {
    return { action: "hold", reason: "human_review_classification_required" };
  }
  if (outcome === "duplicate_noop") return { action: "no_op" };
  return { action: "transition", destination:
    HUMAN_REVIEW_CATEGORIES.has(classification.category) ? "Human Review" : "Spec" };
}

module.exports = {
  CLASSIFICATIONS,
  HUMAN_REVIEW_CATEGORIES,
  STRUCTURAL_RATIONALE,
  classifyHumanReviewRequest,
  decisionRevision,
  humanReviewCategory,
  humanReviewDestination,
  humanReviewRoutingDecision,
  isHumanReviewEligible,
  latestQcBlockerEvidence,
  noArtifactQcText,
  normalizedAssessmentCategory,
  pendingDecision,
  suggestedCategory
};
