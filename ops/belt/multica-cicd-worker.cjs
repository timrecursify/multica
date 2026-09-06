#!/usr/bin/env node
// multica-cicd-worker — the consumer of the CI/CD & Deploy stage.
//
// Nothing owned this stage, so tickets whose PR had already merged sat in it
// forever and Done stayed flat while the belt kept running. This worker closes
// the loop: it reads each ticket's work product, finds its PR, and finishes the
// ticket when the PR is merged, merges it when CI is green, or returns it to
// build with the exact blocking reason when deploy cannot finish.
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const { evaluate } = require('./transition-policy.cjs');
const { createWatchdog, SENTINEL_MS, RETRY_LIMIT } = require('./cicd-watchdog.cjs');
const { mintGithubToken, repoFromGhArgs } = require('./github-token.cjs');
const RECEIPT_ROOT = process.env.MULTICA_RECEIPT_ROOT || '/var/lib/gsp/gsp-multica-runtime/receipts';
let pool;
let relayToken;
let readReceipt = (sha) => JSON.parse(fs.readFileSync(`${RECEIPT_ROOT}/belt-${sha}.json`, 'utf8'));

function initializeRuntime() {
  const { Pool } = require('pg');
  const envPath = process.env.MULTICA_REMOTE_BRIDGE_ENV || '/var/lib/gsp/.secrets/multica-remote/remote-bridge.env';
  const env = fs.readFileSync(envPath, 'utf8');
  relayToken = env.split('\n').find(l => l.startsWith('RELAY_AGENT_SECRET=')).split('=')[1];
  pool = new Pool({ connectionString: env.split('\n').find(l => l.startsWith('DATABASE_URL=')).slice(13).trim() });
}
const POLL_MS = parseInt(process.env.CICD_POLL_MS || '120000', 10);
const CI_FAILURE_POLLS = parseInt(process.env.CICD_FAILURE_POLLS || '3', 10);
const CI_ABSENT_MINUTES = parseInt(process.env.CICD_ABSENT_MINUTES || '20', 10);
const DEPLOY_CANCEL_RETRY_LIMIT = parseInt(process.env.CICD_DEPLOY_CANCEL_RETRY_LIMIT || '3', 10);
const deployCancelRetries = new Map();
// Retroactive CI (Tim 2026-09-02 16:16Z: admin merge + admin deploy with
// retroactive CI/CD for speed; risk paths still wait). Repos listed here merge
// a mergeable PR while its CI is still pending unless the diff touches a risk
// path; main CI validates after the merge.
const RETRO_REPOS = new Set((process.env.CICD_RETROACTIVE_REPOS || '').split(',').map(s => s.trim()).filter(Boolean));
const RISK_PATH = /(^|\/)(migrations?|drizzle)\/|\.env|secret|credential|auth|billing\/.*flag|feature-flag|\.github\/workflows\//i;
function retroactiveEligible(repo, num) {
  if (!RETRO_REPOS.has(repo)) return { ok: false, why: 'repo not retroactive' };
  try {
    const files = JSON.parse(gh(['api', `repos/${repo}/pulls/${num}/files?per_page=100`]));
    const risky = files.map(f => f.filename).filter(f => RISK_PATH.test(f));
    if (risky.length) return { ok: false, why: `risk path ${risky[0]}` };
    return { ok: true, why: `${files.length} files, no risk path` };
  } catch (e) { return { ok: false, why: `files lookup failed: ${String(e.message).split('\n')[0].slice(0, 80)}` }; }
}
// Merging is the one irreversible action here, so it is opt-in and defaults on
// only for repositories this fleet owns.
const MERGE_ENABLED = process.env.CICD_MERGE_ENABLED !== '0';
const ciFailureCounts = new Map();
let watchdog = createWatchdog({ file: process.env.CICD_WATCHDOG_STATE || `${RECEIPT_ROOT}/cicd-watchdog.json` });

let log = (...a) => console.log(new Date().toISOString(), ...a);

let gh = function github(args) {
  if (ghBackoffUntil > Date.now()) { const e = new Error('GitHub API rate limit backoff'); e.rateLimited = true; throw e; }
  // GraphQL (gh pr view/merge) shares one per-user quota with every operator
  // session and was exhausted at 02:19Z on 2026-09-03; route both through REST.
  if (args[0] === 'pr' && args[1] === 'view' && args[3] === '-R') {
    const raw = execFileSync('gh', ['api', '-i', `repos/${args[4]}/pulls/${args[2]}`], ghOptions(args));
    const pr = JSON.parse(rateLimitBody(raw));
    return JSON.stringify({
      state: pr.merged ? 'MERGED' : String(pr.state || '').toUpperCase(),
      mergeable: pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
      headRefOid: pr.head && pr.head.sha, createdAt: pr.created_at, mergedAt: pr.merged_at,
      mergeCommit: pr.merge_commit_sha && pr.merged ? { oid: pr.merge_commit_sha } : null
    });
  }
  if (args[0] === 'pr' && args[1] === 'merge' && args[3] === '-R') {
    try {
      const raw = execFileSync('gh', ['api', '-i', '-X', 'PUT', `repos/${args[4]}/pulls/${args[2]}/merge`, '-f', 'merge_method=squash'], ghOptions(args));
      return rateLimitBody(raw).trim();
    } catch (e) {
      const text = `${e.stdout || ''}\n${e.stderr || ''}`;
      if (/API rate limit exceeded/i.test(text) || /x-ratelimit-remaining:\s*0/i.test(text)) { ghBackoffUntil = rateLimitReset(text); e.rateLimited = true; }
      throw e;
    }
  }
  try {
    const command = args[0] === 'api' && !args.includes('-i') ? ['api', '-i', ...args.slice(1)] : args;
    const raw = execFileSync('gh', command, ghOptions(args));
    return args[0] === 'api' ? rateLimitBody(raw).trim() : raw.trim();
  } catch (e) {
    const text = `${e.stdout || ''}\n${e.stderr || ''}`;
    if (/API rate limit exceeded/i.test(text) || /x-ratelimit-remaining:\s*0/i.test(text)) {
      ghBackoffUntil = rateLimitReset(text); e.rateLimited = true;
    }
    throw e;
  }
};
function ghOptions(args) { const token = mintGithubToken(repoFromGhArgs(args)); return { encoding: 'utf8', timeout: 90000, maxBuffer: 8e6, ...(token ? { env: { ...process.env, GH_TOKEN: token } } : {}) }; }
let ghBackoffUntil = 0;
function rateLimitReset(raw) {
  const m = raw.match(/x-ratelimit-reset:\s*(\d+)/i); return m ? Number(m[1]) * 1000 : Date.now() + 3600000;
}
function rateLimitBody(raw) {
  const split = raw.split(/\r?\n\r?\n/); const headers = split.slice(0, -1).join('\n');
  if (/x-ratelimit-remaining:\s*0/i.test(headers)) ghBackoffUntil = rateLimitReset(headers);
  return split[split.length - 1];
}

