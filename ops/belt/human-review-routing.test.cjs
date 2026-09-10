"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyHumanReviewRequest,
  decisionRevision,
  humanReviewDestination,
  humanReviewRoutingDecision,
  latestQcBlockerEvidence,
  suggestedCategory
} = require("./human-review-routing.cjs");

function trusted(ticket, category, extra = {}) {
  return {
    trusted: true,
    category,
    decision_revision: decisionRevision(ticket),
    assessor_id: "astra-agent",
    assessor_task_id: "astra-task",
    rationale: category === "technical" ? undefined : "actual pending decision",
    ...extra
  };
}

test("phrase matches are suggestions and never execution authorization", () => {
  const money = { id: "i1", title: "Issue refund for a client overcharge" };
  const technical = { id: "i2", title: "Fix issue list sorting bug" };
  assert.equal(suggestedCategory(money), "money");
  assert.equal(classifyHumanReviewRequest(money).category, "unclassified");
  assert.equal(humanReviewDestination(money), null);
  assert.equal(classifyHumanReviewRequest(technical).category, "unclassified");
  assert.equal(humanReviewDestination(technical), null);
});

test("current trusted Astra classifications select only the bounded destination", () => {
  const money = { id: "i1", title: "Refund request", reason: "Decide whether to refund $500" };
  const structural = { id: "i2", title: "Storage cutover", reason: "Choose the canonical store" };
  const technical = { id: "i3", title: "Fix the fixture", reason: "Repair test setup" };
  assert.equal(humanReviewDestination(money, trusted(money, "money")), "Human Review");
  assert.equal(humanReviewDestination(structural, trusted(structural, "structural")), "Human Review");
  assert.equal(humanReviewDestination(technical, trusted(technical, "technical")), "Spec");
});

test("stale, incomplete, and request-authored classifications fail closed", () => {
  const ticket = { id: "i1", title: "Fix fixture", reason: "Repair test setup",
    metadata: { human_review_category: "technical" } };
  assert.equal(classifyHumanReviewRequest(ticket).category, "unclassified");
  assert.equal(classifyHumanReviewRequest(ticket, { ...trusted(ticket, "technical"),
    decision_revision: "stale" }).category, "unclassified");
  assert.equal(classifyHumanReviewRequest(ticket, { category: "technical",
    decision_revision: decisionRevision(ticket) }).category, "unclassified");
});

test("irreversible_production normalizes only with a fundamental or canonical-data rationale", () => {
  const routine = { id: "i1", title: "Send queued vendor email", reason: "Deliver outbound mail" };
  assert.equal(classifyHumanReviewRequest(routine, trusted(routine, "irreversible_production", {
    rationale: "outbound delivery cannot be unsent"
  })).category, "unclassified");
  const canonical = { id: "i2", title: "Delete originals", reason: "Choose whether to delete originals" };
  assert.equal(classifyHumanReviewRequest(canonical, trusted(canonical, "irreversible_production", {
    rationale: "changes the canonical-data retention contract"
  })).category, "structural");
});

test("metadata, phrase, and NO-SHA routing matrix remains fail closed", () => {
  const cases = [
    [{ id: "m", title: "Billing ledger fixture", metadata: { human_review_category: "technical" } }, null],
    [{ id: "p", title: "Raise daily spend cap to $200" }, null],
    [{ id: "n", title: "Do not issue refund; fix the fixture", reason: "QC-BLOCKED NO-SHA" }, "money"],
    [{ id: "s", title: "Migrate the source of truth from D1 to Postgres; drop old tables" }, null]
  ];
  for (const [ticket, suggestion] of cases) {
    const result = classifyHumanReviewRequest(ticket);
    assert.equal(result.category, "unclassified", ticket.id);
    assert.equal(result.suggestion, suggestion, ticket.id);
    assert.equal(humanReviewDestination(ticket), null, ticket.id);
  }
});

test("classification carries the actual pending decision and provenance", () => {
  const ticket = { id: "i1", title: "Billed retrieval", reason: "Tim must choose compensation" };
  const assessment = trusted(ticket, "money", { evidence: "task:decision-evidence", assessed_at: "2026-09-10T00:00:00Z" });
  const result = classifyHumanReviewRequest(ticket, assessment);
  assert.equal(result.decision, ticket.reason);
  assert.equal(result.decision_revision, decisionRevision(ticket));
  assert.deepEqual(result.provenance, {
    source: "trusted_astra_task", assessor_id: "astra-agent", assessor_task_id: "astra-task",
    assessed_at: "2026-09-10T00:00:00Z", evidence: "task:decision-evidence"
  });
});

test("latest QC NO-SHA overrides incidental money prose but not a distinct trusted money decision", () => {
  const ticket = { id: "i1", title: "Do not issue refund; fix the fixture",
    reason: "QC-BLOCKED NO-SHA: no implementation commit exists" };
  const latestQc = { kind: "no_artifact", task_id: "qc-new",
    provenance: "latest_eligible_qc_task" };
  assert.deepEqual(humanReviewRoutingDecision(classifyHumanReviewRequest(ticket), { latestQc }), {
    action: "no_artifact_rescope", category: "technical",
    provenance: "latest_eligible_qc_task", qc_task_id: "qc-new"
  });
  const distinctMoney = trusted(ticket, "money", { rationale: "Tim must choose an actual refund" });
  assert.deepEqual(humanReviewRoutingDecision(
    classifyHumanReviewRequest(ticket, distinctMoney), { latestQc }), {
    action: "transition", destination: "Human Review"
  });
});

test("latest-versus-stale QC selection follows only the newest eligible row", async () => {
  const issue = { id: "issue-1", workspace_id: "workspace-1" };
  const staleNoShaLatestPass = { query: async (sql) => {
    assert.match(sql, /ORDER BY t\.created_at DESC, t\.id DESC LIMIT 1/);
    return { rows: [{ id: "qc-new", status: "completed",
      result: { output: "QC VERDICT: PASS" }, content: null }] };
  } };
  assert.equal(await latestQcBlockerEvidence(staleNoShaLatestPass, issue), null);
  const latestNoSha = { query: async () => ({ rows: [{ id: "qc-new", status: "completed",
    result: { output: "QC-BLOCKED: no implementation SHA exists. NO-SHA." },
    content: "older incidental text" }] }) };
  assert.deepEqual(await latestQcBlockerEvidence(latestNoSha, issue), {
    kind: "no_artifact", task_id: "qc-new", status: "completed",
    provenance: "latest_eligible_qc_task"
  });
  const contradictory = { query: async () => ({ rows: [{ id: "qc-new", status: "completed",
    result: { output: "QC-BLOCKED NO-SHA\nQC VERDICT: FAIL\n" + "a".repeat(40) },
    content: null }] }) };
  assert.equal(await latestQcBlockerEvidence(contradictory, issue), null);
});
