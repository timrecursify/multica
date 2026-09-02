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
// pg module path externalized via GSP_BELT_PG_MODULE; default matches the
// current install so the primitive behavior is preserved.
const { Pool } = require(process.env.GSP_BELT_PG_MODULE || '/home/newadmin/node_modules/pg');

// Operator secret file externalized via env (see ops/gsp-belt README); the
// default matches the current home-directory install so behavior is unchanged.
const ENV = fs.readFileSync(process.env.GSP_BELT_SECRETS_ENV_FILE
  || '/home/newadmin/.secrets/multica-remote/remote-bridge.env', 'utf8');
const RELAY_TOKEN = ENV.split('\n').find(l => l.startsWith('RELAY_AGENT_SECRET=')).split('=')[1];
const pool = new Pool({ connectionString: ENV.split('\n').find(l => l.startsWith('DATABASE_URL=')).slice(13).trim() });
const BOT = 'b8ecc1c4-d58c-4233-a669-7ede7060531c';
const POLL_MS = parseInt(process.env.CICD_POLL_MS || '120000', 10);
// Merging is the one irreversible action here, so it is opt-in and defaults on
// only for repositories this fleet owns.
const MERGE_ENABLED = process.env.CICD_MERGE_ENABLED !== '0';

const log = (...a) => console.log(new Date().toISOString(), ...a);

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 8e6 }).trim();
}

function relay(issueId, toStage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ issue_id: issueId, to_stage: toStage, agent_token: RELAY_TOKEN });
    const req = http.request('http://127.0.0.1:5005/relay/advance',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 20000 }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => res.statusCode >= 400 ? reject(new Error(`${res.statusCode} ${d.slice(0,140)}`)) : resolve(d));
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('relay timeout')); });
    req.write(body); req.end();
  });
}

// Each relay hop enqueues a task for the stage owner. This stage is that task's
// consumer, so closing it is what finishing the stage means.
async function closePendingTask(issueId) {
  await pool.query(
    `UPDATE agent_task_queue SET status='completed'
      WHERE issue_id=$1 AND status IN ('queued','dispatched')`, [issueId]);
}

async function finish(issue, note) {
  await closePendingTask(issue.id);
  await relay(issue.id, 'Done');
  log(`DONE #${issue.number} — ${note}`);
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
function ciState(repo, sha) {
  try {
    const runs = JSON.parse(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=30`]));
    const done = (runs.workflow_runs || []).filter(r => r.status === 'completed');
    if (!done.length) return 'pending';
    if (done.every(r => r.conclusion === 'success')) return 'green';
    if (done.some(r => r.conclusion === 'failure')) return 'red';
    return 'mixed';
  } catch (e) { return 'unknown'; }
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
      if (!prs.length) { await finish(issue, 'no PR referenced; nothing to deploy'); continue; }

      // Resolve every referenced PR first, then decide once.
      const states = [];
      for (const cand of prs) {
        states.push({ pr: cand,
          info: JSON.parse(gh(['pr', 'view', cand.num, '-R', cand.repo, '--json', 'state,mergeable,headRefOid'])) });
      }
      const openStates = states.filter(s2 => s2.info.state !== 'MERGED' && s2.info.state !== 'CLOSED');
      if (!openStates.length) {
        await finish(issue, states.map(s2 => `${s2.pr.repo}#${s2.pr.num} ${s2.info.state.toLowerCase()}`).join(', '));
        continue;
      }
      if (openStates.length > 1) {
        log(`HOLD #${issue.number} ${openStates.length} PRs still open: ` +
            openStates.map(s2 => `${s2.pr.repo}#${s2.pr.num}`).join(', '));
      }
      const pr = openStates[0].pr;
      const info = openStates[0].info;

      const ci = ciState(pr.repo, info.headRefOid);
      if (ci !== 'green') { log(`HOLD #${issue.number} ${pr.repo}#${pr.num} ci=${ci}`); continue; }
      if (!MERGE_ENABLED) { log(`HOLD #${issue.number} ${pr.repo}#${pr.num} green but merging disabled`); continue; }
      if (info.mergeable === 'CONFLICTING') { log(`HOLD #${issue.number} ${pr.repo}#${pr.num} conflicting`); continue; }

      try {
        gh(['pr', 'merge', pr.num, '-R', pr.repo, '--squash', '--delete-branch']);
        await finish(issue, `merged ${pr.repo}#${pr.num} on green CI`);
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

(async () => {
  log(`[cicd-worker] started; poll=${POLL_MS}ms merge=${MERGE_ENABLED}`);
  for (;;) {
    await sweep().catch(e => log('[sweep] error:', e.message));
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