let relay = function relayRequest(issueId, toStage, currentWorkProductMd5, reason, parkedAudit, evidence) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ issue_id: issueId, to_stage: toStage, agent_token: relayToken,
      ...(currentWorkProductMd5 ? { current_work_product_md5: currentWorkProductMd5 } : {}),
      ...(reason ? { reason } : {}),
      ...(parkedAudit ? { parked_audit: parkedAudit } : {}),
      ...(evidence ? { evidence } : {}) });
    const req = http.request('http://127.0.0.1:5005/relay/advance',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 20000 }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} ${d.slice(0,140)}`));
          try { resolve(parseRelayResponse(d, toStage)); }
          catch (error) { reject(error); }
        });
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('relay timeout')); });
    req.write(body); req.end();
  });
};
function parseRelayResponse(raw, toStage) {
  let body;
  try { body = JSON.parse(raw); } catch (_) {
    throw new Error('relay malformed response');
  }
  if (body?.success !== true) {
    throw new Error(`relay rejected ${toStage}: ${body?.error || 'unsuccessful response'}`);
  }
  return body;
}

async function latestVerdict(issueId) {
  const result = await pool.query(
    `SELECT verdict, work_product_md5 FROM qc_verdict
     WHERE issue_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [issueId]);
  return result.rows[0] || null;
}

function receiptFor(sha) {
  try {
    const receipt = readReceipt(sha);
    return receipt?.source_sha === sha && receipt.health === 'ok' && typeof receipt.release === 'string'
      ? receipt : null;
  } catch (_) { return null; }
}

async function humanReview(issue, reason) {
  const evidence = { blocker: reason, namedBlocker: true };
  const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'Human Review', actor: 'operator', evidence });
  if (!verdict.ok) throw new Error(`transition policy rejected Human Review: ${verdict.code}`);
  await relay(issue.id, 'Human Review', null, reason, null, evidence);
  log(`HUMAN REVIEW #${issue.number} — ${reason}`);
}

async function retryEscalation(issue, toStage, reason, evidence = {}) {
  const retryEvidence = { retry_escalation: true, blocker: reason, ...evidence };
  const verdict = evaluate({ from: 'CI/CD & Deploy', to: toStage, actor: 'system', evidence: retryEvidence });
  if (!verdict.ok) throw new Error(`transition policy rejected ${toStage}: ${verdict.code}`);
  await relay(issue.id, toStage, null, reason, null, retryEvidence);
}

async function watchdogFailure(issue, error, sha = '') {
  const row = watchdog.observe(issue.id, { sha, outcome: 'retrying', error });
  // The sentinel is a wall-clock bound independent of poll count. Sparse or
  // failed polls must still produce an auditable human-review hold on time.
  if (watchdog.stalled(row)) {
    const stalled = watchdog.markAlerted(row);
    const detail = `deploy_stalled issue=${issue.id} stage=${row.stage} elapsed_ms=${Date.now() - Date.parse(row.first_seen_at)} last_error=${row.last_error || 'unknown'} correlation_key=${row.correlation_key}`;
    const evidence = { retry_escalation: true, source_sha: sha || null, blocker: detail };
    const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'Spec', actor: 'system', evidence });
    if (!verdict.ok) throw new Error(`transition policy rejected Spec: ${verdict.code}`);
    await relay(issue.id, 'Spec', null, detail, null, evidence);
    log(`ESCALATE #${issue.number} — ${detail}`);
    return { stalled: true, audit: stalled };
  }
  if (!watchdog.retryAllowed(row)) {
    const detail = `deploy_retry_exhausted issue=${issue.id} stage=${row.stage} attempts=${row.attempts} elapsed_ms=${Date.now() - Date.parse(row.first_seen_at)} last_error=${row.last_error || 'unknown'} correlation_key=${row.correlation_key}`;
    log(`TERMINAL #${issue.number} retry limit exhausted before sentinel; escalating correlation_key=${row.correlation_key}`);
    const evidence = { retry_escalation: true, source_sha: sha || null, blocker: detail };
    const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'Spec', actor: 'system', evidence });
    if (!verdict.ok) throw new Error(`transition policy rejected Spec: ${verdict.code}`);
    await relay(issue.id, 'Spec', null, detail, null, evidence);
    log(`ESCALATE #${issue.number} — ${detail}`);
    return { stalled: true, audit: row };
  }
  log(`RETRY #${issue.number} attempt=${row.attempts}/${RETRY_LIMIT} backoff_ms=${watchdog.backoffMs(row)} correlation_key=${row.correlation_key}`);
  return { stalled: false, audit: row };
}

function receiptEvidence(sha) {
  try {
    const receipt = readReceipt(sha);
    if (receipt?.source_sha === sha && receipt.health === 'ok' && typeof receipt.release === 'string') {
      return { receipt, mismatch: false };
    }
    return { receipt, mismatch: true };
  } catch (_) { return { receipt: null, mismatch: false }; }
}

