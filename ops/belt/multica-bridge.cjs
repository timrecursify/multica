const http = require("http");
const { URL } = require("url");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const {
  isBundledChild,
  instructionCompatibility,
  spendPreflight,
  stageCycleAdmission,
  lifetimeTaskAdmission,
  isExecutionStage,
  assertRoutableStageOwners,
  crossStageExecutionAdmission
} = require("./guardrails.cjs");
const { recordParkAndQueueDiagnosis, isBuilderDispatchAllowed } = require("./parked-diagnosis.cjs");

// Relay configuration is supplied by the host environment.
const JWT_SECRET = process.env.JWT_SECRET;
const MULTICA_DB = process.env.DATABASE_URL;
const RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET;
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

for (const [name, value] of Object.entries({
  JWT_SECRET,
  DATABASE_URL: MULTICA_DB,
  RELAY_AGENT_SECRET,
  MULTICA_WORKSPACE_ID: SSO_WORKSPACE_ID
})) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
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
// A stage transition may retire work that has not started. Running paid work
// is never cancelled here: crossStageExecutionAdmission defers the successor
// until it becomes terminal, preserving the predecessor's work product.
const REPLACEABLE_TASK_STATUSES = [
  "queued", "dispatched", "waiting_local_directory", "deferred"
];

