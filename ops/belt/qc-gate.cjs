'use strict';

const { execFileSync } = require('child_process');
const { readTaskEvidence } = require('./qc-verdict-policy.cjs');

const SHA_RE = /^[0-9a-f]{40}$/i;
const SK_SECRET_RE = /\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_]{20,}\b/;
const GH_SECRET_RE = /ghp_/i;
const XOX_SECRET_RE = /xox(?:b|p)-/i;
const AKIA_SECRET_RE = /AKIA[0-9A-Za-z]{16}/i;
const BEGIN_KEY_SECRET_RE = /-----BEGIN (?:PRIVATE|RSA) KEY/i;
const DATABASE_URL_SECRET_RE = /DATABASE_URL=postgres/i;
const OTHER_SECRET_RE = /ghp_|xox(?:b|p)-|AKIA[0-9A-Za-z]{16}|-----BEGIN (?:PRIVATE|RSA) KEY|DATABASE_URL=postgres/i;
const SECRET_RE = { test(value) { return SK_SECRET_RE.test(String(value)) || OTHER_SECRET_RE.test(String(value)); } };
const SOURCE_RE = /\.(?:ts|js|cjs|mjs|py)$/i;
const TEST_RE = /(?:^|[/.])(?:test|spec)\.[^.]+$|(?:^|[/.])tests?[/.]/i;
const PR_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;
// Merge-authorization/policy contexts are orchestrator or human actions; a builder cannot remediate them.
const CI_EXCLUDED_CONTEXTS = new Set(['verdict-gate', 'reviewer-gate']);