function receiptSummary(receipt) {
  if (!receipt || typeof receipt !== 'object') return { present: false };
  return {
    present: true,
    source_sha: typeof receipt.source_sha === 'string' ? receipt.source_sha : null,
    release: typeof receipt.release === 'string' ? receipt.release : null,
    health: typeof receipt.health === 'string' ? receipt.health : null
  };
}

function deployWorkflowNames(repo, sha) {
  try {
    return JSON.parse(gh(['api', `repos/${repo}/contents/.github/workflows?ref=${sha}`]))
      .map(entry => entry.name).filter(name => /^deploy-.*\.ya?ml$/i.test(name));
  } catch (_) { return []; }
}

function noWorkflowCi(repo, sha) {
  try {
    const workflows = JSON.parse(gh(['api', `repos/${repo}/contents/.github/workflows`]));
    const suites = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/check-suites`]));
    return workflows.length === 0 && (suites.check_suites || []).length === 0;
  } catch (_) { return false; }
}

function successfulDeployRun(repo, sha, workflow) {
  try {
    const runs = JSON.parse(gh(['run', 'list', '--repo', repo, '--commit', sha, '--workflow', workflow,
      '--status', 'success', '--json', 'databaseId,conclusion,name,event,path']));
    const run = runs.find(candidate => candidate.conclusion === 'success'
      && (candidate.event === undefined || candidate.event === 'workflow_dispatch'));
    return run ? { kind: 'github_deploy_run', sha, workflow, run } : null;
  } catch (_) { return null; }
}

// GitHub creates a workflow run within seconds of a push, so a merge whose
// deploy workflows produced no run at all matched none of their `on.push.paths`
// filters: it deploys nothing and is already finished. That is the same
// conclusion this function draws for a repository with no deploy workflows.
// Demanding a successful deploy run regardless held 11 tickets in CI/CD & Deploy
// indefinitely (2026-09-03; gsp#1149 merged timrecursify/ppp@0df2727ec36c, which
// touched only docs/ and tests/, so none of ppp's 18 deploy-*.yml ever ran).
// The grace window keeps a just-merged sha pending until GitHub has created its
// runs, so a real deploy is never mistaken for an absent one.
// Upstream: timrecursify/multica PR #422.
const DEPLOY_TRIGGER_GRACE_MINUTES = parseInt(process.env.CICD_DEPLOY_TRIGGER_GRACE_MINUTES || '10', 10);

function noDeployRunTriggered(repo, sha, mergedAt, now = Date.now()) {
  const ageMinutes = (now - Date.parse(mergedAt || '')) / 60000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < DEPLOY_TRIGGER_GRACE_MINUTES) return false;
  try {
    const runs = JSON.parse(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`]));
    return !(runs.workflow_runs || []).some(r => /(^|\/)deploy-[^/]*\.ya?ml$/i.test(r.path || '')
      && (r.event === undefined || r.event === 'workflow_dispatch'));
  } catch (_) { return false; }
}

// A deploy workflow run that has reached a terminal, non-success conclusion
// never becomes successful on its own, so treating it as "still pending" pins
// the ticket in CI/CD & Deploy forever with no escalation path. Measured
// 2026-09-04: 23 of the 24 tickets held on `deploy run pending` had only
// failed/cancelled deploy runs, the oldest stuck 23h. Report the terminal
// failure so routeFinishedPR returns the ticket to build instead of holding
// it silently. A run still queued/in_progress (conclusion null), or any
// success, keeps the old pending behaviour.
const TERMINAL_DEPLOY_CONCLUSIONS = new Set([
  'failure', 'timed_out', 'startup_failure', 'stale', 'action_required',
]);

function laterSuccessfulDeploy(repo, cancelled, sourceSha) {
  try {
    const runs = JSON.parse(gh(['api', `repos/${repo}/actions/runs?status=success&per_page=100`]))
      .workflow_runs || [];
    const later = runs.filter(run => run.path === cancelled.path && run.conclusion === 'success'
      && String(run.created_at || '') > String(cancelled.created_at || '')
      && /^[0-9a-f]{40}$/i.test(run.head_sha || ''))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    for (const run of later) {
      const comparison = JSON.parse(gh(['api', `repos/${repo}/compare/${sourceSha}...${run.head_sha}`]));
      if (comparison.status === 'ahead' || comparison.status === 'identical') return run;
    }
  } catch (_) { /* REST errors conservatively leave the cancellation unresolved. */ }
  return null;
}

