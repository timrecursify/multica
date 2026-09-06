const http = require("http");
const { URL } = require("url");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const {
  isBundledChild,
  instructionCompatibility,
  agentRegistryDefects,
  spendPreflight,
  budgetCountPredicate,
  stageCycleAdmission,
  lifetimeTaskAdmission,
  isExecutionStage,
  assertRoutableStageOwners,
  crossStageExecutionAdmission,
  resolveBuilderRoute
} = require("./guardrails.cjs");
const { isQcLane, isSpecLane, qcEscalationModels, QC_ESCALATION_BOUNCES } = require("./qc-lane.cjs");
const { recordParkAndQueueDiagnosis, isBuilderDispatchAllowed, parseRuntimeEvidenceReference } = require("./parked-diagnosis.cjs");
const { completionAdmission } = require("./relay-completion-admission.cjs");
const { recordParkedEntry } = require("./parked-entry-audit.cjs");

// Relay configuration is supplied by the host environment.
const JWT_SECRET = process.env.JWT_SECRET;
const MULTICA_DB = process.env.DATABASE_URL;
const RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET;
const ARCHIVER_AGENT_SECRET = process.env.ARCHIVER_AGENT_SECRET;
// Optional at process start, but mandatory for an explicit operator terminal
// exit. Leaving it unset therefore fails that exceptional path closed.
const RELAY_OPERATOR_SECRET = process.env.RELAY_OPERATOR_SECRET;
const OPERATOR_SECRET_DISABLED = typeof RELAY_OPERATOR_SECRET === "string" &&
  RELAY_OPERATOR_SECRET.length > 0 && RELAY_OPERATOR_SECRET === RELAY_AGENT_SECRET;
const SSO_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID;

// One canonical login (Cloudflare Access) serving several isolated client
// workspaces. The hostname the user arrived on decides which workspace they
// are signed in to, so each client keeps its own front door.
const SSO_SITES = {
  "tickets.preciouspicspro.com": { workspaceId: "da3c5c5c-a123-4567-b999-c3ed1820da00", slug: "ppp-production" },
  "tickets.synthetic.jp":        { workspaceId: "f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f", slug: "gsp-multica" },
  "gsp-multica.synthetic.jp":    { workspaceId: "f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f", slug: "gsp-multica" },
};

// Unknown host falls back to the single-workspace env var this bridge shipped
// with, so an unmapped hostname degrades to the old behaviour instead of 500.
function resolveSite(req) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  const site = SSO_SITES[host] || { workspaceId: SSO_WORKSPACE_ID, slug: "gsp-multica" };
  return { host, ...site };
}

// Checked when the service starts, not when the module loads. Throwing at load
// time made this file impossible to require without production secrets, which
// is why its test suite could not run anywhere and stayed out of CI. The
// service still refuses to listen without them -- start() calls this first.
function assertRequiredEnvironment() {
  for (const [name, value] of Object.entries({
    JWT_SECRET,
    DATABASE_URL: MULTICA_DB,
    RELAY_AGENT_SECRET,
    ARCHIVER_AGENT_SECRET,
    MULTICA_WORKSPACE_ID: SSO_WORKSPACE_ID
  })) {
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
  }
}
if (OPERATOR_SECRET_DISABLED) {
  console.error("[relay] RELAY_OPERATOR_SECRET duplicates RELAY_AGENT_SECRET; operator terminal exits disabled");
}

const PORT = Number(process.env.PORT || 5005);

// A build must never start from an unwritten specification. The spec agent posts
// its work as a comment on the issue, and the daemon only *instructs* the builder
// to read comment history, so a builder that skips that step silently builds from
// the raw ticket title. Two things below make the specification binding rather
// than advisory:
//   1. Spec -> Queue is refused outright when no specification exists.
//   2. The specification is copied into the issue description between markers, so
//      it sits in the prompt the builder always receives, not in a comment it is
//      merely told to fetch.
// Scoped to the GSP workspace: PPP runs its own relay and its own stage contract.
const SPEC_ENFORCED_WORKSPACE = "f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f";
const SPEC_BEGIN = "<!-- RELAY-SPEC:BEGIN -->";
const SPEC_END = "<!-- RELAY-SPEC:END -->";
const STAGE_CYCLE_LIMIT = Number.parseInt(process.env.RELAY_STAGE_CYCLE_LIMIT || "2", 10);
const LIFETIME_TASK_LIMIT = Number.parseInt(process.env.RELAY_LIFETIME_TASK_LIMIT || "6", 10);
const LIVE_TASK_STATUSES = [
  "queued", "dispatched", "running", "waiting_local_directory", "deferred"
];
const TERMINAL_STAGES = new Set(["Done", "Cancelled", "Archived"]);
const NO_DISPATCH_ARRIVAL_STAGES = new Set(["Human Review", "Parked"]);

function isTerminalStage(stage) {
  return TERMINAL_STAGES.has(stage);
}

function isNoDispatchArrivalStage(stage) {
  return isTerminalStage(stage) || NO_DISPATCH_ARRIVAL_STAGES.has(stage);
}