async function applyDisposition(client, issue, disposition, reason, evidence = {}) {
  const changed = await client.query(
    `UPDATE issue SET status = $1, updated_at = NOW()
      WHERE id = $2 AND status <> $1 RETURNING id`,
    [disposition, issue.id]
  );
  if (changed.rowCount > 0 && disposition === 'Parked') {
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

async function replaceStageTask(client, task) {
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
       agent_id, issue_id, status, priority, runtime_id, context,
       trigger_summary, force_fresh_session, originator_source,
       trigger_evidence_kind
     )
     SELECT $1, $2, 'queued', $3, $4, $5::jsonb, $6, TRUE,
            'unattributed', 'relay_stage_transition'
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_task_queue active
         WHERE active.issue_id = $2
           AND active.status::text = ANY($7::text[])
           AND active.context->>'to_stage' = $8
      )
       ON CONFLICT DO NOTHING
       RETURNING id`,
    [task.agentId, task.issueId, task.priority, task.runtimeId, task.context,
      task.triggerSummary, LIVE_TASK_STATUSES, task.toStage]
  );

  const taskId = inserted.rows[0]?.id || await existingStageTask(
    client, task.issueId, task.toStage
  );
  if (!taskId) {
    throw new Error(`relay successor task was not created for issue ${task.issueId} stage ${task.toStage}`);
  }

  const log = await client.query(
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
  return inserted.rows[0]?.id || null;
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

async function relayAdvance(req, res, body) {
  let client;
  try {
    let { issue_id, to_stage, agent_token, current_work_product_md5 } = body;
    
    // Validate agent token
    if (agent_token !== RELAY_AGENT_SECRET) {
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
    
    client = new Client({ connectionString: MULTICA_DB });
    await client.connect();
    await client.query("BEGIN");
    // Every relay execution admission for an issue takes this transaction lock,
    // including the recovery daemon. A partial unique index would either miss
    // waiting/deferred tasks or incorrectly constrain manual tasks; this lock
    // serializes precisely the belt-owned execution transition.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 804))", [issue_id]);

    const dispositionStages = new Set(["Parked", "Rejected"]);
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
    const targetStageResult = await client.query(
      "SELECT stage_name FROM relay_stage_config WHERE workspace_id = $1 AND stage_name = $2",
      [issue.workspace_id, to_stage]
    );
    if (targetStageResult.rows.length === 0 && !dispositionStages.has(to_stage)) {
      await client.query("ROLLBACK");
      rejectInvalidRelayStage(res, to_stage);
      return;
    }
    const parkedRelease = issue.status === "Parked" && to_stage === "Queue" &&
      issue.metadata?.parked_release_once === true;
    const releaseAt = issue.metadata?.parked_release_at || null;
    if (issue.status === to_stage) {
      const taskId = await existingStageTask(client, issue.id, to_stage);
      await client.query("COMMIT");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        issue: { id: issue.id, status: issue.status },
        transition: "already_applied",
        task_id: taskId
      }));
      return;
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
    // Parked and Rejected are terminal non-execution dispositions, not normal
    // workflow successors. Operators and bounded workers must be able to stop
    // a broken lane without adding an escape hatch to every stage row.
    if (!parkedRelease && !allowedStages.includes(to_stage) && !dispositionStages.has(to_stage)) {
      await client.query("ROLLBACK");
      rejectInvalidRelayTransition(res, issue.status, to_stage);
      return;
    }
    if (issue.status === "Parked" && to_stage === "Queue" && !parkedRelease) {
      await client.query("ROLLBACK");
      console.warn(JSON.stringify({
        event: "relay_advance_rejected", reason: "parked_release_required",
        issue_id: issue.id, target_stage: to_stage
      }));
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "parked_release_required",
        message: "set parked_release_once metadata for one deliberate release" }));
      return;
    }

    // A QC FAIL sends the ticket back to the builder, and nothing counted how
    // often. Each bounce is a fresh task at attempt 1, so max_attempts never
    // fires and In Progress <-> In Review can cycle forever, paying the build
    // and the review lane on every lap. GSP #151 ran 67 laps.
    // The ceiling is agent_task_queue.max_attempts (default 2) -- the belt's own
    // declared retry limit, applied to stage re-entry instead of to one task.
    // Past it the ticket is a human's problem, not another paid rebuild.
    if (issue.status === "In Review" && to_stage === "In Progress" &&
        altStages.includes("Human Review")) {
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
        console.warn(JSON.stringify({
          event: "qc_bounce_ceiling",
          issue_id,
          bounces: n,
          ceiling,
          redirected_to: "Parked"
        }));
        to_stage = "Parked";
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
      if (!bindingSpec) {
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

    const stageResult = await client.query(
      `SELECT rsc.agent_id, rsc.agent_name, a.id AS owner_id, a.runtime_id, a.archived_at,
              a.instructions, a.model, a.max_concurrent_tasks, a.runtime_config,
              (SELECT ar.provider FROM agent_runtime ar WHERE ar.id = a.runtime_id) AS selected_runtime_provider,
              COALESCE(
                a.runtime_id,
                (
                  SELECT ar.id
                  FROM agent_runtime ar
                  WHERE ar.workspace_id = $1
                    AND ar.provider = 'codex'
                    AND ar.status = 'online'
                  ORDER BY ar.updated_at DESC
                  LIMIT 1
                )
              ) AS selected_runtime_id
       FROM relay_stage_config rsc
       LEFT JOIN agent a ON a.id = rsc.agent_id AND a.workspace_id = rsc.workspace_id
       WHERE rsc.workspace_id = $1 AND rsc.stage_name = $2`,
      // Stage owners are keyed by the stage being left: Spec -> Queue wakes
      // the builder, and In Progress -> In Review wakes QC. Looking up the
      // target stage would select the next lane's owner and can burn a paid
      // call on an incompatible runbook.
      [issue.workspace_id, issue.status]
    );

    if (stageResult.rows.length === 0) {
      throw new Error(`Missing relay configuration for stage: ${to_stage}`);
    }

    const stage = stageResult.rows[0];
    if (stage.agent_id && !stage.owner_id) {
      throw new Error(`Relay owner workspace mismatch: ${stage.agent_name} (${stage.agent_id}) for ${issue.workspace_id}`);
    }
    if (stage.agent_id && isExecutionStage(to_stage) && stage.archived_at) {
      throw new Error(`Relay owner is archived: ${stage.agent_name} (${stage.agent_id}) for ${issue.status} -> ${to_stage}`);
    }
    if (stage.agent_id && isExecutionStage(to_stage) && !stage.selected_runtime_id) {
      throw new Error(`No online Codex runtime for stage: ${to_stage}`);
    }

    // A paid call is admitted only when the target stage is explicitly covered
    // by the owner's runbook and its concurrency/model configuration is valid.
    // Unknown instructions fail closed: a worker that would stop on this stage
    // has no useful outcome and still consumes vendor tokens.
    if (stage.agent_id && isExecutionStage(to_stage) && !parkedRelease) {
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
          agent_id: stage.agent_id
        }));
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "paid_dispatch_preflight", detail: preflight.reason }));
        return;
      }
      // A stage re-entry creates a fresh task, so per-task max_attempts does not
      // stop a QC FAIL loop. Count every historical task for this issue and
      // target stage before admitting another paid call; once the ceiling is
      // reached the flight receives an explicit human disposition.
      const history = await client.query(
        `SELECT count(*)::int AS n FROM agent_task_queue
          WHERE issue_id = $1 AND context->>'to_stage' = $2
            AND ($3::timestamptz IS NULL OR created_at >= $3)`,
        [issue.id, to_stage, releaseAt]
      );
      const cycle = stageCycleAdmission(history.rows[0]?.n || 0, STAGE_CYCLE_LIMIT);
      if (!cycle.ok) {
        const moved = await applyDisposition(client, issue, cycle.disposition, cycle.reason, {
          target_stage: to_stage, historical_tasks: history.rows[0]?.n || 0,
          ceiling: cycle.ceiling
        });
        await client.query("COMMIT");
        console.warn(JSON.stringify({
          event: "relay_advance_rejected",
          reason: cycle.reason,
          issue_id: issue.id,
          target_stage: to_stage,
          historical_tasks: history.rows[0]?.n || 0,
          ceiling: cycle.ceiling,
          disposition: cycle.disposition,
          disposition_applied: moved
        }));
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: cycle.reason,
          message: "stage retry ceiling reached; issue parked and retry eligibility removed",
          disposition: cycle.disposition,
          target_stage: to_stage,
          historical_tasks: history.rows[0]?.n || 0,
          ceiling: cycle.ceiling
        }));
        return;
      }
      const lifetimeHistory = await client.query(
        `SELECT count(*)::int AS n FROM agent_task_queue
          WHERE issue_id = $1
            AND ($2::timestamptz IS NULL OR created_at >= $2)`,
        [issue.id, releaseAt]
      );
      const lifetime = lifetimeTaskAdmission(lifetimeHistory.rows[0]?.n || 0, LIFETIME_TASK_LIMIT);
      if (!lifetime.ok) {
        const moved = await applyDisposition(client, issue, lifetime.disposition, lifetime.reason, {
          target_stage: to_stage, historical_tasks: lifetimeHistory.rows[0]?.n || 0,
          ceiling: lifetime.ceiling
        });
        await client.query("COMMIT");
        console.warn(JSON.stringify({
          event: "relay_advance_rejected",
          reason: lifetime.reason,
          issue_id: issue.id,
          target_stage: to_stage,
          historical_tasks: lifetimeHistory.rows[0]?.n || 0,
          ceiling: lifetime.ceiling,
          disposition: lifetime.disposition,
          disposition_applied: moved
        }));
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: lifetime.reason, disposition: lifetime.disposition,
          disposition_applied: moved, historical_tasks: lifetimeHistory.rows[0]?.n || 0,
          ceiling: lifetime.ceiling }));
        return;
      }
    }

    // Never advance an issue into another execution lane while a previous
    // relay execution is live. The previous stage-local predicate allowed
    // Spec -> Queue and Queue -> In Progress to coexist, paying two workers
    // for the same flight. The issue row lock serializes bridge callers; this
    // read locks the live rows so the decision and later insert are atomic.
    // Manual and terminal/disposition destinations stay available because they
    // create no paid execution task.
    if (isExecutionStage(to_stage)) {
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
    }

    const result = await client.query(
      `UPDATE "issue"
       SET status = $1,
           metadata = CASE WHEN $3 THEN
             jsonb_set(COALESCE(metadata, '{}'::jsonb) - 'parked_release_once',
                       '{parked_release_at}', to_jsonb(NOW()), true)
             ELSE metadata END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, status`,
      [to_stage, issue_id, parkedRelease]
    );
    if (parkedRelease) {
      console.warn(JSON.stringify({ event: "parked_release_consumed",
        issue_id: issue.id, from_stage: issue.status, to_stage }));
    }

    let taskId = null;
    let relayLogId = null;

    if (issue.status === 'CI/CD & Deploy' && to_stage === 'Done') {
      relayLogId = await ensureCompletedRelayLog(
        client, issue_id, issue.status, to_stage
      );
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

    if (stage.agent_id && !bundledChild && isExecutionStage(to_stage)) {
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
        // Present only on a build dispatch, and duplicated in the issue
        // description: a builder cannot claim it never received the spec.
        ...(bindingSpec ? { spec: bindingSpec } : {})
      });
      const successor = await replaceStageTask(client, {
        issueId: issue_id,
        fromStage: issue.status,
        toStage: to_stage,
        agentId: stage.agent_id,
        priority: taskPriority,
        runtimeId: stage.selected_runtime_id,
        context,
        triggerSummary: `Relay stage transition: ${issue.status} -> ${to_stage}`
      });
      taskId = successor.taskId;
      relayLogId = successor.relayLogId;
    }

    await client.query("COMMIT");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      issue: result.rows[0],
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

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/relay/advance") {
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
  } else if (req.method === "GET" && req.url === "/sso/bridge") {
    ssoBridge(req, res);
  } else if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
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
  } finally {
    await client.end();
  }
}

async function start() {
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

module.exports = { existingStageTask, replaceStageTask, ensureCompletedRelayLog };
