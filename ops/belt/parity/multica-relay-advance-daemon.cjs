const http = require('http');
const { Pool } = require('pg');
const {
  instructionCompatibility,
  retryAdmission,
  spendPreflight,
  stageCycleAdmission,
  lifetimeTaskAdmission,
  quotaCircuitAdmission,
  crossStageExecutionAdmission
} = require('../guardrails.cjs');
const { recordParkAndQueueDiagnosis, parseDiagnosisOutcome, diagnosisEvidence,
  namedBlocker, isConcreteRuntimeEvidence, verifyRuntimeEvidence,
  diagnosisOutcomeAction, PARK_DIAGNOSIS_KIND } = require('../parked-diagnosis.cjs');
const { completionAdmission } = require('../relay-completion-admission.cjs');

const MULTICA_DB = process.env.DATABASE_URL;
const RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET;
const WORKSPACE_ID = process.env.GSP_WORKSPACE_ID;

if (!MULTICA_DB || !RELAY_AGENT_SECRET || !WORKSPACE_ID) {
  console.error('[relay-advance-daemon] FATAL: env vars missing');
  process.exit(1);
}

const LOG_PREFIX = '[relay-advance-daemon]';

// Deliberately small: the DeepSeek build lane is paid, so a backlog drains at a
// steady trickle rather than firing every stranded ticket at the vendor at once.
const REQUEUE_BATCH = Number.parseInt(process.env.RELAY_REQUEUE_BATCH || '3', 10);

// Only stages whose owning agent is safe to re-run. Deliberately NOT the gated
// or terminal stages: a stranded task in 'Done' or 'CI/CD & Deploy' must not be
// re-dispatched, because replaying that agent moves finished work backwards.
// 'Queue' is where the build lane strands its work. 'Spec' was added 2026-08-31
// on evidence: 324 tickets (207 GSP + 117 PPP) sat in Spec having NEVER had a
// task dispatched, so no failure existed for the requeue to find. Their owning
// agent is declared by relay_stage_config row 1 (Registered -> Spec,
// multica-qc-worker-2, the spec writer) -- the belt knew who owned them and
// still dispatched nobody. Widen further only with the same kind of evidence.
const REQUEUE_STAGES = (process.env.RELAY_REQUEUE_STAGES || 'Queue,Spec,In Review')
  .split(',').map(s => s.trim()).filter(Boolean);

// Mirrors --max-concurrent-tasks in fleet/multica-daemon-wrapper.sh. Not a
// threshold of our own: it is the number of tasks the Tower can actually hold.
const MAX_CONCURRENT = Number.parseInt(process.env.RELAY_MAX_CONCURRENT || '12', 10);
const QUEUED_TASK_TTL_MINUTES = Number.parseInt(process.env.MULTICA_QUEUED_TASK_TTL_MINUTES || '120', 10);
const STAGE_CYCLE_LIMIT = Number.parseInt(process.env.RELAY_STAGE_CYCLE_LIMIT || '2', 10);
const LIFETIME_TASK_LIMIT = Number.parseInt(process.env.RELAY_LIFETIME_TASK_LIMIT || '6', 10);
const QUOTA_FAILURE_LIMIT = Number.parseInt(process.env.RELAY_QUOTA_FAILURE_LIMIT || '3', 10);

async function pauseQuotaLane(client, row, consecutiveFailures) {
  const paused = await client.query(
    `UPDATE agent
        SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || '{"quota_paused":true}'::jsonb,
            updated_at = NOW()
      WHERE id = $1
        AND runtime_config->>'quota_paused' IS DISTINCT FROM 'true'
      RETURNING id`,
    [row.agent_id]
  );
  if (paused.rowCount > 0) {
    await client.query(
      `INSERT INTO activity_log
         (workspace_id, issue_id, actor_type, action, details)
       SELECT workspace_id, id, 'system', 'relay_lane_paused', $2::jsonb
         FROM issue WHERE id = $1`,
      [row.issue_id, JSON.stringify({ agent_id: row.agent_id,
        reason: 'provider_quota_limit', consecutive_failures: consecutiveFailures,
        ceiling: QUOTA_FAILURE_LIMIT })]
    );
  }
  return paused.rowCount > 0;
}

async function applyDisposition(client, row, disposition, reason, evidence = {}) {
  const changed = await client.query(
    `UPDATE issue SET status = $1, updated_at = NOW()
      WHERE id = $2 AND status <> $1 RETURNING id`,
    [disposition, row.issue_id]
  );
  if (changed.rowCount > 0 && disposition === 'Parked') {
    const diagnosisTaskId = await recordParkAndQueueDiagnosis(client,
      { id: row.issue_id, workspace_id: row.workspace_id, status: row.stage,
        priority: row.priority }, { ...evidence, reason,
        failure_reason: row.failure_reason });
    if (diagnosisTaskId) evidence = { ...evidence, diagnosis_task_id: diagnosisTaskId };
  }
  await client.query(
    `UPDATE agent_task_queue
        SET status = 'cancelled', completed_at = NOW(),
            prepare_lease_expires_at = NULL, failure_reason = $2
      WHERE issue_id = $1
        -- Never interrupt a paid task already executing. Cross-stage
        -- admission defers successors until running predecessors are
        -- terminal; only unstarted work may be retired by a disposition.
        AND status IN ('queued','dispatched','waiting_local_directory','deferred')
        AND COALESCE(context->>'kind', '') <> 'parked_diagnosis'`,
    [row.issue_id, reason]
  );
  if (changed.rowCount > 0) {
    await client.query(
      `INSERT INTO activity_log
         (workspace_id, issue_id, actor_type, action, details)
       SELECT workspace_id, id, 'system', 'relay_disposition_applied', $2::jsonb
         FROM issue WHERE id = $1`,
      [row.issue_id, JSON.stringify({ from: row.stage, to: disposition, reason, ...evidence })]
    );
  }
  return changed.rowCount > 0;
}

const configuredPoolMax = Number.parseInt(process.env.RELAY_PG_POOL_MAX || '2', 10);
const poolMax = Number.isInteger(configuredPoolMax) && configuredPoolMax > 0
  ? Math.min(configuredPoolMax, 4)
  : 2;