function validArchiveReceipt(issueId, receipt) {
  if (typeof receipt !== "string" || !ARCHIVER_AGENT_SECRET) return false;
  const payload = `archiver:${issueId}:Done->Archived`;
  const prefix = `${payload}:`;
  if (!receipt.startsWith(prefix)) return false;
  const supplied = receipt.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac("sha256", ARCHIVER_AGENT_SECRET).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

async function verifiedParkedEvidenceRelease(client, issue, toStage, reason) {
  if (issue.status !== 'Parked' || toStage !== 'In Review' || issue.metadata?.parked_release_once !== true) return false;
  const match = String(reason || '').match(/^runtime_evidence_verified:(.+)$/);
  const reference = match && parseRuntimeEvidenceReference(match[1]);
  if (!reference) return false;
  const sql = {
    task: `SELECT 1 FROM agent_task_queue WHERE id = $1::uuid AND issue_id = $2::uuid AND status = 'completed' AND context->>'kind' IS DISTINCT FROM 'parked_diagnosis'`,
    qc: `SELECT 1 FROM qc_verdict WHERE id = $1::integer AND issue_id = $2::uuid`,
    activity: `SELECT 1 FROM activity_log WHERE id = $1::uuid AND issue_id = $2::uuid`
  };
  return (await client.query(sql[reference.kind], [reference.id, issue.id])).rowCount === 1;
}
// The operator recovery tool records this marker only after its exact failed
// relay-requeue lineage and same-issue runtime evidence checks succeed. Consume
// it before the retry ceiling is evaluated: it admits one stranded QC task,
// not a general Parked escape hatch.
async function consumeParkedQcRecovery(client, issue, toStage, reason, evidenceRelease) {
  if (!evidenceRelease || issue.status !== 'Parked' || toStage !== 'In Review') return false;
  const match = String(reason || '').match(/^runtime_evidence_verified:(.+)$/);
  const evidence = match && parseRuntimeEvidenceReference(match[1]);
  if (!evidence) return false;
  const consumed = await client.query(
    `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) - 'parked_qc_recovery', updated_at = NOW()
      WHERE id = $1::uuid AND status = 'Parked' AND metadata->>'parked_release_once' = 'true'
        AND metadata->'parked_qc_recovery'->>'canonical_evidence' = $2::text
        AND metadata->'parked_qc_recovery'->>'failed_task_id' ~* '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'
      RETURNING id`, [issue.id, `${evidence.kind}:${evidence.id}`]);
  return consumed.rowCount === 1;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MD5_RE = /^[a-f0-9]{32}$/i;
const SHA_RE = /^[a-f0-9]{40}$/i;
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RERUN_IDEM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/;

// Operator-authorized respec is deliberately a separate endpoint.  It is the
// only sanctioned exception to automatic retry lineage: no agent task is
// created or fabricated, and the mutation is recorded in the relay audit log.
async function operatorRespec(client, payload) {
  const issueId = String(payload.issue_id || "");
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  const idem = String(payload.idempotency_key || "");
  if (!UUID_RE.test(issueId) || !reason || !IDEM_KEY_RE.test(idem)) {
    return { ok: false, status: 400, error: "invalid_request" };
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 806))", [issueId]);
  const issueResult = await client.query(
    `SELECT id, workspace_id, status, metadata FROM issue WHERE id = $1::uuid FOR UPDATE`, [issueId]);
  if (!issueResult.rows[0]) return { ok: false, status: 404, error: "issue_not_found" };
  const issue = issueResult.rows[0];
  const prior = await client.query(
    `SELECT id, parked_audit FROM relay_run_log
      WHERE issue_id = $1::uuid AND parked_audit->'operator_respec'->>'idempotency_key' = $2
      ORDER BY id DESC LIMIT 1`, [issueId, idem]);
  if (prior.rows[0]) {
    const recorded = prior.rows[0].parked_audit.operator_respec;
    if (recorded.reason !== reason) return { ok: false, status: 409, error: "idempotency_conflict" };
    return { ok: true, replay: true, receipt: { issue_id: issueId, prior_stage: "Human Review",
      new_stage: "Spec", reason, idempotency_key: idem, audit_row_id: prior.rows[0].id,
      accounting_baseline: recorded.accounting_baseline } };
  }
  if (issue.status !== "Human Review") return { ok: false, status: 409, error: "human_review_stage_required" };
  const [cycle, lifetime] = await Promise.all([
    capEscalationVerified(client, issue, "stage_cycle_limit", "Human Review"),
    capEscalationVerified(client, issue, "lifetime_task_limit", "Human Review")
  ]);
  if (!cycle && !lifetime) return { ok: false, status: 409, error: "cap_evidence_required" };
  const baseline = new Date().toISOString();
  const metadata = JSON.stringify({ ...(issue.metadata || {}),
    retry_escalation_at: baseline, operator_respec_at: baseline,
    operator_respec_reason: reason, operator_respec_idempotency_key: idem
  });
  // Remove stale release markers while retaining the fresh retry baseline.
  await client.query(
    `UPDATE issue SET status = 'Spec', metadata = (COALESCE($2::jsonb, '{}'::jsonb)
       - 'parked_release_at' - 'human_review_release_at' - 'human_review_release_reason'
       - 'retry_escalation'), updated_at = NOW() WHERE id = $1::uuid`, [issueId, metadata]);
  const audit = { operator_respec: { operator_authorized: true, reason,
    idempotency_key: idem, accounting_baseline: baseline, cap_evidence: { stage_cycle: cycle, lifetime } } };
  const log = await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
      VALUES ($1::uuid, 'Human Review', 'Spec', 'completed', $2::jsonb) RETURNING id`,
    [issueId, JSON.stringify(audit)]);
  const auditId = log.rows[0]?.id;
  return { ok: true, replay: false, receipt: { issue_id: issueId, prior_stage: "Human Review",
    new_stage: "Spec", reason, idempotency_key: idem, audit_row_id: auditId,
    accounting_baseline: baseline } };
}

// This deliberately reads only the canonical link tables.  issue.pr_url and
// comment text are presentation/provenance data, not authority to skip work.
async function mergedPrEvidence(client, issue, evidence, dependencies = {}) {
  const sha = evidence && evidence.sha;
  if (!SHA_RE.test(String(sha || ''))) return { ok: false, reason: 'invalid_sha' };
  const linked = await client.query(
    `SELECT pr.repo_owner || '/' || pr.repo_name AS repository, pr.html_url, pr.head_sha, pr.merged_at
       FROM github_pull_request pr JOIN issue_pull_request link ON link.pull_request_id=pr.id
      WHERE link.issue_id=$1 AND NOT link.reference_only AND pr.state='merged' AND pr.merged_at IS NOT NULL
      UNION ALL
     SELECT pr.repo_owner || '/' || pr.repo_name, pr.html_url, pr.head_sha, pr.merged_at
       FROM vcs_pull_request pr JOIN issue_vcs_pull_request link ON link.pull_request_id=pr.id
      WHERE link.issue_id=$1 AND NOT link.reference_only AND pr.state='merged' AND pr.merged_at IS NOT NULL`, [issue.id]);
  if (linked.rows.length !== 1) return { ok: false, reason: linked.rows.length ? 'ambiguous_linked_pr' : 'missing_linked_pr' };
  const pr = linked.rows[0];
  if (String(pr.head_sha).toLowerCase() !== String(sha).toLowerCase()) return { ok: false, reason: 'sha_mismatch' };
  try {
    // gh uses the installation/user credential already configured for the belt.
    const repo = pr.repository;
    const gh = dependencies.execFileSync || execFileSync;
    const defaultBranch = gh('gh', ['api', `repos/${repo}`, '--jq', '.default_branch'], { encoding: 'utf8', timeout: 20000 }).trim();
    const relation = gh('gh', ['api', `repos/${repo}/compare/${sha}...${defaultBranch}`, '--jq', '.status'], { encoding: 'utf8', timeout: 20000 }).trim();
    if (!['ahead', 'identical'].includes(relation)) return { ok: false, reason: 'sha_not_on_default_branch' };
    return { ok: true, pr: { ...pr, default_branch: defaultBranch, verified_at: new Date().toISOString(), sha } };
  } catch (_) { return { ok: false, reason: 'github_verification_failed' }; }
}

async function authorizeRelayStatusWrites(client) {
  await client.query("SELECT set_config('multica.relay_authorized', 'on', true)");
}

async function rerunParkedDiagnosis(client, payload) {
  if (!UUID_RE.test(String(payload.issue_id || '')) || !RERUN_IDEM_KEY_RE.test(String(payload.idempotency_key || ''))) {
    return { ok: false, error: 'invalid_request' };
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 805))", [payload.issue_id]);
  const issue = await client.query(
    `SELECT id, workspace_id, status, priority, metadata, parent_issue_id
       FROM issue WHERE id = $1::uuid FOR UPDATE`,
    [payload.issue_id]);
  if (issue.rowCount === 0) return { ok: false, error: 'issue_not_found' };
  if (issue.rows[0].status !== 'Parked') return { ok: false, error: 'parked_issue_required' };
  // parent_issue_id is the durable bundle marker. Older rows may not have the
  // copied metadata fields, so checking metadata alone let legacy bundled
  // children reach the diagnosis INSERT and fail with a silent 500.
  if (isBundledChild(issue.rows[0]) || issue.rows[0].metadata?.bundled_into_id ||
      issue.rows[0].metadata?.bundled_into) {
    return { ok: false, error: 'bundled_issue_requires_canonical_parent' };
  }
  const prior = await client.query(
    `SELECT id FROM agent_task_queue
      WHERE issue_id = $1::uuid AND context->>'kind' = 'parked_diagnosis'
        AND context->>'operator_rerun_idem_key' = $2::text
      ORDER BY created_at DESC LIMIT 1`, [payload.issue_id, payload.idempotency_key]);
  if (prior.rowCount > 0) return { ok: true, replay: true, task_id: prior.rows[0].id };
  const active = await client.query(
    `SELECT id FROM agent_task_queue WHERE issue_id = $1::uuid
      AND context->>'kind' = 'parked_diagnosis'
      AND status IN ('queued','dispatched','running','waiting_local_directory','deferred') LIMIT 1`, [payload.issue_id]);
  if (active.rowCount > 0) return { ok: true, replay: true, task_id: active.rows[0].id };
  let selection;
  try {
    selection = await recordParkAndQueueDiagnosis(client, issue.rows[0], {
      reason: 'operator_parked_diagnosis_rerun', operator_rerun_idem_key: payload.idempotency_key,
      skip_reason_comment: false
    });
  } catch (err) {
    if (err && typeof err === 'object') err.relayDiagnosisContext = {
      issue_id: issue.rows[0].id, workspace_id: issue.rows[0].workspace_id
    };
    throw err;
  }
  return selection.task_id
    ? { ok: true, replay: false, task_id: selection.task_id }
    : { ok: false, error: selection.reason || 'diagnosis_owner_or_capacity_unavailable' };
}

function diagnosisRerunErrorStatus(error) {
  if (error === 'invalid_request') return 400;
  if (error === 'issue_not_found') return 404;
  return 409;
}

function parkedDiagnosisRerunRefusal(err) {
  if (err?.code === '23514' && err?.constraint === 'agent_task_queue_active_requires_runtime') {
    return 'diagnosis_runtime_unavailable';
  }
  return null;
}

function logDiagnosisRerunError(err, payload) {
  const context = err && err.relayDiagnosisContext || {};
  console.error(JSON.stringify({
    event: 'parked_diagnosis_rerun_error',
    issue_id: context.issue_id || (UUID_RE.test(String(payload?.issue_id || '')) ? payload.issue_id : null),
    workspace_id: context.workspace_id || null,
    error_name: err?.name || 'Error',
    error_message: String(err?.message || err),
    error_code: err?.code || null,
    error_constraint: err?.constraint || null,
    stack: err?.stack || null
  }));
}
const IDEM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/;
const FAILURE_CLASSES = new Set(["none", "implementation", "evidence", "tool", "access"]);
const RETRY_ESCALATION_REASONS = new Set([
  "completion_blocked", "completion_qc_blocked", "completion_spec_blocked",
  "completion_build_blocked", "completion_failed", "completion_no_work_product",
  "missing_result", "qc_bounce_ceiling", "stage_cycle_limit", "lifetime_task_limit"
]);
const RETRY_ESCALATION_DEADLINE_MINUTES = Number.parseInt(
  process.env.RELAY_RETRY_ESCALATION_DEADLINE_MINUTES || "20", 10
);
let testClientFactory = null;
// A stage transition may retire work that has not started. Running paid work
// is never cancelled here: crossStageExecutionAdmission defers the successor
// until it becomes terminal, preserving the predecessor's work product.
const REPLACEABLE_TASK_STATUSES = [
  "queued", "dispatched", "waiting_local_directory", "deferred"
];

// Queue is a bookkeeping stage after the builder has produced its work
// product. The builder task is admitted on Spec -> Queue; Queue -> In Progress
// records that the same flight is ready for QC and must never buy another
// builder run. The pending relay row is correlated to the original builder
// task so the relay daemon can enqueue QC after that task reaches a terminal
// state.
function isBookkeepingTransition(fromStage, toStage) {
  return fromStage === "Queue" && toStage === "In Progress";
}

// Relay owners are normally keyed by the stage being left: Spec -> Queue
// wakes the builder and In Progress -> In Review wakes QC. A backward branch
// re-enters an earlier execution lane, however, so the owner for the stage
// being left may be incompatible with the destination (for example,
// In Review -> In Progress would otherwise wake the deploy agent). Resolve
// those branches to the canonical entry owner of their destination lane while
// retaining the existing source-stage convention for forward transitions.
const BACKWARD_LANE_OWNER_STAGE = Object.freeze({
  Spec: "Registered",
  Queue: "Queue",
  "In Progress": "Queue",
  "In Review": "In Progress",
  "CI/CD & Deploy": "In Review"
});

function ownerStageForTransition(fromStage, toStage) {
  // Parked is a disposition rather than a configured execution lane, so it is
  // absent from stageOrder. A diagnosis-authorized no-spec release returns to
  // Spec and must use the Registered scoper pool, never Parked's prior builder.
  if (fromStage === "Parked" && toStage === "Spec") return "Registered";
  // A verified already-fixed diagnosis returns directly to QC. Parked has no
  // execution owner, so selecting the source row would reuse the pre-park
  // builder; use the canonical In Progress -> In Review Sol-low owner instead.
  if (fromStage === "Parked" && toStage === "In Review") return "In Progress";
  const stageOrder = ["Registered", "Spec", "Queue", "In Progress", "In Review", "Human Review", "CI/CD & Deploy"];
  const fromIndex = stageOrder.indexOf(fromStage);
  const toIndex = stageOrder.indexOf(toStage);
  if (fromIndex !== -1 && toIndex !== -1 && toIndex < fromIndex) {
    return BACKWARD_LANE_OWNER_STAGE[toStage] || fromStage;
  }
  return fromStage;
}

function relayVerdictError(res, status, error) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function validateRelayVerdict(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "invalid_payload";
  const required = ["issue_id", "checker", "verdict", "work_product_md5", "bound_sha", "observed_sha", "failure_class", "qualifying", "model", "effort", "idem_key"];
  if (required.some((key) => !(key in payload))) return "missing_fields";
  if (!UUID_RE.test(payload.issue_id)) return "invalid_issue_id";
  if (payload.qc_task_id != null && !UUID_RE.test(payload.qc_task_id)) return "invalid_qc_task_id";
  if (typeof payload.checker !== "string" || !IDENTITY_RE.test(payload.checker)) return "invalid_checker";
  if (payload.verdict !== "PASS" && payload.verdict !== "FAIL") return "invalid_verdict";
  if (typeof payload.work_product_md5 !== "string" || !MD5_RE.test(payload.work_product_md5)) return "invalid_work_product_md5";
  if (typeof payload.bound_sha !== "string" || !SHA_RE.test(payload.bound_sha)) return "invalid_bound_sha";
  if (typeof payload.observed_sha !== "string" || !SHA_RE.test(payload.observed_sha)) return "invalid_observed_sha";
  if (payload.bound_sha.toLowerCase() !== payload.observed_sha.toLowerCase()) return "sha_binding_mismatch";
  if (!FAILURE_CLASSES.has(payload.failure_class)) return "invalid_failure_class";
  if (typeof payload.qualifying !== "boolean") return "invalid_qualifying";
  if (payload.model !== "gpt-5.6-sol" || payload.effort !== "low") return "invalid_qc_lane";
  if (typeof payload.idem_key !== "string" || !IDEM_KEY_RE.test(payload.idem_key)) return "invalid_idem_key";
  return null;
}

function qcBounceDecision(latestVerdict, expectedStage) {
  if (latestVerdict?.verdict !== "PASS") return { action: "escalate" };
  if (!MD5_RE.test(String(latestVerdict.work_product_md5 || "")) ||
      expectedStage !== "CI/CD & Deploy") {
    return { action: "hold", reason: "pass_deploy_evidence_invalid" };
  }
  return { action: "deploy", toStage: expectedStage };
}

async function latestQcVerdict(client, issueId) {
  const result = await client.query(
    `SELECT verdict, work_product_md5
       FROM qc_verdict
      WHERE issue_id = $1
      ORDER BY created_at DESC
      LIMIT 1`, [issueId]
  );
  return result.rows[0] || null;
}

// QC workers leave a durable, human-readable gate comment in addition to the
// normalized qc_verdict row.  Keep the comment as an independent admission
// signal: a stale PASS/hash must never make a ticket Done after a newer gate
// explicitly failed.  The id is returned so callers can audit the exact gate
// that caused the refusal.
async function latestQcGateComment(client, issueId) {
  const result = await client.query(
    `SELECT id, content, created_at
       FROM comment
      WHERE issue_id = $1
        AND content LIKE '%<!-- multica-qc-gate -->%'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`, [issueId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const match = String(row.content || '').match(/QC[- ]GATE\s*:\s*(PASS|FAIL)\b/i) ||
    String(row.content || '').match(/QC[- ]GATE\s+(PASS|FAIL)\b/i);
  return { id: row.id, created_at: row.created_at, verdict: match?.[1]?.toUpperCase() || null };
}

// A deploy may only be admitted after the Sol-low QC lane has recorded a
// qualifying PASS bound to the exact reviewed tree.  Keep this check at the
// relay boundary as well as in the policy table: a stale database alt edge or
// a hand-written request must not create a deploy task.
async function directDeployQcAdmission(client, issueId) {
  const result = await client.query(
    `SELECT verdict, qualifying, model, effort, bound_sha, observed_head
       FROM qc_attempt
      WHERE issue_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`, [issueId]
  );
  const row = result.rows[0];
  return Boolean(row && row.verdict === 'PASS' && row.qualifying === true &&
    row.model === 'gpt-5.6-sol' && row.effort === 'low' &&
    SHA_RE.test(String(row.bound_sha || '')) &&
    String(row.bound_sha).toLowerCase() === String(row.observed_head || '').toLowerCase());
}

async function latestCompletedSolLowQcTask(client, issueId, workspaceId, explicitTaskId = null) {
  const result = await client.query(
      `SELECT t.id, t.agent_id, t.status, t.context, t.result, t.completed_at,
              a.name AS agent_name
       FROM agent_task_queue t
       JOIN issue i ON i.id = t.issue_id AND i.workspace_id = t.workspace_id
       JOIN agent a ON a.id = t.agent_id AND a.workspace_id = i.workspace_id
      WHERE t.issue_id = $1 AND i.workspace_id = $2 AND t.status = 'completed'
        AND t.context->>'to_stage' = 'In Review'
        AND COALESCE(a.model, a.runtime_config->>'model') = 'gpt-5.6-sol'
        AND COALESCE(a.thinking_level, a.runtime_config->>'reasoning_effort') = 'low'
        AND ($3::uuid IS NULL OR t.id = $3::uuid)
      ORDER BY t.completed_at DESC NULLS LAST, t.created_at DESC, t.id DESC
      LIMIT 1 FOR UPDATE`,
    [issueId, workspaceId, explicitTaskId]
  );
  return result.rows[0] || null;
}

async function latestRunningSolLowQcTask(client, issueId, workspaceId, checker, explicitTaskId = null) {
  const result = await client.query(
    `SELECT t.id, t.issue_id, t.workspace_id, t.agent_id, t.status, t.context, t.result, t.completed_at,
            a.name AS agent_name, a.model, a.thinking_level, a.runtime_config
       FROM agent_task_queue t
       JOIN issue i ON i.id = t.issue_id AND i.workspace_id = t.workspace_id
       JOIN agent a ON a.id = t.agent_id AND a.workspace_id = i.workspace_id
      WHERE t.issue_id = $1 AND i.workspace_id = $2 AND t.status = 'running'
        AND t.context->>'to_stage' = 'In Review' AND a.name = $3
        AND COALESCE(a.model, a.runtime_config->>'model') = ANY($5::text[])
        AND COALESCE(a.thinking_level, a.runtime_config->>'reasoning_effort') = $6::text
        AND ($4::uuid IS NULL OR t.id = $4::uuid)
      ORDER BY t.created_at DESC, t.id DESC LIMIT 2 FOR UPDATE`,
    [issueId, workspaceId, checker, explicitTaskId, qcLaneModelsSqlArray(), QC_LANE_EFFORT]
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

function taskResultText(result) {
  if (result == null) return "";
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { return result; }
  }
  if (!result || typeof result !== "object") return "";
  return [result.output, result.comment, result.error]
    .filter((value) => typeof value === "string").join("\n");
}

function isNoArtifactQcBlock(text) {
  if (typeof text !== "string" || !/^\s*QC[- ]BLOCKED\b/im.test(text)) return false;
  if (/^\s*QC\s+VERDICT\s*:\s*(?:PASS|FAIL)\b/im.test(text) || /QC_EVIDENCE_JSON=/m.test(text)) return false;
  if (PR_URL_RE.test(text) || /\b[0-9a-f]{40}\b/i.test(text)) return false;
  return /\bNO-SHA\b/i.test(text) ||
    /\bno\s+(?:(?:implementation|bound|reviewable)\s+)?SHA\b/i.test(text) ||
    /\bno\s+(?:linked\s+)?PR\b/i.test(text) ||
    /\bno\s+immutable\s+tracked-tree\s+artifact\b/i.test(text);
}

function operatorRescopeIssueId(explicitIssueId, reason) {
  if (explicitIssueId != null) return String(explicitIssueId);
  const match = String(reason || "").match(
    /^RETURN:Spec — QC-BLOCKED NO-SHA operator re-scope ([0-9a-f-]+)$/i
  );
  return match?.[1] || null;
}

async function issueImplementationArtifact(client, issueId) {
  const result = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM qc_verdict WHERE issue_id = $1) AS has_qc_verdict,
       EXISTS (
         SELECT 1 FROM agent_task_queue
          WHERE issue_id = $1 AND status = 'completed'
            AND context->>'to_stage' = 'Queue'
            AND (
              NULLIF(BTRIM(COALESCE(result->>'work_product', '')), '') IS NOT NULL
              OR result::text ~* 'https?://github\\.com/[[:alnum:]_.-]+/[[:alnum:]_.-]+/pull/[0-9]+'
              OR result::text ~* '"(implementation_sha|bound_sha|observed_sha)"[^0-9a-f]{0,32}[0-9a-f]{40}'
            )
       ) AS has_builder_artifact,
       EXISTS (
         SELECT 1 FROM comment
          WHERE issue_id = $1 AND (
            content ~* 'https?://github\\.com/[[:alnum:]_.-]+/[[:alnum:]_.-]+/pull/[0-9]+'
            OR content ~* '(^|[\r\n])[[:space:]*-]*(implementation[_ ]sha|bound[_ ]sha|observed[_ ]sha)[[:space:]]*[:=][[:space:]]*[0-9a-f]{40}'
          )
       ) AS has_comment_artifact`, [issueId]);
  const row = result.rows[0] || {};
  return Boolean(row.has_qc_verdict || row.has_builder_artifact || row.has_comment_artifact);
}

async function noArtifactRescopeAdmission(client, issue, toStage, operatorIssueId) {
  if (!["In Review", "Human Review"].includes(issue.status)) return false;
  const qcReturn = issue.status === "In Review" && toStage === "In Progress" &&
    operatorIssueId == null;
  const operatorReturn = toStage === "Spec" && UUID_RE.test(String(operatorIssueId || "")) &&
    String(operatorIssueId).toLowerCase() === String(issue.id).toLowerCase();
  if (!qcReturn && !operatorReturn) return false;
  if (issue.metadata?.no_artifact_rescope_consumed_at) return false;
  const task = await latestCompletedSolLowQcTask(client, issue.id, issue.workspace_id);
  if (!task || task.status !== "completed" || !isNoArtifactQcBlock(taskResultText(task.result))) return false;
  return !await issueImplementationArtifact(client, issue.id);
}