function check(name, ok, detail) { return { name, ok: Boolean(ok), detail: String(detail || '') }; }
function ghJson(gh, args) { return JSON.parse(gh(args)); }
function repoFrom(issue, pr) {
  return issue.repo || issue.repository || (pr.html_url || '').match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull/)?.[1];
}
function pathTokens(scope) {
  return String(scope || '').split(/\s+/).map(s => s.replace(/[(),;:]$/g, '')).filter(s => s.includes('/') || /\.[A-Za-z0-9]+$/.test(s));
}
function md5ForSha(sha, workspace, repo) {
  const [owner, name] = String(repo || '').split('/');
  const root = workspace?.bareCache || '/var/lib/gsp/multica/workspaces/.repos';
  const dir = `${root}/${workspace?.id}/github.com+${owner}+${name}.git`;
  try {
    execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--full-tree', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (!require('fs').existsSync(dir)) return `unavailable: no bare cache for ${owner}/${name}`;
    try { execFileSync('git', ['-C', dir, 'fetch', '--quiet', 'origin', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (fetchErr) { return `unavailable: ${fetchErr.message}`; }
  }
  try {
    const tree = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--full-tree', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return require('crypto').createHash('md5').update(tree.split('\n').filter(Boolean).sort().join('\n') + (tree.trim() ? '\n' : '')).digest('hex');
  } catch (err) { return `unavailable: ${err.message}`; }
}
async function findPr({ issue, db }) {
  const metadata = issue.metadata || {};
  if (metadata.pr_url) {
    const m = String(metadata.pr_url).match(PR_URL_RE);
    if (m) return { html_url: metadata.pr_url, repo: m[1], pr_number: Number(m[2]) };
  }
  const linked = await db.query('SELECT p.* FROM issue_vcs_pull_request ip JOIN vcs_pull_request p ON p.id=ip.pull_request_id WHERE ip.issue_id=$1 ORDER BY p.updated_at DESC LIMIT 1', [issue.id]);
  if (linked.rows[0]) return linked.rows[0];
  const comments = await db.query('SELECT content FROM comment WHERE issue_id=$1 ORDER BY created_at DESC LIMIT 40', [issue.id]);
  for (const row of comments.rows) { const m = String(row.content || '').match(PR_URL_RE); if (m) return { html_url: m[0], repo: m[1], pr_number: Number(m[2]) }; }
  const tasks = await db.query("SELECT result FROM agent_task_queue WHERE issue_id=$1 AND status='completed' ORDER BY completed_at DESC LIMIT 20", [issue.id]);
  for (const row of tasks.rows) { const parsed = readTaskEvidence({ result: row.result }); const text = JSON.stringify(row.result || {}); const m = text.match(PR_URL_RE); if (m) return { html_url: m[0], repo: m[1], pr_number: Number(m[2]), result: parsed }; }
  return null;
}
async function runQcGate({ issue = {}, workspace = {}, evidence = {}, gh, db }) {
  const checks = [];
  const pr = await findPr({ issue, db });
  if (!pr) { checks.push(check('pr_linked', false, 'no_pr')); return { verdict: evidence.bound_sha ? 'FAIL' : 'BLOCKED', failure_class: evidence.bound_sha ? 'evidence' : 'evidence', checks, bound_sha: null, pr_number: null }; }
  checks.push(check('pr_linked', true, pr.html_url || `#${pr.pr_number}`));
  const repo = repoFrom(issue, pr); const number = pr.pr_number || pr.number;
  const detail = ghJson(gh, ['api', `repos/${repo}/pulls/${number}`]);
  const sha = detail.head?.sha; checks.push(check('sha_reachable', SHA_RE.test(String(sha)), SHA_RE.test(String(sha)) ? sha : 'invalid_sha'));
  if (!SHA_RE.test(String(sha))) return { verdict: 'FAIL', failure_class: 'evidence', checks, bound_sha: null, pr_number: number };
  const runs = ghJson(gh, ['api', `repos/${repo}/commits/${sha}/check-runs`]).check_runs || [];
  const pending = runs.some(r => !['completed'].includes(String(r.status).toLowerCase()));
  const ciRuns = runs.filter(r => !CI_EXCLUDED_CONTEXTS.has(String(r.name || '').toLowerCase()));
  const failing = ciRuns.find(r => ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(String(r.conclusion).toLowerCase()));
  checks.push(check('ci_not_failed', !failing, failing ? `ci_failed:${failing.name || 'unnamed'}` : 'no_failures'));
  checks.push(check('ci_complete', !pending, pending ? 'ci_pending' : 'all_complete'));
  const ciPending = ciRuns.some(r => !['completed'].includes(String(r.status).toLowerCase()));
  const ciGreen = !failing && !ciPending && ciRuns.every(r => ['success', 'skipped', 'neutral'].includes(String(r.conclusion).toLowerCase()));
  checks.push(check('ci_green', ciGreen, ciGreen ? 'all_green' : (ciPending ? 'ci_pending' : 'not_green')));
  const files = ghJson(gh, ['api', `repos/${repo}/pulls/${number}/files?per_page=100`]);
  const tokens = pathTokens(evidence.bindingScope || issue.bindingScope); const scopeOk = !tokens.length || files.every(f => tokens.some(t => f.filename === t || f.filename.startsWith(t.endsWith('/') ? t : `${t}/`)));
  checks.push(check('scope', scopeOk, tokens.length ? (scopeOk ? 'in_scope' : 'out_of_scope') : 'no path tokens'));
  const patch = files.map(f => f.patch || '').join('\n');
  const secretPattern = SK_SECRET_RE.test(patch) ? 'sk_key' : GH_SECRET_RE.test(patch) ? 'ghp' : XOX_SECRET_RE.test(patch) ? 'xox' : AKIA_SECRET_RE.test(patch) ? 'akia' : BEGIN_KEY_SECRET_RE.test(patch) ? 'begin_key' : DATABASE_URL_SECRET_RE.test(patch) ? 'database_url' : null;
  checks.push(check('no_secrets', !secretPattern, secretPattern ? `secret_pattern:${secretPattern}` : 'clean'));
  let sizeOk = true; let sizeDetail = 'under_limit';
  if (files.length > 40) sizeDetail = 'skipped >40 files'; else for (const f of files) if (f.additions > 0 && SOURCE_RE.test(f.filename) && !TEST_RE.test(f.filename)) {
    const body = ghJson(gh, ['api', `repos/${repo}/contents/${f.filename}?ref=${sha}`]);
    const lines = Buffer.from(body.content || '', 'base64').toString().split('\n').length;
    const added = String(f.status || '').toLowerCase() === 'added';
    if (lines > 500 && (added || lines - Number(f.additions || 0) + Number(f.deletions || 0) <= 500)) {
      sizeOk = false; sizeDetail = `${f.filename}:${lines}`; break;
    }
    if (lines > 500) sizeDetail = `legacy:${f.filename}:${lines}`;
  }
  checks.push(check('size', sizeOk, sizeDetail));
  checks.push(check('tests_touched', !files.some(f => SOURCE_RE.test(f.filename)) || files.some(f => TEST_RE.test(f.filename)), 'soft'));
  checks.push(check('pr_mergeable', true, detail.mergeable_state || 'unknown'));
  const failed = checks.filter(c => getHardChecks().includes(c.name) && !c.ok);
  const workProductMd5 = md5ForSha(sha, workspace, repo);
  if (String(workProductMd5 || '').startsWith('unavailable:')) checks.push(check('work_product_md5', true, workProductMd5));
  return { verdict: failed.length ? 'FAIL' : 'PASS', failure_class: failed.length ? 'evidence' : 'none', checks, bound_sha: sha, pr_number: Number(number), work_product_md5: workProductMd5 };
}
const HARD_CHECKS = ['pr_linked', 'sha_reachable', 'ci_not_failed', 'scope', 'no_secrets', 'size'];
function getHardChecks() { return process.env.QC_GATE_CI_ADVISORY === '0' ? [...HARD_CHECKS, 'ci_complete'] : HARD_CHECKS; }
module.exports = { runQcGate, md5ForSha, pathTokens, SECRET_RE, HARD_CHECKS, getHardChecks, CI_EXCLUDED_CONTEXTS };
