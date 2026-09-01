// Pure admission checks shared by the relay and its recovery worker.
// Keep these side-effect free so the spend gates can be tested without a live DB.

const NONTERMINAL_TASK_STATES = new Set([
  'queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'
]);
const STAGE_ALIASES = new Map([
  ['in_progress', 'In Progress'],
  ['in_review', 'In Review']
]);
const NON_EXECUTION_STAGES = new Set([
  'Human Review', 'Parked', 'Rejected', 'Done', 'Archived', 'Cancelled'
]);
const EXTERNAL_TRANSITION_STAGES = new Set(['Done']);
const QUOTA_PAUSE_MAX_AGE_MS = 15 * 60 * 1000;

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
    [/\b(In Progress)\b/i, 'In Progress'],
    [/\b(In Review)\b/i, 'In Review'],
    [/\b(CI\/CD & Deploy)\b/i, 'CI/CD & Deploy'],
    [/\b(Done)\b/i, 'Done'],
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

// A relay execution task is work the belt itself created for a concrete stage.
// Manual/operator tasks deliberately do not carry this marker and must not
// prevent an operator moving a ticket through a manual or terminal stage.
function isActiveExecutionTask(task, issueId) {
  if (!task || task.issue_id !== issueId || !NONTERMINAL_TASK_STATES.has(task.status)) {
    return false;
  }
  const context = task.context || {};
  if (!context.to_stage || String(context.source || '').startsWith('manual')) return false;
  return isExecutionStage(context.to_stage);
}

// Cross-stage admission is intentionally issue-wide. Stage-local duplicate
// checks miss the dangerous shape: an active Spec -> Queue execution and a
// concurrent Queue -> In Progress execution for the same issue.
function crossStageExecutionAdmission(tasks, issueId) {
  const active = (tasks || []).filter((task) => isActiveExecutionTask(task, issueId));
  return active.length === 0
    ? { ok: true }
    : {
        ok: false,
        reason: 'prior_execution_active',
        active_task_ids: active.map((task) => task.id).filter(Boolean),
        active_stages: [...new Set(active.map((task) => canonicalStage(task.context.to_stage)))].sort()
      };
}

function retryAdmission({ attempt, maxAttempts = 2, failureReason, queueAgeMinutes = 0,
  queueTtlMinutes = 120, infraReasons = [] }) {
  const infra = infraReasons.includes(failureReason);
  const age = Number(queueAgeMinutes);
  const ttl = Number(queueTtlMinutes);
  if (!Number.isInteger(attempt) || !Number.isInteger(maxAttempts)) {
    return { ok: false, reason: 'attempt_budget_exhausted' };
  }
  // Infrastructure recovery replays the same attempt number. Its ceiling is
  // enforced by the relay's stage-cycle disposition, not by a budget it never
  // consumes. Rejecting it here strands a task selected by the recovery query.
  if (!infra && attempt >= maxAttempts) {
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
  if (agent.runtime_config && agent.runtime_config.quota_paused === true) {
    return { ok: false, reason: `provider_quota_paused:${agent.name || agent.agent_name || agent.id || 'unknown_agent'}` };
  }
  const routing = beltRoutingAdmission(agent, selectedRuntime);
  if (!routing.ok) return routing;
  const model = String(selectedRuntime.model || agent.model || '').trim();
  const provider = String(selectedRuntime.provider || '').toLowerCase();
  const paid = selectedRuntime.paid === true || provider === 'openrouter' || /^deepseek[/:]/i.test(model);
  // Subscription lanes (Luna/Sol) are not blocked by an absent concurrency
  // setting. Both concurrency and an explicit token budget are mandatory when
  // the selected provider/model can spend OpenRouter funds.
  if (paid && (!Number.isInteger(cap) || cap <= 0)) return { ok: false, reason: 'invalid_concurrency_cap' };
  if (paid && !model) return { ok: false, reason: 'missing_model' };
  const tokenBudget = Number(selectedRuntime.token_budget ?? agent.token_budget ??
    (agent.runtime_config && agent.runtime_config.token_budget));
  if (paid && (!Number.isFinite(tokenBudget) || tokenBudget <= 0)) {
    return { ok: false, reason: 'missing_paid_token_budget' };
  }
  return { ok: true, cap };
}

function beltRoutingAdmission(agent, selectedRuntime = {}) {
  const cfg = agent?.runtime_config && typeof agent.runtime_config === 'object' ? agent.runtime_config : {};
  const name = String(agent?.name || agent?.agent_name || '').toLowerCase();
  const role = String(cfg.role || '').toLowerCase();
  const model = String(selectedRuntime.model || agent?.model || cfg.model || '').toLowerCase();
  const effort = String(agent?.thinking_level || cfg.reasoning_effort || '').toLowerCase();
  const build = role === 'build' || name.includes('build');
  const qcOrSpec = role === 'qc' || role === 'spec' || name.includes('qc') || name.includes('spec');
  if (!build && !qcOrSpec) return { ok: true };
  if (effort !== 'low') return { ok: false, reason: 'belt_low_reasoning_effort_required' };
  if (build && !(/^deepseek[/:]/.test(model) || model === 'gpt-5.6-terra')) return { ok: false, reason: 'builder_requires_deepseek_or_terra' };
  if (qcOrSpec && model !== 'gpt-5.6-sol') return { ok: false, reason: 'qc_spec_requires_sol_low' };
  return { ok: true };
}

function quotaPauseClearance({ pausedAt, fallbackAt, budgetExhausted, now = Date.now(),
  maxAgeMs = QUOTA_PAUSE_MAX_AGE_MS }) {
  const timestamp = Date.parse(pausedAt || fallbackAt || '');
  if (!Number.isFinite(timestamp)) return { clear: true, reason: 'invalid_pause_timestamp' };
  if (now - timestamp <= maxAgeMs) return { clear: false, reason: 'pause_within_grace_period' };
  return budgetExhausted === true
    ? { clear: false, reason: 'build_budget_exhausted' }
    : { clear: true, reason: 'build_budget_not_exhausted' };
}

function quotaPauseFlipLogLine(agentName, timestamp, paused) {
  return `quota_paused flip agent="${agentName}" timestamp=${timestamp} value=${paused}`;
}

function stageCycleAdmission(taskCount, limit = 2) {
  const count = Number(taskCount);
  const ceiling = Number(limit);
  if (!Number.isInteger(ceiling) || ceiling < 1) return { ok: false, reason: 'invalid_stage_cycle_limit' };
  return count < ceiling
    ? { ok: true, ceiling }
    : { ok: false, reason: 'stage_cycle_limit', ceiling, disposition: 'Parked' };
}

function lifetimeTaskAdmission(taskCount, limit = 6) {
  const count = Number(taskCount);
  const ceiling = Number(limit);
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    return { ok: false, reason: 'invalid_lifetime_task_limit' };
  }
  return count < ceiling
    ? { ok: true, ceiling }
    : { ok: false, reason: 'lifetime_task_limit', ceiling, disposition: 'Parked' };
}