async function consumeNoArtifactRescope(client, issue) {
  const consumed = await client.query(
    `UPDATE issue
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                                 '{no_artifact_rescope_consumed_at}', to_jsonb(NOW()), true),
            updated_at = NOW()
      WHERE id = $1::uuid AND status IN ('In Review', 'Human Review')
        AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'no_artifact_rescope_consumed_at')
      RETURNING id`, [issue.id]);
  return consumed.rowCount === 1;
}

async function latestQcNoArtifactSignal(client, issue) {
  const latest = await client.query(
    `SELECT t.result, c.content
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
        AND COALESCE(a.model, a.runtime_config->>'model') = 'gpt-5.6-sol'
        AND COALESCE(a.thinking_level, a.runtime_config->>'reasoning_effort') = 'low'
      ORDER BY t.created_at DESC, t.id DESC LIMIT 1`, [issue.id, issue.workspace_id]);
  const row = latest.rows[0];
  return Boolean(row && (isNoArtifactQcBlock(taskResultText(row.result)) ||
    isNoArtifactQcBlock(row.content)));
}

function qcTaskEvidence(task) {
  const output = task.result && typeof task.result === "object" ? task.result.output : null;
  if (typeof output !== "string") return null;
  const matches = [...output.matchAll(/^QC_EVIDENCE_JSON=(\{[^\r\n]*\})$/gm)];
  if (matches.length !== 1) return null;
  let evidence;
  try { evidence = JSON.parse(matches[0][1]); } catch { return null; }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  if ((evidence.verdict !== "PASS" && evidence.verdict !== "FAIL") ||
      !MD5_RE.test(String(evidence.work_product_md5 || "")) ||
      !SHA_RE.test(String(evidence.bound_sha || "")) ||
      !SHA_RE.test(String(evidence.observed_sha || "")) ||
      String(evidence.bound_sha).toLowerCase() !== String(evidence.observed_sha).toLowerCase() ||
      !FAILURE_CLASSES.has(evidence.failure_class) || typeof evidence.qualifying !== "boolean" ||
      evidence.model !== "gpt-5.6-sol" || evidence.effort !== "low") return null;
  return evidence;
}

function qcTaskEvidenceMismatch(task, payload) {
  const evidence = qcTaskEvidence(task);
  if (!evidence) return "qc_task_evidence_required";
  if (evidence.verdict !== payload.verdict) return "qc_task_verdict_mismatch";
  if (String(evidence.work_product_md5 || "").toLowerCase() !== payload.work_product_md5.toLowerCase()) return "qc_task_work_product_mismatch";
  if (String(evidence.bound_sha || "").toLowerCase() !== payload.bound_sha.toLowerCase() ||
      String(evidence.observed_sha || "").toLowerCase() !== payload.observed_sha.toLowerCase()) return "qc_task_sha_mismatch";
  if (evidence.failure_class !== payload.failure_class || evidence.qualifying !== payload.qualifying ||
      evidence.model !== payload.model || evidence.effort !== payload.effort) return "qc_task_evidence_mismatch";
  return null;
}

function retryEscalationReason(reason) {
  const match = String(reason || "").match(/^retry_escalation:([a-z_]+)$/);
  return match && RETRY_ESCALATION_REASONS.has(match[1]) ? match[1] : null;
}

async function retryEscalationSourceTask(client, issue, requestedTaskId = null) {
  if (requestedTaskId != null && !UUID_RE.test(String(requestedTaskId))) return null;
  const source = await client.query(
    `SELECT t.id FROM agent_task_queue t
      JOIN issue i ON i.id = t.issue_id AND i.workspace_id = $2::uuid
      WHERE t.issue_id = $1::uuid
        AND ($4::uuid IS NULL OR t.id = $4::uuid)
        AND (
          (t.status IN ('queued','dispatched','running','waiting_local_directory','deferred')
            AND t.context->>'to_stage' = $3::text)
          OR (t.status IN ('completed','failed','cancelled') AND EXISTS (
            SELECT 1 FROM relay_run_log r
             WHERE r.task_id = t.id AND r.issue_id = t.issue_id
               AND r.to_stage = $3::text AND r.status = 'pending'
          ))
        )
      ORDER BY t.created_at DESC, t.id DESC LIMIT 2 FOR UPDATE OF t`,
    [issue.id, issue.workspace_id, issue.status, requestedTaskId]);
  return source.rows.length === 1 ? source.rows[0].id : null;
}

async function capEscalationVerified(client, issue, trigger, stage) {
  const since = issue.metadata?.human_review_release_at ||
    issue.metadata?.parked_release_at || issue.metadata?.retry_escalation_at || null;
  if (trigger === "stage_cycle_limit") {
    const history = await client.query(
      `SELECT count(*)::int AS n FROM agent_task_queue
        WHERE issue_id = $1::uuid AND context->>'to_stage' = $2::text
          AND trigger_comment_id IS NULL
          AND COALESCE(context->>'kind', '') <> 'retry_escalation'
          ${budgetCountPredicate()}
          AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)`,
      [issue.id, stage, since]);
    return Number(history.rows[0]?.n || 0) >= STAGE_CYCLE_LIMIT;
  }
  if (trigger !== "lifetime_task_limit") return true;
  const history = await client.query(
    `SELECT count(*)::int AS n FROM agent_task_queue
      WHERE issue_id = $1::uuid
        AND trigger_comment_id IS NULL
        ${budgetCountPredicate()}
        AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`,
    [issue.id, since]);
  return Number(history.rows[0]?.n || 0) >= LIFETIME_TASK_LIMIT;
}

// One re-spec is a bounded handoff. A second escalation for the same
// stage is evidence that the handoff did not break the cycle, so park it.
function retryEscalationLoop(issue, stage) {
  return issue.metadata?.retry_escalation?.trigger_stage === stage;
}

async function verifiedRetryEscalation(client, issue, body) {
  const trigger = retryEscalationReason(body.reason);
  const taskId = body.retry_escalation_task_id;
  const stage = body.retry_escalation_stage;
  if (!trigger && !taskId && !stage) return null;
  if (!trigger || body.to_stage !== "Spec" || !UUID_RE.test(String(taskId || "")) ||
      typeof stage !== "string" || stage !== issue.status ||
      issue.metadata?.retry_escalation?.source_task_id === taskId) return false;
  const task = await client.query(
    `SELECT t.status, t.result, t.error FROM agent_task_queue t
      JOIN issue i ON i.id = t.issue_id AND i.workspace_id = $3::uuid
      WHERE t.id = $1::uuid AND t.issue_id = $2::uuid
        AND (t.context->>'to_stage' = $4::text OR EXISTS (
          SELECT 1 FROM relay_run_log r
           WHERE r.task_id = t.id AND r.issue_id = t.issue_id AND r.to_stage = $4::text
        ))
        AND t.status IN ('completed', 'failed', 'cancelled') FOR UPDATE OF t`,
    [taskId, issue.id, issue.workspace_id, stage]
  );
  const row = task.rows[0];
  if (!row) return false;
  if (trigger.startsWith("completion_") || trigger === "missing_result") {
    const admission = completionAdmission(row.result ?? (row.error ? { error: row.error } : null));
    if (row.status !== "completed" || admission.ok || admission.reason !== trigger) return false;
  }
  if (!await capEscalationVerified(client, issue, trigger, stage)) return false;
  return { reason: trigger, trigger_stage: stage, source_task_id: taskId };
}

function escalationDeadline() {
  const minutes = Number.isInteger(RETRY_ESCALATION_DEADLINE_MINUTES) &&
    RETRY_ESCALATION_DEADLINE_MINUTES > 0 ? RETRY_ESCALATION_DEADLINE_MINUTES : 20;
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// Tim's rule (2026-09-06): after two failed Luna QC passes the review goes to
// Sol immediately. The count has to run before the owner is chosen, otherwise
// the third Luna review is already dispatched by the time anyone notices.
// Counting tasks (not verdicts) keeps a QC run that died without writing a
// verdict from being invisible here.
async function qcEscalationPreference(client, issue, toStage) {
  if (toStage !== "In Review") return [];
  const prior = await client.query(
    `SELECT count(*)::int AS n FROM agent_task_queue
      WHERE issue_id = $1::uuid AND context->>'to_stage' = 'In Review'
        AND trigger_comment_id IS NULL
        AND COALESCE(context->>'kind', '') <> 'retry_escalation'`,
    [issue.id]
  );
  const bounces = Number(prior.rows[0]?.n || 0);
  if (!Number.isInteger(QC_ESCALATION_BOUNCES) || QC_ESCALATION_BOUNCES < 1) return [];
  return bounces >= QC_ESCALATION_BOUNCES ? qcEscalationModels() : [];
}

async function recordRetryEscalation(client, issue, escalation) {
  // The target is whatever the caller actually routed to. Hard-coding "Spec"
  // wrote a false audit record whenever the disposition differed.
  const details = { target_stage: "Spec", ...escalation };
  await client.query(
    `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) ||
          jsonb_build_object('retry_escalation', $2::jsonb, 'retry_escalation_at', to_jsonb(NOW())),
        updated_at = NOW() WHERE id = $1::uuid`, [issue.id, JSON.stringify(details)]);
  const content = `<!-- multica-retry-escalation -->\nreason_code: ${details.reason}\n` +
    `failed_stage: ${details.trigger_stage}\nowner: ${details.owner}\ndeadline: ${details.deadline}\n` +
    `source_task_id: ${details.source_task_id || "bridge_cap"}\nnext_action: re-spec on ${details.model}`;
  await client.query(
    `INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type)
     SELECT $1::uuid, $2::uuid, 'system', $3::uuid, $4::text, 'system'
      WHERE NOT EXISTS (SELECT 1 FROM comment WHERE issue_id = $1::uuid AND content = $4::text)`,
    [issue.id, issue.workspace_id, "00000000-0000-0000-0000-000000000000", content]);
  await client.query(
    `INSERT INTO activity_log (workspace_id, issue_id, actor_type, action, details)
     VALUES ($1::uuid, $2::uuid, 'system', 'relay_retry_escalated', $3::jsonb)`,
    [issue.workspace_id, issue.id, JSON.stringify(details)]);
}

async function selectRetryEscalationOwner(client, issue) {
  const owner = await selectStageOwner(client, issue.workspace_id, "Registered", "Spec");
  if (!owner?.agent_id || !owner.owner_id || owner.archived_at || !owner.selected_runtime_id) {
    throw new Error(`No active re-spec owner for workspace ${issue.workspace_id}`);
  }
  // A re-spec is a scoping run, so the spec lane is admissible here alongside
  // QC's. Hard-coding gpt-5.6-sol rejected the workspace's actual Spec owner --
  // an opus scoper, which guardrails.cjs already admits through isSpecLane --
  // and every retry escalation threw before it could hand the ticket back.
  if (!isQcLane(owner.model, owner.thinking_level) && !isSpecLane(owner.model, owner.thinking_level)) {
    throw new Error(`re-spec owner has invalid lane: ${owner.agent_name}`);
  }
  const compatibility = instructionCompatibility(owner.instructions, "Spec");
  const preflight = spendPreflight(owner, { provider: owner.selected_runtime_provider });
  if (!compatibility.ok || !preflight.ok) {
    const reason = compatibility.ok ? preflight.reason : "instruction_incompatible";
    throw new Error(`re-spec owner refused: ${reason}`);
  }
  return owner;
}

async function applyDisposition(client, issue, disposition, reason, evidence = {}) {
  const changed = await client.query(
    `UPDATE issue SET status = $1, updated_at = NOW()
      WHERE id = $2 AND status <> $1 RETURNING id`,
    [disposition, issue.id]
  );
  if (changed.rowCount > 0 && disposition === 'Parked') {
    await recordParkedEntry(client, {
      issueId: issue.id,
      fromStage: issue.status,
      trigger: reason,
      intendedStage: evidence.target_stage || null,
      attempts: evidence.historical_tasks || 0,
      taskCount: evidence.task_count || evidence.historical_tasks || 0
    });
    const diagnosisTaskId = await recordParkAndQueueDiagnosis(client, issue,
      { ...evidence, reason });
    if (diagnosisTaskId) evidence = { ...evidence, diagnosis_task_id: diagnosisTaskId };
  }
  await client.query(
    `UPDATE agent_task_queue
        SET status = 'cancelled', completed_at = NOW(),
            prepare_lease_expires_at = NULL, failure_reason = $2
      WHERE issue_id = $1
        -- A disposition must not interrupt a paid task that already started.
        -- Running predecessors are handled by cross-stage admission and are
        -- allowed to reach a terminal state before any successor is created.
        AND status IN ('queued','dispatched','waiting_local_directory','deferred')
        AND COALESCE(context->>'kind', '') <> 'parked_diagnosis'`,
    [issue.id, reason]
  );
  if (changed.rowCount > 0) {
    await client.query(
      `INSERT INTO activity_log
         (workspace_id, issue_id, actor_type, action, details)
       VALUES ($1, $2, 'system', 'relay_disposition_applied', $3::jsonb)`,
      [issue.workspace_id, issue.id, JSON.stringify({
        from: issue.status, to: disposition, reason, ...evidence
      })]
    );
  }
  return changed.rowCount > 0;
}

// The spec agent's output is recognised by its required headings, not by author:
// re-running the spec lane under a different agent must keep working.
async function latestSpecComment(client, issueId) {
  const r = await client.query(
    `SELECT content
       FROM comment
      WHERE issue_id = $1
        AND content LIKE '%## Spec%'
        AND content LIKE '%## Evidence%'
      ORDER BY created_at DESC
      LIMIT 1`,
    [issueId]
  );
  return r.rows[0]?.content || null;
}

// Idempotent: re-advancing a ticket replaces the block instead of stacking copies.
function descriptionWithSpec(description, spec) {
  const body = typeof description === "string" ? description : "";
  const block = `${SPEC_BEGIN}\n## Specification (binding — built to this)\n${spec}\n${SPEC_END}`;
  const begin = body.indexOf(SPEC_BEGIN);
  const end = body.indexOf(SPEC_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return body.slice(0, begin) + block + body.slice(end + SPEC_END.length);
  }
  return body ? `${body}\n\n${block}` : block;
}

// A ticket is not finished when review passes; it is finished when its change is
// merged and deployed. QC used to advance straight to Done, so tickets closed
// while their pull request sat open and nothing ever shipped. Work that produced
// a pull request must pass through CI/CD & Deploy, where multica-cicd-worker
// checks the run on the head SHA, merges when green, and only then finishes it.
// A ticket with no pull request (a question, a document, a decision) still goes
// straight to Done — there is nothing to deploy.
const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i;

async function issuePullRequest(client, issueId) {
  const r = await client.query(
    `SELECT content FROM comment WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 40`,
    [issueId]
  );
  for (const row of r.rows) {
    const m = PR_URL_RE.exec(row.content || "");
    if (m) return m[0];
  }
  return null;
}

function rejectInvalidRelayStage(res, toStage) {
  // Structured logging is the audit event for rejected requests. An invalid
  // target cannot be recorded in relay_run_log because that table models only
  // completed/pending configured transitions.
  console.warn(JSON.stringify({
    event: "relay.advance.rejected",
    reason: "invalid_to_stage",
    to_stage: typeof toStage === "string" ? toStage : null
  }));
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: "invalid_to_stage",
    message: "to_stage must be a configured relay stage"
  }));
}

