const http = require('http');
const { Pool } = require('pg');
const {
  instructionCompatibility,
  retryAdmission,
  spendPreflight,
  stageCycleAdmission,
  lifetimeTaskAdmission,
  quotaCircuitAdmission,
  crossStageExecutionAdmission,
  quotaPauseClearance,
  quotaPauseFlipLogLine
} = require('../guardrails.cjs');
const { recordParkAndQueueDiagnosis, parseDiagnosisOutcome, diagnosisEvidence,
  namedBlocker, isConcreteRuntimeEvidence, verifyRuntimeEvidence, currentPassWorkProductMD5,
  diagnosisOutcomeAction, PARK_DIAGNOSIS_KIND } = require('../parked-diagnosis.cjs');
const { completionAdmission } = require('../relay-completion-admission.cjs');
const { recordParkedEntry } = require('../parked-entry-audit.cjs');

const MULTICA_DB = process.env.DATABASE_URL;
const RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET;
const WORKSPACE_ID = process.env.GSP_WORKSPACE_ID;

const LOG_PREFIX = '[relay-advance-daemon]';
const TERMINAL_STAGES = new Set(['Done', 'Cancelled', 'Archived']);
const MD5_RE = /^[0-9a-f]{32}$/i;
const FULL_SHA_RE = /(^|[^0-9a-f])([0-9a-f]{40})(?![0-9a-f])/ig;
const QC_EVIDENCE_MISMATCH_LIMIT = 3;

