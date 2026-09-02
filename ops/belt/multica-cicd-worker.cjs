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
const { currentStrictPass } = require('./qc-strict-evidence.cjs');
const { evaluate } = require('./transition-policy.cjs');
const RECEIPT_ROOT = process.env.MULTICA_RECEIPT_ROOT || '/home/newadmin/gsp-multica-runtime/receipts';
let pool;
let relayToken;
let readReceipt = (sha) => JSON.parse(fs.readFileSync(`${RECEIPT_ROOT}/belt-${sha}.json`, 'utf8'));

function initializeRuntime() {
  const { Pool } = require('pg');
  const envPath = process.env.MULTICA_REMOTE_BRIDGE_ENV || '/home/newadmin/.secrets/multica-remote/remote-bridge.env';
  const env = fs.readFileSync(envPath, 'utf8');
  relayToken = env.split('\n').find(l => l.startsWith('RELAY_AGENT_SECRET=')).split('=')[1];
  pool = new Pool({ connectionString: env.split('\n').find(l => l.startsWith('DATABASE_URL=')).slice(13).trim() });
}
const POLL_MS = parseInt(process.env.CICD_POLL_MS || '120000', 10);
const CI_FAILURE_POLLS = parseInt(process.env.CICD_FAILURE_POLLS || '3', 10);
const CI_ABSENT_MINUTES = parseInt(process.env.CICD_ABSENT_MINUTES || '20', 10);
// Merging is the one irreversible action here, so it is opt-in and defaults on
// only for repositories this fleet owns.
const MERGE_ENABLED = process.env.CICD_MERGE_ENABLED !== '0';
const ciFailureCounts = new Map();

const log = (...a) => console.log(new Date().toISOString(), ...a);

let gh = function github(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 8e6 }).trim();
};

let relay = function relayRequest(issueId, toStage, currentWorkProductMd5, reason, parkedAudit) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ issue_id: issueId, to_stage: toStage, agent_token: relayToken,
      ...(currentWorkProductMd5 ? { current_work_product_md5: currentWorkProductMd5 } : {}),
      ...(reason ? { reason } : {}),
      ...(parkedAudit ? { parked_audit: parkedAudit } : {}) });
    const req = http.request('http://127.0.0.1:5005/relay/advance',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 20000 }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => res.statusCode >= 400 ? reject(new Error(`${res.statusCode} ${d.slice(0,140)}`)) : resolve(d));
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('relay timeout')); });
    req.write(body); req.end();
  });
};

async function latestVerdict(issueId) {
  return currentStrictPass(pool, issueId);
}

function receiptFor(sha) {
  try {
    const receipt = readReceipt(sha);
    return receipt?.source_sha === sha && receipt.health === 'ok' && typeof receipt.release === 'string'
      ? receipt : null;
  } catch (_) { return null; }
}

async function humanReview(issue, reason) {
  const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'Human Review', actor: 'system',
    evidence: { namedBlocker: reason } });
  if (!verdict.ok) throw new Error(`transition policy rejected Human Review: ${verdict.code}`);
  await relay(issue.id, 'Human Review', null, reason);
  log(`HUMAN REVIEW #${issue.number} — ${reason}`);
}

async function routeFinishedPR(issue, note, mergedSha) {
  const latest = await latestVerdict(issue.id);
  const receipt = receiptFor(mergedSha);
  if (!latest || !latest.work_product_md5 || latest.bound_sha !== mergedSha || !receipt) {
    await humanReview(issue, `${note}; exact-SHA release receipt at reviewed SHA is required`);
    return;
  }
  const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'Done', actor: 'system', evidence: {
    ciSuccess: true, mergeDeployReceipt: receipt, reviewedSha: latest.bound_sha, qualifyingPass: true
  } });
  if (!verdict.ok) throw new Error(`transition policy rejected Done: ${verdict.code}`);
  await relay(issue.id, 'Done', latest.work_product_md5);
  log(`DONE #${issue.number} — ${note}`);
}

async function escalateCi(issue, pr, ci) {
  await returnToBuild(issue, pr, `ci=${ci} for ${CI_FAILURE_POLLS} consecutive polls`);
}