function terminalDeployEvaluation(repo, sha) {
  try {
    const runs = JSON.parse(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`]))
      .workflow_runs || [];
    const deployRuns = runs.filter(r => /(^|\/)deploy-[^/]*\.ya?ml$/i.test(r.path || '')
      && (r.event === undefined || r.event === 'workflow_dispatch'));
    if (!deployRuns.length) return null;
    const attempted = [];
    const failedGates = [];
    for (const run of deployRuns) {
      let jobs = null;
      try {
        if (run.id || run.database_id) {
          const payload = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${run.id || run.database_id}/jobs?per_page=100`]));
          jobs = payload.jobs || [];
        }
      } catch (_) { jobs = null; }
      if (Array.isArray(jobs) && jobs.length === 0) continue;
      if (Array.isArray(jobs)) {
        const deployJob = jobs.find(job => /^(?:deploy\b)|\/\s*deploy\b/i.test(job.name || job.id || ''));
        const failed = jobs.filter(job => job !== deployJob && job.conclusion === 'failure');
        if (deployJob?.conclusion === 'skipped' && failed.length) {
          failedGates.push(...failed.map(job => job.name || job.id || 'unknown gate'));
          continue;
        }
      }
      attempted.push(run);
    }
    if (failedGates.length) {
      return { failed: [...new Set(failedGates)].sort().map(name =>
        `blocked_on=ci failing_gate=${name}`).join(', ') };
    }
    if (!attempted.length) return { noAttempt: true };
    const superseded = attempted.filter(run => run.conclusion === 'cancelled'
      && laterSuccessfulDeploy(repo, run, sha));
    const unresolved = attempted.filter(run => !superseded.includes(run));
    if (unresolved.some(run => run.conclusion !== 'cancelled' && !TERMINAL_DEPLOY_CONCLUSIONS.has(run.conclusion))) return null;
    if (unresolved.length) {
      const cancelled = unresolved.filter(run => run.conclusion === 'cancelled');
      const failed = unresolved.filter(run => run.conclusion !== 'cancelled');
      return {
        ...(failed.length ? { failed: [...new Set(failed.map(r =>
          `${(r.path || '').replace(/^.*\//, '')}=${r.conclusion}`))].sort().join(', ') } : {}),
        ...(cancelled.length ? { cancelled: [...new Set(cancelled.map(r =>
          `${(r.path || '').replace(/^.*\//, '')}=cancelled`))].sort().join(', ') } : {}),
        ...(cancelled.length ? { cancelledRuns: cancelled } : {}),
        superseded
      };
    }
    return superseded.length ? { superseded } : null;
  } catch (_) { return null; }
}

async function retriggerCancelledDeploys(issue, repo, sha, cancelledRuns) {
  const workflows = [...new Set((cancelledRuns || []).map(run => run.path).filter(Boolean))];
  let dispatched = 0;
  for (const workflowPath of workflows) {
    const workflow = workflowPath.replace(/^.*\//, '');
    const key = `${issue.id}:${sha}:${workflow}`;
    let attempts = deployCancelRetries.get(key);
    if (attempts === undefined) {
      try {
        const row = (await pool?.query('SELECT metadata FROM issue WHERE id=$1', [issue.id]))?.rows?.[0];
        attempts = Number(row?.metadata?.deploy_cancel_retries?.[key]) || 0;
      } catch (_) { attempts = 0; }
      deployCancelRetries.set(key, attempts);
    }
    if (attempts >= DEPLOY_CANCEL_RETRY_LIMIT) {
      log(`DEPLOY-CANCEL-CAP #${issue.number} ${sha} workflow=${workflow} attempts=${attempts}`);
      continue;
    }
    try {
      const run = (cancelledRuns || []).find(candidate => candidate.path === workflowPath);
      const runId = run?.id || run?.database_id;
      if (!runId) throw new Error('cancelled deploy run has no id');
      // Rerun the cancelled run itself. workflow_dispatch --ref accepts only a
      // branch or tag, not the merge commit SHA, and would therefore fail.
      gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/rerun`]);
      deployCancelRetries.set(key, attempts + 1);
      dispatched += 1;
      try { await pool?.query("update issue SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deploy_cancel_retries', COALESCE(metadata->'deploy_cancel_retries', '{}'::jsonb) || jsonb_build_object($2, $3::int)) WHERE id=$1", [issue.id, key, attempts + 1]); } catch (_) { /* degraded/test DB */ }
      log(`DEPLOY-RETRIGGER #${issue.number} ${sha} workflow=${workflow} attempt=${attempts + 1}/${DEPLOY_CANCEL_RETRY_LIMIT}`);
    } catch (e) {
      const nextAttempts = attempts + 1;
      deployCancelRetries.set(key, nextAttempts);
      try { await pool?.query("update issue SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deploy_cancel_retries', COALESCE(metadata->'deploy_cancel_retries', '{}'::jsonb) || jsonb_build_object($2, $3::int)) WHERE id=$1", [issue.id, key, nextAttempts]); } catch (_) { /* degraded/test DB */ }
      log(`DEPLOY-RETRIGGER-FAIL #${issue.number} ${sha} workflow=${workflow} ${String(e.message).split('\n')[0]}`);
    }
  }
  return { dispatched, capped: workflows.filter(path => (deployCancelRetries.get(`${issue.id}:${sha}:${path.replace(/^.*\//, '')}`) || 0) >= DEPLOY_CANCEL_RETRY_LIMIT).length };
}

function terminalFailedDeployRuns(repo, sha) {
  return terminalDeployEvaluation(repo, sha)?.failed || null;
}

function mergeDeployEvidence(repo, sha, mergedAt) {
  const receipt = receiptEvidence(sha);
  if (receipt.mismatch) return { mismatch: true, receipt: receipt.receipt };
  if (receipt.receipt) return { evidence: receipt.receipt };
  const workflows = deployWorkflowNames(repo, sha);
  if (!workflows.length) return { evidence: { kind: 'merge_is_deploy', sha } };
  for (const workflow of workflows) {
    const run = successfulDeployRun(repo, sha, workflow);
    if (run) return { evidence: run };
  }
  if (noDeployRunTriggered(repo, sha, mergedAt)) {
    return { evidence: { kind: 'merge_is_deploy', sha, noDeployWorkflowTriggered: true } };
  }
  const terminal = terminalDeployEvaluation(repo, sha);
  if (terminal?.noAttempt) {
    return { evidence: { kind: 'github_deploy_run_no_attempt', sha } };
  }
  if (terminal?.failed) return { failed: terminal.failed };
  if (terminal?.cancelled) return { cancelled: terminal.cancelled, cancelledRuns: terminal.cancelledRuns };
  if (terminal?.superseded?.length) {
    return { evidence: { kind: 'github_deploy_run_superseded', sha,
      superseded: terminal.superseded.map(run => ({ workflow: run.path, run: run.id || run.database_id })) } };
  }
  return { pending: true };
}

async function routeFinishedPR(issue, note, mergedSha, pr = {}) {
  const latest = await latestVerdict(issue.id);
  let ci = ciState(pr.repo, pr.headSha || mergedSha, pr.createdAt);
  if (ci === 'absent' && noWorkflowCi(pr.repo, pr.headSha || mergedSha)) {
    ci = 'green';
    log(`CI N/A #${issue.number} ${pr.repo} has no workflows or check suites`);
  }
  // A merge may have been authorized retroactively while CI was still queued.
  // Re-check that authorization here, then continue to the deploy-evidence
  // gate; CI queue state alone must not strand an already deployed ticket.
  const retro = (ci === 'pending' || ci === 'no_checks' || ci === 'cancelled_only') && pr.num != null
    ? retroactiveEligible(pr.repo, pr.num) : null;
  // A merged PR with no checks or only cancelled checks is already terminal:
  // retroactive eligibility authorizes a merge, but cannot veto one that
  // happened. Keep the risk-path veto for pending, pre-merge authorization.
  const terminalMergedCi = ci === 'no_checks' || ci === 'cancelled_only';
  const retroactiveMerge = terminalMergedCi || Boolean(retro?.ok);
  if (ci !== 'green' && !retroactiveMerge) {
    if (ci === 'absent' || ['red', 'mixed'].includes(ci)) {
      await returnIssueToBuild(issue, `${note}; merged head CI is ${ci}`);
    } else log(`HOLD #${issue.number} merged ${pr.repo || 'PR'} ci=${ci}${retro?.why ? ` retro=${retro.why}` : ''}`);
    return { status: 'returned' };
  }
  if (latest && latest.verdict !== 'PASS') {
    await returnIssueToBuild(issue, `${note}; latest QC PASS evidence is absent`);
    return { status: 'returned' };
  }
  const deploy = mergeDeployEvidence(pr.repo, mergedSha, pr.mergedAt);
  if (deploy.mismatch) {
    const reason = `retry_escalation:release_receipt_mismatch issue=${issue.id} merged_sha=${mergedSha}`;
    await retryEscalation(issue, 'Parked', reason, {
      anomaly: 'release_receipt_mismatch', merged_sha: mergedSha,
      receipt: receiptSummary(deploy.receipt)
    });
    return { status: 'returned' };
  }
  if (deploy.failed) {
    await returnIssueToBuild(issue, `${note}; deploy run failed for ${mergedSha} (${deploy.failed})`);
    return { status: 'returned' };
  }
  if (deploy.cancelled) {
    const retry = await retriggerCancelledDeploys(issue, pr.repo, mergedSha, deploy.cancelledRuns);
    if (!retry.dispatched && retry.capped) {
      await returnIssueToBuild(issue, `${note}; deploy cancelled retry cap reached for ${mergedSha} (${deploy.cancelled})`);
      return { status: 'returned', sha: mergedSha };
    }
    log(`DEPLOY-CANCELLED #${issue.number} ${mergedSha} (${deploy.cancelled}); deploy was cancelled and is undeployed`);
    return { status: 'pending', sha: mergedSha };
  }
  if (deploy.pending) { log(`HOLD #${issue.number} deploy run pending for ${mergedSha}`); return { status: 'pending', sha: mergedSha }; }
  const noVerdict = !latest;
  const reviewedSha = noVerdict ? mergedSha : latest.bound_sha || mergedSha;
  const evidence = { ciSuccess: retroactiveMerge ? 'retroactive' : true,
    ...(retroactiveMerge ? { retroactiveMerge: true } : {}),
    mergeDeployReceipt: deploy.evidence, reviewedSha,
    qualifyingPass: !noVerdict, ...(noVerdict ? { noVerdict: true } : {}) };
  const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'Done', actor: 'system', evidence });
  if (!verdict.ok) throw new Error(`transition policy rejected Done: ${verdict.code}`);
  await relay(issue.id, 'Done', latest?.work_product_md5 || null, null, null, evidence);
  log(noVerdict ? `NO-VERDICT #${issue.number} accepted merged+green sha=${mergedSha}` :
    `DONE #${issue.number} — ${note}`);
  return { status: 'done', sha: mergedSha };
}

