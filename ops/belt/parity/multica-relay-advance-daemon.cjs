const http = require('http');
const { Pool } = require('pg');

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
             rrl.to_stage, rsc.next_stage
      FROM agent_task_queue atq
      INNER JOIN relay_run_log rrl ON rrl.task_id = atq.id AND rrl.status = $1
      INNER JOIN relay_stage_config rsc ON rrl.to_stage = rsc.stage_name
      INNER JOIN issue i ON atq.issue_id = i.id
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
        } else {
          console.log(`${LOG_PREFIX} Failed: ${row.issue_id} status ${response.status}`);
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
    const query = `SELECT DISTINCT atq.issue_id, atq.status as task_status, i.status as to_stage, rsc.next_stage
      FROM agent_task_queue atq
      INNER JOIN issue i ON atq.issue_id = i.id
      INNER JOIN relay_stage_config rsc ON i.status = rsc.stage_name
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
        } else {
          console.log(`${LOG_PREFIX} [recovery] Failed: ${row.issue_id} status ${response.status}`);
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
          resolve({ ok: res.statusCode === 200, status: res.statusCode, error: parsed.error });
        } catch { resolve({ ok: res.statusCode === 200, status: res.statusCode }); }
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
        AND i.workspace_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM relay_run_log WHERE issue_id = i.id
        )
      LIMIT 10`;

    const result = await client.query(query, ['Registered', WORKSPACE_ID]);

    if (result.rows.length === 0) return;

    console.log(`${LOG_PREFIX} Found ${result.rows.length} unqueued Registered tickets`);

    for (const row of result.rows) {
      try {
        const payload = { issue_id: row.id, to_stage: 'Spec', agent_token: RELAY_AGENT_SECRET };
        const response = await postToRelay(payload);

        if (response.ok) {
          console.log(`${LOG_PREFIX} Advanced Registered ticket ${row.id} (#${row.number}) → Spec`);
        } else {
          console.log(`${LOG_PREFIX} Failed: ${row.id} status ${response.status}`);
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
       SELECT i.id AS issue_id, i.number, i.status AS stage, i.updated_at,
              t.id AS dead_task_id, t.status AS dead_task_status,
              t.attempt, t.max_attempts, t.failure_reason,
              r.from_stage, r.agent_id, r.runtime_mode,
              COALESCE(
                (SELECT ar.id FROM agent_runtime ar
                  WHERE ar.workspace_id = i.workspace_id
                    AND ar.provider = 'codex'
                    AND ar.status = 'online'
                  ORDER BY ar.updated_at DESC LIMIT 1)
              ) AS runtime_id
         FROM issue i
         LEFT JOIN LATERAL (
           SELECT * FROM agent_task_queue
            WHERE issue_id = i.id ORDER BY created_at DESC LIMIT 1
         ) t ON true
         JOIN LATERAL (
           SELECT rsc.stage_name AS from_stage, rsc.agent_id,
                  COALESCE(a.runtime_mode, 'local') AS runtime_mode
             FROM relay_stage_config rsc
             JOIN agent a ON a.id = rsc.agent_id AND a.archived_at IS NULL
            WHERE rsc.next_stage = i.status
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
                   AND t.attempt < t.max_attempts))
          AND NOT EXISTS (
            SELECT 1 FROM agent_task_queue q
             WHERE q.issue_id = i.id AND q.status IN ('queued', 'running')
          )
          -- A bundled child is never its own unit of work: its MEGA parent
          -- carries the fix. The bridge withholds the child's task at the
          -- relay hop, which leaves the child sitting in a stage with no task
          -- -- exactly the cold-start shape the branch above rescues. So this
          -- daemon resurrected 235 children the bridge had just withheld and
          -- paid for the same change twice. Exclude them here too: the
          -- invariant has to hold at BOTH creation points or neither.
          AND NOT EXISTS (
            SELECT 1 FROM issue p
             WHERE p.id = i.parent_issue_id
               AND p.title LIKE 'MEGA%'
               AND p.status NOT IN ('Done', 'Cancelled', 'Archived')
               AND i.title NOT LIKE 'MEGA%'
          )
       ) c
       ) ranked
        WHERE ranked.rn <= $2
        ORDER BY ranked.updated_at ASC`,
      [INFRA_FAILURE_REASONS, REQUEUE_BATCH, REQUEUE_STAGES]
    );

    if (candidates.rows.length === 0) return;

    // Backpressure, scoped per owning agent. Each agent carries its own
    // authoritative ceiling in `agent.max_concurrent_tasks` (build lane 9, each
    // QC worker 5 as of 2026-08-31), so no constant needs inventing here;
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
      // A 'completed' predecessor means QC finished without writing a verdict.
      // That is a real retry, not an infra replay, so it costs an attempt.
      const noArtifact = row.dead_task_status === 'completed';
      const infra = INFRA_FAILURE_REASONS.includes(row.failure_reason || 'cancelled');
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
           VALUES ($1, $2, 'queued', $3, $4::jsonb, $5, TRUE,
                   'unattributed', 'relay_stage_transition', $6, $7, $8)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [row.agent_id, row.issue_id, row.runtime_id, context,
           coldStart
             ? `Relay cold start: never dispatched in ${row.stage}`
             : noArtifact
               ? `Relay requeue: task completed in ${row.stage} without producing its artifact`
               : `Relay requeue: stranded in ${row.stage} (${row.failure_reason || 'cancelled'})`,
           attempt, maxAttempts, row.dead_task_id]
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

console.log(`${LOG_PREFIX} Starting (15s interval, recovery every 2m, cleanup every 5m)`);
setInterval(findAndAdvanceTasks, 15000);
setInterval(findAndAdvanceRegistered, 20000);
setInterval(recoveryAdvanceTasks, 120000);
setInterval(cleanupStalePendingRows, 300000);
setInterval(requeueStrandedTasks, 60000);
findAndAdvanceTasks().catch(err => console.error(`${LOG_PREFIX} Error: ${err.message}`));
findAndAdvanceRegistered().catch(err => console.error(`${LOG_PREFIX} Error in Registered pass: ${err.message}`));
cleanupStalePendingRows().catch(err => console.error(`${LOG_PREFIX} Error in cleanup: ${err.message}`));
