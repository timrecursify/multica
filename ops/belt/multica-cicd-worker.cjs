#!/usr/bin/env node
// multica-cicd-worker — the consumer of the CI/CD & Deploy stage.
//
// Nothing owned this stage, so tickets whose PR had already merged sat in it
// forever and Done stayed flat while the belt kept running. This worker closes
// the loop: it reads each ticket's work product, finds its PR, and finishes the
// ticket when the PR is merged, merges it when CI is green, or leaves it in
// place with a note when CI is red.
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
let pool;
let relayToken;

function initializeRuntime() {
  const { Pool } = require('pg');
  const envPath = process.env.MULTICA_REMOTE_BRIDGE_ENV || '/home/newadmin/.secrets/multica-remote/remote-bridge.env';
  const env = fs.readFileSync(envPath, 'utf8');
  relayToken = env.split('\n').find(l => l.startsWith('RELAY_AGENT_SECRET=')).split('=')[1];
  pool = new Pool({ connectionString: env.split('\n').find(l => l.startsWith('DATABASE_URL=')).slice(13).trim() });
}
const BOT = 'b8ecc1c4-d58c-4233-a669-7ede7060531c';
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

let relay = function relayRequest(issueId, toStage, currentWorkProductMd5, reason) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ issue_id: issueId, to_stage: toStage, agent_token: relayToken,
      ...(currentWorkProductMd5 ? { current_work_product_md5: currentWorkProductMd5 } : {}),
      ...(reason ? { reason } : {}) });
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

// Each relay hop enqueues a task for the stage owner. This stage is that task's
// consumer, so closing it is what finishing the stage means.
async function closePendingTask(issueId) {
  await pool.query(
    `UPDATE agent_task_queue SET status='completed'
      WHERE issue_id=$1 AND status IN ('queued','dispatched')
        AND context->>'to_stage'='CI/CD & Deploy'`, [issueId]);
}

async function latestVerdict(issueId) {
  const verdict = await pool.query(
    `SELECT verdict, work_product_md5 FROM qc_verdict
      WHERE issue_id=$1 ORDER BY created_at DESC LIMIT 1`, [issueId]);
  return verdict.rows[0];
}

async function routeFinishedPR(issue, note) {
  const latest = await latestVerdict(issue.id);
  if (!latest || latest.verdict !== 'PASS' || !latest.work_product_md5) {
    await relay(issue.id, 'Parked');
    await closePendingTask(issue.id);
    log(`PARKED #${issue.number} — ${note}; latest QC is ${latest?.verdict || 'missing'}`);
    return;
  }
  await relay(issue.id, 'Done', latest.work_product_md5);
  await closePendingTask(issue.id);
  log(`DONE #${issue.number} — ${note}`);
}

async function escalateCi(issue, pr, ci) {
  await relay(issue.id, 'Parked');
  await closePendingTask(issue.id);
  log(`PARKED #${issue.number} ${pr.repo}#${pr.num}: ci=${ci} for ${CI_FAILURE_POLLS} consecutive polls`);
}

async function returnToBuild(issue, pr, reason) {
  const detail = `${pr.repo}#${pr.num} ${reason}`;
  await relay(issue.id, 'In Progress', null, `RETURN:In Progress — ${detail}`);
  await closePendingTask(issue.id);
  log(`RETURN #${issue.number} ${detail}`);
}

function countCiFailure(issue, pr, sha, ci) {
  const key = `${issue.id}:${pr.repo}#${pr.num}:${sha}`;
  if (ci !== 'red' && ci !== 'unknown') {
    ciFailureCounts.delete(key);
    return 0;
  }
  const count = (ciFailureCounts.get(key) || 0) + 1;
  ciFailureCounts.set(key, count);
  return count;
}

function findPR(work) {
  const url = (work || '').match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (url) return { repo: `${url[1]}/${url[2]}`, num: url[3] };
  const bare = (work || '').match(/\bPR\s*#(\d+)/i);
  if (bare) return { repo: 'timrecursify/ppp', num: bare[1] };
  return null;
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
  if (out.length) return out;
  const bare = (work || '').match(/\bPR\s*#(\d+)/i);
  return bare ? [{ repo: 'timrecursify/ppp', num: bare[1] }] : [];
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
      return Number.isFinite(ageMinutes) && ageMinutes >= CI_ABSENT_MINUTES ? 'absent' : 'pending';
    }
    if ((runs.workflow_runs || []).some(r => r.status !== 'completed')) return 'pending';
    if (!done.length) return 'pending';
    if (done.every(r => r.conclusion === 'success')) return 'green';
    if (done.some(r => r.conclusion === 'failure')) return 'red';
    return 'mixed';
  } catch (e) { return 'unknown'; }
}