async function closureWatchdog(issue, result, sha) {
  if (!result || result.status !== 'pending') return false;
  const row = watchdog.observe(issue.id, { sha, outcome: 'closure_pending' });
  if (!watchdog.stalled(row)) return false;
  const alerted = watchdog.markAlerted(row, 'closure_stalled');
  const elapsed = Date.now() - Date.parse(row.first_seen_at);
  const reason = `retry_escalation:closure_stalled issue=${issue.id} stage=${row.stage} elapsed_ms=${elapsed} last_error=${row.last_error || 'deploy pending'} correlation_key=${row.correlation_key}`;
  await retryEscalation(issue, 'Spec', reason, {
    trigger_reason: 'closure_stalled', stage: row.stage, elapsed_ms: elapsed,
    last_error: row.last_error || 'deploy pending', correlation_key: row.correlation_key
  });
  return Boolean(alerted);
}

async function escalateCi(issue, pr, ci) {
  await returnToBuild(issue, pr, `ci=${ci} for ${CI_FAILURE_POLLS} consecutive polls`);
}

async function returnIssueToBuild(issue, reason) {
  const recorded = await recordReturn(issue, reason);
  if (recorded.count >= 3) {
    if (recorded.firstEscalation) {
      const detail = `return_loop issue=${issue.id} reason=${normalizeReturnReason(reason)} count=${recorded.count}`;
      const sourceSha = issue.source_sha || (String(reason).match(/[0-9a-f]{40}/i) || [])[0] || null;
      const evidence = { retry_escalation: true, source_sha: sourceSha, blocker: detail };
      const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'Parked', actor: 'system', evidence });
      if (!verdict.ok) throw new Error(`transition policy rejected Parked: ${verdict.code}`);
      await relay(issue.id, 'Parked', null, detail, { trigger: 'cicd_return_loop', intendedStage: 'Queue', attempts: recorded.count, reason: detail, source_sha: sourceSha }, evidence);
      log(`HOLD #${issue.number} return loop escalated reason=${normalizeReturnReason(reason)} count=${recorded.count}`);
    } else log(`HOLD #${issue.number} return loop already escalated reason=${normalizeReturnReason(reason)} count=${recorded.count}`);
    return { escalated: true };
  }
  const evidence = { ciFailureOrAbsent: true, mergeConflictEvidence: reason };
  const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'In Progress', actor: 'system', evidence });
  if (!verdict.ok) throw new Error(`transition policy rejected In Progress: ${verdict.code}`);
  await relay(issue.id, 'In Progress', null, `RETURN:In Progress — ${reason}`, null, evidence);
  noteReturn(issue, reason);
  log(`RETURN #${issue.number} ${reason}`);
}