const pool = new Pool({
  connectionString: MULTICA_DB,
  max: poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  application_name: 'multica-relay-advance-daemon',
  options: '-c idle_session_timeout=10min -c idle_in_transaction_session_timeout=5min'
});

pool.on('error', (err) => {
  console.error(`${LOG_PREFIX} [pg-pool] Idle client error: ${err.message}`);
});


async function markRelayLogCompleted(client, issueId) {
  try {
    await client.query(
      `UPDATE relay_run_log SET status = $1 WHERE issue_id = $2 AND status = $3`,
      ['completed', issueId, 'pending']
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to update relay_run_log: ${err.message}`);
  }
}

async function markRelayLogFailed(client, issueId) {
  try {
    await client.query(
      `UPDATE relay_run_log SET status = $1 WHERE issue_id = $2 AND status = $3`,
      ['failed', issueId, 'pending']
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to update relay_run_log: ${err.message}`);
  }
}

// Row-scoped variants. The issue-scoped functions above close EVERY pending
// row for an issue, which loses the correlation between a task and the relay
// log it belongs to. Use these wherever the specific row id is known.
async function markRelayLogCompletedById(client, logId) {
  try {
    await client.query(
      `UPDATE relay_run_log SET status = 'completed' WHERE id = $1 AND status = 'pending'`,
      [logId]
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to update relay_run_log ${logId}: ${err.message}`);
  }
}

async function markRelayLogFailedById(client, logId) {
  try {
    await client.query(
      `UPDATE relay_run_log SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
      [logId]
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to update relay_run_log ${logId}: ${err.message}`);
  }
}

async function cleanupStalePendingRows() {
  const client = await pool.connect();
  try {

    // Close a pending row only when the advance it represents ALREADY happened
    // by some other path -- i.e. the issue has reached the stage AFTER the
    // row's to_stage. The previous condition (i.status = rrl.to_stage) was the
    // very precondition findAndAdvanceTasks waits for, so this cleanup was
    // racing the advancer and closing its work queue.
    const cleanupResult = await client.query(
      `UPDATE relay_run_log rrl
       SET status = 'completed'
       FROM issue i, relay_stage_config rsc
       WHERE rrl.status = 'pending'
         AND i.id = rrl.issue_id
         AND rsc.workspace_id = i.workspace_id
         AND rsc.stage_name = rrl.to_stage
         AND i.status = rsc.next_stage`
    );

    if (cleanupResult.rowCount > 0) {
      console.log(`${LOG_PREFIX} [cleanup] Marked ${cleanupResult.rowCount} stale relay_run_log entries as completed`);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} [cleanup] Error: ${err.message}`);
  } finally {
    client.release();
  }
}

