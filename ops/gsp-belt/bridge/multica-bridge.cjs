const http = require("http");
const { URL } = require("url");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

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
    let { issue_id, to_stage, agent_token } = body;

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

    const targetStageResult = await client.query(
      "SELECT stage_name FROM relay_stage_config WHERE stage_name = $1",
      [to_stage]
    );
    if (targetStageResult.rows.length === 0) {
      await client.query("ROLLBACK");
      rejectInvalidRelayStage(res, to_stage);
      return;
    }

    const issueResult = await client.query(
      `SELECT id, status, workspace_id, description, parent_issue_id, title
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
    if (issue.status === to_stage) {
      await client.query("COMMIT");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        issue: { id: issue.id, status: issue.status },
        transition: "already_applied"
      }));
      return;
    }

    const transitionResult = await client.query(
      `SELECT next_stage, alt_next_stages
       FROM relay_stage_config
       WHERE stage_name = $1`,
      [issue.status]
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
    if (!allowedStages.includes(to_stage)) {
      await client.query("ROLLBACK");
      rejectInvalidRelayTransition(res, issue.status, to_stage);
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
          redirected_to: "Human Review"
        }));
        to_stage = "Human Review";
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
      `SELECT rsc.agent_id, rsc.agent_name, a.runtime_id, a.archived_at,
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
       LEFT JOIN agent a ON a.id = rsc.agent_id
       WHERE rsc.stage_name = $2`,
      [issue.workspace_id, issue.status]
    );

    if (stageResult.rows.length === 0) {
      throw new Error(`Missing relay configuration for stage: ${to_stage}`);
    }

    const stage = stageResult.rows[0];
    if (stage.agent_id && stage.archived_at) {
      throw new Error(`Relay owner is archived: ${stage.agent_name} (${stage.agent_id}) for ${issue.status} -> ${to_stage}`);
    }
    if (stage.agent_id && !stage.selected_runtime_id) {
      throw new Error(`No online Codex runtime for stage: ${to_stage}`);
    }

    const result = await client.query(
      `UPDATE "issue"
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, status`,
      [to_stage, issue_id]
    );

    let taskId = null;
    let relayLogId = null;

    // A bundled child must never be dispatched on its own. Its MEGA parent IS
    // the unit of work: dispatching the child too pays for the same fix twice
    // and, on 2026-08-31, tripled in-flight by re-dispatching 235 children that
    // had just been bundled. The stage transition still commits -- the child
    // keeps moving with its parent -- only the paid task is withheld.
    // A MEGA that is itself someone's child is exempt: it is still a work unit.
    let childOfOpenMega = false;
    if (stage.agent_id && issue.parent_issue_id && !/^MEGA/.test(issue.title || '')) {
      const parent = await client.query(
        `SELECT status FROM "issue" WHERE id = $1`, [issue.parent_issue_id]
      );
      if (parent.rows.length &&
          !['Done', 'Cancelled', 'Archived'].includes(parent.rows[0].status)) {
        childOfOpenMega = true;
        console.error('[relay] child of open MEGA - stage advanced, task withheld:',
          issue_id, issue.status, '->', to_stage);
      }
    }

    if (stage.agent_id && !childOfOpenMega) {
      const context = JSON.stringify({
        source: "relay-advance",
        from_stage: issue.status,
        to_stage,
        agent_name: stage.agent_name,
        // Present only on a build dispatch, and duplicated in the issue
        // description: a builder cannot claim it never received the spec.
        ...(bindingSpec ? { spec: bindingSpec } : {})
      });
      // A pending task will pick the issue up at its current stage, so a second
      // task is redundant; the stage transition must not be sacrificed to it.
      const taskResult = await client.query(
        `INSERT INTO agent_task_queue (
           agent_id, issue_id, status, runtime_id, context,
           trigger_summary, force_fresh_session, originator_source,
           trigger_evidence_kind
         )
         VALUES ($1, $2, 'queued', $3, $4::jsonb, $5, TRUE,
                 'unattributed', 'relay_stage_transition')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          stage.agent_id,
          issue_id,
          stage.selected_runtime_id,
          context,
          `Relay stage transition: ${issue.status} -> ${to_stage}`
        ]
      );
      if (taskResult.rows.length === 0) {
        console.error('[relay] task already pending for issue', issue_id, 'agent', stage.agent_id, '- stage transition committed without new task');
      } else {
        taskId = taskResult.rows[0].id;

        const logResult = await client.query(
          `INSERT INTO relay_run_log (
             issue_id, from_stage, to_stage, agent_id, task_id, status
           )
           VALUES ($1, $2, $3, $4, $5, 'pending')
           RETURNING id`,
          [issue_id, issue.status, to_stage, stage.agent_id, taskId]
        );
        relayLogId = logResult.rows[0].id;
      }
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

http.createServer(async (req, res) => {
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
}).listen(PORT, "127.0.0.1", () => {
  console.log(`GSP Multica relay bridge listening on 127.0.0.1:${PORT}`);
  console.log(`SSO workspace: ${SSO_WORKSPACE_ID}`);
  console.log(`SSO Bridge: /sso/bridge (CF Access)`);
  console.log(`Relay: /relay/advance (ticket updates)`);
});
