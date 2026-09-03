'use strict';

function ciState(runs) {
  if (!Array.isArray(runs) || !runs.length) return 'pending';
  if (runs.some(run => run.status !== 'completed')) return 'pending';
  return runs.every(run => run.conclusion === 'success') ? 'green' : 'red';
}

function qcAdmission(verdict, headSha) {
  if (!verdict) return { ok: false, reason: 'QC verdict missing' };
  if (verdict.verdict !== 'PASS') return { ok: false, reason: `QC verdict ${verdict.verdict}` };
  if (verdict.qualifying !== true || verdict.model !== 'gpt-5.6-sol' || verdict.effort !== 'low')
    return { ok: false, reason: 'QC verdict is not qualifying Sol-low' };
  if (!verdict.bound_sha || String(verdict.bound_sha).toLowerCase() !== String(headSha).toLowerCase())
    return { ok: false, reason: 'QC PASS bound_sha does not match current head' };
  return { ok: true };
}

async function admit({ info, runs, verdict }) {
  if (info.state !== 'OPEN') return { ok: false, reason: `PR state=${info.state}` };
  if (info.mergeable !== 'MERGEABLE') return { ok: false, reason: `PR mergeable=${info.mergeable}` };
  const ci = ciState(runs);
  if (ci !== 'green') return { ok: false, reason: `ci=${ci}` };
  return qcAdmission(verdict, info.headRefOid);
}

module.exports = { ciState, qcAdmission, admit };
