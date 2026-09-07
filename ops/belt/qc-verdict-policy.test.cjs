"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateQcVerdict, validateEvidence } = require("./qc-verdict-policy.cjs");

const sha = "a".repeat(40);
const evidence = Object.freeze({ verdict: "PASS", work_product_md5: "b".repeat(32),
  bound_sha: sha, observed_sha: sha, failure_class: "none", qualifying: true,
  model: "gpt-5.6-sol", effort: "low" });
const task = (overrides = {}) => ({ id: "task-1", issue_id: "issue-1", workspace_id: "workspace-1",
  status: "completed", context: { to_stage: "In Review", head_sha: sha },
  agent: { model: "gpt-5.6-sol", thinking_level: "low" },
  result: { output: `QC_EVIDENCE_JSON=${JSON.stringify(evidence)}` }, ...overrides });
const worker = { type: "worker", authenticated_task_id: "task-1" };

test("qualifying PASS derives binding from the authenticated Sol-low task", () => {
  const result = validateQcVerdict({ actor: worker, task: task(), evidence });
  assert.equal(result.ok, true);
  assert.deepEqual(result.binding, { task_id: "task-1", issue_id: "issue-1", workspace_id: "workspace-1",
    bound_sha: sha, model: "gpt-5.6-sol", effort: "low" });
});

const failEvidence = (overrides = {}) => ({ ...evidence, verdict: "FAIL",
  failure_class: "implementation", qualifying: false,
  rework_summary: "ops/belt/stage-routing.cjs:19 returns null toStage for a merged risk PR", ...overrides });

test("implementation FAIL remains valid when task evidence matches", () => {
  const fail = failEvidence();
  const result = validateQcVerdict({ actor: worker, task: task({ result: { output: `QC_EVIDENCE_JSON=${JSON.stringify(fail)}` } }), evidence: fail });
  assert.equal(result.ok, true);
});

test("a FAIL must name the defect it is rejecting", () => {
  assert.equal(validateEvidence(failEvidence({ rework_summary: undefined })), "rework_summary_required");
  assert.equal(validateEvidence(failEvidence({ rework_summary: "   " })), "rework_summary_required");
  assert.equal(validateEvidence(failEvidence({ rework_summary: "implementation incomplete" })), "rework_summary_not_specific");
  assert.equal(validateEvidence(failEvidence({ rework_summary: "failed QC" })), "rework_summary_not_specific");
  assert.equal(validateEvidence(failEvidence({ rework_summary: "n/a" })), "rework_summary_not_specific");
  assert.equal(validateEvidence(failEvidence()), null);
});

test("qualifying true is reserved for a PASS", () => {
  assert.equal(validateEvidence(failEvidence({ qualifying: true })), "fail_must_not_qualify");
  assert.equal(validateEvidence(evidence), null);
});

test("a PASS never needs a rework summary", () => {
  assert.equal(validateEvidence({ ...evidence, rework_summary: undefined }), null);
});

test("the enforcement reaches the full verdict path, not just the validator", () => {
  const fail = failEvidence({ rework_summary: "none" });
  const result = validateQcVerdict({ actor: worker, task: task({ result: { output: `QC_EVIDENCE_JSON=${JSON.stringify(fail)}` } }), evidence: fail });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rework_summary_not_specific");
});

test("wrong SHA, non-Sol-low, stale attempt, and incomplete stage fail closed", () => {
  assert.equal(validateQcVerdict({ actor: worker, task: task(), evidence: { ...evidence, observed_sha: "c".repeat(40) } }).reason, "sha_binding_mismatch");
  assert.equal(validateQcVerdict({ actor: worker, task: task({ agent: { model: "gpt-5.6-terra", thinking_level: "low" } }), evidence }).reason, "completed_sol_low_qc_required");
  assert.equal(validateQcVerdict({ actor: { ...worker, authenticated_task_id: "old-task" }, task: task(), evidence }).reason, "authenticated_task_required");
  assert.equal(validateQcVerdict({ actor: worker, task: task({ status: "running" }), evidence }).reason, "completed_current_stage_qc_required");
});

test("task evidence is the one accepted legacy bridge shape", () => {
  const result = validateQcVerdict({ actor: worker, task: task(), evidence: { ...evidence, model: "gpt-5.6-terra" } });
  assert.equal(result.reason, "qc_task_evidence_mismatch");
  assert.equal(validateQcVerdict({ actor: worker, task: task({ result: { output: "QC_EVIDENCE_JSON={bad}" } }), evidence }).reason, "qc_task_evidence_required");
});

test("external receipt requires an authenticated operator", () => {
  assert.equal(validateQcVerdict({ actor: { type: "operator", authenticated: true, external_receipt: "receipt-1" }, evidence }).ok, true);
  assert.equal(validateQcVerdict({ actor: { type: "operator", authenticated: false, external_receipt: "receipt-1" }, evidence }).reason, "authenticated_external_receipt_required");
});