function normalizeReturnReason(reason) {
  const text = String(reason || '').toLowerCase();
  if (text.includes('cancelled_only')) return 'merged_ci_cancelled_only';
  if (text.includes('deploy run failed')) return 'deploy_failure';
  if (text.includes('merge conflict')) return 'merge_conflict';
  if (text.includes('no ci runs')) return 'ci_absent';
  if (text.includes('ci=')) return 'ci_failure';
  return text.replace(/https?:\/\/\S+/g, 'pr').replace(/\d+/g, '#').slice(0, 120);
}

async function recordReturn(issue, reason) {
  const key = normalizeReturnReason(reason);
  try {
    const result = await pool.query(
      `update issue SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY['return_counts', $2],
        to_jsonb((COALESCE(metadata->'return_counts'->>$2, '0')::int + 1)), true)
       WHERE id=$1 RETURNING metadata`, [issue.id, key]);
    const metadata = result.rows?.[0]?.metadata;
    const count = Number(metadata?.return_counts?.[key]);
    if (Number.isFinite(count) && count > 0) {
      const firstEscalation = count >= 3 && !metadata?.return_escalations?.[key];
      if (firstEscalation) await pool.query(
        `update issue SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY['return_escalations', $2], 'true'::jsonb, true) WHERE id=$1`, [issue.id, key]);
      return { count, firstEscalation };
    }
  } catch (_) { /* tests and degraded DBs retain the in-process guard below */ }
  issue.__returnCounts = issue.__returnCounts || {};
  issue.__returnCounts[key] = (issue.__returnCounts[key] || 0) + 1;
  const count = issue.__returnCounts[key];
  issue.__returnEscalations = issue.__returnEscalations || {};
  const firstEscalation = count >= 3 && !issue.__returnEscalations[key];
  if (firstEscalation) issue.__returnEscalations[key] = true;
  return { count, firstEscalation };
}