function uniqueFullSha(value) {
  const matches = [...String(value || '').matchAll(FULL_SHA_RE)]
    .map((match) => match[2].toLowerCase());
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function strictQcAttempt(row, verdictMd5) {
  if (!row.qc_attempt_bound_sha && !row.qc_attempt_observed_sha) return null;
  const bound = String(row.qc_attempt_bound_sha || '').toLowerCase();
  const observed = String(row.qc_attempt_observed_sha || '').toLowerCase();
  const md5 = String(row.qc_attempt_work_product_md5 || '').toLowerCase();
  const evidenceAgentId = row.qc_attempt_evidence_agent_id || row.task_agent_id;
  const ok = row.qc_attempt_verdict === 'PASS' && row.qc_attempt_qualifying === true &&
    row.qc_attempt_evidence_agent_model === 'gpt-5.6-sol' &&
    row.qc_attempt_evidence_agent_effort === 'low' &&
    row.qc_verdict_checker_id === evidenceAgentId &&
    /^[0-9a-f]{40}$/.test(bound) && bound === observed && md5 === verdictMd5;
  return ok ? { ok: true, boundSha: bound,
    evidenceTaskId: row.qc_attempt_evidence_task_id || row.task_id }
    : { ok: false, reason: 'qc_attempt_mismatch' };
}

function legacyQcVerdict(row, verdictMd5, requireVerdictWindow = true) {
  const taskSha = uniqueFullSha(JSON.stringify(row.task_result || ''));
  const verdictSha = uniqueFullSha(row.qc_verdict_notes);
  const started = Date.parse(row.task_started_at || '');
  const completed = Date.parse(row.task_completed_at || '');
  const recorded = Date.parse(row.qc_verdict_created_at || '');
  const inWindow = Number.isFinite(started) && Number.isFinite(completed) &&
    Number.isFinite(recorded) && recorded >= started && recorded <= completed + 30000;
  const ok = row.qc_verdict_checker_id === row.task_agent_id &&
    row.task_agent_model === 'gpt-5.6-sol' && row.task_agent_effort === 'low' &&
    (!requireVerdictWindow || inWindow) &&
    taskSha && taskSha === verdictSha && MD5_RE.test(verdictMd5);
  return ok ? { ok: true, boundSha: taskSha, evidenceTaskId: row.task_id }
    : { ok: false, reason: 'legacy_qc_evidence_mismatch' };
}

function qcCompletionAdvance(row) {
  if (row.to_stage !== 'In Review' || row.next_stage !== 'CI/CD & Deploy') {
    return { ok: false, reason: 'manual_gated_stage' };
  }
  if (row.task_status !== 'completed' || row.qc_verdict !== 'PASS') {
    return { ok: false, reason: 'completed_sol_low_pass_required' };
  }
  const md5 = String(row.qc_verdict_work_product_md5 || '').toLowerCase();
  if (!MD5_RE.test(md5)) return { ok: false, reason: 'qc_work_product_md5_required' };
  const strict = strictQcAttempt(row, md5);
  if (strict) {
    return strict.ok ? { ok: true, workProductMd5: md5, boundSha: strict.boundSha,
      evidenceTaskId: strict.evidenceTaskId } : strict;
  }
  const candidates = Array.isArray(row.qc_evidence_tasks) && row.qc_evidence_tasks.length > 0
    ? row.qc_evidence_tasks.map((task) => ({ ...row, ...task })) : [row];
  for (const candidate of candidates) {
    const evidence = legacyQcVerdict(candidate, md5, candidates.length === 1 && candidate === row);
    if (evidence.ok) {
      return { ok: true, workProductMd5: md5, boundSha: evidence.boundSha,
        evidenceTaskId: evidence.evidenceTaskId };
    }
  }
  return { ok: false, reason: 'legacy_qc_evidence_mismatch' };
}

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
const NON_REQUEUE_STAGES = new Set(['Human Review', 'Done', 'Cancelled', 'Archived']);
const configuredRequeueStages = (process.env.RELAY_REQUEUE_STAGES || 'Queue,In Progress,Spec')
  .split(',').map(s => s.trim()).filter(Boolean);
const excludedRequeueStages = configuredRequeueStages.filter((stage) => NON_REQUEUE_STAGES.has(stage));
const REQUEUE_STAGES = configuredRequeueStages.filter((stage) => !NON_REQUEUE_STAGES.has(stage));
if (excludedRequeueStages.length > 0) {
  console.warn(`${LOG_PREFIX} [requeue] ignoring non-dispatch stages: ${excludedRequeueStages.join(', ')}`);
}

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
        SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || jsonb_build_object(
              'quota_paused', true,
              'quota_paused_at', to_jsonb(NOW())
            ),
            updated_at = NOW()
      WHERE id = $1
        AND runtime_config->>'quota_paused' IS DISTINCT FROM 'true'
      RETURNING id, workspace_id, COALESCE(name, id::text) AS agent_name,
                runtime_config->>'quota_paused_at' AS paused_at`,
    [row.agent_id]
  );
  if (paused.rowCount > 0) {
    const pause = paused.rows[0];
    await client.query(
      `INSERT INTO activity_log
         (workspace_id, issue_id, actor_type, action, details)
       SELECT workspace_id, id, 'system', 'relay_lane_paused', $2::jsonb
         FROM issue WHERE id = $1`,
      [row.issue_id, JSON.stringify({ agent_id: pause.id, agent_name: pause.agent_name,
        timestamp: pause.paused_at,
        reason: 'provider_quota_limit', consecutive_failures: consecutiveFailures,
        ceiling: QUOTA_FAILURE_LIMIT })]
    );
    return pause;
  }
  return null;
}

function logQuotaPauseFlip({ agent_name: agentName, timestamp, paused }) {
  console.warn(`${LOG_PREFIX} ${quotaPauseFlipLogLine(agentName, timestamp, paused)}`);
}

async function hasBindingSpec(client, issueId) {
  const result = await client.query(
    `SELECT 1 FROM comment
      WHERE issue_id = $1 AND content LIKE '%## Spec%' AND content LIKE '%## Evidence%'
      LIMIT 1`, [issueId]
  );
  return result.rowCount > 0;
}

async function reconcileQuotaPauses({ connect = () => pool.connect(), now = () => Date.now(),
  onFlip = logQuotaPauseFlip,
  onError = (err) => console.error(`${LOG_PREFIX} [quota-pause] reconciliation error: ${err.message}`) } = {}) {
  let client;
  const committedFlips = [];
  try {
    client = await connect();
    await client.query('BEGIN');
    // Lock each paused agent before deciding whether to clear it. This makes a
    // fresh quota failure wait behind reconciliation instead of losing its
    // newly-written timestamp to a stale clear.
    const paused = await client.query(
      `SELECT a.id, a.workspace_id, COALESCE(a.name, a.id::text) AS agent_name,
              a.runtime_config->>'quota_paused_at' AS paused_at, a.updated_at,
              EXISTS (
                SELECT 1 FROM build_budget b
                 WHERE b.workspace_id = a.workspace_id
                   AND b.scope = 'workspace'
                   AND b.state = 'closed'
                   AND b.spent_ticks + b.reserved_ticks >= b.limit_ticks
              ) AS budget_exhausted
         FROM agent a
        WHERE a.runtime_config->>'quota_paused' = 'true'
        FOR UPDATE SKIP LOCKED`
    );
    for (const agent of paused.rows) {
      const clearance = quotaPauseClearance({
        pausedAt: agent.paused_at,
        fallbackAt: agent.updated_at,
        budgetExhausted: agent.budget_exhausted,
        now: now()
      });
      if (!clearance.clear) continue;
      const cleared = await client.query(
        `UPDATE agent
            SET runtime_config = (COALESCE(runtime_config, '{}'::jsonb) - 'quota_paused' - 'quota_paused_at')
                  || jsonb_build_object(
                    'quota_pause_cleared_at', to_jsonb(NOW()),
                    'quota_pause_clear_reason', $2
                  ),
                updated_at = NOW()
          WHERE id = $1
            AND runtime_config->>'quota_paused' = 'true'
          RETURNING runtime_config->>'quota_pause_cleared_at' AS cleared_at`,
        [agent.id, clearance.reason]
      );
      if (cleared.rowCount === 0) continue;
      const timestamp = cleared.rows[0].cleared_at;
      await client.query(
        `INSERT INTO activity_log
           (workspace_id, issue_id, actor_type, action, details)
         VALUES ($1, NULL, 'system', 'relay_lane_resumed', $2::jsonb)`,
        [agent.workspace_id, JSON.stringify({ agent_id: agent.id, agent_name: agent.agent_name,
          timestamp, paused_at: agent.paused_at, reason: clearance.reason })]
      );
      committedFlips.push({ agent_name: agent.agent_name, timestamp, paused: false });
    }
    await client.query('COMMIT');
    for (const flip of committedFlips) onFlip(flip);
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    onError(err);
  } finally {
    if (client) client.release();
  }
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

async function holdQcEvidenceMismatch(client, logId) {
  return client.query(
    `UPDATE relay_run_log
        SET parked_audit = jsonb_set(
              COALESCE(parked_audit, '{}'::jsonb),
              '{qc_evidence_mismatch_count}',
              to_jsonb(COALESCE((parked_audit->>'qc_evidence_mismatch_count')::int, 0) + 1)),
            status = CASE
              WHEN COALESCE((parked_audit->>'qc_evidence_mismatch_count')::int, 0) + 1 >= $2
                THEN 'rejected'
              ELSE status
            END
      WHERE id = $1 AND status = 'pending'
      RETURNING status, parked_audit->>'qc_evidence_mismatch_count' AS mismatch_count`,
    [logId, QC_EVIDENCE_MISMATCH_LIMIT]
  );
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

// A QC verdict can be recorded after the relay row that originally delivered
// the issue to In Review was completed (for example, while this daemon was
// down or by a QC rerun). findAndAdvanceTasks deliberately consumes only
// pending, task-correlated rows, so create that missing row here and let its
// normal QC admission path decide whether the evidence is sufficient.
async function enqueuePassWithoutRelayRows({ dbPool = pool, logger = console } = {}) {
  const client = await dbPool.connect();
  try {
    const result = await client.query(
      `WITH candidates AS (
         SELECT i.id AS issue_id, qc."checker_id", evidence_task.id AS task_id
           FROM issue i
           JOIN relay_stage_config rsc
             ON rsc.workspace_id = i.workspace_id
            AND rsc.stage_name = i.status
           JOIN LATERAL (
             SELECT "checker_id", "verdict", "created_at", "id"
               FROM qc_verdict
              WHERE "issue_id" = i.id
              ORDER BY "created_at" DESC, "id" DESC
              LIMIT 1
           ) qc ON true
           JOIN LATERAL (
             SELECT id
               FROM agent_task_queue
              WHERE issue_id = i.id
                AND agent_id = qc."checker_id"
                AND status = 'completed'
              ORDER BY completed_at DESC, id DESC
              LIMIT 1
          ) evidence_task ON true
          WHERE i.status = 'In Review'
            AND rsc.next_stage = 'CI/CD & Deploy'
            AND qc."verdict" = 'PASS'
            AND qc."created_at" > COALESCE((
              SELECT MAX(created_at) FROM relay_run_log WHERE issue_id = i.id
            ), '-infinity'::timestamptz)
            AND NOT EXISTS (
              SELECT 1 FROM relay_run_log pending
               WHERE pending.issue_id = i.id AND pending.status = 'pending'
            )
          ORDER BY qc."created_at" ASC
          LIMIT 20
       )
       INSERT INTO relay_run_log (issue_id, from_stage, to_stage, agent_id, task_id, status)
       SELECT c.issue_id, 'In Review', 'In Review', c.checker_id, c.task_id, 'pending'
         FROM candidates c
        WHERE NOT EXISTS (
          SELECT 1 FROM relay_run_log pending
           WHERE pending.issue_id = c.issue_id AND pending.status = 'pending'
        )
       RETURNING id, issue_id`
    );
    if (result.rowCount > 0) {
      logger.log(`${LOG_PREFIX} Enqueued ${result.rowCount} PASS verdict(s) missing relay rows`);
    }
    return result.rows;
  } catch (err) {
    logger.error(`${LOG_PREFIX} [pass-sweep] DB error: ${err.message}`);
    return [];
  } finally {
    client.release();
  }
}

async function advanceTick() {
  await enqueuePassWithoutRelayRows();
  await findAndAdvanceTasks();
}

async function findAndAdvanceTasks({ dbPool = pool, postRelay = postToRelay,
  logger = console } = {}) {
  const client = await dbPool.connect();
  const gatedStages = ['CI/CD & Deploy', 'Done', 'Fable QC'];
  try {

    // Correlate strictly on the task that owns the relay log. Advance only
    // genuinely completed tasks; a failed task must never move work forward.
    // No completed_at window: eligibility is the task's terminal state, so a
    // daemon outage delays an advance instead of stranding it forever.
    const query = `SELECT rrl.id AS log_id, atq.id AS task_id, atq.issue_id,
             atq.status AS task_status,
             atq.result AS task_result, atq.error AS task_error,
             atq.agent_id AS task_agent_id, atq.started_at AS task_started_at,
             atq.completed_at AS task_completed_at,
             task_agent.model AS task_agent_model,
             task_agent.thinking_level AS task_agent_effort,
             verdict.checker_id AS qc_verdict_checker_id,
             verdict.verdict AS qc_verdict,
             verdict.work_product_md5 AS qc_verdict_work_product_md5,
             verdict.notes AS qc_verdict_notes,
             verdict.created_at AS qc_verdict_created_at,
             attempt.verdict AS qc_attempt_verdict,
             attempt.work_product_md5 AS qc_attempt_work_product_md5,
             attempt.bound_sha AS qc_attempt_bound_sha,
             attempt.observed_head AS qc_attempt_observed_sha,
             attempt.qualifying AS qc_attempt_qualifying,
             attempt.evidence_task_id AS qc_attempt_evidence_task_id,
             attempt.evidence_agent_id AS qc_attempt_evidence_agent_id,
             attempt.evidence_agent_model AS qc_attempt_evidence_agent_model,
             attempt.evidence_agent_effort AS qc_attempt_evidence_agent_effort,
             evidence.tasks AS qc_evidence_tasks,
             i.workspace_id, i.priority, rrl.to_stage, rsc.next_stage
      FROM agent_task_queue atq
      INNER JOIN relay_run_log rrl ON rrl.task_id = atq.id AND rrl.status = $1
      INNER JOIN issue i ON atq.issue_id = i.id
      LEFT JOIN agent task_agent ON task_agent.id = atq.agent_id
      INNER JOIN relay_stage_config rsc ON rrl.to_stage = rsc.stage_name AND rsc.workspace_id = i.workspace_id
      LEFT JOIN LATERAL (
        SELECT checker_id, verdict, work_product_md5, notes, created_at
          FROM qc_verdict WHERE issue_id = atq.issue_id
         ORDER BY created_at DESC LIMIT 1
      ) verdict ON true
      LEFT JOIN LATERAL (
        SELECT qa.verdict, qa.work_product_md5, qa.bound_sha, qa.observed_head,
               qa.qualifying,
               evidence_task.id AS evidence_task_id,
               evidence_task.agent_id AS evidence_agent_id,
               evidence_agent.model AS evidence_agent_model,
               evidence_agent.thinking_level AS evidence_agent_effort
          FROM qc_attempt qa
          INNER JOIN agent_task_queue evidence_task
                  ON evidence_task.issue_id = qa.issue_id
                 AND evidence_task.id::text = substring(
                       qa.notes FROM 'relay_task_id=([0-9a-f-]{36})')
          INNER JOIN agent evidence_agent
                  ON evidence_agent.id = evidence_task.agent_id
                 AND evidence_agent.workspace_id = i.workspace_id
         WHERE qa.issue_id = atq.issue_id
           AND evidence_task.agent_id = verdict.checker_id
           AND qa.work_product_md5 = verdict.work_product_md5
         ORDER BY qa.created_at DESC LIMIT 1
      ) attempt ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'task_id', evidence_task.id,
                 'task_status', evidence_task.status,
                 'task_result', evidence_task.result,
                 'task_agent_id', evidence_task.agent_id,
                 'task_agent_model', evidence_agent.model,
                 'task_agent_effort', evidence_agent.thinking_level,
                 'task_started_at', evidence_task.started_at,
                 'task_completed_at', evidence_task.completed_at
               ) ORDER BY evidence_task.completed_at DESC) AS tasks
          FROM agent_task_queue evidence_task
          INNER JOIN agent evidence_agent
                  ON evidence_agent.id = evidence_task.agent_id
                 AND evidence_agent.workspace_id = i.workspace_id
         WHERE evidence_task.issue_id = atq.issue_id
           AND evidence_task.agent_id = verdict.checker_id
           AND evidence_task.status = 'completed'
           AND COALESCE(evidence_agent.model,
                        evidence_agent.runtime_config->>'model') = 'gpt-5.6-sol'
           AND COALESCE(evidence_agent.thinking_level,
                        evidence_agent.runtime_config->>'reasoning_effort') = 'low'
      ) evidence ON true
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
      logger.log(`${LOG_PREFIX} Closed ${failed.rowCount} relay log(s) whose task failed/cancelled; NOT advanced`);
    }

    if (result.rows.length === 0) return;

    logger.log(`${LOG_PREFIX} Found ${result.rows.length} tasks ready to advance`);

    for (const row of result.rows) {
      try {
        // A completed terminal arrival is a final ledger entry, not an exit
        // trigger. This also neutralizes old rows created before the bridge
        // stopped terminal-stage dispatch.
        if (TERMINAL_STAGES.has(row.to_stage)) {
          await markRelayLogCompletedById(client, row.log_id);
          logger.log(`${LOG_PREFIX} TERMINAL: issue=${row.issue_id}, stage='${row.to_stage}', relay=${row.log_id}`);
          continue;
        }
        const completion = completionAdmission(row.task_result ??
          (row.task_error ? { error: row.task_error } : null));
        if (!completion.ok) {
          // Process exit 0 is not a work-product guarantee. A completed task
          // carrying an explicit blocker/FAIL (or no result at all) must not
          // buy another same-lane attempt. The bridge changes hands to re-spec.
          const escalation = await requestRetryEscalation(row, completion.reason);
          logger.log(`${LOG_PREFIX} [completion-admission] RESPEC: issue=${row.issue_id}, stage='${row.to_stage}', reason=${completion.reason}, relay=${escalation.status}`);
          await markRelayLogFailedById(client, row.log_id);
          continue;
        }
        // A QC worker records its verdict before its own execution row becomes
        // terminal. The bridge correctly defers its in-task advance, so replay
        // that exact handoff here only after completion and only when the same
        // Sol-low task carries a SHA-bound PASS plus the current artifact MD5.
        const qcAdvance = qcCompletionAdvance(row);
        if (gatedStages.includes(row.next_stage) && !qcAdvance.ok) {
          if (qcAdvance.reason === 'qc_work_product_md5_required') {
            logger.log(`${LOG_PREFIX} PENDING: issue=${row.issue_id}, reason=pass_without_md5`);
            continue;
          }
          if (qcAdvance.reason === 'qc_attempt_mismatch' ||
              qcAdvance.reason === 'legacy_qc_evidence_mismatch') {
            const held = await holdQcEvidenceMismatch(client, row.log_id);
            const state = held.rows[0];
            logger.log(`${LOG_PREFIX} QC evidence mismatch: issue=${row.issue_id}, ` +
              `relay=${row.log_id}, attempt=${state?.mismatch_count || 'unknown'}, ` +
              `status=${state?.status || 'unknown'}`);
          }
          logger.log(`${LOG_PREFIX} PENDING: issue=${row.issue_id}, to_stage='${row.to_stage}', reason=${qcAdvance.reason}`);
          continue;
        }

        if (qcAdvance.ok) {
          const currentWorkProductMd5 = await currentPassWorkProductMD5(client, row.issue_id);
          if (!currentWorkProductMd5) {
            logger.log(`${LOG_PREFIX} PENDING: issue=${row.issue_id}, reason=pass_without_md5`);
            continue;
          }
          if (currentWorkProductMd5.toLowerCase() !== qcAdvance.workProductMd5) {
            logger.log(`${LOG_PREFIX} PENDING: issue=${row.issue_id}, reason=stale_pass_md5_mismatch`);
            continue;
          }
        }

        const payload = { issue_id: row.issue_id, to_stage: row.next_stage,
          agent_token: RELAY_AGENT_SECRET,
          relay_source_task_id: qcAdvance.evidenceTaskId || row.task_id,
          ...(qcAdvance.ok ? { current_work_product_md5: qcAdvance.workProductMd5 } : {}) };
        const response = await postRelay(payload);

        if (response.ok) {
          const proof = qcAdvance.ok ? ` sha=${qcAdvance.boundSha} md5=${qcAdvance.workProductMd5}` : '';
          logger.log(`${LOG_PREFIX} Advanced ${row.issue_id} '${row.to_stage}' → '${row.next_stage}' (task-correlated log ${row.log_id})${proof}`);
          await markRelayLogCompletedById(client, row.log_id);
        } else if (response.deferred) {
          // Preserve the task-correlated pending log. The same advance becomes
          // eligible once the predecessor is terminal; recording failure here
          // would strand it permanently.
          logger.log(`${LOG_PREFIX} DEFERRED: ${row.issue_id} reason=${response.error || 'prior_execution_active'}`);
        } else {
          // The relay's own error text was parsed and then discarded, so 76 of every
          // 400 log lines were a bare `status 409` with no cause. Print the reason.
          logger.log(`${LOG_PREFIX} Failed: ${row.issue_id} status ${response.status}${response.error ? ` reason=${response.error}` : ''}`);
          await markRelayLogFailedById(client, row.log_id);
        }
      } catch (err) {
        logger.error(`${LOG_PREFIX} Error: ${err.message}`);
        await markRelayLogFailedById(client, row.log_id);
      }
    }
  } catch (err) {
    logger.error(`${LOG_PREFIX} DB error: ${err.message}`);
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
    const query = `SELECT DISTINCT atq.id AS task_id, atq.issue_id,
             atq.status as task_status,
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
          const escalation = await requestRetryEscalation(row, completion.reason);
          console.log(`${LOG_PREFIX} [recovery] RESPEC: issue=${row.issue_id}, reason=${completion.reason}, relay=${escalation.status}`);
          await markRelayLogFailed(client, row.issue_id);
          continue;
        }
        // Check if next stage is gated; skip auto-advance if it is
        if (gatedStages.includes(row.next_stage)) {
          console.log(`${LOG_PREFIX} [recovery] SKIPPED: issue=${row.issue_id}, from_stage='${row.to_stage}', to_stage='${row.next_stage}', reason=gated stage requires manual approval`);
          await markRelayLogCompleted(client, row.issue_id);
          continue;
        }

        const payload = { issue_id: row.issue_id, to_stage: row.next_stage,
          agent_token: RELAY_AGENT_SECRET, relay_source_task_id: row.task_id };
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
            status: res.statusCode, error: parsed.error, body: data });
        } catch { resolve({ ok: res.statusCode === 200, deferred: res.statusCode === 202,
          status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}

function requestRetryEscalation(row, reason) {
  const taskId = row.task_id || row.dead_task_id;
  const triggerStage = row.to_stage || row.stage;
  return postToRelay({
    issue_id: row.issue_id,
    to_stage: 'Spec',
    agent_token: RELAY_AGENT_SECRET,
    reason: `retry_escalation:${reason}`,
    retry_escalation_task_id: taskId,
    retry_escalation_stage: triggerStage
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
async function requeueStrandedTasks({ dbPool = pool } = {}) {
  const client = await dbPool.connect();
  try {
    const candidates = await client.query(
      `SELECT i.id AS issue_id, i.workspace_id, i.number, i.priority, i.status AS stage,
              i.created_at AS issue_created_at, i.metadata,
              t.id AS dead_task_id, t.status AS dead_task_status,
              t.attempt, t.max_attempts, t.failure_reason,
              t.result AS dead_task_result, t.error AS dead_task_error,
              r.from_stage, r.agent_id, r.runtime_mode, r.instructions,
              r.model, r.thinking_level, r.max_concurrent_tasks, r.runtime_config, r.archived_at, r.agent_name,
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
                  a.name AS agent_name, a.instructions, a.model, a.thinking_level, a.max_concurrent_tasks, a.runtime_config, a.archived_at
             FROM relay_stage_config rsc
             JOIN agent a ON a.id = rsc.agent_id AND a.workspace_id = rsc.workspace_id AND a.archived_at IS NULL
            WHERE rsc.workspace_id = i.workspace_id AND rsc.next_stage = i.status
              AND a.runtime_config->>'quota_paused' IS DISTINCT FROM 'true'
            ORDER BY rsc.id LIMIT 1
         ) r ON true
        WHERE i.status = ANY($2::text[])
          -- t.id IS NULL is the cold start: a ticket that reached this stage
          -- and never had a first task. The lateral above used to be an inner
          -- join, so such a ticket produced no row and was invisible to the
          -- requeue forever -- no agent, no error, no alert. It is not a retry,
          -- so the attempt/max_attempts test cannot apply to it.
          AND (t.id IS NULL OR t.status IN ('failed', 'cancelled'))
          AND NOT EXISTS (
            SELECT 1 FROM agent_task_queue q
             WHERE q.issue_id = i.id AND q.status IN
               ('queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred')
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
        ORDER BY i.created_at ASC
        LIMIT $1::int`,
      [REQUEUE_BATCH, REQUEUE_STAGES]
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
      const compatibility = instructionCompatibility(row.instructions, row.stage);
      if (!compatibility.ok) {
        console.log(`${LOG_PREFIX} [requeue] HELD #${row.number}: agent instructions do not authorize '${compatibility.stage}'`);
        continue;
      }
      const preflight = spendPreflight(row, { provider: row.runtime_provider });
      if (!preflight.ok) {
        console.log(JSON.stringify({ event: 'relay_requeue_held', issue_number: row.number,
          reason: preflight.reason, agent_name: preflight.agent_name,
          agent_id: preflight.agent_id, actual_model: preflight.model,
          actual_effort: preflight.effort, expected_model: preflight.expected_model,
          expected_effort: preflight.expected_effort }));
        continue;
      }
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
      const attempt = coldStart ? 1
        : !infra ? row.attempt + 1
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
          const quotaPause = circuit.pause
            ? await pauseQuotaLane(client, row, circuit.consecutive)
            : null;
          await client.query('COMMIT');
          const moved = await postToRelay({ issue_id: row.issue_id, to_stage: 'Human Review',
            agent_token: RELAY_AGENT_SECRET, reason: 'payment_required_402' });
          if (quotaPause) {
            logQuotaPauseFlip({ agent_name: quotaPause.agent_name,
              timestamp: quotaPause.paused_at, paused: true });
          }
          console.log(`${LOG_PREFIX} [requeue] MONEY-BLOCKED #${row.number}: 402 -> Human Review; relay=${moved.status}; lane_paused=${Boolean(quotaPause)}`);
          continue;
        }
        const releaseAt = row.metadata?.parked_release_at ||
          row.metadata?.retry_escalation_at || null;
        const history = await client.query(
          `SELECT count(*)::int AS n FROM agent_task_queue
            WHERE issue_id = $1 AND context->>'to_stage' = $2
              AND ($3::timestamptz IS NULL OR created_at >= $3)`,
          [row.issue_id, row.stage, releaseAt]
        );
        const cycle = stageCycleAdmission(history.rows[0]?.n || 0, STAGE_CYCLE_LIMIT);
        if (!cycle.ok) {
          await client.query('ROLLBACK');
          const escalation = await requestRetryEscalation(row, cycle.reason);
          console.log(`${LOG_PREFIX} [requeue] RESPEC #${row.number}: ${cycle.reason}; relay=${escalation.status}`);
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
          await client.query('ROLLBACK');
          const escalation = await requestRetryEscalation(row, lifetime.reason);
          console.log(`${LOG_PREFIX} [requeue] RESPEC #${row.number}: ${lifetime.reason}; relay=${escalation.status}`);
          continue;
        }
        const context = JSON.stringify({
          source: coldStart ? 'relay-cold-start'
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

async function recordDiagnosisReleaseFailure(client, taskId, context, failure) {
  const attempts = Number.parseInt(context?.diagnosis_release_attempts || '0', 10) || 0;
  const nextAttempts = attempts + 1;
  const error = String(failure).slice(0, 2000);
  if (nextAttempts >= 5) {
    await client.query(
      `UPDATE agent_task_queue
          SET context = COALESCE(context, '{}'::jsonb) ||
                jsonb_build_object('diagnosis_processed', true,
                  'diagnosis_release_attempts', $2::int,
                  'diagnosis_release_error', $3::text)
        WHERE id = $1::uuid`, [taskId, nextAttempts, error]);
    return;
  }
  await client.query(
    `UPDATE agent_task_queue
        SET context = (COALESCE(context, '{}'::jsonb) - 'diagnosis_processed'
              - 'runtime_evidence_recovery_v2_consumed') ||
            jsonb_build_object('diagnosis_release_attempts', $2::int)
      WHERE id = $1::uuid`, [taskId, nextAttempts]);
}

async function processParkedDiagnoses({ diagnosisPool = pool, relayPost = postToRelay } = {}) {
  const client = await diagnosisPool.connect();
  try {
    const { rows: candidates } = await client.query(
      `SELECT t.id, i.workspace_id
         FROM agent_task_queue t
         JOIN issue i ON i.id = t.issue_id
        WHERE t.status = 'completed'
          AND t.context->>'kind' = $1::text
          AND (
            COALESCE(t.context->>'diagnosis_processed', 'false') <> 'true'
            OR (t.context->>'evidence_correction_retry' = 'true'
                AND COALESCE(t.context->>'diagnosis_processed', 'false') = 'true'
                AND COALESCE(t.context->>'runtime_evidence_recovery_consumed', 'false') <> 'true'
                AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified')
            OR (t.context->>'evidence_correction_retry' = 'true'
                AND COALESCE(t.context->>'diagnosis_processed', 'false') = 'true'
                AND t.context->>'runtime_evidence_recovery_consumed' = 'true'
                AND t.context->>'runtime_evidence_recovery_v2_requested' = 'true'
                AND COALESCE(t.context->>'runtime_evidence_recovery_v2_consumed', 'false') <> 'true'
                AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified')
          )
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
          WHERE t.id = $1::uuid
            AND t.context->>'kind' = $2::text
            AND i.workspace_id = $3::uuid
            AND t.status = 'completed'
            AND (
              COALESCE(t.context->>'diagnosis_processed', 'false') <> 'true'
              OR (t.context->>'evidence_correction_retry' = 'true'
                  AND COALESCE(t.context->>'diagnosis_processed', 'false') = 'true'
                  AND COALESCE(t.context->>'runtime_evidence_recovery_consumed', 'false') <> 'true'
                  AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified')
              OR (t.context->>'evidence_correction_retry' = 'true'
                  AND COALESCE(t.context->>'diagnosis_processed', 'false') = 'true'
                  AND t.context->>'runtime_evidence_recovery_consumed' = 'true'
                  AND t.context->>'runtime_evidence_recovery_v2_requested' = 'true'
                  AND COALESCE(t.context->>'runtime_evidence_recovery_v2_consumed', 'false') <> 'true'
                  AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified')
            )
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
      const completionMD5 = outcome === 'already_fixed' && evidenceVerified
        ? await currentPassWorkProductMD5(client, task.issue_id) : null;
      const invalidAlreadyFixed = outcome === 'already_fixed' && !evidenceVerified;
      const needsQC = outcome === 'already_fixed' && evidenceVerified && !completionMD5;
      const invalidBlocked = outcome === 'genuinely_blocked' && !blocker;
      const duplicate = text.match(/duplicate[_ ](?:of|issue)\s*[:#]?\s*([0-9a-f-]{8,}|\d+)/i)?.[1] || null;
      let duplicateIssueId = null;
      if (outcome === 'duplicate' && duplicate) {
        const target = await client.query(
          `SELECT id FROM issue
            WHERE workspace_id = $1::uuid AND id <> $2::uuid
              AND status NOT IN ('Cancelled', 'Archived')
              AND (id::text = $3::text OR number::text = $3::text)
            ORDER BY (status = 'Done') DESC, updated_at DESC
            LIMIT 1`, [task.workspace_id, task.issue_id, duplicate]);
        duplicateIssueId = target.rows[0]?.id || null;
      }
      const invalidDuplicate = outcome === 'duplicate' && !duplicateIssueId;
      const hasSpec = outcome === 'fixable' ? await hasBindingSpec(client, task.issue_id) : true;
      const action = diagnosisOutcomeAction({ outcome, evidenceVerified: Boolean(completionMD5), duplicateIssueId,
        blocker, missingOutcome, invalidAlreadyFixed, invalidDuplicate, hasBindingSpec: hasSpec, needsQC });
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
             WHERE id = $1::uuid AND status = 'Parked'`, [task.issue_id]);
      } else if (action.action === 'close' && action.status === 'Cancelled') {
        await client.query(
          `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('duplicate_of', $2::uuid),
                  updated_at = NOW()
             WHERE id = $1::uuid AND status = 'Parked'`, [task.issue_id, duplicateIssueId]);
      } else if (action.action === 'close' && action.status === 'Done') {
        // Done is owned by the relay's terminal authority below. Do not write
        // issue metadata as a proxy for a terminal transition.
      } else {
        await client.query(
          `UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                    jsonb_build_object('parked_blocker', $2::text),
                  updated_at = NOW()
             WHERE id = $1::uuid AND status = 'Parked'`, [task.issue_id,
            action.blocker]);
      }
      await client.query(
        `UPDATE agent_task_queue
            SET context = COALESCE(context, '{}'::jsonb) ||
                  CASE WHEN context->>'evidence_correction_retry' = 'true'
                       AND context->>'diagnosis_processed' = 'true'
                       AND context->>'runtime_evidence_recovery_consumed' = 'true'
                       AND context->>'runtime_evidence_recovery_v2_requested' = 'true'
                    THEN '{"runtime_evidence_recovery_v2_consumed":true}'::jsonb
                  WHEN context->>'evidence_correction_retry' = 'true'
                       AND context->>'diagnosis_processed' = 'true'
                    THEN '{"runtime_evidence_recovery_consumed":true}'::jsonb
                    ELSE '{"diagnosis_processed":true}'::jsonb END
          WHERE id = $1::uuid`, [task.id]);
      await client.query('COMMIT');
      const nextStage = action.action === 'release' ? action.nextStage
        : action.action === 'close' ? action.status : null;
      if (nextStage) {
        try {
          const response = await relayPost({ issue_id: task.issue_id, to_stage: nextStage,
            agent_token: RELAY_AGENT_SECRET,
            ...(completionMD5 ? { current_work_product_md5: completionMD5 } : {}),
            ...(needsQC ? { reason: `runtime_evidence_verified:${evidence}` } : {}) });
          if (!response.ok) {
            await recordDiagnosisReleaseFailure(client, task.id, task.context,
              `status=${response.status}; body=${response.body || response.error || ''}`);
          }
          console.log(`${LOG_PREFIX} [diagnosis] #${task.number}: ${outcome} -> ${nextStage}; relay=${response.status}`);
        } catch (err) {
          await recordDiagnosisReleaseFailure(client, task.id, task.context,
            `fetch_error=${err.message}`);
          console.error(`${LOG_PREFIX} [diagnosis] #${task.number}: relay error: ${err.message}`);
        }
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

function startDaemon() {
  if (!MULTICA_DB || !RELAY_AGENT_SECRET || !WORKSPACE_ID) {
    console.error('[relay-advance-daemon] FATAL: env vars missing');
    process.exit(1);
  }
  console.log(`${LOG_PREFIX} Starting (15s interval, recovery every 2m, cleanup every 5m)`);
  setInterval(advanceTick, 15000);
  setInterval(findAndAdvanceRegistered, 20000);
  setInterval(recoveryAdvanceTasks, 120000);
  setInterval(cleanupStalePendingRows, 300000);
  setInterval(requeueStrandedTasks, 60000);
  setInterval(processParkedDiagnoses, 30000);
  setInterval(reconcileQuotaPauses, 60000);
  advanceTick().catch(err => console.error(`${LOG_PREFIX} Error: ${err.message}`));
  findAndAdvanceRegistered().catch(err => console.error(`${LOG_PREFIX} Error in Registered pass: ${err.message}`));
  cleanupStalePendingRows().catch(err => console.error(`${LOG_PREFIX} Error in cleanup: ${err.message}`));
  processParkedDiagnoses().catch(err => console.error(`${LOG_PREFIX} Error in parked diagnosis pass: ${err.message}`));
  reconcileQuotaPauses().catch(err => console.error(`${LOG_PREFIX} Error in quota-pause reconciliation: ${err.message}`));
}

if (require.main === module) startDaemon();

module.exports = { advanceTick, enqueuePassWithoutRelayRows, findAndAdvanceTasks, pauseQuotaLane, qcCompletionAdvance,
  reconcileQuotaPauses, processParkedDiagnoses, requeueStrandedTasks, startDaemon };
