#!/usr/bin/env node
'use strict';

// Scheduled entry point.  CICD_REAPER_REPOS is a comma-separated allow-list;
// the allow-list prevents an accidental organisation-wide cancellation.
const { execFileSync } = require('node:child_process');
const { createReaper } = require('./ci-run-reaper-lib.cjs');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 8e6 }).trim();
async function main() {
  const repos = (process.env.CICD_REAPER_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!repos.length) { console.error('CICD_REAPER_REPOS is required'); process.exitCode = 2; return; }
  const protectedHeads = (process.env.CICD_REAPER_HELD_HEADS || '').split(',').map(s => s.trim()).filter(Boolean);
  const reap = createReaper({ gh, staleMs: Number(process.env.CICD_REAPER_STALE_MS || 86400000) });
  for (const repo of repos) {
    const prs = JSON.parse(gh(['api', `repos/${repo}/pulls?state=open&per_page=100`])).map(p => p.head?.sha).filter(Boolean);
    const runs = JSON.parse(gh(['api', `repos/${repo}/actions/runs?per_page=100`])).workflow_runs || [];
    await reap(repo, runs, { openPrHeads: prs, heldTicketHeads: protectedHeads });
  }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