// The reconciled build task carries no return reason (context is only
// {kind, source, to_stage}), so a builder re-read the ticket, saw its own PR,
// and reported ADVANCED again in under a minute (GSP-1097, 2026-09-03 05:30Z:
// 70 of 97 rework tasks finished in <3 min with the PR still dirty). The
// reason has to live on the ticket, where the brief is assembled from.
const PPP_WORKSPACE = 'da3c5c5c-a123-4567-b999-c3ed1820da00';
function noteReturn(issue, reason) {
  const board = issue.workspace_id === PPP_WORKSPACE ? 'prod' : 'gsp';
  const body = [`/note CI/CD RETURN: ${reason}.`,
    'Required before this ticket can advance again:',
    '1. git fetch origin; rebase the PR branch onto the PR base branch (master for sk-cli, main elsewhere); resolve every conflict (git merge-tree --write-tree origin/<base> HEAD names the files).',
    '2. Push the rebased branch; confirm GitHub reports the PR mergeable and CI runs on the new head.',
    '3. Report the new head SHA. Reporting ADVANCED with the PR still conflicting or without a fresh CI run returns it here again.'].join('\n');
  try {
    execFileSync('sk', ['multica', 'comment', '--board', board, '--number', String(issue.number), '--body', body],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log(`NOTE-FAIL #${issue.number} ${String(e.message).split('\n')[0].slice(0, 160)}`);
  }
}

async function returnToBuild(issue, pr, reason) {
  const detail = `${pr.repo}#${pr.num} ${reason}`;
  await returnIssueToBuild(issue, detail);
}

function countCiFailure(issue, pr, sha, ci) {
  const key = `${issue.id}:${pr.repo}#${pr.num}:${sha}`;
  // Pending and unknown are not failures: a queued run on a saturated runner
  // pool (ppp: 5 runners, ~20 jobs per PR) must wait, not return the ticket.
  if (!['red', 'mixed'].includes(ci)) {
    ciFailureCounts.delete(key);
    return 0;
  }
  const count = (ciFailureCounts.get(key) || 0) + 1;
  ciFailureCounts.set(key, count);
  return count;
}

// A flight can cite more than one pull request, and taking the first match
// closes it against whichever happened to be mentioned most recently. gsp#83
// cites sk-cli#316 (merged) and sk-cli#498 (open): the single-match read shipped
// it to Done on #316 every poll while belt-config-guard.sh returned it for #498,
// so the two flapped once every five minutes. A flight is finished only when
// EVERY pull request it references is finished.
function findAllPRs(work) {
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;
  let m;
  while ((m = re.exec(work || '')) !== null) {
    const pr = { repo: `${m[1]}/${m[2]}`, num: m[3] };
    const k = `${pr.repo}#${pr.num}`;
    if (!seen.has(k)) { seen.add(k); out.push(pr); }
  }
  return out;
}

function hasBarePRReference(work) {
  return /\bPR\s*#\d+/i.test(work || '');
}

// Green means every completed run on THIS head SHA succeeded. A run list
// filtered by status alone can return a success from an older SHA of the same
// branch, which is how a red PR reads as green.
function ciState(repo, sha, createdAt, now = Date.now()) {
  try {
    const runs = JSON.parse(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=30`]));
    // A run whose name is its file path is GitHub's 'invalid workflow file'
    // marker: it has no jobs and says nothing about this SHA.
    // Cancelled runs (superseded by a newer push, or operator queue trims)
    // say nothing about the SHA either.
    const rawCount = (runs.workflow_runs || []).length;
    runs.workflow_runs = (runs.workflow_runs || []).filter(r => !String(r.name || '').startsWith('.github/') && r.conclusion !== 'cancelled');
    const done = (runs.workflow_runs || []).filter(r => r.status === 'completed');
    // Only cancelled or invalid runs: CI was attempted, treat as not yet checked.
    if (rawCount && !(runs.workflow_runs || []).length) return 'cancelled_only';
    if (!(runs.workflow_runs || []).length) {
      const ageMinutes = (now - Date.parse(createdAt || '')) / 60000;
      return Number.isFinite(ageMinutes) && ageMinutes >= CI_ABSENT_MINUTES ? 'absent' : 'no_checks';
    }
    if ((runs.workflow_runs || []).some(r => r.status !== 'completed')) return 'pending';
    if (!done.length) return 'pending';
    if (done.every(r => r.conclusion === 'success')) return 'green';
    if (done.some(r => r.conclusion === 'failure')) return 'red';
    return 'mixed';
  } catch (e) {
    const errorClass = e?.name || e?.constructor?.name || 'Error';
    const errorMessage = String(e?.message || e).split('\n')[0].slice(0, 160);
    log(`CI-UNKNOWN ${repo}@${sha}: ${errorClass}: ${errorMessage}`);
    return 'unknown';
  }
}


async function sweep() {
  const prCache = new Map();
  const { rows } = await pool.query(
    `SELECT id, number, title, workspace_id, metadata FROM issue WHERE status='CI/CD & Deploy' ORDER BY number`);
  if (!rows.length) { log('[poll] CI/CD & Deploy is empty'); return; }
  log(`[poll] ${rows.length} ticket(s) in CI/CD & Deploy`);
  for (let issueIndex = 0; issueIndex < rows.length; issueIndex++) {
    const issue = rows[issueIndex];
    try {
      watchdog.observe(issue.id);
      // Read the thread, not just its last line. The pull request is announced by
      // whichever comment the builder wrote, and a later note pushes it out of a
      // one-row lookup. Reading one comment closed flights whose pull request was
      // still open, which is the exact failure this stage exists to prevent.
      // Read every comment, including QC ones. A QC verdict frequently carries the
      // pull request it reviewed, and skipping those comments made this stage fall
      // back to an older link: #78 was closed against ppp#8881 while its real pull
      // request, ppp#10474, was open and mergeable in a comment the filter dropped.
      const w = await pool.query(
        `SELECT content FROM comment WHERE issue_id=$1
         ORDER BY created_at DESC LIMIT 40`, [issue.id]);
      const seenPR = new Set();
      const prs = [];
      let hasBarePR = false;
      for (const row of w.rows) {
        const content = row.content || '';
        hasBarePR ||= hasBarePRReference(content);
        for (const cand of findAllPRs(content)) {
          const k = `${cand.repo}#${cand.num}`;
          if (!seenPR.has(k)) { seenPR.add(k); prs.push(cand); }
        }
      }
      if (!prs.length) {
        await returnIssueToBuild(issue, hasBarePR ? 'ambiguous PR reference, no repository' : 'no PR referenced');
        watchdog.clear(issue.id);
        continue;
      }

      // Resolve every referenced PR first, then decide once.
      const states = [];
      for (const cand of prs) {
        const key = `${cand.repo}#${cand.num}`;
        let info = prCache.get(key);
        if (!info) {
          info = JSON.parse(gh(['pr', 'view', cand.num, '-R', cand.repo, '--json', 'state,mergeable,headRefOid,createdAt,mergedAt,mergeCommit']));
          prCache.set(key, info);
        }
        states.push({ pr: cand, info });
      }
      // A closed, unmerged pull request is a dead end only when nothing
      // replaced it. gsp#1577 cited sk-cli#986 (closed) and its replacement
      // #1123 (open, mergeable): returning on #986 sent the builder to rebase
      // #1123 four times in 30 minutes (2026-09-03 06:05Z). A superseded PR is
      // ignored; the ticket returns only when every cited PR is closed.
      const closed = states.filter(s2 => s2.info.state === 'CLOSED');
      const alive = states.filter(s2 => s2.info.state !== 'CLOSED');
      if (closed.length && !alive.length) {
        await returnIssueToBuild(issue, closed.map(s2 => `${s2.pr.repo}#${s2.pr.num} closed without merge`).join(', '));
        continue;
      }
      if (closed.length) {
        log(`SUPERSEDED #${issue.number} ignoring ${closed.map(s2 => `${s2.pr.repo}#${s2.pr.num}`).join(', ')} (closed; ${alive.length} live PR(s) remain)`);
      }
      const openStates = alive.filter(s2 => s2.info.state !== 'MERGED');
      if (!openStates.length) {
        // Several merged PRs finish a ticket when the newest of them is
        // deployed (gsp#1058: four merged sk-cli PRs, returned every poll).
        const merged = alive.filter(s2 => /^[0-9a-f]{40}$/.test(s2.info.mergeCommit?.oid || ''))
          .sort((a, b) => String(b.info.mergedAt || '').localeCompare(String(a.info.mergedAt || '')));
        if (!merged.length) {
          await returnIssueToBuild(issue, 'exactly one merged PR with a full merge SHA is required');
          continue;
        }
        const last = merged[0];
        const result = await routeFinishedPR(issue, merged.length === 1 ? 'merged PR' : `latest of ${merged.length} merged PRs`, last.info.mergeCommit.oid, {
          repo: last.pr.repo, num: last.pr.num, headSha: last.info.headRefOid, createdAt: last.info.createdAt,
          mergedAt: last.info.mergedAt
        });
        if (result?.status === 'pending') await closureWatchdog(issue, result, last.info.mergeCommit.oid);
        else if (result?.status === 'done' || result?.status === 'returned') watchdog.clear(issue.id);
        continue;
      }
      if (openStates.length > 1) {
        const list = openStates.map(s2 => `${s2.pr.repo}#${s2.pr.num}`).join(', ');
        await returnToBuild(issue, openStates[0].pr,
          `${openStates.length} open PRs (${list}); keep exactly one: close the superseded PRs with gh pr close, then rebase the survivor`);
        continue;
      }
      const pr = openStates[0].pr;
      const info = openStates[0].info;

      if (info.mergeable === 'CONFLICTING') {
        await returnToBuild(issue, pr, 'merge conflict; verify master..merge diff after rebase');
        continue;
      }

      const ci = ciState(pr.repo, info.headRefOid, info.createdAt);
      if (ci === 'absent') {
        await returnToBuild(issue, pr, `no CI runs after ${CI_ABSENT_MINUTES} minutes`);
        continue;
      }
      const failures = countCiFailure(issue, pr, info.headRefOid, ci);
      if (failures >= CI_FAILURE_POLLS) { await escalateCi(issue, pr, ci); continue; }
      if (ci !== 'green') {
        const retro = (ci === 'pending' || ci === 'no_checks' || ci === 'cancelled_only') && info.mergeable !== 'CONFLICTING' ? retroactiveEligible(pr.repo, pr.num) : null;
        if (!retro || !retro.ok) {
          const count = failures ? ` poll=${failures}/${CI_FAILURE_POLLS}` : '';
          log(`HOLD #${issue.number} ${pr.repo}#${pr.num} ci=${ci}${count}${retro ? ` retro=${retro.why}` : ''}`);
          continue;
        }
        log(`RETRO #${issue.number} ${pr.repo}#${pr.num} ci=${ci} merging ahead of CI (${retro.why})`);
      }
      if (!MERGE_ENABLED) { log(`HOLD #${issue.number} ${pr.repo}#${pr.num} green but merging disabled`); continue; }
      // Operator-owned merge, delegated to the belt (Tim 2026-09-03 01:48Z:
      // CI/CD & Deploy is owned end to end). Only a green, MERGEABLE PR merges;
      // the next poll sees it merged and routes the ticket to Done.
      // UNKNOWN means GitHub has not recomputed yet (every merge on the repo
      // resets it). Only CONFLICTING holds; the merge call itself refuses
      // (405) if the PR is not mergeable.
      if (info.mergeable === 'CONFLICTING') {
        log(`HOLD #${issue.number} ${pr.repo}#${pr.num} green but mergeable=${info.mergeable}`);
        continue;
      }
      try {
        gh(['pr', 'merge', String(pr.num), '-R', pr.repo, '--squash', '--admin', '--delete-branch']);
        log(`MERGED #${issue.number} ${pr.repo}#${pr.num} squash by belt operator`);
      } catch (e) {
        // GitHub reports mergeable=null for every open PR right after a base
        // move and recomputes lazily; a PR read as UNKNOWN can still be dirty,
        // and the merge call then answers 405 "merge conflicts". That is the
        // same fact as CONFLICTING: return it now instead of retrying every poll.
        if (/merge conflicts/i.test(String(e.message))) {
          await returnToBuild(issue, pr, 'merge conflict; verify master..merge diff after rebase');
          continue;
        }
        log(`MERGE-FAIL #${issue.number} ${pr.repo}#${pr.num}: ${String(e.message).split('\n')[0].slice(0, 160)}`);
      }
    } catch (e) {
      if (e.rateLimited || ghBackoffUntil > Date.now()) {
        log(`RATE-LIMIT sweep skipped=${rows.length - issueIndex} reset=${new Date(ghBackoffUntil).toISOString()}`);
        return;
      }
      // GSP-1973 / upstream multica#465: watchdogFailure escalates via
      // humanReview -> relay('Human Review'), which the relay refuses with
      // 409 actor_denied because this worker holds RELAY_AGENT_SECRET while
      // that transition is operator-only. Thrown from inside this catch, it
      // escaped the loop and aborted the whole sweep, so every ticket ordered
      // after the first escalating one was skipped.
      let failure = { stalled: false };
      try {
        failure = await watchdogFailure(issue, e.message);
      } catch (escalationError) {
        log(`ESCALATE-FAIL #${issue.number}: ${String(escalationError.message).split('\n')[0].slice(0, 160)}`);
      }
      log(`ERR #${issue.number}: ${String(e.message).split('\n')[0].slice(0, 160)}${failure.stalled ? ' (Human Review)' : ''}`);
    }
  }
}

async function main() {
  initializeRuntime();
  log(`[cicd-worker] started; poll=${POLL_MS}ms merge=${MERGE_ENABLED} sentinel_ms=${SENTINEL_MS} retry_limit=${RETRY_LIMIT}`);
  for (;;) {
    await sweep().catch(e => log('[sweep] error:', e.message));
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main();

function setTestDependencies(dependencies) {
  if (require.main === module) throw new Error('test dependencies unavailable in worker process');
  if (dependencies.pool) pool = dependencies.pool;
  if (dependencies.relay) relay = dependencies.relay;
  if (dependencies.gh) gh = dependencies.gh;
  if (dependencies.readReceipt) readReceipt = dependencies.readReceipt;
  if (dependencies.log) log = dependencies.log;
  if (dependencies.watchdog) watchdog = dependencies.watchdog;
}

module.exports = { ciState, countCiFailure, escalateCi, returnToBuild, humanReview, retryEscalation,
  routeFinishedPR, receiptFor, mergeDeployEvidence, noDeployRunTriggered, terminalFailedDeployRuns,
  terminalDeployEvaluation, retriggerCancelledDeploys, normalizeReturnReason, parseRelayResponse,
  setTestDependencies, sweep, watchdogFailure, closureWatchdog };