function rejectInvalidRelayTransition(res, fromStage, toStage) {
  console.warn(JSON.stringify({
    event: "relay.advance.rejected",
    reason: "invalid_transition",
    from_stage: fromStage,
    to_stage: toStage
  }));
  res.writeHead(409, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: "invalid_transition",
    message: "to_stage is not a configured successor of the issue status",
    from_stage: fromStage,
    to_stage: toStage
  }));
}

// Admit a transition against the stage that was locked at the start of the
// request.  Keep this decision as a value: callers must not re-evaluate after
// updating the issue, when a read would naturally see the destination stage
// and turn a committed transition into a false `transition_denied` response.
function admitConfiguredTransition({ fromStage, toStage, expectedStage, altStages = [],
  exceptional = false }) {
  const allowed = [expectedStage, ...altStages].filter(Boolean);
  return {
    fromStage,
    toStage,
    ok: exceptional || allowed.includes(toStage)
  };
}

// Every committed relay transition gets one compact, secret-free audit event.
// The JSON shape is intentionally stable so operators can query actor, route,
// reason, and outcome without reverse-engineering empty activity rows.
// activity_log.actor_type is constrained to the member/agent/system enum
// (001_init.up.sql:160). Relay roles such as 'archiver' and 'operator' are
// finer-grained than that column admits, so the column carries the enum value
// and details.actor_type keeps the exact role for querying.
const ACTIVITY_LOG_ACTOR_TYPES = new Set(['member', 'agent', 'system']);

async function recordTransitionAudit(client, issue, {
  fromStage, toStage, actorType = 'system', actorId = null, reason = null,
  evidence = {}, result = 'committed', error = null
} = {}) {
  const columnActorType = ACTIVITY_LOG_ACTOR_TYPES.has(actorType) ? actorType : 'system';
  const details = {
    issue_id: issue.id,
    from_stage: fromStage,
    to_stage: toStage,
    actor_type: actorType,
    actor_id: actorId,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null,
    evidence: evidence && typeof evidence === 'object' ? evidence : {},
    result,
    error: error ? String(error).slice(0, 500) : null,
    timestamp: new Date().toISOString()
  };
  await client.query(
    `INSERT INTO activity_log (workspace_id, issue_id, actor_type, action, details)
     VALUES ($1::uuid, $2::uuid, $3::text, 'relay_transition', $4::jsonb)`,
    [issue.workspace_id, issue.id, columnActorType, JSON.stringify(details)]
  );
  return details;
}

function isCicdReturn(fromStage, toStage, reason) {
  return fromStage === "CI/CD & Deploy" && toStage === "In Progress" &&
    typeof reason === "string" &&
    /^RETURN:In Progress — [^\s/]+\/[^\s#]+#[1-9][0-9]* (?:merge conflict; verify master\.\.merge diff after rebase|no CI runs after [1-9][0-9]* minutes)$/.test(reason);
}

// The CI/CD repair exception is intentionally per-issue, not per caller
// reason.  This conditional update is performed in the relay transaction, so
// the row lock and durable marker make the authorization single-use across a
// complete return -> build -> QC -> deploy cycle.
async function consumeCicdReturnAuthorization(client, issueId) {
  const consumed = await client.query(
    `UPDATE "issue"
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                                 '{cicd_return_consumed_at}', to_jsonb(NOW()), true),
            updated_at = NOW()
      WHERE id = $1
        AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'cicd_return_consumed_at')
      RETURNING id`,
    [issueId]
  );
  return consumed.rows.length === 1;
}

async function authorizeCicdReturnCapBypass(client, issueId, capBypass) {
  if (!capBypass) return false;
  return consumeCicdReturnAuthorization(client, issueId);
}

async function replaceStageTask(client, task) {
  // The issue row lock normally serializes relayAdvance callers. Keep the
  // enqueue primitive safe for recovery/replay callers too: the predicate and
  // insert must share a stage-specific transaction lock or simultaneous
  // retries can both observe no active successor.
  if (task.serialize) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      task.issueId, task.toStage
    ]);
  }
  const context = typeof task.context === 'string' ? JSON.parse(task.context) : task.context;
  if (!isBuilderDispatchAllowed(context)) {
    throw new Error('builder dispatcher rejected a no_builder diagnosis task');
  }
  // The issue row is locked by relayAdvance. Cancel only unstarted relay work
  // for another execution stage before making the successor visible. Running
  // paid work and manual/disposition tasks are deliberately preserved.
  await client.query(
    `UPDATE agent_task_queue
        SET status = 'cancelled', completed_at = NOW(),
            prepare_lease_expires_at = NULL,
            failure_reason = 'relay_stage_transition_superseded'
      WHERE issue_id = $1
        AND status::text = ANY($2::text[])
        AND context ? 'to_stage'
        AND COALESCE(context->>'source', '') NOT LIKE 'manual%'
        AND context->>'to_stage' NOT IN
            ('Human Review', 'Parked', 'Rejected', 'Done', 'Archived', 'Cancelled')
        AND COALESCE(context->>'to_stage', '') IS DISTINCT FROM $3`,
    [task.issueId, REPLACEABLE_TASK_STATUSES, task.toStage]
  );

  const inserted = await client.query(
    `INSERT INTO agent_task_queue (
       agent_id, issue_id, workspace_id, status, priority, runtime_id, context,
       trigger_summary, force_fresh_session, originator_source,
       trigger_evidence_kind
     )
     SELECT $1, $2, $3, 'queued', $4, $5, $6::jsonb, $7, TRUE,
            'unattributed', 'relay_stage_transition'
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_task_queue active
         WHERE active.issue_id = $2
           AND active.status::text = ANY($8::text[])
           AND active.context->>'to_stage' = $9
      )
       ON CONFLICT DO NOTHING
       RETURNING id`,
    [task.agentId, task.issueId, task.workspaceId, task.priority, task.runtimeId, task.context,
      task.triggerSummary, LIVE_TASK_STATUSES, task.toStage]
  );

  const taskId = inserted.rows[0]?.id || await existingStageTask(
    client, task.issueId, task.toStage
  );
  if (!taskId) {
    throw new Error(`relay successor task was not created for issue ${task.issueId} stage ${task.toStage}`);
  }

  const log = task.relayAudit
    ? await client.query(
      `INSERT INTO relay_run_log (
         issue_id, from_stage, to_stage, agent_id, task_id, status, parked_audit
       )
       SELECT $1, $2, $3, $4, $5, 'pending', $6::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM relay_run_log
           WHERE issue_id = $1 AND task_id = $5
        )
       RETURNING id`,
      [task.issueId, task.fromStage, task.toStage, task.agentId, taskId, task.relayAudit]
    ) : await client.query(
      `INSERT INTO relay_run_log (
         issue_id, from_stage, to_stage, agent_id, task_id, status
       )
       SELECT $1, $2, $3, $4, $5, 'pending'
        WHERE NOT EXISTS (
          SELECT 1 FROM relay_run_log
           WHERE issue_id = $1 AND task_id = $5
        )
       RETURNING id`,
      [task.issueId, task.fromStage, task.toStage, task.agentId, taskId]
    );
  return { taskId, relayLogId: log.rows[0]?.id || null };
}

// Link the Queue -> In Progress bookkeeping hop to the builder task that
// produced the work product. This gives the relay daemon a task-correlated
// trigger for the following In Progress -> In Review QC hop without creating a
// second paid builder task. A missing predecessor is rejected by relayAdvance
// before the issue status changes, so a manual shortcut cannot skip the build.
async function recordBookkeepingHandoff(client, issueId) {
  const predecessor = await client.query(
    `SELECT id, agent_id, status, result
       FROM agent_task_queue
      WHERE issue_id = $1
        AND context->>'to_stage' = 'Queue'
        AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [issueId]
  );
  const task = predecessor.rows[0];
  // A terminal status alone is not a work-product proof. Keep this check
  // aligned with the completion daemon so a handoff cannot race a failing
  // builder or turn a missing result into a paid QC dispatch.
  if (!task || task.status !== 'completed' || !completionAdmission(task.result).ok) {
    return null;
  }

  const log = await client.query(
    `WITH existing AS (
       SELECT id FROM relay_run_log
        WHERE issue_id = $1 AND from_stage = 'Queue'
          AND to_stage = 'In Progress' AND task_id = $3
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE
     ), inserted AS (
       INSERT INTO relay_run_log
         (issue_id, from_stage, to_stage, agent_id, task_id, status)
       SELECT $1, 'Queue', 'In Progress', $2, $3, 'pending'
        WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id
     )
     SELECT id FROM inserted UNION ALL SELECT id FROM existing LIMIT 1`,
    [issueId, task.agent_id, task.id]
  );
  return { taskId: task.id, relayLogId: log.rows[0]?.id || null };
}

// Terminal transitions do not create a successor task, so they cannot use the
// task-backed relay log path above. Keep one completed audit row for the deploy
// close; the issue row lock held by relayAdvance makes the update/insert pair
// idempotent for retries of the same transition.
async function ensureCompletedRelayLog(client, issueId, fromStage, toStage) {
  const completed = await client.query(
    `WITH candidate AS (
      SELECT id FROM relay_run_log
       WHERE issue_id = $1
         AND from_stage = $2
         AND to_stage = $3
         AND status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM relay_run_log
            WHERE issue_id = $1
              AND from_stage = $2
              AND to_stage = $3
              AND status = 'completed'
         )
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE
    )
    UPDATE relay_run_log
       SET status = 'completed'
      FROM candidate
     WHERE relay_run_log.id = candidate.id
     RETURNING relay_run_log.id`,
    [issueId, fromStage, toStage]
  );
  if (completed.rows[0]?.id) return completed.rows[0].id;

  const inserted = await client.query(
    `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status)
     SELECT $1, $2, $3, 'completed'
      WHERE NOT EXISTS (
        SELECT 1 FROM relay_run_log
         WHERE issue_id = $1
           AND from_stage = $2
           AND to_stage = $3
           AND status = 'completed'
      )
     RETURNING id`,
    [issueId, fromStage, toStage]
  );
  if (inserted.rows[0]?.id) return inserted.rows[0].id;
  const existing = await client.query(
    `SELECT id FROM relay_run_log
      WHERE issue_id = $1 AND from_stage = $2 AND to_stage = $3
        AND status = 'completed'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [issueId, fromStage, toStage]
  );
  return existing.rows[0]?.id || null;
}

async function completedTerminalRelayLog(client, issueId, toStage) {
  const existing = await client.query(
    `SELECT id FROM relay_run_log
      WHERE issue_id = $1 AND to_stage = $2 AND status = 'completed'
      ORDER BY created_at DESC, id DESC LIMIT 1`, [issueId, toStage]);
  return existing.rows[0]?.id || null;
}