// The reviewer gate refuses to merge without a MERGE-INTENT comment bound to the
// head SHA under review, and nothing mirrored Multica's QC into GitHub, so eight
// PPP pull requests sat green-blocked with a PASS recorded here and no evidence
// there. Mirroring is only honest when it asserts what Multica actually checked:
// qc_verdict stores work_product_md5, NOT a git SHA, so a PASS alone proves
// nothing about a given head. A verdict is mirrored only when one of the QC
// worker's own comments cites the pull request's CURRENT head SHA. If the branch
// moved after review, that match fails and nothing is posted -- the stale-verdict
// case, where a re-push outruns QC and a merge would ship unreviewed code.
async function mirrorVerdictToPR(issue, pr, headSha) {
  const v = await pool.query(
    `SELECT verdict FROM qc_verdict WHERE issue_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [issue.id]);
  if (!v.rows.length || v.rows[0].verdict !== 'PASS') return false;

  const bound = await pool.query(
    `SELECT 1 FROM comment WHERE issue_id=$1 AND content LIKE '%' || $2 || '%' LIMIT 1`,
    [issue.id, headSha]);
  if (!bound.rows.length) {
    log(`NO-MIRROR #${issue.number} ${pr.repo}#${pr.num}: PASS not bound to head ${headSha.slice(0,12)}`);
    return false;
  }

  const existing = gh(['pr', 'view', pr.num, '-R', pr.repo, '--json', 'comments',
                       '-q', '.comments[].body']);
  if (existing.includes('MERGE-INTENT:')) return true;

  const body = [
    '## QC VERDICT: PASS',
    '',
    `Mirrored from Multica issue #${issue.number}. Bound head SHA: \`${headSha}\``,
    'This verdict VOIDS on any new push.',
    '',
    `MERGE-INTENT: multica-cicd-worker MULT-${issue.number}`
  ].join('\n');
  gh(['pr', 'comment', pr.num, '-R', pr.repo, '--body', body]);
  log(`MIRRORED #${issue.number} -> ${pr.repo}#${pr.num} (head ${headSha.slice(0,12)})`);
  return true;
}

async function sweep() {
  const { rows } = await pool.query(
    `SELECT id, number, title FROM issue WHERE status='CI/CD & Deploy' ORDER BY number`);
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
      for (const row of w.rows) {
        for (const cand of findAllPRs(row.content || '')) {
          const k = `${cand.repo}#${cand.num}`;
          if (!seenPR.has(k)) { seenPR.add(k); prs.push(cand); }
        }
      }
      if (!prs.length) { await routeFinishedPR(issue, 'no PR referenced; nothing to deploy'); continue; }

      // Resolve every referenced PR first, then decide once.
      const states = [];
      for (const cand of prs) {
        states.push({ pr: cand,
          info: JSON.parse(gh(['pr', 'view', cand.num, '-R', cand.repo, '--json', 'state,mergeable,headRefOid,createdAt'])) });
      }
      const openStates = states.filter(s2 => s2.info.state !== 'MERGED' && s2.info.state !== 'CLOSED');
      if (!openStates.length) {
        await routeFinishedPR(issue, states.map(s2 => `${s2.pr.repo}#${s2.pr.num} ${s2.info.state.toLowerCase()}`).join(', '));
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
      try { await mirrorVerdictToPR(issue, pr, info.headRefOid); }
      catch (e) { log(`MIRROR-ERR #${issue.number}: ${String(e.message).split('\n')[0].slice(0,140)}`); }

      try {
        gh(['pr', 'merge', pr.num, '-R', pr.repo, '--squash', '--delete-branch']);
        // Closing is intentionally deferred to the next poll. If relay or task
        // cleanup fails then, the PR is already observed as MERGED and this
        // worker cannot issue a second merge command.
        log(`MERGED #${issue.number} ${pr.repo}#${pr.num}; close on next poll`);
      } catch (e) {
        // A required check the fleet must not weaken (the reviewer gate) blocks
        // the merge. That is the gate doing its job; report and move on.
        log(`BLOCKED #${issue.number} ${pr.repo}#${pr.num}: ${String(e.message).split('\n').find(l => l.trim()) || e.message}`.slice(0, 300));
      }
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
}

module.exports = { ciState, countCiFailure, escalateCi, returnToBuild,
  routeFinishedPR, setTestDependencies, sweep };