function isExecutionStage(stage) {
  return !NON_EXECUTION_STAGES.has(canonicalStage(stage));
}

function routableOwnerDefects(rows) {
  const defects = [];
  for (const row of rows || []) {
    if (!row.next_stage || EXTERNAL_TRANSITION_STAGES.has(row.stage_name)) continue;
    let reason = null;
    if (!row.agent_id || !row.owner_id) reason = 'missing_owner';
    else if (row.owner_archived_at) reason = 'owner_archived';
    else if (!['idle', 'working'].includes(row.owner_status)) reason = 'owner_inactive';
    else if (!instructionCompatibility(row.owner_instructions, row.next_stage).ok) {
      reason = 'instruction_incompatible';
    }
    if (reason) defects.push(`${row.stage_name}:${reason}`);
  }
  return defects.sort();
}

function assertRoutableStageOwners(rows) {
  const defects = routableOwnerDefects(rows);
  if (defects.length > 0) {
    throw new Error(`Routable relay stage owner defects: ${defects.join(', ')}`);
  }
}

function quotaCircuitAdmission(failureReasons, limit = 3) {
  const ceiling = Number(limit);
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    return { pause: true, reason: 'invalid_quota_failure_limit' };
  }
  let consecutive = 0;
  for (const reason of failureReasons || []) {
    if (!/\b402\b|provider_quota_limit|payment[ _-]?required/i.test(String(reason || ''))) break;
    consecutive += 1;
  }
  return { pause: consecutive >= ceiling, consecutive, ceiling };
}

module.exports = {
  NONTERMINAL_TASK_STATES,
  canonicalStage,
  isBundledChild,
  instructionStages,
  instructionCompatibility,
  hasActiveTaskForIssueStage,
  isActiveExecutionTask,
  crossStageExecutionAdmission,
  retryAdmission,
  spendPreflight,
  beltRoutingAdmission,
  QUOTA_PAUSE_MAX_AGE_MS,
  quotaPauseClearance,
  quotaPauseFlipLogLine,
  stageCycleAdmission,
  lifetimeTaskAdmission,
  isExecutionStage,
  routableOwnerDefects,
  assertRoutableStageOwners,
  quotaCircuitAdmission
};
