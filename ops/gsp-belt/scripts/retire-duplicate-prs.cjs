#!/usr/bin/env node
'use strict';
// Owner-operated only.  Dry run never calls a mutating gh command.
const fs = require('fs');
const { execFileSync } = require('child_process');
const CLUSTERS = [[44,63,179,196,215],[66,157,231],[145,185],[69,77],[43,51],[67,153]];
const args = process.argv.slice(2); const fixtureArg = args.indexOf('--fixture');
const fixture = fixtureArg >= 0 ? JSON.parse(fs.readFileSync(args[fixtureArg + 1], 'utf8')) : null;
const apply = args.includes('--apply'); const confirm = args.includes('--confirm-owner-close');
const canonicalArg = args.find(x => x.startsWith('--canonicals='));
const canonicals = new Map((canonicalArg ? canonicalArg.split('=')[1] : '').split(',').filter(Boolean).map(p => p.split(':').map(Number)));
function gh(a) { return JSON.parse(execFileSync('gh', a, { encoding: 'utf8' })); }
function record(pr) {
  if (fixture) return fixture[String(pr)];
  const v = gh(['pr','view',String(pr),'-R','timrecursify/multica','--json','number,state,mergeable,headRefOid,body,statusCheckRollup']);
  // Live evidence is deliberately obtained from the authoritative DB by the
  // operator wrapper; absent a mapped issue this safely remains non-admitted.
  return { ...v, ci: (v.statusCheckRollup || []).every(x => x.status === 'COMPLETED' && x.conclusion === 'SUCCESS') ? 'green' : 'not-green', qc: null };
}
function admitted(r) { return r && r.state === 'OPEN' && r.mergeable === 'MERGEABLE' && r.ci === 'green' && r.qc && r.qc.verdict === 'PASS' && r.qc.qualifying === true && r.qc.model === 'gpt-5.6-sol' && r.qc.effort === 'low' && r.qc.bound_sha === r.headRefOid; }
for (let i = 0; i < CLUSTERS.length; i++) {
  const members = CLUSTERS[i], rows = members.map(n => [n, record(n)]);
  console.log(`cluster ${i + 1}: ${members.map(n => '#' + n).join('/')}`);
  for (const [n, r] of rows) console.log(`  #${n} state=${r?.state || 'UNKNOWN'} head=${r?.headRefOid || 'unknown'} ci=${r?.ci || 'unknown'} qc=${r?.qc ? `${r.qc.verdict}/${r.qc.bound_sha}` : 'missing'}`);
  const canonical = canonicals.get(i + 1);
  if (!apply) { console.log('  proposed canonical: OWNER SELECTION REQUIRED; superseded: none'); continue; }
  const selected = rows.find(([n]) => n === canonical)?.[1];
  if (!confirm || !canonical || !admitted(selected)) { console.log('  SKIP: explicit confirmed, admitted canonical required'); continue; }
  for (const [n] of rows) if (n !== canonical) {
    execFileSync('gh', ['pr','close',String(n),'-R','timrecursify/multica','--comment',`Superseded by #${canonical}; closed by repository owner duplicate-cleanup confirmation.`], { stdio: 'inherit' });
  }
}