async function returnIssueToBuild(issue, reason) {
  const verdict = evaluate({ from: 'CI/CD & Deploy', to: 'In Progress', actor: 'system',
    evidence: { ciFailureOrAbsent: true, mergeConflictEvidence: reason } });
  if (!verdict.ok) throw new Error(`transition policy rejected In Progress: ${verdict.code}`);
  await relay(issue.id, 'In Progress', null, `RETURN:In Progress — ${reason}`);
  log(`RETURN #${issue.number} ${reason}`);
}

async function returnToBuild(issue, pr, reason) {
  const detail = `${pr.repo}#${pr.num} ${reason}`;
  await returnIssueToBuild(issue, detail);
}

function countCiFailure(issue, pr, sha, ci) {
  const key = `${issue.id}:${pr.repo}#${pr.num}:${sha}`;
  if (!['red', 'unknown', 'mixed', 'pending'].includes(ci)) {
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
    const done = (runs.workflow_runs || []).filter(r => r.status === 'completed');
    if (!(runs.workflow_runs || []).length) {
      const ageMinutes = (now - Date.parse(createdAt || '')) / 60000;
      return Number.isFinite(ageMinutes) && ageMinutes >= CI_ABSENT_MINUTES ? 'absent' : 'no_checks';
    }
    if ((runs.workflow_runs || []).some(r => r.status !== 'completed')) return 'pending';
    if (!done.length) return 'pending';
    if (done.every(r => r.conclusion === 'success')) return 'green';
    if (done.some(r => r.conclusion === 'failure')) return 'red';
    return 'mixed';
  } catch (e) { return 'unknown'; }
}


async function sweep() {
  const { rows } = await pool.query(
    `SELECT id, number, title, workspace_id, metadata FROM issue WHERE status='CI/CD & Deploy' ORDER BY number`);
  if (!rows.length) { log('[poll] CI/CD & Deploy is empty'); return; }
  log(`[poll] ${rows.length} ticket(s) in CI/CD & Deploy`);
  for (const issue of rows) {
    try {
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
        await humanReview(issue, hasBarePR ? 'ambiguous PR reference, no repository' : 'no PR referenced');
        continue;
      }

      // Resolve every referenced PR first, then decide once.
      const states = [];
      for (const cand of prs) {
        states.push({ pr: cand,
          info: JSON.parse(gh(['pr', 'view', cand.num, '-R', cand.repo, '--json', 'state,mergeable,headRefOid,createdAt,mergedAt,mergeCommit'])) });
      }
      const closed = states.filter(s2 => s2.info.state === 'CLOSED');
      if (closed.length) {
        const first = closed[0];
        await humanReview(issue, closed.map(s2 => `${s2.pr.repo}#${s2.pr.num} closed without merge`).join(', '));
        continue;
      }
      const openStates = states.filter(s2 => s2.info.state !== 'MERGED');
      if (!openStates.length) {
        const mergedSha = states[0].info.mergeCommit?.oid;
        if (states.length !== 1 || !/^[0-9a-f]{40}$/.test(mergedSha || '')) {
          await humanReview(issue, 'exactly one merged PR with a full merge SHA is required');
          continue;
        }
        await routeFinishedPR(issue, 'merged PR has exact-SHA release receipt', mergedSha);
        continue;
      }
      if (openStates.length > 1) {
        log(`HOLD #${issue.number} ${openStates.length} PRs still open: ` +
            openStates.map(s2 => `${s2.pr.repo}#${s2.pr.num}`).join(', '));
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
        const count = failures ? ` poll=${failures}/${CI_FAILURE_POLLS}` : '';
        log(`HOLD #${issue.number} ${pr.repo}#${pr.num} ci=${ci}${count}`);
        continue;
      }
      if (!MERGE_ENABLED) { log(`HOLD #${issue.number} ${pr.repo}#${pr.num} green but merging disabled`); continue; }
      log(`HOLD #${issue.number} ${pr.repo}#${pr.num} CI is green; merge is operator-owned`);
    } catch (e) {
      log(`ERR #${issue.number}: ${String(e.message).split('\n')[0].slice(0, 160)}`);
    }
  }
}

async function main() {
  initializeRuntime();
  log(`[cicd-worker] started; poll=${POLL_MS}ms merge=${MERGE_ENABLED}`);
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
}

module.exports = { ciState, countCiFailure, escalateCi, returnToBuild, humanReview,
  routeFinishedPR, receiptFor, setTestDependencies, sweep };