async function existingStageTask(client, issueId, toStage) {
  const existing = await client.query(
    `SELECT id FROM agent_task_queue
      WHERE issue_id = $1
        AND status::text = ANY($2::text[])
        AND context->>'to_stage' = $3
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [issueId, LIVE_TASK_STATUSES, toStage]
  );
  return existing.rows[0]?.id || null;
}

async function ssoBridge(req, res) {
  try {
    // Read CF Access authenticated user email from header
    const userEmail = req.headers["cf-access-authenticated-user-email"];

    if (!userEmail) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not authenticated via CF Access" }));
      return;
    }

    const site = resolveSite(req);

    const client = new Client({ connectionString: MULTICA_DB });
    await client.connect();

    // Get or create user
    let userResult = await client.query(
      "SELECT id FROM \"user\" WHERE email = $1",
      [userEmail]
    );

    let userId;
    if (userResult.rows.length === 0) {
      // Create new user
      const createResult = await client.query(
        "INSERT INTO \"user\" (id, name, email, created_at, updated_at, onboarded_at) VALUES (gen_random_uuid(), $1, $2, NOW(), NOW(), NOW()) RETURNING id",
        [userEmail.split("@")[0], userEmail]
      );
      userId = createResult.rows[0].id;

      // Add to workspace as admin
      await client.query(
        "INSERT INTO member (id, user_id, workspace_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, $3, NOW())",
        [userId, site.workspaceId, 'admin']
      );
    } else {
      userId = userResult.rows[0].id;
      // Ensure onboarded_at is set for existing users
      await client.query(
        "UPDATE \"user\" SET onboarded_at = COALESCE(onboarded_at, NOW()) WHERE id = $1",
        [userId]
      );
      // A user who already exists (created on another host) still needs a
      // membership row here, or the redirect lands on a workspace they
      // cannot read.
      await client.query(
        "INSERT INTO member (id, user_id, workspace_id, role, created_at) SELECT gen_random_uuid(), $1, $2, 'admin', NOW() WHERE NOT EXISTS (SELECT 1 FROM member WHERE user_id = $1 AND workspace_id = $2)",
        [userId, site.workspaceId]
      );
    }

    await client.end();

    // Create JWT token
    const token = jwt.sign(
      { sub: userId, email: userEmail, workspace_id: site.workspaceId },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Generate CSRF token: nonce.signature where signature = HMAC-SHA256(nonce, authToken)
    // This matches the server's ValidateCSRF expectation: hex(nonce).hex(HMAC-SHA256(nonce, authToken))
    const nonce = crypto.randomBytes(16);
    const mac = crypto.createHmac("sha256", token);
    mac.update(nonce);
    const sig = mac.digest("hex");
    const csrfToken = nonce.toString("hex") + "." + sig;

    // Set secure HttpOnly cookie for auth and CSRF cookie for POST requests
    res.writeHead(302, {
      "Location": `/${site.slug}/issues`,
      "Set-Cookie": [
        `multica_auth=${token}; Path=/; Domain=${site.host}; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
        `multica_csrf=${csrfToken}; Path=/; Domain=${site.host}; Secure; SameSite=Lax; Max-Age=604800`
      ]
    });
    res.end();
  } catch (err) {
    console.error("SSO Bridge error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function canonicalStageOwner(client, workspaceId, ownerStage) {
  const result = await client.query(
    `SELECT rsc.agent_id, rsc.agent_name, a.id AS owner_id, a.runtime_id, a.archived_at,
            a.instructions, a.model, a.thinking_level, a.max_concurrent_tasks, a.runtime_config,
            (SELECT ar.provider FROM agent_runtime ar WHERE ar.id = a.runtime_id) AS selected_runtime_provider,
            COALESCE(a.runtime_id, (
              SELECT ar.id FROM agent_runtime ar
               WHERE ar.workspace_id = $1 AND ar.provider = 'codex' AND ar.status = 'online'
               ORDER BY ar.updated_at DESC LIMIT 1
            )) AS selected_runtime_id
       FROM relay_stage_config rsc
       LEFT JOIN agent a ON a.id = rsc.agent_id AND a.workspace_id = rsc.workspace_id
      WHERE rsc.workspace_id = $1 AND rsc.stage_name = $2`, [workspaceId, ownerStage]);
  return result.rows[0] || null;
}

async function selectPoolOwner(client, workspaceId, ownerStage, toStage, options = {}) {
  // Selection and the rotation update share the relay transaction. The advisory
  // lock makes equal-load choices stable under concurrent advances into this pool.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [workspaceId, toStage]);
  const result = await client.query(
    `SELECT p.agent_id, a.name AS agent_name, a.id AS owner_id, a.runtime_id, a.archived_at,
            a.status AS agent_status, a.instructions, a.model, a.thinking_level,
            a.max_concurrent_tasks, a.runtime_config, p.last_selected_at,
            COALESCE(own_runtime.provider, online_runtime.provider) AS selected_runtime_provider,
            COALESCE(own_runtime.id, online_runtime.id) AS selected_runtime_id,
            COALESCE(active.task_count, 0)::int AS active_task_count
       FROM relay_stage_agent_pool p
       JOIN relay_stage_pool policy ON policy.workspace_id = p.workspace_id
        AND policy.stage_name = p.stage_name AND policy.enabled = true
       LEFT JOIN agent a ON a.id = p.agent_id AND a.workspace_id = p.workspace_id
       LEFT JOIN agent_runtime own_runtime ON own_runtime.id = a.runtime_id
        AND own_runtime.provider = 'codex' AND own_runtime.status = 'online'
       LEFT JOIN LATERAL (
         SELECT ar.id, ar.provider FROM agent_runtime ar
          WHERE ar.workspace_id = p.workspace_id AND ar.provider = 'codex' AND ar.status = 'online'
          ORDER BY ar.updated_at DESC LIMIT 1
       ) online_runtime ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS task_count FROM agent_task_queue atq
          WHERE atq.agent_id = p.agent_id
            AND atq.status IN ('queued','dispatched','running','waiting_local_directory','deferred')
       ) active ON true
      WHERE p.workspace_id = $1 AND p.stage_name = $2 AND p.enabled = true
      ORDER BY active_task_count, p.last_selected_at NULLS FIRST, p.agent_id`, [workspaceId, toStage]);
  if (result.rows.length === 0) return null;
  const identityEligible = result.rows.filter((row) => row.archived_at === null &&
    ["idle", "working"].includes(row.agent_status) && row.selected_runtime_id &&
    instructionCompatibility(row.instructions, toStage).ok);
  if (identityEligible.length === 0) throw new Error(`No eligible stage owner in pool: ${workspaceId}/${toStage}`);
  const ts = (value) => (value === null || value === undefined) ? -Infinity : new Date(value).getTime();
  identityEligible.sort((left, right) => Number(left.active_task_count) - Number(right.active_task_count) ||
    ts(left.last_selected_at) - ts(right.last_selected_at) ||
    String(left.agent_id).localeCompare(String(right.agent_id)));
  // An escalation lane narrows the pool rather than replacing it. When no
  // member of the preferred lane is eligible the normal pool still owns the
  // stage, so a missing or offline escalation agent degrades to today's
  // behaviour instead of stalling the advance.
  const preferModels = Array.isArray(options.preferModels) ? options.preferModels : [];
  const preferred = preferModels.length
    ? identityEligible.filter((row) => preferModels.includes(row.model))
    : [];
  const candidates = preferred.length ? preferred : identityEligible;
  const eligible = candidates.filter((row) =>
    Number(row.active_task_count) < Number(row.max_concurrent_tasks));
  // A pool is still a valid owner when every member is busy. Queue the task on
  // its least-loaded compatible member instead of rejecting the relay advance.
  // The SQL order preserves the normal round-robin choice for below-cap rows.
  const selected = eligible[0] || candidates[0];
  await client.query(
    `UPDATE relay_stage_agent_pool SET last_selected_at = NOW()
      WHERE workspace_id = $1 AND stage_name = $2 AND agent_id = $3`,
    [workspaceId, toStage, selected.agent_id]
  );
  return selected;
}

async function selectStageOwner(client, workspaceId, ownerStage, toStage, options = {}) {
  const pooled = await selectPoolOwner(client, workspaceId, ownerStage, toStage, options);
  return pooled || canonicalStageOwner(client, workspaceId, ownerStage);
}

async function relayVerdict(req, res, payload) {
  if (!RELAY_AGENT_SECRET || payload.agent_token !== RELAY_AGENT_SECRET) {
    relayVerdictError(res, 403, "invalid_token");
    return;
  }
  const invalid = validateRelayVerdict(payload);
  if (invalid) {
    relayVerdictError(res, 400, invalid);
    return;
  }
  const client = testClientFactory ? testClientFactory() : new Client({ connectionString: MULTICA_DB });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [payload.idem_key]);
    const prior = await client.query(
      `SELECT issue_id, checker_name, verdict, work_product_md5, bound_sha,
              observed_head, failure_class, qualifying, model, effort
         FROM qc_attempt WHERE idem_key = $1 FOR UPDATE`, [payload.idem_key]
    );
    const replay = prior.rows.length > 0;
    if (replay) {
      const existing = prior.rows[0];
      const same = existing.issue_id === payload.issue_id && existing.verdict === payload.verdict &&
        String(existing.work_product_md5).toLowerCase() === payload.work_product_md5.toLowerCase() &&
        String(existing.bound_sha).toLowerCase() === payload.bound_sha.toLowerCase() &&
        String(existing.observed_head).toLowerCase() === payload.observed_sha.toLowerCase() &&
        existing.failure_class === payload.failure_class && existing.qualifying === payload.qualifying &&
        existing.model === payload.model && existing.effort === payload.effort;
      if (!same) {
        await client.query("COMMIT");
        return relayVerdictError(res, 409, "idempotency_conflict");
      }
      // FAIL replays are immutable acknowledgements. Only PASS replays repair
      // a missing verdict row so they cannot alter FAIL behavior.
      if (payload.verdict !== "PASS") {
        await client.query("COMMIT");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, replay: true, issue_id: payload.issue_id,
          work_product_md5: existing.work_product_md5 }));
        return;
      }
    }

    const issue = await client.query(
      `SELECT id, workspace_id FROM issue WHERE id = $1 FOR UPDATE`, [payload.issue_id]
    );
    if (issue.rows.length === 0) {
      await client.query("ROLLBACK");
      return relayVerdictError(res, 404, "issue_not_found");
    }
    const qcTask = await latestCompletedSolLowQcTask(client, payload.issue_id,
      issue.rows[0].workspace_id, payload.qc_task_id || null);
    if (!qcTask) {
      await client.query("ROLLBACK");
      return relayVerdictError(res, 409, "assigned_running_sol_low_in_review_qc_task_required");
    }
    const evidenceMismatch = qcTaskEvidenceMismatch(qcTask, payload);
    if (evidenceMismatch) {
      await client.query("ROLLBACK");
      return relayVerdictError(res, 409, evidenceMismatch);
    }
    const notes = [
      `relay_task_id=${qcTask.id}`,
      `relay_agent_id=${qcTask.agent_id}`,
      `relay_agent_name=${qcTask.agent_name}`,
      typeof payload.notes === "string" && payload.notes.length <= 2000 ? payload.notes : null,
    ].filter(Boolean).join("\n");
    const current = await client.query(
      `SELECT issue_id, checker_id, notes, created_at
         FROM qc_verdict WHERE issue_id = $1 FOR UPDATE`, [payload.issue_id]
    );
    const currentVerdict = current.rows[0];
    const currentFromBoundTask = currentVerdict &&
      currentVerdict.checker_id === qcTask.agent_id &&
      String(currentVerdict.notes || "").includes(`relay_task_id=${qcTask.id}`);
    if (replay && !liveQcTask && currentVerdict && !currentFromBoundTask &&
        new Date(currentVerdict.created_at) > new Date(qcTask.completed_at)) {
      await client.query("ROLLBACK");
      return relayVerdictError(res, 409, "qc_verdict_newer_than_bound_qc_task");
    }
    if (!replay) {
      await client.query(
        `INSERT INTO qc_attempt
           (issue_id, checker_name, verdict, work_product_md5, bound_sha, observed_head,
            failure_class, qualifying, model, effort, idem_key, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [payload.issue_id, qcTask.agent_name, payload.verdict, payload.work_product_md5,
          payload.bound_sha, payload.observed_sha, payload.failure_class, payload.qualifying,
          payload.model, payload.effort, payload.idem_key, notes]
      );
    }
    if (!currentFromBoundTask) {
      if (currentVerdict) {
        await client.query(
          `UPDATE qc_verdict SET checker_id = $2, checker_name = $3, verdict = $4,
                  work_product_md5 = $5, notes = $6, created_at = NOW()
            WHERE issue_id = $1`,
          [payload.issue_id, qcTask.agent_id, qcTask.agent_name, payload.verdict,
            payload.work_product_md5, notes]
        );
      } else {
        await client.query(
          `INSERT INTO qc_verdict
             (issue_id, checker_id, checker_name, verdict, work_product_md5, notes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [payload.issue_id, qcTask.agent_id, qcTask.agent_name, payload.verdict,
            payload.work_product_md5, notes]
        );
      }
    }
    await client.query("COMMIT");
    res.writeHead(replay ? 200 : 201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, replay, issue_id: payload.issue_id,
      checker_id: qcTask.agent_id, work_product_md5: payload.work_product_md5 }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[relay/verdict] ERROR:", err.message);
    relayVerdictError(res, 500, "internal_error");
  } finally {
    await client.end().catch(() => {});
  }
}

