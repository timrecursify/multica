// Pure admission checks shared by the relay and its recovery worker.
// Keep these side-effect free so the spend gates can be tested without a live DB.

const NONTERMINAL_TASK_STATES = new Set([
  'queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'
]);
const STAGE_ALIASES = new Map([
  ['in_progress', 'In Progress'],
  ['in_review', 'In Review']
]);

function canonicalStage(stage) {
  return STAGE_ALIASES.get(stage) || stage;
}

function isBundledChild(issue) {
  // parent_issue_id is the durable bundle marker. Children are dispositioned by
  // their MEGA, even after that parent reaches a terminal state.
  return Boolean(issue && issue.parent_issue_id);
}

function instructionStages(instructions) {
  const text = String(instructions || '');
  const stages = new Set();
  const patterns = [
    [/RUNBOOK_BUILD_WORKER(?:\.md)?/i, 'Queue'],
    [/RUNBOOK_SPEC_WORKER(?:\.md)?/i, 'Spec'],
    [/RUNBOOK_QC_WORKER(?:\.md)?/i, 'In Review'],
    [/\b(?:in the )?(Spec)\b/i, 'Spec'],
    [/\b(In Review)\b/i, 'In Review'],
    [/\b(Queue)\b/i, 'Queue'],
    [/\b(Registered)\b/i, 'Registered']
  ];
  for (const [pattern, stage] of patterns) {
    if (pattern.test(text)) stages.add(stage);
  }
  return stages;
}

function instructionCompatibility(instructions, targetStage) {
  const allowed = instructionStages(instructions);
  const stage = canonicalStage(targetStage);
  return {
    ok: allowed.size > 0 && allowed.has(stage),
    stage,
    allowed: [...allowed].sort()
  };
}

function hasActiveTaskForIssueStage(tasks, issueId, stage) {
  const wanted = canonicalStage(stage);
  return (tasks || []).some((task) => {
    if (task.issue_id !== issueId || !NONTERMINAL_TASK_STATES.has(task.status)) return false;
    const taskStage = task.context && task.context.to_stage;
    return canonicalStage(taskStage) === wanted;
  });
}

function retryAdmission({ attempt, maxAttempts = 2, failureReason, queueAgeMinutes = 0,
  queueTtlMinutes = 120, infraReasons = [] }) {
  const infra = infraReasons.includes(failureReason);
  const age = Number(queueAgeMinutes);
  const ttl = Number(queueTtlMinutes);
  if (!Number.isInteger(attempt) || !Number.isInteger(maxAttempts) || attempt >= maxAttempts) {
    return { ok: false, reason: 'attempt_budget_exhausted' };
  }
  if (!infra && failureReason) return { ok: true, consumesAttempt: true };
  if (Number.isFinite(age) && Number.isFinite(ttl) && age >= ttl / 2) {
    return { ok: false, reason: 'queue_headroom_exhausted' };
  }
  return { ok: true, consumesAttempt: !infra };
}

function spendPreflight(agent, selectedRuntime = {}) {
  const cap = Number(agent && agent.max_concurrent_tasks);
  if (!String(agent.instructions || '').trim()) return { ok: false, reason: 'missing_instructions' };
  if (agent.archived_at) return { ok: false, reason: 'agent_archived' };
  const model = String(selectedRuntime.model || agent.model || '').trim();
  const provider = String(selectedRuntime.provider || '').toLowerCase();
  const paid = selectedRuntime.paid === true || provider === 'openrouter' || /^deepseek[/:]/i.test(model);
  // Subscription lanes (Luna/Sol) are not blocked by an absent cap. A cap is
  // mandatory only when the selected provider/model can spend OpenRouter funds.
  if (paid && (!Number.isInteger(cap) || cap <= 0)) return { ok: false, reason: 'invalid_concurrency_cap' };
  if (paid && !model) return { ok: false, reason: 'missing_model' };
  return { ok: true, cap };
}

module.exports = {
  NONTERMINAL_TASK_STATES,
  canonicalStage,
  isBundledChild,
  instructionStages,
  instructionCompatibility,
  hasActiveTaskForIssueStage,
  retryAdmission,
  spendPreflight
};
