"use strict";

// QC verdicts are authoritative only when their evidence is bound to the
// authenticated task that produced it.  The bridge's legacy marker remains
// accepted so existing completed PASS tasks can be reconciled after cutover.
const SHA_RE = /^[a-f0-9]{40}$/i;
const MD5_RE = /^[a-f0-9]{32}$/i;
const FAILURE_CLASSES = new Set(["none", "implementation", "evidence", "tool", "access"]);

function readTaskEvidence(task) {
  const output = task?.result?.output;
  if (typeof output !== "string") return { ok: false, reason: "qc_task_evidence_required" };
  const matches = [...output.matchAll(/^QC_EVIDENCE_JSON=(\{[^\r\n]*\})$/gm)];
  if (matches.length !== 1) return { ok: false, reason: "qc_task_evidence_required" };
  try {
    const evidence = JSON.parse(matches[0][1]);
    return evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? { ok: true, evidence } : { ok: false, reason: "qc_task_evidence_required" };
  } catch {
    return { ok: false, reason: "qc_task_evidence_required" };
  }
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return "invalid_evidence";
  if (evidence.verdict !== "PASS" && evidence.verdict !== "FAIL") return "invalid_verdict";
  if (!MD5_RE.test(String(evidence.work_product_md5 || ""))) return "invalid_work_product_md5";
  if (!SHA_RE.test(String(evidence.bound_sha || ""))) return "invalid_bound_sha";
  if (!SHA_RE.test(String(evidence.observed_sha || ""))) return "invalid_observed_sha";
  if (evidence.bound_sha.toLowerCase() !== evidence.observed_sha.toLowerCase()) return "sha_binding_mismatch";
  if (!FAILURE_CLASSES.has(evidence.failure_class)) return "invalid_failure_class";
  if (typeof evidence.qualifying !== "boolean") return "invalid_qualifying";
  return null;
}

function taskLane(task) {
  const agent = task?.agent || {};
  const runtime = agent.runtime_config || task?.runtime_config || {};
  return {
    model: agent.model || task?.model || task?.agent_model || runtime.model,
    effort: agent.thinking_level || task?.thinking_level || task?.agent_effort ||
      runtime.reasoning_effort
  };
}

function equal(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function internalBinding(task, actor) {
  if (!task || task.status !== "completed" || task.context?.to_stage !== "In Review") {
    return { ok: false, reason: "completed_current_stage_qc_required" };
  }
  if (!task.id || !task.issue_id || !task.workspace_id || actor?.type !== "worker" ||
      actor.authenticated_task_id !== task.id) return { ok: false, reason: "authenticated_task_required" };
  const lane = taskLane(task);
  if (lane.model !== "gpt-5.6-sol" || lane.effort !== "low") {
    return { ok: false, reason: "completed_sol_low_qc_required" };
  }
  const parsed = readTaskEvidence(task);
  if (!parsed.ok) return parsed;
  const invalid = validateEvidence(parsed.evidence);
  if (invalid) return { ok: false, reason: invalid };
  const contextSha = task.context.bound_sha || task.context.head_sha || task.context.commit_sha;
  if (contextSha != null && (!SHA_RE.test(String(contextSha)) || !equal(contextSha, parsed.evidence.bound_sha))) {
    return { ok: false, reason: "qc_task_sha_mismatch" };
  }
  return { ok: true, binding: { task_id: task.id, issue_id: task.issue_id,
    workspace_id: task.workspace_id, bound_sha: parsed.evidence.bound_sha.toLowerCase(), ...lane },
  evidence: parsed.evidence };
}

function validateInternalVerdict({ actor, task, evidence }) {
  const bound = internalBinding(task, actor);
  if (!bound.ok) return bound;
  const submitted = evidence || bound.evidence;
  const invalid = validateEvidence(submitted);
  if (invalid) return { ok: false, reason: invalid };
  const keys = ["verdict", "work_product_md5", "bound_sha", "observed_sha", "failure_class", "qualifying"];
  if (keys.some((key) => submitted[key] !== bound.evidence[key]) ||
      (submitted.issue_id != null && submitted.issue_id !== bound.binding.issue_id) ||
      (submitted.workspace_id != null && submitted.workspace_id !== bound.binding.workspace_id) ||
      (submitted.model != null && submitted.model !== bound.binding.model) ||
      (submitted.effort != null && submitted.effort !== bound.binding.effort)) {
    return { ok: false, reason: "qc_task_evidence_mismatch" };
  }
  return { ok: true, binding: bound.binding, evidence: { ...bound.evidence,
    issue_id: bound.binding.issue_id, workspace_id: bound.binding.workspace_id,
    model: bound.binding.model, effort: bound.binding.effort } };
}

function validateExternalVerdict({ actor, evidence }) {
  if (actor?.type !== "operator" || actor.authenticated !== true ||
      typeof actor.external_receipt !== "string" || actor.external_receipt.trim() === "") {
    return { ok: false, reason: "authenticated_external_receipt_required" };
  }
  const invalid = validateEvidence(evidence);
  if (invalid) return { ok: false, reason: invalid };
  return { ok: true, binding: { actor: "operator", external_receipt: actor.external_receipt }, evidence };
}

function validateQcVerdict(input) {
  return input?.actor?.type === "operator"
    ? validateExternalVerdict(input) : validateInternalVerdict(input || {});
}

module.exports = { FAILURE_CLASSES, readTaskEvidence, validateEvidence, taskLane, internalBinding,
  validateInternalVerdict, validateExternalVerdict, validateQcVerdict };
