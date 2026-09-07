'use strict';
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(['queued', 'pending', 'in_progress']);
function protectedShaSet({ openPrHeads = [], heldTicketHeads = [] } = {}) { return new Set([...openPrHeads, ...heldTicketHeads].filter(Boolean).map(String)); }
function reapCandidates(runs, { openPrHeads = [], heldTicketHeads = [], now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const protectedHeads = protectedShaSet({ openPrHeads, heldTicketHeads });
  return (Array.isArray(runs) ? runs : []).filter(run => {
    if (!run || !run.id || !ACTIVE.has(run.status) || run.conclusion) return false;
    if (protectedHeads.has(String(run.head_sha || run.headSha || ''))) return false;
    const age = now - Date.parse(run.created_at || run.createdAt || '');
    if (!Number.isFinite(age) || age < staleMs) return false;
    return run.status !== 'in_progress' || !(run.runner_name || run.runnerName);
  });
}
function queueMetrics(runs, { now = Date.now() } = {}) {
  const active = (Array.isArray(runs) ? runs : []).filter(r => r && ACTIVE.has(r.status));
  const ages = active.map(r => now - Date.parse(r.created_at || r.createdAt || '')).filter(Number.isFinite);
  const labels = new Set(); for (const run of active) for (const label of (run.labels || run.runner_labels || [])) labels.add(String(label));
  return { queue_depth: active.filter(r => r.status === 'queued' || r.status === 'pending').length, in_progress: active.filter(r => r.status === 'in_progress').length, oldest_age_ms: ages.length ? Math.max(...ages) : 0, runner_labels: [...labels].sort() };
}
function createReaper({ gh, log = () => {}, now = Date.now, staleMs = DEFAULT_STALE_MS } = {}) {
  if (typeof gh !== 'function') throw new TypeError('gh function is required');
  return async function reap(repo, runs, refs = {}) {
    const candidates = reapCandidates(runs, { ...refs, now: now(), staleMs }); let cancelled = 0;
    for (const run of candidates) { await gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${run.id}/cancel`]); cancelled++; }
    const metrics = { ...queueMetrics(runs, { now: now() }), reaper_cancellations: cancelled };
    log(`[ci-reaper] ${repo} queue_depth=${metrics.queue_depth} oldest_age_ms=${metrics.oldest_age_ms} cancellations=${cancelled} labels=${metrics.runner_labels.join(',') || 'none'}`);
    return { cancelled, runIds: candidates.map(r => r.id), metrics };
  };
}
module.exports = { DEFAULT_STALE_MS, reapCandidates, queueMetrics, createReaper, protectedShaSet };