async function relayAdvance(req, res, body) {
  let client;
  try {
    let { issue_id, to_stage, agent_token, current_work_product_md5, reason, parked_audit,
      operator_rescope_issue_id, operator_terminal_exit, operator_release } = body;
    
    // The archiver is a narrowly-scoped service authority. It authenticates
    // with its dedicated header and a signed receipt; it must not inherit the
    // general relay or operator authority.
    const archiveEvidence = body.evidence?.signedArchivePlanReceipt;
    const archiverRequest = body.actor === "archiver" && to_stage === "Archived" &&
      req.headers["x-relay-archiver-secret"] === ARCHIVER_AGENT_SECRET;
    const relayRequest = agent_token === RELAY_AGENT_SECRET && body.actor !== "archiver";
    if (!relayRequest && !archiverRequest) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Reject non-string input before any database work. String targets are
    // checked against relay_stage_config below, which is the sole workflow
    // contract shared with clients.
    if (typeof to_stage !== "string") {
      rejectInvalidRelayStage(res, to_stage);
      return;
    }

    client = testClientFactory ? testClientFactory() : new Client({ connectionString: MULTICA_DB });
    await client.connect();
    await client.query("BEGIN");
    await authorizeRelayStatusWrites(client);
    // Every relay execution admission for an issue takes this transaction lock,
    // including the recovery daemon. A partial unique index would either miss
    // waiting/deferred tasks or incorrectly constrain manual tasks; this lock
    // serializes precisely the belt-owned execution transition.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 804))", [issue_id]);

    const dispositionStages = new Set(["Parked", "Rejected", "Cancelled"]);
    let parkedAudit = to_stage === "Parked" ? parked_audit : null;
    let escalationLoop = false;
    const issueResult = await client.query(
      `SELECT id, status, workspace_id, description, parent_issue_id, title, priority, metadata
       FROM "issue"
       WHERE id = $1
       FOR UPDATE`,
      [issue_id]
    );

    if (issueResult.rows.length === 0) {
      await client.query("ROLLBACK");
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Issue not found" }));
      return;
    }

    const issue = issueResult.rows[0];
    if (archiverRequest && (issue.status !== "Done" || !validArchiveReceipt(issue.id, archiveEvidence))) {
      await client.query("ROLLBACK");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_archiver_evidence" }));
      return;
    }
    // In Progress -> Done is the genuine no-code terminal path.  The build
    // worker cannot self-assert it: only the relay/system may submit a
    // machine-readable NO-SHA work product, and any code-bearing route must
    // go through In Review (and then QC/deploy as configured).
    if (issue.status === 'In Progress' && to_stage === 'Done') {
      const completionEvidence = body.evidence && typeof body.evidence === 'object' ? body.evidence : {};
      const changedFiles = Array.isArray(completionEvidence.changedFiles)
        ? completionEvidence.changedFiles
        : Array.isArray(completionEvidence.checkout?.changedFiles) ? completionEvidence.checkout.changedFiles : [];
      const noSha = typeof completionEvidence.workProductEvidence === 'string' &&
        /\bNO-SHA\b/i.test(completionEvidence.workProductEvidence);
      if (completionEvidence.checkoutClean === false || changedFiles.length > 0) {
        await client.query('ROLLBACK');
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_deploy_route_ineligible', files: changedFiles }));
        return;
      }
      if (completionEvidence.noDeployRoute !== 'no_pr' || !noSha) {
        await client.query('ROLLBACK');
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_deploy_route_evidence_required',
          message: 'In Progress -> Done requires an independently checked NO-SHA work product' }));
        return;
      }
    }
    if (issue.status === 'In Progress' && to_stage === 'CI/CD & Deploy' && !body.merged_pr_evidence) {
      const allowed = await directDeployQcAdmission(client, issue.id);
      if (!allowed) {
        await client.query('ROLLBACK');
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'qualifying_qc_pass_required' }));
        return;
      }
    }
    const evidenceRequested = body.merged_pr_evidence === true ||
      (body.merged_pr_evidence && typeof body.merged_pr_evidence === 'object');
    const evidenceOperator = evidenceRequested && !OPERATOR_SECRET_DISABLED &&
      req.headers["x-relay-operator-secret"] === RELAY_OPERATOR_SECRET;
    let evidenceTransition = false;
    let evidenceAudit = null;
    if (evidenceRequested) {
      if (!evidenceOperator) {
        await client.query("ROLLBACK");
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "merged_pr_evidence_operator_required" }));
        return;
      }
      // The first evidence transition changes the source stage, so replay
      // recognition must happen before the source-stage guard.  Match the
      // evidence captured in the completed no-dispatch audit; a different SHA
      // is deliberately not treated as a replay.
      const suppliedSha = typeof body.merged_pr_evidence === 'object'
        ? body.merged_pr_evidence.sha : body.sha;
      if (issue.status === 'CI/CD & Deploy' && to_stage === 'CI/CD & Deploy' &&
          SHA_RE.test(String(suppliedSha || ''))) {
        const applied = await client.query(
          `SELECT id FROM relay_run_log
            WHERE issue_id = $1 AND to_stage = 'CI/CD & Deploy' AND status = 'completed'
              AND parked_audit->'merged_pr_evidence'->>'verified_sha' ILIKE $2
            ORDER BY created_at DESC, id DESC LIMIT 1`, [issue.id, suppliedSha]);
        if (applied.rows[0]?.id) {
          await client.query("COMMIT");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, issue: { id: issue.id, status: issue.status },
            transition: 'already_applied', task_id: null, relay_log_id: applied.rows[0].id }));
          return;
        }
      }
      if (!['Spec', 'Queue', 'In Progress'].includes(issue.status) || to_stage !== 'CI/CD & Deploy') {
        await client.query("ROLLBACK");
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "merged_pr_evidence_source_stage_invalid" }));
        return;
      }
      const verified = await mergedPrEvidence(client, issue,
        typeof body.merged_pr_evidence === 'object' ? body.merged_pr_evidence : body);
      if (!verified.ok) {
        await client.query("ROLLBACK");
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: verified.reason }));
        return;
      }
      evidenceTransition = true;
      evidenceAudit = { merged_pr_evidence: { source_stage: issue.status, pr_url: verified.pr.html_url,
        repository: verified.pr.repository, default_branch: verified.pr.default_branch,
        verified_sha: verified.pr.sha, merged_at: verified.pr.merged_at,
        verified_at: verified.pr.verified_at } };
    }
    const noArtifactRescope = await noArtifactRescopeAdmission(
      client, issue, to_stage, operatorRescopeIssueId(operator_rescope_issue_id, reason)
    );
    if (noArtifactRescope && to_stage === "In Progress") {
      to_stage = "Spec";
    }
    if (issue.status === "In Review" && to_stage === "Human Review" &&
        await latestQcNoArtifactSignal(client, issue)) {
      await client.query("ROLLBACK");
      console.warn(JSON.stringify({
        event: "relay_advance_rejected",
        reason: "technical_human_review_forbidden",
        issue_id: issue.id,
        from_stage: issue.status,
        to_stage
      }));
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "technical_human_review_forbidden",
        message: "QC-BLOCKED NO-SHA work must be re-scoped by Sol-low; Human Review is money-only"
      }));
      return;
    }
    let retryEscalation = noArtifactRescope ? null :
      await verifiedRetryEscalation(client, issue, body);
    if (retryEscalation === false) {
      await client.query("ROLLBACK");
      console.warn(JSON.stringify({ event: "relay_advance_rejected",
        reason: "retry_escalation_evidence_required", issue_id: issue.id }));
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "retry_escalation_evidence_required" }));
      return;
    }
    // Spec is already the re-scoping lane. Treat a retry escalation emitted
    // for a Spec task as handled in place instead of requesting Spec -> Spec.
    // The caller receives an explicit result and can close its failed relay
    // row without creating another execution task.
    if (retryEscalation && issue.status === "Spec") {
      await client.query("COMMIT");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        issue: { id: issue.id, status: issue.status },
        transition: "retry_escalation_handled",
        handled: "already_in_spec"
      }));
      return;
    }
    if (retryEscalation && retryEscalationLoop(issue, retryEscalation.trigger_stage)) {
      escalationLoop = true;
      parkedAudit = { trigger: "escalation_loop", reason: "escalation_loop", intendedStage: "Spec",
        attempts: 2, taskCount: 2 };
      to_stage = "Parked";
      retryEscalation = null;
    }
    const targetStageResult = await client.query(
      "SELECT stage_name FROM relay_stage_config WHERE workspace_id = $1 AND stage_name = $2",
      [issue.workspace_id, to_stage]
    );
    if (targetStageResult.rows.length === 0 && !dispositionStages.has(to_stage)) {
      await client.query("ROLLBACK");
      rejectInvalidRelayStage(res, to_stage);
      return;
    }
    const sourceStageResult = await client.query(
      "SELECT next_stage FROM relay_stage_config WHERE workspace_id = $1 AND stage_name = $2",
      [issue.workspace_id, issue.status]
    );
    // Done -> Archived remains an automation path: it is the configured,
    // terminal-to-terminal successor and terminal arrivals return before any
    // task dispatch. Other terminal exits require operator-only credentials.
    const configuredTerminalExit = isTerminalStage(issue.status) &&
      sourceStageResult.rows[0]?.next_stage === to_stage;
    const explicitTerminalExitRequested = isTerminalStage(issue.status) &&
      operator_terminal_exit === true && typeof reason === "string" && reason.trim() !== "";
    const explicitTerminalExit = explicitTerminalExitRequested &&
      !OPERATOR_SECRET_DISABLED &&
      typeof RELAY_OPERATOR_SECRET === "string" && RELAY_OPERATOR_SECRET.length > 0 &&
      req.headers["x-relay-operator-secret"] === RELAY_OPERATOR_SECRET;
    const explicitHumanReviewReleaseRequested = issue.status === "Human Review" &&
      operator_release === true && typeof reason === "string" && reason.trim() !== "";
    const explicitHumanReviewRelease = explicitHumanReviewReleaseRequested &&
      !OPERATOR_SECRET_DISABLED &&
      typeof RELAY_OPERATOR_SECRET === "string" && RELAY_OPERATOR_SECRET.length > 0 &&
      req.headers["x-relay-operator-secret"] === RELAY_OPERATOR_SECRET;
    const operatorCapBypass = explicitTerminalExit || explicitHumanReviewRelease;

    // Check the durable gate before the same-stage/idempotency fast path. A
    // replay of a Done request must not turn a newly recorded QC FAIL into a
    // successful 200 noop; every route that asks to reach Done is subject to
    // the same fail-closed admission decision.
    const doneGate = to_stage === "Done" ? await latestQcGateComment(client, issue.id) : null;
    if (to_stage === "Done" && doneGate?.verdict === "FAIL") {
      await client.query("ROLLBACK");
      console.warn(JSON.stringify({
        event: "relay_advance_rejected",
        reason: "qc_gate_failed",
        issue_id: issue.id,
        gate_comment_id: doneGate.id,
        from_stage: issue.status,
        to_stage
      }));
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "qc_gate_failed",
        message: "Done is refused while the newest QC gate verdict is FAIL",
        gate_comment_id: doneGate.id,
        from_stage: issue.status,
        to_stage
      }));
      return;
    }
    if (isTerminalStage(issue.status) && explicitTerminalExitRequested &&
        OPERATOR_SECRET_DISABLED) {
      await client.query("ROLLBACK");
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "terminal_stage_operator_secret_conflict",
        message: "operator terminal exits are disabled because relay secrets are identical"
      }));
      return;
    }
    if (explicitHumanReviewReleaseRequested && !explicitHumanReviewRelease) {
      await client.query("ROLLBACK");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "terminal_stage_operator_secret_conflict",
        message: "operator human review releases require a valid operator secret"
      }));
      return;
    }
    if (isTerminalStage(issue.status) && !configuredTerminalExit && !explicitTerminalExit) {
      await client.query("ROLLBACK");
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "terminal_stage_operator_marker_required",
        message: "terminal exits require the configured successor or an authenticated operator marker and reason"
      }));
      return;
    }
    const parkedRelease = issue.status === "Parked" && ["Queue", "Spec"].includes(to_stage) &&
      issue.metadata?.parked_release_once === true;
    const parkedEvidenceQcRelease = await verifiedParkedEvidenceRelease(client, issue, to_stage, reason);
    // Parked -> Done is reserved for the relay's already-fixed diagnosis
    // outcome. It still reaches the current PASS + work-product-hash gate
    // below; the relay secret is the authority boundary for this exception.
    const parkedDiagnosisDone = issue.status === "Parked" && to_stage === "Done";
    // A deploy worker return is a bounded change-of-hands, not another blind
    // retry. It admits one repair task after a named terminal deploy blocker
    // (merge conflict or absent CI), even when historical retry counts are
    // exhausted. Its durable authorization is consumed only after admission
    // succeeds and only when it must bypass an execution cap.
    const cicdReturn = isCicdReturn(issue.status, to_stage, reason) &&
      !issue.metadata?.cicd_return_consumed_at;
    let cicdReturnCapBypass = false;
    if (explicitHumanReviewRelease) {
      issue.metadata = { ...(issue.metadata || {}),
        human_review_release_at: new Date().toISOString(),
        human_review_release_reason: reason.trim() };
    }
    // A person releasing a ticket is a decision to spend more on it, so it
    // resets both budgets. The belt escalating to itself is not: it writes
    // retry_escalation_at on every lap, and honouring that as a lifetime floor
    // handed the ticket a fresh six paid runs each time. The stage-cycle budget
    // still honours it, because handing the flight to a bounded re-spec is
    // exactly what that escalation is for.
    const humanReleaseAt = issue.metadata?.human_review_release_at ||
      issue.metadata?.parked_release_at || null;
    const releaseAt = humanReleaseAt || issue.metadata?.retry_escalation_at || null;
    if (issue.status === to_stage && !retryEscalation) {
      const taskId = await existingStageTask(client, issue.id, to_stage);
      const relayLogId = isTerminalStage(to_stage)
        ? await completedTerminalRelayLog(client, issue.id, to_stage) : null;
      await client.query(
        `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, status, parked_audit)
         SELECT $1, $2, $2, 'noop', jsonb_build_object('reason', 'same_stage')
          WHERE NOT EXISTS (SELECT 1 FROM relay_run_log
            WHERE issue_id = $1 AND from_stage = $2 AND to_stage = $2
              AND status = 'noop' AND created_at > NOW() - interval '1 minute')`,
        [issue.id, issue.status]);
      await client.query("COMMIT");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        issue: { id: issue.id, status: issue.status },
        transition: "already_applied",
        task_id: taskId,
        relay_log_id: relayLogId
      }));
      return;
    }

    const bookkeepingTransition = isBookkeepingTransition(issue.status, to_stage);
    let bookkeepingHandoff = null;
    if (bookkeepingTransition) {
      bookkeepingHandoff = await recordBookkeepingHandoff(client, issue.id);
      if (!bookkeepingHandoff) {
        await client.query("ROLLBACK");
        console.warn(JSON.stringify({
          event: "relay_advance_rejected",
          reason: "builder_work_product_required",
          issue_id: issue.id,
          from_stage: issue.status,
          to_stage
        }));
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "builder_work_product_required",
          message: "Queue -> In Progress is bookkeeping for a completed builder task; re-enter Spec to start a build"
        }));
        return;
      }
    }

    const transitionResult = await client.query(
      `SELECT next_stage, alt_next_stages
       FROM relay_stage_config
       WHERE workspace_id = $1 AND stage_name = $2`,
      [issue.workspace_id, issue.status]
    );
    // A stage may have more than one legal successor. QC decides whether a
    // passed ticket needs a deploy (CI/CD & Deploy), a human (Human Review,
    // money or architecture only), or nothing further (Done). A single linear
    // next_stage forced every passed ticket through Human Review, which is why
    // that column stayed full while Done stayed flat. alt_next_stages is
    // additive: a NULL leaves the stage exactly as strict as it was.
    const expectedStage = transitionResult.rows[0]?.next_stage;
    const altStages = transitionResult.rows[0]?.alt_next_stages || [];
    const allowedStages = [expectedStage].concat(altStages).filter(Boolean);
    if (issue.status === "In Review" && to_stage === "Spec" && !noArtifactRescope) {
      const decision = qcBounceDecision(await latestQcVerdict(client, issue_id), expectedStage);
      if (decision.action === "hold") {
        await client.query("ROLLBACK");
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: decision.reason }));
        return;
      }
      if (decision.action === "deploy") {
        to_stage = decision.toStage;
        retryEscalation = null;
        console.warn(JSON.stringify({
          event: "qc_pass_rescope_suppressed",
          issue_id,
          redirected_to: to_stage
        }));
      }
    }
    // Parked and Rejected are terminal non-execution dispositions, not normal
    // workflow successors. Operators and bounded workers must be able to stop
    // a broken lane without adding an escape hatch to every stage row.
    const transitionAdmission = admitConfiguredTransition({
      fromStage: issue.status,
      toStage: to_stage,
      expectedStage,
      altStages,
      exceptional: retryEscalation || parkedRelease || parkedEvidenceQcRelease ||
        parkedDiagnosisDone || noArtifactRescope || evidenceTransition ||
        dispositionStages.has(to_stage)
    });
    if (!transitionAdmission.ok) {
      await client.query("ROLLBACK");
      rejectInvalidRelayTransition(res, issue.status, to_stage);
      return;
    }
    if (issue.status === "Parked" && ["Queue", "Spec"].includes(to_stage) && !parkedRelease) {
      await client.query("ROLLBACK");
      console.warn(JSON.stringify({
        event: "relay_advance_rejected", reason: "parked_release_required",
        issue_id: issue.id, target_stage: to_stage
      }));
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "parked_release_required",
        message: "a completed Sol-low diagnosis must authorize one deliberate release" }));
      return;
    }

    // A QC FAIL sends the ticket back to the builder, and nothing counted how
    // often. Each bounce is a fresh task at attempt 1, so max_attempts never
    // fires and In Progress <-> In Review can cycle forever, paying the build
    // and the review lane on every lap. GSP #151 ran 67 laps.
    // The ceiling is agent_task_queue.max_attempts (default 2) -- the belt's own
    // declared retry limit, applied to stage re-entry instead of to one task.
    // Past it the ticket changes hands to a re-spec, not another paid rebuild.
    if (issue.status === "In Review" && to_stage === "In Progress" &&
        altStages.includes("Human Review")) {
      const decision = qcBounceDecision(await latestQcVerdict(client, issue_id), expectedStage);
      if (decision.action === "hold") {
        await client.query("ROLLBACK");
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: decision.reason }));
        return;
      }
      if (decision.action === "deploy") {
        to_stage = decision.toStage;
        retryEscalation = null;
        console.warn(JSON.stringify({
          event: "qc_pass_bounce_suppressed",
          issue_id,
          redirected_to: to_stage
        }));
      } else {
        const bounced = await client.query(
          `SELECT count(*)::int AS n,
                  COALESCE(max(q.max_attempts), 2) AS ceiling
             FROM relay_run_log l
             LEFT JOIN agent_task_queue q ON q.id = l.task_id
            WHERE l.issue_id = $1
              AND l.from_stage = 'In Review'
              AND l.to_stage = 'In Progress'`,
          [issue_id]
        );
        const { n, ceiling } = bounced.rows[0];
        if (n >= ceiling) {
          const sourceTaskId = await retryEscalationSourceTask(
            client, issue, body.relay_source_task_id
          );
          if (!sourceTaskId) {
            // A capped QC return must be terminally bounded even when the
            // original task has already been consumed. Requiring a source task
            // here caused the daemon to retry the same 409 forever.
            retryEscalation = null;
            to_stage = "Human Review";
            parkedAudit = {
              ...(parkedAudit || {}),
              reason: "qc_bounce_ceiling",
              bounce_count: n,
              ceiling,
              disposition: "Human Review",
              issue_id: issue.id
            };
            console.warn(JSON.stringify({
              event: "qc_bounce_ceiling",
              issue_id,
              bounces: n,
              ceiling,
              redirected_to: "Human Review",
              source_task_id: null
            }));
          } else {
            retryEscalation = {
              reason: "qc_bounce_ceiling", trigger_stage: issue.status,
              attempts: n, ceiling, source_task_id: sourceTaskId,
              deadline: escalationDeadline()
            };
            to_stage = "Spec";
            console.warn(JSON.stringify({
              event: "qc_bounce_ceiling",
              issue_id,
              bounces: n,
              ceiling,
              redirected_to: "Spec",
              source_task_id: sourceTaskId
            }));
          }
        }
      }
    }

    // Enforcement point: no deploy, no Done.
    if (issue.workspace_id === SPEC_ENFORCED_WORKSPACE &&
        to_stage === "Done" &&
        (issue.status === "In Review" || issue.status === "Human Review")) {
      const prUrl = await issuePullRequest(client, issue.id);
      if (prUrl) {
        await client.query("ROLLBACK");
        console.warn(JSON.stringify({
          event: "relay_advance_rejected",
          reason: "deploy_required",
          issue_id: issue.id,
          from_stage: issue.status,
          to_stage,
          pull_request: prUrl
        }));
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "deploy_required",
          message: "this issue has a pull request, so it must go to 'CI/CD & Deploy' to be merged and deployed, not straight to Done",
          pull_request: prUrl,
          from_stage: issue.status,
          to_stage
        }));
        return;
      }
    }

    if (to_stage === "Done") {
      const verdict = await client.query(
        `SELECT verdict, work_product_md5 FROM qc_verdict
          WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1`, [issue.id]
      );
      const latest = verdict.rows[0];
      if (!latest || latest.verdict !== "PASS") {
        await client.query("ROLLBACK");
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no_pass_verdict", message: "Done requires a current PASS verdict" }));
        return;
      }
      if (typeof current_work_product_md5 !== "string" ||
          current_work_product_md5.toLowerCase() !== String(latest.work_product_md5 || "").toLowerCase()) {
        await client.query("ROLLBACK");
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "work_product_mismatch", message: "Done requires the hash from the current PASS verdict" }));
        return;
      }
    }

    // Enforcement point: no specification, no build.
    let bindingSpec = null;
    if (issue.workspace_id === SPEC_ENFORCED_WORKSPACE && to_stage === "Queue") {
      bindingSpec = await latestSpecComment(client, issue.id);
      if (!bindingSpec && parkedRelease) {
        // A diagnosis-approved release must never bounce a no-spec issue into
        // Queue just to receive spec_required. Re-enter the scoper lane once;
        // the existing release timestamp keeps this bounded from the new stage.
        to_stage = "Spec";
      } else if (!bindingSpec) {
        await client.query("ROLLBACK");
        console.warn(JSON.stringify({
          event: "relay_advance_rejected",
          reason: "spec_required",
          issue_id: issue.id,
          from_stage: issue.status,
          to_stage
        }));
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "spec_required",
          message: "no specification exists for this issue, so it cannot reach a builder",
          from_stage: issue.status,
          to_stage
        }));
        return;
      }
      await client.query(
        `UPDATE "issue" SET description = $1, updated_at = NOW() WHERE id = $2`,
        [descriptionWithSpec(issue.description, bindingSpec), issue.id]
      );
    }

    const ownerStage = retryEscalation ? "Registered" :
      ownerStageForTransition(issue.status, to_stage);
    const preferModels = (isNoDispatchArrivalStage(to_stage) || evidenceTransition || retryEscalation)
      ? [] : await qcEscalationPreference(client, issue, to_stage);
    let stage = (isNoDispatchArrivalStage(to_stage) || evidenceTransition) ? {} : (retryEscalation
      ? await selectRetryEscalationOwner(client, issue)
      : await selectStageOwner(client, issue.workspace_id, ownerStage, to_stage, { preferModels }));
    if (retryEscalation) {
      retryEscalation = { ...retryEscalation, owner: stage.agent_name,
        model: stage.model, effort: stage.thinking_level,
        deadline: escalationDeadline() };
    }

    if (!stage) {
      throw new Error(`Missing relay configuration for stage: ${to_stage}`);
    }
    if (stage.agent_id && !stage.owner_id) {
      throw new Error(`Relay owner workspace mismatch: ${stage.agent_name} (${stage.agent_id}) for ${issue.workspace_id}`);
    }
    if (stage.agent_id && isExecutionStage(to_stage) && !bookkeepingTransition && stage.archived_at) {
      throw new Error(`Relay owner is archived: ${stage.agent_name} (${stage.agent_id}) for ${issue.status} -> ${to_stage}`);
    }
    if (stage.agent_id && isExecutionStage(to_stage) && !bookkeepingTransition && !stage.selected_runtime_id) {
      throw new Error(`No online Codex runtime for stage: ${to_stage}`);
    }

    // A paid call is admitted only when the target stage is explicitly covered
    // by the owner's runbook and its concurrency/model configuration is valid.
    // Unknown instructions fail closed: a worker that would stop on this stage
    // has no useful outcome and still consumes vendor tokens.
    let builderRoute = { ok: true, route: null };
    if (stage.agent_id && isExecutionStage(to_stage) && !parkedRelease && !bookkeepingTransition) {
      builderRoute = resolveBuilderRoute(stage, {
        provider: stage.selected_runtime_provider,
        model: stage.runtime_config && stage.runtime_config.model
      });
      if (!builderRoute.ok) {
        await client.query("ROLLBACK");
        console.warn(JSON.stringify({ event: "relay_advance_rejected", reason: builderRoute.reason,
          issue_id: issue.id, agent_id: stage.agent_id }));
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: builderRoute.reason, message: "builder route is unavailable or contradictory" }));
        return;
      }
      const compatibility = instructionCompatibility(stage.instructions, to_stage);
      if (!compatibility.ok) {
        // Persist rejected advances so the Registered recovery pass can apply
        // a durable ceiling.  A rollback here leaves no trace, and its
        // NOT-EXISTS probe retries the same incompatible paid lane forever.
        const rejected = await client.query(
          `SELECT count(*)::int AS n
             FROM relay_run_log
            WHERE issue_id = $1 AND from_stage = $2 AND to_stage = $3
              AND status = 'rejected'
              AND created_at >= NOW() - INTERVAL '24 hours'`,
          [issue.id, issue.status, to_stage]
        );
        const rejectionCount = Number(rejected.rows[0]?.n || 0) + 1;
        await client.query(
          `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, agent_id, status)
           VALUES ($1, $2, $3, $4, 'rejected')`,
          [issue.id, issue.status, to_stage, stage.agent_id]
        );
        const capped = rejectionCount >= STAGE_CYCLE_LIMIT;
        const dispositionApplied = capped
          ? await applyDisposition(client, issue, 'Rejected', 'agent_stage_incompatible_window', {
              target_stage: to_stage, rejection_count: rejectionCount,
              ceiling: STAGE_CYCLE_LIMIT, window_hours: 24
            })
          : false;
        await client.query("COMMIT");
        console.warn(JSON.stringify({
          event: "relay_advance_rejected",
          reason: capped ? "stage_retry_ceiling" : "agent_stage_incompatible",
          issue_id: issue.id,
          agent_id: stage.agent_id,
          stage: compatibility.stage,
          allowed_stages: compatibility.allowed,
          rejection_count: rejectionCount,
          ceiling: STAGE_CYCLE_LIMIT,
          disposition: capped ? "Rejected" : "retry_allowed",
          disposition_applied: dispositionApplied
        }));
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify(capped ? {
          error: "stage_retry_ceiling",
          message: "stage advance rejected after repeated incompatible owner rejections",
          disposition: "Rejected",
          rejection_count: rejectionCount,
          ceiling: STAGE_CYCLE_LIMIT
        } : {
          error: "agent_stage_incompatible",
          message: "the assigned agent instructions do not authorize this stage",
          stage: compatibility.stage,
          allowed_stages: compatibility.allowed,
          rejection_count: rejectionCount,
          ceiling: STAGE_CYCLE_LIMIT
        }));
        return;
      }
      const preflight = spendPreflight(stage, { provider: stage.selected_runtime_provider });
      if (!preflight.ok) {
        await client.query("ROLLBACK");
        console.warn(JSON.stringify({
          event: "relay_advance_rejected",
          reason: "paid_dispatch_preflight",
          detail: preflight.reason,
          issue_id: issue.id,
          agent_id: stage.agent_id,
          routing: preflight.agent_name ? { agent_name: preflight.agent_name,
            agent_id: preflight.agent_id, actual_model: preflight.model,
            actual_effort: preflight.effort, expected_model: preflight.expected_model,
            expected_effort: preflight.expected_effort } : undefined
        }));
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "paid_dispatch_preflight", detail: preflight.reason,
          agent_name: preflight.agent_name, agent_id: preflight.agent_id,
          actual_model: preflight.model, actual_effort: preflight.effort,
          expected_model: preflight.expected_model, expected_effort: preflight.expected_effort }));
        return;
      }
      // A stage re-entry creates a fresh task, so per-task max_attempts does not
      // stop a QC FAIL loop. Count every historical task for this issue and
      // target stage before admitting another paid call; once the ceiling is
      // reached the flight changes hands to a bounded re-spec task.
      const history = await client.query(
        `SELECT count(*)::int AS n FROM agent_task_queue
          WHERE issue_id = $1 AND context->>'to_stage' = $2
            AND trigger_comment_id IS NULL
            AND COALESCE(context->>'kind', '') <> 'retry_escalation'
            ${budgetCountPredicate()}
            AND ($3::timestamptz IS NULL OR created_at >= $3)`,
        [issue.id, to_stage, releaseAt]
      );
      const cycle = stageCycleAdmission(history.rows[0]?.n || 0, STAGE_CYCLE_LIMIT);
      const parkedQcRecovery = !cycle.ok && await consumeParkedQcRecovery(
        client, issue, to_stage, reason, parkedEvidenceQcRelease
      );
      if (!cycle.ok && !operatorCapBypass && retryEscalationLoop(issue, issue.status)) {
        escalationLoop = true;
        parkedAudit = { trigger: "escalation_loop", reason: "escalation_loop", intendedStage: "Spec",
          attempts: 2, taskCount: 2 };
        to_stage = "Parked";
      }
      if (!cycle.ok && !operatorCapBypass && !cicdReturn && !parkedQcRecovery && !escalationLoop &&
          !noArtifactRescope && !retryEscalation) {
        const sourceTaskId = await retryEscalationSourceTask(
          client, issue, body.relay_source_task_id
        );
        if (!sourceTaskId) {
          await client.query("ROLLBACK");
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "retry_escalation_source_task_required",
            reason: cycle.reason }));
          return;
        }
        retryEscalation = {
          reason: cycle.reason, trigger_stage: issue.status,
          attempts: history.rows[0]?.n || 0, ceiling: cycle.ceiling,
          source_task_id: sourceTaskId, deadline: escalationDeadline(),
          target_stage: cycle.disposition
        };
        to_stage = cycle.disposition;
        stage = await selectRetryEscalationOwner(client, issue);
        retryEscalation.owner = stage.agent_name;
        retryEscalation.model = stage.model;
        retryEscalation.effort = stage.thinking_level;
        console.warn(JSON.stringify({
          event: "relay_retry_escalated",
          reason: cycle.reason,
          issue_id: issue.id,
          target_stage: to_stage,
          historical_tasks: history.rows[0]?.n || 0,
          ceiling: cycle.ceiling,
          disposition: cycle.disposition,
          escalation_owner: stage.agent_name,
          deadline: retryEscalation.deadline
        }));
      }
      const lifetimeHistory = await client.query(
        `SELECT count(*)::int AS n FROM agent_task_queue
          WHERE issue_id = $1
            AND trigger_comment_id IS NULL
            ${budgetCountPredicate()}
            AND ($2::timestamptz IS NULL OR created_at >= $2)`,
        [issue.id, humanReleaseAt]
      );
      const lifetime = lifetimeTaskAdmission(lifetimeHistory.rows[0]?.n || 0, LIFETIME_TASK_LIMIT);
      cicdReturnCapBypass = cicdReturn && (!cycle.ok || !lifetime.ok);
      if (!lifetime.ok && !operatorCapBypass && retryEscalationLoop(issue, issue.status)) {
        escalationLoop = true;
        parkedAudit = { trigger: "escalation_loop", reason: "escalation_loop", intendedStage: "Spec",
          attempts: 2, taskCount: 2 };
        to_stage = "Parked";
      }
      if (!lifetime.ok && !operatorCapBypass && !cicdReturn && !noArtifactRescope && !escalationLoop && !retryEscalation) {
        const sourceTaskId = await retryEscalationSourceTask(
          client, issue, body.relay_source_task_id
        );
        if (!sourceTaskId) {
          await client.query("ROLLBACK");
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "retry_escalation_source_task_required",
            reason: lifetime.reason }));
          return;
        }
        retryEscalation = {
          reason: lifetime.reason, trigger_stage: issue.status,
          attempts: lifetimeHistory.rows[0]?.n || 0, ceiling: lifetime.ceiling,
          source_task_id: sourceTaskId, deadline: escalationDeadline()
        };
        to_stage = lifetime.disposition;
        stage = await selectRetryEscalationOwner(client, issue);
        retryEscalation.owner = stage.agent_name;
        retryEscalation.model = stage.model;
        retryEscalation.effort = stage.thinking_level;
        console.warn(JSON.stringify({
          event: "relay_retry_escalated",
          reason: lifetime.reason,
          issue_id: issue.id,
          target_stage: to_stage,
          historical_tasks: lifetimeHistory.rows[0]?.n || 0,
          ceiling: lifetime.ceiling,
          disposition: lifetime.disposition,
          escalation_owner: stage.agent_name,
          deadline: retryEscalation.deadline
        }));
      }
    }

    // Never advance an issue into another execution lane while a previous
    // relay execution is live. The previous stage-local predicate allowed
    // Spec -> Queue and Queue -> In Progress to coexist, paying two workers
    // for the same flight. The issue row lock serializes bridge callers; this
    // read locks the live rows so the decision and later insert are atomic.
    // Manual and terminal/disposition destinations stay available because they
    // create no paid execution task.
    if (isExecutionStage(to_stage) && !bookkeepingTransition) {
      const liveRows = await client.query(
        `SELECT id, issue_id, status,
                jsonb_build_object(
                  'source', context->>'source',
                  'to_stage', context->>'to_stage'
                ) AS context
           FROM agent_task_queue
          WHERE issue_id = $1
            AND status IN ('queued', 'dispatched', 'running',
                           'waiting_local_directory', 'deferred')
            AND context ? 'to_stage'
          FOR UPDATE`,
        [issue.id]
      );
      const admission = crossStageExecutionAdmission(liveRows.rows, issue.id);
      if (!admission.ok) {
        await client.query('COMMIT');
        console.info(JSON.stringify({
          event: 'relay_advance_deferred', issue_id: issue.id,
          from_stage: issue.status, to_stage, ...admission
        }));
        // 202 is an intentional, bounded defer rather than a rejection. The
        // advance daemon keeps the task-correlated relay log pending and
        // retries only after the predecessor can become terminal.
        res.writeHead(202, { 'Content-Type': 'application/json', 'Retry-After': '15' });
        res.end(JSON.stringify({
          error: admission.reason,
          message: 'a prior relay execution is still active; no stage change or task was created',
          retry_after_seconds: 15,
          ...admission
        }));
        return;
      }
      if (cicdReturnCapBypass && !await authorizeCicdReturnCapBypass(
        client, issue.id, cicdReturnCapBypass
      )) {
        throw new Error(`CI/CD return authorization already consumed: ${issue.id}`);
      }
      if (noArtifactRescope && !await consumeNoArtifactRescope(client, issue)) {
        throw new Error(`no-artifact re-scope authorization already consumed: ${issue.id}`);
      }
    }

    const result = await client.query(
      `UPDATE "issue"
       SET status = $1,
           metadata = CASE
             WHEN $3 THEN jsonb_set(COALESCE(metadata, '{}'::jsonb) - 'parked_release_once',
                                    '{parked_release_at}', to_jsonb(NOW()), true)
             WHEN $4 THEN COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'human_review_release_at', $5::timestamptz,
               'human_review_release_reason', $6::text)
             ELSE metadata END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, status`,
      [to_stage, issue_id, parkedRelease || parkedEvidenceQcRelease,
        explicitHumanReviewRelease, issue.metadata?.human_review_release_at || null,
        explicitHumanReviewRelease ? reason.trim() : null]
    );
    if (parkedRelease || parkedEvidenceQcRelease) {
      console.warn(JSON.stringify({ event: "parked_release_consumed",
        issue_id: issue.id, from_stage: issue.status, to_stage }));
    }
    if (retryEscalation) await recordRetryEscalation(client, issue, retryEscalation);

    let taskId = null;
    let relayLogId = null;

    if (to_stage === "Parked" && result.rowCount > 0) {
      relayLogId = await recordParkedEntry(client, {
        issueId: issue.id,
        fromStage: issue.status,
        trigger: parkedAudit?.trigger || "relay_advance",
        intendedStage: parkedAudit?.intendedStage || null,
        attempts: parkedAudit?.attempts || 0,
        taskCount: parkedAudit?.taskCount || 0,
        callerAudit: parkedAudit,
        terminalExit: explicitTerminalExit
          ? { operator_marker: true, reason: reason.trim() }
          : null
      });
      if (escalationLoop === true && result.rowCount > 0) {
        await recordParkAndQueueDiagnosis(client, issue, {
          ...parkedAudit, reason: 'escalation_loop'
        });
      }
    }

    if (evidenceTransition) {
      relayLogId = await ensureCompletedRelayLog(client, issue_id, issue.status, to_stage);
      await client.query(`UPDATE relay_run_log SET parked_audit=$2::jsonb WHERE id=$1`,
        [relayLogId, JSON.stringify(evidenceAudit)]);
      await recordTransitionAudit(client, issue, {
        fromStage: issue.status, toStage: to_stage, reason, evidence: evidenceAudit,
        actorType: 'operator', result: 'committed'
      });
      await client.query("COMMIT");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, issue: result.rows[0], task_id: null, relay_log_id: relayLogId }));
      return;
    }

    if (isNoDispatchArrivalStage(to_stage)) {
      // Parked has already written its completed, dedicated audit row above.
      // Other no-dispatch arrivals need a regular completed relay log.
      relayLogId = relayLogId || await ensureCompletedRelayLog(
        client, issue_id, issue.status, to_stage
      );
      await recordTransitionAudit(client, issue, {
        fromStage: issue.status, toStage: to_stage, reason,
        evidence: {
          ...(parkedAudit || {}),
          ...(archiverRequest ? { signedArchivePlanReceipt: archiveEvidence } : {})
        },
        actorType: archiverRequest ? 'archiver' : (explicitTerminalExit || explicitHumanReviewRelease ? 'operator' : 'system'),
        result: 'committed'
      });
      // Terminal, human-gate, and parked-disposition arrivals have no stage owner, task, or
      // successor relay. Keep this return before every dispatch path.
      await client.query("COMMIT");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        issue: result.rows[0],
        task_id: null,
        relay_log_id: relayLogId
      }));
      return;
    }

    // A bundled child must never be dispatched on its own. Its MEGA parent IS
    // the unit of work: dispatching the child too pays for the same fix twice
    // and, on 2026-08-31, tripled in-flight by re-dispatching 235 children that
    // had just been bundled. The stage transition still commits -- the child
    // keeps moving with its parent -- only the paid task is withheld.
    let bundledChild = false;
    if (stage.agent_id && isBundledChild(issue)) {
      bundledChild = true;
      console.error('[relay] bundled child - stage advanced, task withheld:',
        issue_id, issue.status, '->', to_stage);
    }

    if (bookkeepingTransition) {
      relayLogId = bookkeepingHandoff.relayLogId;
    } else if (stage.agent_id && !bundledChild && isExecutionStage(to_stage)) {
      // Preserve the board's issue priority on the queue row. The daemon
      // orders claims by this integer (urgent=4 .. none=0); omitting it
      // silently defaulted every relay task to 0 and defeated priority FIFO.
      const taskPriority = {
        urgent: 4,
        high: 3,
        medium: 2,
        low: 1,
        none: 0
      }[String(issue.priority || "none").toLowerCase()] ?? 0;
      const context = JSON.stringify({
        source: "relay-advance",
        from_stage: issue.status,
        to_stage,
        agent_name: stage.agent_name,
        ...(builderRoute && builderRoute.route ? { builder_route: builderRoute.route } : {}),
        pool_stage: stage.pool_stage || (stage.agent_id ? to_stage : null),
        ...(retryEscalation ? {
          kind: "retry_escalation",
          escalation_reason: retryEscalation.reason,
          escalation_owner: retryEscalation.owner,
          escalation_deadline: retryEscalation.deadline,
          escalation_source_task_id: retryEscalation.source_task_id
        } : {}),
        ...(cicdReturn ? { return_reason: reason } : {}),
        ...(noArtifactRescope ? {
          rescope_reason: "qc_blocked_no_artifact",
          operator_rescope_issue_id: issue.id
        } : {}),
        ...(explicitTerminalExit ? {
          terminal_exit: { operator_marker: true, reason: reason.trim() }
        } : {}),
        // Present only on a build dispatch, and duplicated in the issue
        // description: a builder cannot claim it never received the spec.
        ...(bindingSpec ? { spec: bindingSpec } : {})
      });
      const successor = await replaceStageTask(client, {
        issueId: issue_id,
        workspaceId: issue.workspace_id,
        fromStage: issue.status,
        toStage: to_stage,
        agentId: stage.agent_id,
        priority: taskPriority,
        runtimeId: stage.selected_runtime_id,
        context,
        relayAudit: operatorCapBypass ? JSON.stringify({
          ...(explicitHumanReviewRelease ? {
            operator_release: {
              actor: "operator",
              target_stage: to_stage,
              reason: reason.trim()
            }
          } : {}),
          ...(explicitTerminalExit ? {
            terminal_exit: { operator_marker: true, reason: reason.trim() }
          } : {}),
          operator_cap_bypass: true,
          reason: reason.trim()
        }) : null,
        triggerSummary: retryEscalation
          ? `re-spec escalation: ${retryEscalation.reason}`
          : `Relay stage transition: ${issue.status} -> ${to_stage}`
      });
      taskId = successor.taskId;
      relayLogId = successor.relayLogId;
    }

    await recordTransitionAudit(client, issue, {
      fromStage: issue.status, toStage: to_stage, reason,
      evidence: {
        ...(retryEscalation ? { retry_escalation: retryEscalation.reason } : {}),
        ...(cicdReturn ? { cicd_return: true } : {}),
        ...(noArtifactRescope ? { no_artifact_rescope: true } : {})
      },
      actorType: archiverRequest ? 'archiver' : (explicitTerminalExit || explicitHumanReviewRelease ? 'operator' : 'system'),
      evidence: archiverRequest ? { signedArchivePlanReceipt: archiveEvidence } : {},
      actorId: stage?.agent_id || null,
      result: 'committed'
    });
    await client.query("COMMIT");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      issue: result.rows[0],
      transition: { fromStage: transitionAdmission.fromStage, toStage: transitionAdmission.toStage },
      task_id: taskId,
      relay_log_id: relayLogId
    }));
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // The connection may have failed before the transaction started.
      }
    }
    console.error("Relay error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  } finally {
    if (client) {
      await client.end().catch(() => {});
    }
  }
}

