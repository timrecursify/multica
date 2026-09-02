#!/usr/bin/env node
// Dry-run-first duplicate PR cleanup. It never selects a canonical PR itself.
const fs = require('fs');
const { execFileSync } = require('child_process');
const CLUSTERS = [[44,63,179,196,215], [66,157,231], [145,185], [69,77], [43,51], [67,153]];
const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const apply = args.includes('--apply');
const fixturePath = value('--fixture');
const confirmations = args.filter(a => /^--canonical=\d+$/.test(a)).map(a => Number(a.slice(12)));

if (apply && (!args.includes('--confirm-owner') || confirmations.length !== CLUSTERS.length)) {
  throw new Error('apply requires --confirm-owner and exactly one --canonical=<PR> for every cluster');
}
if (apply && fixturePath) throw new Error('fixture mode never permits mutations');

const fixture = fixturePath ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : null;
function gh(argv) { return execFileSync('gh', argv, { encoding: 'utf8' }).trim(); }
function inspect(pr) {
  if (fixture) return fixture[String(pr)] || { number: pr, state: 'UNKNOWN', ci: 'unknown', qc: null };
  const info = JSON.parse(gh(['pr', 'view', String(pr), '-R', 'timrecursify/multica', '--json', 'state,mergeable,headRefOid']));
  const runs = JSON.parse(gh(['api', `repos/timrecursify/multica/actions/runs?head_sha=${info.headRefOid}&per_page=30`]));
  const done = (runs.workflow_runs || []).filter(r => r.status === 'completed');
  return { number: pr, state: info.state, mergeable: info.mergeable, head_sha: info.headRefOid,
    ci: done.length && done.every(r => r.conclusion === 'success') ? 'green' : 'not-green', qc: 'live DB lookup required' };
}
function admitted(row) {
  const q = row.qc;
  return row.state === 'OPEN' && row.mergeable !== 'CONFLICTING' && row.ci === 'green' && q &&
    q.verdict === 'PASS' && q.qualifying === true && q.model === 'gpt-5.6-sol' && q.effort === 'low' && q.bound_sha === row.head_sha;
}

for (let i = 0; i < CLUSTERS.length; i++) {
  const members = CLUSTERS[i];
  const rows = members.map(inspect);
  const canonical = apply ? confirmations[i] : null;
  console.log(`cluster ${i + 1}: #${members.join('/#')}`);
  for (const row of rows) console.log(`  #${row.number}: state=${row.state} head=${row.head_sha || 'unknown'} ci=${row.ci} qc=${JSON.stringify(row.qc)}`);
  console.log(`  proposed canonical: ${canonical ? '#' + canonical : 'OWNER SELECTION REQUIRED'}; superseded: ${canonical ? members.filter(n => n !== canonical).map(n => '#' + n).join(', ') : 'none'}`);
  if (!apply) continue;
  const chosen = rows.find(row => row.number === canonical);
  if (!chosen || !admitted(chosen)) { console.log('  SKIP: canonical is absent, closed, conflicting/unmergeable, or not exact-head admitted'); continue; }
  for (const row of rows.filter(row => row.number !== canonical)) {
    gh(['pr', 'close', String(row.number), '-R', 'timrecursify/multica', '--comment', `Superseded by #${canonical}; closed by repository-owner confirmed duplicate cleanup.`]);
  }
}