async function findAndAdvanceTasks() {
  const client = await pool.connect();
  const gatedStages = ['CI/CD & Deploy', 'Done', 'Fable QC'];
  try {

    // Correlate strictly on the task that owns the relay log. Advance only
    // genuinely completed tasks; a failed task must never move work forward.
    // No completed_at window: eligibility is the task's terminal state, so a
    // daemon outage delays an advance instead of stranding it forever.
    const query = `SELECT rrl.id AS log_id, atq.issue_id, atq.status AS task_status,
             atq.result AS task_result, atq.error AS task_error,
             i.workspace_id, i.priority, rrl.to_stage, rsc.next_stage
      FROM agent_task_queue atq
      INNER JOIN relay_run_log rrl ON rrl.task_id = atq.id AND rrl.status = $1
      INNER JOIN issue i ON atq.issue_id = i.id
      INNER JOIN relay_stage_config rsc ON rrl.to_stage = rsc.stage_name AND rsc.workspace_id = i.workspace_id
      WHERE atq.status = 'completed'
        AND i.status = rrl.to_stage
        AND rsc.next_stage IS NOT NULL
      ORDER BY rrl.created_at ASC
      LIMIT 20`;

    const result = await client.query(query, ['pending']);

    // A failed or cancelled task must not advance, but its pending log must not
    // linger either -- otherwise the row is retried forever. Close it as failed
    // and leave the issue where it is; the build worker owns returning its own
    // incomplete work to Queue.
    const failed = await client.query(
      `UPDATE relay_run_log rrl
       SET status = 'failed'
       FROM agent_task_queue atq
       WHERE rrl.task_id = atq.id
         AND rrl.status = 'pending'
         AND atq.status IN ('failed', 'cancelled')
       RETURNING rrl.id, rrl.issue_id`
    );
    if (failed.rowCount > 0) {
      console.log(`${LOG_PREFIX} Closed ${failed.rowCount} relay log(s) whose task failed/cancelled; NOT advanced`);
    }

    if (result.rows.length === 0) return;

    console.log(`${LOG_PREFIX} Found ${result.rows.length} tasks ready to advance`);

    for (const row of result.rows) {
      try {
        const completion = completionAdmission(row.task_result ??
          (row.task_error ? { error: row.task_error } : null));
        if (!completion.ok) {
          // Process exit 0 is not a work-product guarantee. A completed task
          // carrying an explicit blocker/FAIL (or no result at all) must not
          // advance into a successor lane and buy another paid task.
          const parked = await applyDisposition(client,
            { ...row, stage: row.to_stage }, completion.disposition, completion.reason,
            { target_stage: row.to_stage, completion_reason: completion.reason });
          console.log(`${LOG_PREFIX} [completion-admission] PARK: issue=${row.issue_id}, stage='${row.to_stage}', reason=${completion.reason}, disposition_applied=${parked}`);
          await markRelayLogFailedById(client, row.log_id);
          continue;
        }
        // Check if next stage is gated; skip auto-advance if it is
        if (gatedStages.includes(row.next_stage)) {
          console.log(`${LOG_PREFIX} SKIPPED: issue=${row.issue_id}, to_stage='${row.to_stage}', reason=stage requires manual QC approval`);
          await markRelayLogCompletedById(client, row.log_id);
          continue;
        }

        const payload = { issue_id: row.issue_id, to_stage: row.next_stage, agent_token: RELAY_AGENT_SECRET };
        const response = await postToRelay(payload);

        if (response.ok) {
          console.log(`${LOG_PREFIX} Advanced ${row.issue_id} '${row.to_stage}' → '${row.next_stage}' (task-correlated log ${row.log_id})`);
          await markRelayLogCompletedById(client, row.log_id);
        } else if (response.deferred) {
          // Preserve the task-correlated pending log. The same advance becomes
          // eligible once the predecessor is terminal; recording failure here
          // would strand it permanently.
          console.log(`${LOG_PREFIX} DEFERRED: ${row.issue_id} reason=${response.error || 'prior_execution_active'}`);
        } else {
          // The relay's own error text was parsed and then discarded, so 76 of every
          // 400 log lines were a bare `status 409` with no cause. Print the reason.
          console.log(`${LOG_PREFIX} Failed: ${row.issue_id} status ${response.status}${response.error ? ` reason=${response.error}` : ''}`);
          await markRelayLogFailedById(client, row.log_id);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Error: ${err.message}`);
        await markRelayLogFailedById(client, row.log_id);
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} DB error: ${err.message}`);
  } finally {
    client.release();
  }
}

async function recoveryAdvanceTasks() {
  const client = await pool.connect();
  const gatedStages = ['CI/CD & Deploy', 'Done', 'Fable QC'];
  // SAFETY: only recover tickets stuck in 'Registered' stage to prevent unauthorized moves out of verdict-gated stages
  const allowedSourceStages = ['Registered'];
  try {

    // Get the latest relay_run_log per issue using LATERAL subquery
    const query = `SELECT DISTINCT atq.issue_id, atq.status as task_status,
             atq.result AS task_result, atq.error AS task_error,
             i.workspace_id, i.priority, i.status as to_stage, rsc.next_stage
      FROM agent_task_queue atq
      INNER JOIN issue i ON atq.issue_id = i.id
      INNER JOIN relay_stage_config rsc ON i.status = rsc.stage_name AND rsc.workspace_id = i.workspace_id
      LEFT JOIN LATERAL (
        SELECT * FROM relay_run_log WHERE issue_id = atq.issue_id ORDER BY created_at DESC LIMIT 1
      ) rrl ON true
      WHERE atq.status IN ('completed', 'failed')
        AND i.status = ANY($1)
        AND rsc.next_stage IS NOT NULL
        AND (rrl.id IS NULL OR rrl.status IN ('pending', 'completed'))
      LIMIT 30`;

    const result = await client.query(query, [allowedSourceStages]);

    if (result.rows.length === 0) return;

    console.log(`${LOG_PREFIX} [recovery] Found ${result.rows.length} orphaned Registered tasks to advance (safety: only Registered allowed)`);

    for (const row of result.rows) {
      try {
        if (row.task_status !== 'completed') {
          console.log(`${LOG_PREFIX} [recovery] HOLD: issue=${row.issue_id}, status=${row.task_status}, reason=task_not_completed`);
          await markRelayLogFailed(client, row.issue_id);
          continue;
        }
        const completion = completionAdmission(row.task_result ??
          (row.task_error ? { error: row.task_error } : null));
        if (!completion.ok) {
          const parked = await applyDisposition(client,
            { ...row, stage: row.to_stage }, completion.disposition, completion.reason,
            { target_stage: row.to_stage, completion_reason: completion.reason });
          console.log(`${LOG_PREFIX} [recovery] PARK: issue=${row.issue_id}, reason=${completion.reason}, disposition_applied=${parked}`);
          await markRelayLogFailed(client, row.issue_id);
          continue;
        }
        // Check if next stage is gated; skip auto-advance if it is
        if (gatedStages.includes(row.next_stage)) {
          console.log(`${LOG_PREFIX} [recovery] SKIPPED: issue=${row.issue_id}, from_stage='${row.to_stage}', to_stage='${row.next_stage}', reason=gated stage requires manual approval`);
          await markRelayLogCompleted(client, row.issue_id);
          continue;
        }

        const payload = { issue_id: row.issue_id, to_stage: row.next_stage, agent_token: RELAY_AGENT_SECRET };
        const response = await postToRelay(payload);

        if (response.ok) {
          console.log(`${LOG_PREFIX} [recovery] Advanced Registered ticket ${row.issue_id} '${row.to_stage}' → '${row.next_stage}'`);
          await markRelayLogCompleted(client, row.issue_id);
        } else if (response.deferred) {
          console.log(`${LOG_PREFIX} [recovery] DEFERRED: ${row.issue_id} reason=${response.error || 'prior_execution_active'}`);
        } else {
          console.log(`${LOG_PREFIX} [recovery] Failed: ${row.issue_id} status ${response.status}${response.error ? ` reason=${response.error}` : ''}`);
          await markRelayLogFailed(client, row.issue_id);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} [recovery] Error advancing Registered: ${err.message}`);
        await markRelayLogFailed(client, row.issue_id);
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} [recovery] DB error: ${err.message}`);
  } finally {
    client.release();
  }
}

function postToRelay(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const opts = { hostname: '127.0.0.1', port: 5005, path: '/relay/advance', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000 };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: res.statusCode === 200, deferred: res.statusCode === 202,
            status: res.statusCode, error: parsed.error });
        } catch { resolve({ ok: res.statusCode === 200, deferred: res.statusCode === 202, status: res.statusCode }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}


async function findAndAdvanceRegistered() {
  const client = await pool.connect();
  try {

    const query = `SELECT i.id, i.number
      FROM issue i
      WHERE i.status = $1
        AND EXISTS (SELECT 1 FROM relay_stage_config rsc
                    WHERE rsc.workspace_id = i.workspace_id AND rsc.stage_name = i.status)
        AND (
          (
            NOT EXISTS (
              SELECT 1 FROM relay_run_log WHERE issue_id = i.id
            )
            OR (
              SELECT count(*) FROM relay_run_log r
               WHERE r.issue_id = i.id
                 AND r.from_stage = 'Registered'
                 AND r.to_stage = 'Spec'
                 AND r.status = 'rejected'
                 AND r.created_at >= NOW() - INTERVAL '24 hours'
            ) < $2
          )
          AND (
            SELECT count(*) FROM agent_task_queue t
             WHERE t.issue_id = i.id
               AND t.context->>'to_stage' = 'Spec'
               AND t.started_at IS NOT NULL
          ) < $2
        )
      LIMIT 10`;

    const result = await client.query(query, ['Registered', STAGE_CYCLE_LIMIT]);

    if (result.rows.length === 0) return;

    console.log(`${LOG_PREFIX} Found ${result.rows.length} unqueued Registered tickets`);

    for (const row of result.rows) {
      try {
        const payload = { issue_id: row.id, to_stage: 'Spec', agent_token: RELAY_AGENT_SECRET };
        const response = await postToRelay(payload);

        if (response.ok) {
          console.log(`${LOG_PREFIX} Advanced Registered ticket ${row.id} (#${row.number}) → Spec`);
        } else {
          console.log(`${LOG_PREFIX} Failed: ${row.id} status ${response.status}${response.error ? ` reason=${response.error}` : ''}`);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Error advancing Registered: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} DB error in Registered pass: ${err.message}`);
  } finally {
    client.release();
  }
}

// A task killed by the fleet or the vendor says nothing about the ticket, so it
// must not spend the ticket's retry budget (GSP #727). These reasons requeue at
// the same attempt number; anything else -- a task that actually ran and
// produced a bad result -- costs an attempt as before.
const INFRA_FAILURE_REASONS = [
  'runtime_offline',
  'timeout',
  'queued_expired',
  'cancelled',
  'stream_disconnected'
];

// The relay only ever creates a task at the MOMENT a ticket transitions into a
// stage (multica-bridge.cjs). If that task later dies while the ticket is still
// sitting in the stage, nothing re-dispatches it and the ticket is stranded for
// good -- 156 of them were, when the build fleet dropped on 2026-08-30 (GSP #725).
// This pass replays the dispatch, taking the owner from relay_stage_config rather
// than from the ticket's own relay_run_log history. History is the wrong source:
// archiving agent "Codex Sol" on 2026-08-30 20:36 orphaned 129 Queue tickets at a
// stroke, and a requeue that trusted their logs would keep aiming at that dead
// agent forever (the agent_task_queue trigger rejects an archived assignee). The
// stage contract is the authority on who owns a stage, so a re-owned stage heals
// its own strays.
async function requeueStrandedTasks() {
  const client = await pool.connect();
  try {
    const candidates = await client.query(
      // The outer wrapper ranks candidates per owning agent. A single global
      // `ORDER BY updated_at ASC LIMIT n` let the oldest backlog monopolise
      // every tick: ~300 Spec tickets are all older than any In Review one,
      // so the In Review lane would never appear in a 3-row window and its
      // tickets could not be recovered at all. Ranking per agent gives each
      // owning lane its own oldest-first slice; the per-agent capacity check
      // below is still what decides how many actually dispatch.
      `SELECT * FROM (
       SELECT c.*, ROW_NUMBER() OVER (
                PARTITION BY c.agent_id ORDER BY c.updated_at ASC
              ) AS rn FROM (
       SELECT i.id AS issue_id, i.workspace_id, i.number, i.priority, i.status AS stage, i.updated_at, i.metadata,
              t.id AS dead_task_id, t.status AS dead_task_status,
              t.attempt, t.max_attempts, t.failure_reason,
              t.result AS dead_task_result, t.error AS dead_task_error,
              r.from_stage, r.agent_id, r.runtime_mode, r.instructions,
              r.model, r.max_concurrent_tasks, r.runtime_config, r.archived_at,
              COALESCE(
                (SELECT ar.id FROM agent_runtime ar
                  WHERE ar.workspace_id = i.workspace_id
                    AND ar.provider = 'codex'
                    AND ar.status = 'online'
                  ORDER BY ar.updated_at DESC LIMIT 1)
              ) AS runtime_id,
              (SELECT ar.provider FROM agent_runtime ar
                WHERE ar.id = (SELECT ar2.id FROM agent_runtime ar2
                  WHERE ar2.workspace_id = i.workspace_id
                    AND ar2.provider = 'codex'
                    AND ar2.status = 'online'
                  ORDER BY ar2.updated_at DESC LIMIT 1)) AS runtime_provider
         FROM issue i
         LEFT JOIN LATERAL (
           SELECT * FROM agent_task_queue
            WHERE issue_id = i.id ORDER BY created_at DESC LIMIT 1
         ) t ON true
         JOIN LATERAL (
           SELECT rsc.stage_name AS from_stage, rsc.agent_id,
                  COALESCE(a.runtime_mode, 'local') AS runtime_mode,
                  a.instructions, a.model, a.max_concurrent_tasks, a.runtime_config, a.archived_at
             FROM relay_stage_config rsc
             JOIN agent a ON a.id = rsc.agent_id AND a.workspace_id = rsc.workspace_id AND a.archived_at IS NULL
            WHERE rsc.workspace_id = i.workspace_id AND rsc.next_stage = i.status
              AND a.runtime_config->>'quota_paused' IS DISTINCT FROM 'true'
            ORDER BY rsc.id LIMIT 1
         ) r ON true
        WHERE i.status = ANY($3)
          -- t.id IS NULL is the cold start: a ticket that reached this stage
          -- and never had a first task. The lateral above used to be an inner
          -- join, so such a ticket produced no row and was invisible to the
          -- requeue forever -- no agent, no error, no alert. It is not a retry,
          -- so the attempt/max_attempts test cannot apply to it.
          AND (t.id IS NULL
               OR (t.status IN ('failed', 'cancelled')
                   AND (t.attempt < t.max_attempts
                        OR COALESCE(t.failure_reason, 'cancelled') = ANY($1)))
               -- Third stranding case: the QC task ran to 'completed' but wrote
               -- no verdict (QC-BLOCKED). It is not failed and not cancelled, so
               -- neither of the branches above can see it, and a ticket with no
               -- verdict can never advance -- 44 sat in In Review this way on
               -- 2026-08-31 (GSP #761). Bounded by the task's own attempt
               -- ceiling, so each ticket gets exactly one retry, never a loop.
               OR (i.status = 'In Review'
                   AND t.status = 'completed'
                   AND t.attempt < t.max_attempts
                   AND NOT EXISTS (
                     SELECT 1 FROM qc_verdict v WHERE v.issue_id = i.id
                   ))
               -- Fourth stranding case, same shape one stage earlier. A spec
               -- worker that posts a specification advances the flight to
               -- 'Queue' in the same run, so a task that ran to 'completed'
               -- and left the flight in 'Spec' produced no specification: the
               -- SPEC-BLOCKED result. 36 sat this way on 2026-08-31 (GSP #775),
               -- invisible to every branch above because the task did not fail.
               -- The stage is the evidence, so no content test is needed.
               OR (i.status = 'Spec'
                   AND t.status = 'completed'
                   AND t.attempt < t.max_attempts)
               OR (t.id IS NOT NULL
                   AND t.status IN ('queued', 'dispatched', 'running')
                   AND ((t.context ? 'to_stage'
                         AND t.context->>'to_stage' IS DISTINCT FROM i.status)
                        OR (NOT (t.context ? 'to_stage')
                            AND t.created_at < i.updated_at))))
          AND NOT EXISTS (
            SELECT 1 FROM agent_task_queue q
             WHERE q.issue_id = i.id AND q.status IN
               ('queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred')
               AND COALESCE(q.context->>'to_stage', '') = i.status
          )
          AND COALESCE(t.context->>'no_builder', 'false') <> 'true'
          -- A bundled child is never its own unit of work: its MEGA parent
          -- carries the fix. The bridge withholds the child's task at the
          -- relay hop, which leaves the child sitting in a stage with no task
          -- -- exactly the cold-start shape the branch above rescues. So this
          -- daemon resurrected 235 children the bridge had just withheld and
          -- paid for the same change twice. Exclude them here too: the
          -- invariant has to hold at BOTH creation points or neither.
          -- Any parent link marks a bundled child. Its MEGA is the only unit
          -- of work, even after the parent has shipped and the child is still
          -- open for disposition.
          AND i.parent_issue_id IS NULL
       ) c
       ) ranked
        WHERE ranked.rn <= $2
        ORDER BY ranked.updated_at ASC`,
      [INFRA_FAILURE_REASONS, REQUEUE_BATCH, REQUEUE_STAGES]
    );

    if (candidates.rows.length === 0) return;

    // Backpressure, scoped per owning agent. Each agent carries its own
    // authoritative concurrency ceiling in `agent.max_concurrent_tasks` (build
    // lane 9, each QC worker 5 as of 2026-08-31), so no constant needs inventing;
    // RELAY_MAX_CONCURRENT survives only as the fallback for an agent with no
    // cap recorded.
    //
    // This must be per agent, not one global number. The lanes execute in two
    // independent pools: `agent.runtime_mode='local'` runs on the on-box Tower
    // (--max-concurrent-tasks=12) while the spec/QC/merge lanes are
    // runtime_mode='cloud' and never occupy a Tower slot. Measured 2026-08-31:
    // 73 cloud tasks completed in one hour while 9 local builds held their
    // slots for that entire hour and completed none. Counting every queued task
    // against the single local cap let slow local builds hold the cloud lanes
    // shut -- that is why 325 cold starts sat behind
    // `HELD: queued=12 >= max=12` while the pool they needed was idle.
    //
    // Count only 'running'. `max_concurrent_tasks` is a concurrency ceiling, and
    // the bridge honours it exactly: measured 2026-08-31 the build lane sat at
    // running=9 against cap=9 with queued=13, and each QC worker likewise ran at
    // or under its 5. Counting the queue against a concurrency cap compared two
    // different things, and because a healthy lane always holds a buffer the
    // requeue was starved permanently -- every tick logged
    // `HELD: in_flight=22 >= cap=9` and not one stranded flight was ever
    // admitted, which made the Spec and In Review drains inert.
    //
    // Queue depth stays bounded without counting it here: the requeue admits
    // only stranded flights, and every branch that admits one is capped by that
    // task's own `attempt < max_attempts`. Each flight is therefore retried once
    // and then stops competing, so the extra work is bounded by the size of the
    // stranded set, not by how often the loop runs.
    const { rows: loadRows } = await client.query(
      `SELECT a.id AS agent_id,
              COALESCE(a.max_concurrent_tasks, $1) AS cap,
              count(q.id) FILTER (WHERE q.status = 'running')::int AS in_flight
         FROM agent a
         LEFT JOIN agent_task_queue q ON q.agent_id = a.id
        WHERE a.id = ANY($2::uuid[])
        GROUP BY a.id, a.max_concurrent_tasks`,
      [MAX_CONCURRENT, [...new Set(candidates.rows.map((c) => c.agent_id))]]
    );
    const slotsByAgent = new Map(loadRows.map((r) => [r.agent_id, r.cap - r.in_flight]));
    const loadByAgent = new Map(loadRows.map((r) => [r.agent_id, r]));

    const admitted = [];
    const heldByAgent = new Map();
    for (const row of candidates.rows) {
      const free = slotsByAgent.get(row.agent_id) ?? 0;
      if (free > 0) {
        admitted.push(row);
        slotsByAgent.set(row.agent_id, free - 1);
      } else {
        heldByAgent.set(row.agent_id, (heldByAgent.get(row.agent_id) || 0) + 1);
      }
    }
    // Held work stays visible per agent: a silent return is what made the
    // original starvation impossible to see.
    for (const [agentId, n] of heldByAgent) {
      const l = loadByAgent.get(agentId);
      // Report the slots this tick actually had, not the pre-admission
      // snapshot. The old wording printed `in_flight=5 >= cap=9`, a comparison
      // that is plainly false, because in_flight was read before the loop
      // admitted anything. It reads like an off-by-one in the gate and is not:
      // the gate admits `cap - in_flight` and holds the remainder.
      const opened = l ? Math.max(0, l.cap - l.in_flight) : 0;
      console.log(`${LOG_PREFIX} [requeue] HELD: ${n} candidate(s) for agent ${agentId}, ${opened} slot(s) opened this tick and all were filled (cap=${l ? l.cap : '?'}, running=${l ? l.in_flight : '?'})`);
    }
    if (admitted.length === 0) return;

    let requeued = 0;
    for (const row of admitted) {
      if (!row.runtime_id) {
        console.log(`${LOG_PREFIX} [requeue] SKIPPED #${row.number}: no online codex runtime for its workspace`);
        continue;
      }
      // A cold start has no prior task, so it is attempt 1 of the queue's own
      // default ceiling -- never row.attempt + 1 on a NULL.
      const coldStart = !row.dead_task_id;
      if (row.dead_task_status === 'completed') {
        const completion = completionAdmission(row.dead_task_result ??
          (row.dead_task_error ? { error: row.dead_task_error } : null));
        if (!completion.ok) {
          // The predecessor reached process status=completed but did not
          // produce admissible work. Re-dispatching it would buy a duplicate
          // paid task (the GSP #1229 shape), so hold it for diagnosis/operator
          // action instead of treating it as an ordinary missing artifact.
          const parked = await applyDisposition(client,
            { ...row, stage: row.stage }, completion.disposition, completion.reason,
            { target_stage: row.stage, completion_reason: completion.reason });
          console.log(`${LOG_PREFIX} [requeue] PARK #${row.number}: completed predecessor failed completion admission (${completion.reason}), disposition_applied=${parked}`);
          continue;
        }
      }
      const compatibility = instructionCompatibility(row.instructions, row.stage);
      if (!compatibility.ok) {
        console.log(`${LOG_PREFIX} [requeue] HELD #${row.number}: agent instructions do not authorize '${compatibility.stage}'`);
        continue;
      }
      const preflight = spendPreflight(row, { provider: row.runtime_provider });
      if (!preflight.ok) {
        console.log(`${LOG_PREFIX} [requeue] HELD #${row.number}: paid dispatch preflight ${preflight.reason}`);
        continue;
      }
      // A 'completed' predecessor means QC finished without writing a verdict.
      // That is a real retry, not an infra replay, so it costs an attempt.
      const noArtifact = row.dead_task_status === 'completed';
      const infra = INFRA_FAILURE_REASONS.includes(row.failure_reason || 'cancelled');
      if (infra) {
        const headroom = await client.query(
          `SELECT COALESCE(max(EXTRACT(epoch FROM (now() - created_at)) / 60), 0) AS age
             FROM agent_task_queue WHERE status = 'queued'`
        );
        const admission = retryAdmission({
          attempt: row.attempt,
          maxAttempts: row.max_attempts == null ? 2 : row.max_attempts,
          failureReason: row.failure_reason || 'cancelled',
          queueAgeMinutes: Number(headroom.rows[0]?.age || 0),
          queueTtlMinutes: QUEUED_TASK_TTL_MINUTES,
          infraReasons: INFRA_FAILURE_REASONS
        });
        if (!admission.ok) {
          console.log(`${LOG_PREFIX} [requeue] HELD #${row.number}: ${admission.reason}`);
          continue;
        }
      }
      // noArtifact must be checked BEFORE infra: a completed task has a NULL
      // failure_reason, which coalesces to 'cancelled' -- an INFRA reason --
      // and infra replays reuse the same attempt number. Left in that order
      // the retry would never consume an attempt and these tickets would
      // requeue forever, which is the QC bounce loop that burned 134 paid
      // calls on a single ticket. A missing verdict is a real failed try.
      const attempt = coldStart ? 1
        : (noArtifact || !infra) ? row.attempt + 1
        : row.attempt;
      const maxAttempts = row.max_attempts == null ? 2 : row.max_attempts;
      try {
        await client.query('BEGIN');
        // Match the bridge's issue-scoped relay lock. This is intentionally
        // narrower than a queue-wide unique constraint: manual tasks and
        // terminal dispositions are outside execution admission.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 804))", [row.issue_id]);
        // Serialize admission with the bridge and other recovery workers.
        // The old code cancelled a live task for a *different* stage before it
        // created this retry. That turns an active Spec -> Queue flight into a
        // Queue -> In Progress task and loses the predecessor's work product.
        await client.query('SELECT id FROM issue WHERE id = $1 FOR UPDATE', [row.issue_id]);
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
          [row.issue_id]
        );
        const crossStage = crossStageExecutionAdmission(liveRows.rows, row.issue_id);
        if (!crossStage.ok) {
          await client.query('ROLLBACK');
          console.log(`${LOG_PREFIX} [requeue] DEFERRED #${row.number}: ${crossStage.reason} tasks=${crossStage.active_task_ids.join(',')} stages=${crossStage.active_stages.join(',')}`);
          continue;
        }
        if (quotaCircuitAdmission([row.failure_reason], 1).pause) {
          const recentFailures = await client.query(
            `SELECT failure_reason FROM agent_task_queue
              WHERE agent_id = $1 AND status = 'failed'
              ORDER BY created_at DESC LIMIT $2`,
            [row.agent_id, QUOTA_FAILURE_LIMIT]
          );
          const circuit = quotaCircuitAdmission(
            recentFailures.rows.map((failure) => failure.failure_reason), QUOTA_FAILURE_LIMIT
          );
          const lanePaused = circuit.pause
            ? await pauseQuotaLane(client, row, circuit.consecutive)
            : false;
          const moved = await applyDisposition(client, row, 'Human Review', 'payment_required_402', {
            dead_task_id: row.dead_task_id, consecutive_failures: circuit.consecutive,
            lane_paused: lanePaused
          });
          await client.query('COMMIT');
          console.log(`${LOG_PREFIX} [requeue] MONEY-BLOCKED #${row.number}: 402 -> Human Review; applied=${moved}; lane_paused=${lanePaused}`);
          continue;
        }
        const releaseAt = row.metadata?.parked_release_at || null;
        const history = await client.query(
          `SELECT count(*)::int AS n FROM agent_task_queue
            WHERE issue_id = $1 AND context->>'to_stage' = $2
              AND ($3::timestamptz IS NULL OR created_at >= $3)`,
          [row.issue_id, row.stage, releaseAt]
        );
        const cycle = stageCycleAdmission(history.rows[0]?.n || 0, STAGE_CYCLE_LIMIT);
        if (!cycle.ok) {
          const moved = await applyDisposition(client, row, cycle.disposition, cycle.reason, {
            target_stage: row.stage, historical_tasks: history.rows[0]?.n || 0,
            ceiling: cycle.ceiling
          });
          await client.query('COMMIT');
          console.log(`${LOG_PREFIX} [requeue] PARKED #${row.number}: ${cycle.reason}; applied=${moved}`);
          continue;
        }
        const lifetimeHistory = await client.query(
          `SELECT count(*)::int AS n FROM agent_task_queue
            WHERE issue_id = $1
              AND ($2::timestamptz IS NULL OR created_at >= $2)`,
          [row.issue_id, releaseAt]
        );
        const lifetime = lifetimeTaskAdmission(lifetimeHistory.rows[0]?.n || 0, LIFETIME_TASK_LIMIT);
        if (!lifetime.ok) {
          const moved = await applyDisposition(client, row, lifetime.disposition, lifetime.reason, {
            historical_tasks: lifetimeHistory.rows[0]?.n || 0, ceiling: lifetime.ceiling
          });
          await client.query('COMMIT');
          console.log(`${LOG_PREFIX} [requeue] PARKED #${row.number}: ${lifetime.reason}; applied=${moved}`);
          continue;
        }
        const context = JSON.stringify({
          source: coldStart ? 'relay-cold-start'
            : noArtifact
              ? (row.stage === 'Spec' ? 'relay-spec-no-artifact' : 'relay-qc-no-verdict')
              : 'relay-requeue',
          from_stage: row.from_stage,
          to_stage: row.stage,
          requeue_of_task: row.dead_task_id,
          dead_task_reason: row.failure_reason
        });
        const task = await client.query(
          `INSERT INTO agent_task_queue (
             agent_id, issue_id, status, runtime_id, context,
             trigger_summary, force_fresh_session, originator_source,
             trigger_evidence_kind, attempt, max_attempts, retry_of_task_id
           )
           SELECT $1, $2, 'queued', $3, $4::jsonb, $5, TRUE,
                  'unattributed', 'relay_stage_transition', $6, $7, $8
            WHERE NOT EXISTS (
              SELECT 1 FROM agent_task_queue active
               WHERE active.issue_id = $2
                 AND active.status IN ('queued', 'dispatched', 'running',
                                       'waiting_local_directory', 'deferred')
                 AND active.context->>'to_stage' = $9
            )
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [row.agent_id, row.issue_id, row.runtime_id, context,
           coldStart
             ? `Relay cold start: never dispatched in ${row.stage}`
             : noArtifact
               ? `Relay requeue: task completed in ${row.stage} without producing its artifact`
               : `Relay requeue: stranded in ${row.stage} (${row.failure_reason || 'cancelled'})`,
           attempt, maxAttempts, row.dead_task_id, row.stage]
        );
        if (task.rows.length === 0) {
          // ON CONFLICT DO NOTHING matched, or a BEFORE INSERT trigger cancelled
          // the row. Either way no task exists and the ticket stays stranded, so
          // say so: a bare `continue` here made a failed requeue look identical
          // to a tick with nothing to do.
          await client.query('ROLLBACK');
          console.log(`${LOG_PREFIX} [requeue] SKIPPED #${row.number}: insert produced no row (conflict or trigger); still stranded in '${row.stage}'`);
          continue;
        }
        await client.query(
          `INSERT INTO relay_run_log (issue_id, from_stage, to_stage, agent_id, task_id, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [row.issue_id, row.from_stage, row.stage, row.agent_id, task.rows[0].id]
        );
        await client.query('COMMIT');
        requeued++;
        console.log(`${LOG_PREFIX} [requeue] #${row.number} stranded in '${row.stage}' (${row.failure_reason || 'cancelled'}) -> new task ${task.rows[0].id} attempt ${attempt}/${row.max_attempts}`);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error(`${LOG_PREFIX} [requeue] Error on #${row.number}: ${err.message}`);
      }
    }
    if (requeued > 0) {
      console.log(`${LOG_PREFIX} [requeue] Requeued ${requeued} stranded ticket(s)`);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} [requeue] DB error: ${err.message}`);
  } finally {
    client.release();
  }
}

function diagnosisText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  return [result.comment, result.output, result.text, result.error]
    .filter(Boolean).join('\n');
}

async function processParkedDiagnoses() {
  const client = await pool.connect();
  try {
    const { rows: candidates } = await client.query(
      `SELECT t.id, i.workspace_id
         FROM agent_task_queue t
         JOIN issue i ON i.id = t.issue_id
        WHERE t.status = 'completed'
          AND t.context->>'kind' = $1
          AND COALESCE(t.context->>'diagnosis_processed', 'false') <> 'true'
          AND i.workspace_id IS NOT NULL
        ORDER BY t.completed_at ASC
        LIMIT 25`, [PARK_DIAGNOSIS_KIND]);
    for (const candidate of candidates) {
      // Claim the diagnosis row under lock. Multiple relay daemon instances
      // may tick together; SKIP LOCKED prevents duplicate outcomes/comments.
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT t.id, t.issue_id, t.result, t.context,
                i.workspace_id, i.status, i.number
           FROM agent_task_queue t
           JOIN issue i ON i.id = t.issue_id
          WHERE t.id = $1
            AND t.context->>'kind' = $2
            AND i.workspace_id = $3
            AND t.status = 'completed'
            AND COALESCE(t.context->>'diagnosis_processed', 'false') <> 'true'
          FOR UPDATE OF t SKIP LOCKED`, [candidate.id, PARK_DIAGNOSIS_KIND, candidate.workspace_id]);
      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        continue;
      }
      const task = locked.rows[0];
      const text = diagnosisText(task.result);
      const parsedOutcome = parseDiagnosisOutcome(text);
      const evidence = diagnosisEvidence(text);
      const blocker = namedBlocker(text);
      // A malformed Sol-low response must not create an unbounded retry or a
      // silent parked ticket. Treat it as a named blocker until an operator
      // can rerun the single diagnosis task deliberately.
      const outcome = parsedOutcome || 'genuinely_blocked';
      const missingOutcome = !parsedOutcome;
      const evidenceVerified = outcome === 'already_fixed' && isConcreteRuntimeEvidence(evidence)
        ? await verifyRuntimeEvidence(client, task.issue_id, evidence, task.id) : false;
      const invalidAlreadyFixed = outcome === 'already_fixed' && !evidenceVerified;
      const invalidBlocked = outcome === 'genuinely_blocked' && !blocker;
      const duplicate = text.match(/duplicate[_ ](?:of|issue)\s*[:#]?\s*([0-9a-f-]{8,}|\d+)/i)?.[1] || null;
      let duplicateIssueId = null;
      if (outcome === 'duplicate' && duplicate) {
        const target = await client.query(
          `SELECT id FROM issue
            WHERE workspace_id = $1 AND id <> $2
              AND status NOT IN ('Cancelled', 'Archived')
              AND (id::text = $3 OR number::text = $3)
            ORDER BY (status = 'Done') DESC, updated_at DESC
            LIMIT 1`, [task.workspace_id, task.issue_id, duplicate]);
        duplicateIssueId = target.rows[0]?.id || null;
      }
      const invalidDuplicate = outcome === 'duplicate' && !duplicateIssueId;
      const action = diagnosisOutcomeAction({ outcome, evidenceVerified, duplicateIssueId,
        blocker, missingOutcome, invalidAlreadyFixed, invalidDuplicate });
      const content = `<!-- multica-diagnosis-outcome -->\nSol-low diagnosis outcome: ${outcome}.\n${missingOutcome ? 'blocker: diagnosis response omitted an explicit outcome.\n' : ''}${invalidAlreadyFixed ? 'blocker: already_fixed requires concrete runtime_evidence.\n' : ''}${invalidBlocked ? 'blocker: genuinely_blocked requires a named blocker.\n' : ''}${invalidDuplicate ? 'blocker: duplicate requires an existing same-workspace duplicate_of target.\n' : ''}${evidence ? `runtime_evidence: ${evidence}\n` : ''}${blocker ? `blocker: ${blocker}\n` : ''}${text.slice(0, 2000)}`;
      await client.query(
        `INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type)
         SELECT $1::uuid, $2::uuid, 'system', $3::uuid, $4::text, 'system'
          WHERE NOT EXISTS (
            SELECT 1 FROM comment WHERE issue_id = $1::uuid
              AND content LIKE '<!-- multica-diagnosis-outcome -->%'
              AND content LIKE $5::text
          )`,
        [task.issue_id, task.workspace_id, '00000000-0000-0000-0000-000000000000',
          content, `%outcome: ${outcome}.%`]
      );
      if (action.action === 'release') {
        await client.query(
          `UPDATE issue SET metadata = jsonb_set(
                    jsonb_set(COALESCE(metadata, '{}'::jsonb),
                      '{parked_release_once}', 'true'::jsonb, true),
                    '{parked_release_at}', to_jsonb(NOW()), true),
                  updated_at = NOW()
             WHERE id = $1 AND status = 'Parked'`, [task.issue_id]);
      } else if (action.action === 'close' && action.status === 'Done') {
        await client.query(
          `UPDATE issue SET status = 'Done', updated_at = NOW()
             WHERE id = $1 AND status = 'Parked'`, [task.issue_id]);
      } else if (action.action === 'close' && action.status === 'Cancelled') {
        await client.query(
          `UPDATE issue SET status = 'Cancelled',
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('duplicate_of', $2::uuid),
                  updated_at = NOW()
             WHERE id = $1 AND status = 'Parked'`, [task.issue_id, duplicateIssueId]);
      } else {
        await client.query(
          `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                    jsonb_build_object('parked_blocker', $2::text),
                  updated_at = NOW()
             WHERE id = $1 AND status = 'Parked'`, [task.issue_id,
            action.blocker]);
      }
      await client.query(
        `UPDATE agent_task_queue
            SET context = COALESCE(context, '{}'::jsonb) || '{"diagnosis_processed":true}'::jsonb
          WHERE id = $1`, [task.id]);
      await client.query('COMMIT');
      if (outcome === 'fixable') {
        const response = await postToRelay({ issue_id: task.issue_id, to_stage: 'Queue', agent_token: RELAY_AGENT_SECRET });
        if (!response.ok) {
          // Keep the diagnosis retryable when the bridge is unavailable; the
          // release marker is harmless and the bridge consumes it once.
          await client.query(
            `UPDATE agent_task_queue
                SET context = context - 'diagnosis_processed'
              WHERE id = $1`, [task.id]);
        }
        console.log(`${LOG_PREFIX} [diagnosis] #${task.number}: fixable -> Queue; relay=${response.status}`);
      } else {
        console.log(`${LOG_PREFIX} [diagnosis] #${task.number}: ${outcome}`);
      }
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`${LOG_PREFIX} [diagnosis] DB error: ${err.message}`);
  } finally {
    client.release();
  }
}

console.log(`${LOG_PREFIX} Starting (15s interval, recovery every 2m, cleanup every 5m)`);
setInterval(findAndAdvanceTasks, 15000);
setInterval(findAndAdvanceRegistered, 20000);
setInterval(recoveryAdvanceTasks, 120000);
setInterval(cleanupStalePendingRows, 300000);
setInterval(requeueStrandedTasks, 60000);
setInterval(processParkedDiagnoses, 30000);
findAndAdvanceTasks().catch(err => console.error(`${LOG_PREFIX} Error: ${err.message}`));
findAndAdvanceRegistered().catch(err => console.error(`${LOG_PREFIX} Error in Registered pass: ${err.message}`));
cleanupStalePendingRows().catch(err => console.error(`${LOG_PREFIX} Error in cleanup: ${err.message}`));
processParkedDiagnoses().catch(err => console.error(`${LOG_PREFIX} Error in parked diagnosis pass: ${err.message}`));