async function relayOperatorRespec(req, res, body) {
  if (!RELAY_OPERATOR_SECRET || OPERATOR_SECRET_DISABLED ||
      (req.headers || {})["x-relay-operator-secret"] !== RELAY_OPERATOR_SECRET) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "operator_secret_required" }));
    return;
  }
  const client = testClientFactory ? testClientFactory() : new Client({ connectionString: MULTICA_DB });
  try {
    await client.connect();
    await client.query("BEGIN");
    await authorizeRelayStatusWrites(client);
    const result = await operatorRespec(client, body || {});
    if (!result.ok) {
      await client.query("ROLLBACK");
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    await client.query("COMMIT");
    res.writeHead(result.replay ? 200 : 201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, replay: Boolean(result.replay), ...result.receipt }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[relay/operator-respec] ERROR:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  } finally { await client.end().catch(() => {}); }
}

async function relayDiagnosisRerun(req, res, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !RELAY_AGENT_SECRET || payload.agent_token !== RELAY_AGENT_SECRET) {
    return relayVerdictError(res, 403, 'invalid_token');
  }
  if (!UUID_RE.test(String(payload.issue_id || '')) || !RERUN_IDEM_KEY_RE.test(String(payload.idempotency_key || ''))) {
    return relayVerdictError(res, 400, 'invalid_request');
  }
  const client = testClientFactory ? testClientFactory() : new Client({ connectionString: MULTICA_DB });
  try {
    await client.connect();
    await client.query('BEGIN');
    const result = await rerunParkedDiagnosis(client, payload);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return relayVerdictError(res, diagnosisRerunErrorStatus(result.error), result.error);
    }
    await client.query('COMMIT');
    res.writeHead(result.replay ? 200 : 202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logDiagnosisRerunError(err, payload);
    const refusal = parkedDiagnosisRerunRefusal(err);
    relayVerdictError(res, refusal ? 409 : 500, refusal || 'internal_error');
  } finally { await client.end().catch(() => {}); }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/relay/verdict") {
    if (req.method !== "POST") return relayVerdictError(res, 405, "method_not_allowed");
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        relayVerdict(req, res, JSON.parse(body));
      } catch {
        relayVerdictError(res, 400, "invalid_json");
      }
    });
      } else if (req.method === "POST" && req.url === "/relay/advance") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            relayAdvance(req, res, data);
          } catch (err) {
            res.writeHead(400);
            res.end("Invalid JSON");
          }
        });
      } else if (req.method === "POST" && (req.url === "/relay/operator-respec" || req.url === "/relay/respec")) {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          try { relayOperatorRespec(req, res, JSON.parse(body)); } catch { relayVerdictError(res, 400, "invalid_json"); }
        });
      } else if (req.method === "POST" && req.url === "/relay/parked-diagnosis-rerun") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          try { relayDiagnosisRerun(req, res, JSON.parse(body)); } catch { relayVerdictError(res, 400, 'invalid_json'); }
        });
  } else if (req.method === "GET" && req.url === "/sso/bridge") {
    ssoBridge(req, res);
  } else if (req.url === "/health") {
    // Keep health useful to the belt guard without exposing credentials.  A
    // ready authority requires both distinct relay credentials and the
    // startup-validated database/workspace configuration.
    const authority = RELAY_AGENT_SECRET && RELAY_OPERATOR_SECRET &&
      RELAY_AGENT_SECRET !== RELAY_OPERATOR_SECRET && MULTICA_DB && SSO_WORKSPACE_ID
      ? "ready" : "unavailable";
    res.writeHead(authority === "ready" ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: authority === "ready" ? "ok" : "unavailable",
      workspace_id: SSO_WORKSPACE_ID || null, authority }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

async function assertRoutableStagesHaveOwners() {
  const client = new Client({ connectionString: MULTICA_DB });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT rsc.stage_name, rsc.next_stage, rsc.agent_id,
              a.id AS owner_id, a.status AS owner_status,
              a.archived_at AS owner_archived_at,
              a.instructions AS owner_instructions
         FROM relay_stage_config rsc
         LEFT JOIN agent a ON a.id = rsc.agent_id AND a.workspace_id = rsc.workspace_id
        ORDER BY rsc.workspace_id, rsc.id`
    );
    assertRoutableStageOwners(result.rows);
    const registry = await client.query(
      `SELECT id, name, instructions, archived_at FROM agent
       UNION ALL SELECT NULL::uuid, NULL::text, NULL::text, NULL::timestamptz WHERE false`
    );
    const pool = await client.query(`SELECT agent_id, stage_name, enabled FROM relay_stage_agent_pool`);
    const defects = agentRegistryDefects(registry.rows, pool.rows);
    if (defects.length) throw new Error(`Agent registry validation failed: ${defects.join('; ')}`);
  } finally {
    await client.end();
  }
}

async function start() {
  assertRequiredEnvironment();
  await assertRoutableStagesHaveOwners();
  server.listen(PORT, "127.0.0.1", () => {
  console.log(`GSP Multica relay bridge listening on 127.0.0.1:${PORT}`);
  console.log(`SSO workspace: ${SSO_WORKSPACE_ID}`);
  console.log(`SSO Bridge: /sso/bridge (CF Access)`);
  console.log(`Relay: /relay/advance (ticket updates)`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error(`Relay bridge startup refused: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertRequiredEnvironment,
  qcEscalationPreference,
  selectRetryEscalationOwner,
  recordRetryEscalation,
  existingStageTask,
  replaceStageTask,
  ownerStageForTransition,
  ensureCompletedRelayLog,
  completedTerminalRelayLog,
  isBookkeepingTransition,
  recordBookkeepingHandoff,
  validateRelayVerdict,
  qcBounceDecision,
  directDeployQcAdmission,
  recordTransitionAudit,
  latestCompletedSolLowQcTask,
  latestRunningSolLowQcTask,
  qcTaskEvidence,
  qcTaskEvidenceMismatch,
  relayVerdict,
  relayAdvance,
  admitConfiguredTransition,
  relayOperatorRespec,
  operatorRespec,
  setTestClientFactory(factory) { testClientFactory = factory; },
  isCicdReturn,
  consumeCicdReturnAuthorization,
  authorizeCicdReturnCapBypass,
  selectPoolOwner,
  selectStageOwner,
  applyDisposition,
  consumeParkedQcRecovery,
  taskResultText,
  isNoArtifactQcBlock,
  operatorRescopeIssueId,
  issueImplementationArtifact,
  noArtifactRescopeAdmission,
  consumeNoArtifactRescope,
  latestQcNoArtifactSignal,
  latestQcGateComment,
  isTerminalStage,
  isNoDispatchArrivalStage,
  retryEscalationReason,
  verifiedRetryEscalation,
  retryEscalationSourceTask,
  capEscalationVerified,
  retryEscalationLoop,
  authorizeRelayStatusWrites,
  rerunParkedDiagnosis,
  relayDiagnosisRerun,
  diagnosisRerunErrorStatus,
  parkedDiagnosisRerunRefusal,
  mergedPrEvidence
};
