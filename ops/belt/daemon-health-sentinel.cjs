'use strict';

const fs = require('fs');

const DEFAULT_WINDOW_MINUTES = 5;

function evaluateDaemonHealth(row, state = {}, options = {}) {
  const now = options.now == null ? Date.now() : options.now;
  const windowMs = (options.windowMinutes || DEFAULT_WINDOW_MINUTES) * 60 * 1000;
  const stalled = Number(row.queued || 0) > 0 && Number(row.dispatched || 0) + Number(row.running || 0) === 0;
  const next = { ...state };
  if (!stalled) return { stalled: false, alert: null, state: {} };
  const since = state.since == null ? now : state.since;
  next.since = since;
  if (now - since < windowMs || state.alerted) return { stalled: true, alert: null, state: next };
  next.alerted = true;
  return { stalled: true, state: next, alert: {
    type: 'daemon_stalled_queue', queued: Number(row.queued || 0),
    dispatched: Number(row.dispatched || 0), running: Number(row.running || 0),
    sustainedMinutes: options.windowMinutes || DEFAULT_WINDOW_MINUTES
  } };
}

async function runDaemonHealthSentinel(client, options = {}) {
  const result = await client.query(`SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
       count(*) FILTER (WHERE status = 'dispatched')::int AS dispatched,
       count(*) FILTER (WHERE status = 'running')::int AS running
       FROM agent_task_queue`);
  const state = options.state || {};
  const evaluation = evaluateDaemonHealth((result.rows || [])[0] || {}, state, options);
  if (evaluation.alert && typeof options.emitAlert === 'function') await options.emitAlert(evaluation.alert);
  return evaluation;
}

async function main() {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const stateFile = process.env.MULTICA_DAEMON_HEALTH_STATE || '/var/lib/multica/daemon-health.json';
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  try {
    const evaluation = await runDaemonHealthSentinel(client, {
      state, windowMinutes: Number(process.env.MULTICA_DAEMON_STALL_MINUTES || DEFAULT_WINDOW_MINUTES),
      emitAlert: (alert) => process.stdout.write(`${JSON.stringify(alert)}\n`)
    });
    fs.mkdirSync(require('path').dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(evaluation.state));
  } finally { await client.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { DEFAULT_WINDOW_MINUTES, evaluateDaemonHealth, runDaemonHealthSentinel };
