const path = require('path');
const guardrails = { min_uptime: 60000, max_restarts: 5, exp_backoff_restart_delay: 5000, autorestart: true, kill_timeout: 10000 };
const relayWrapper = path.resolve(__dirname, '../gsp-belt/relay/multica-relay-advance-wrapper.sh');
const runtimeRoot = process.env.BELT_RUNTIME_ROOT ?? '/var/lib/gsp';
const beltRoot = process.env.BELT_SOURCE_ROOT ?? path.resolve(__dirname);
// Must stay byte-identical to BELT_CANONICAL_WORKSPACES_ROOT in workspace-root.sh:
// the wrapper refuses any workspace root that is not the canonical one (exit 64).
// It is deliberately not derived from runtimeRoot -- it is pinned under the belt
// service user HOME so the gsp desk gate admits the per-ticket workdirs.
const CANONICAL_WORKSPACES_ROOT = '/var/lib/gsp-multica/dev/workspaces';
module.exports = {
  apps: [
    { name: 'gsp-multica-bridge', script: path.join(runtimeRoot, 'gsp-multica/multica-bridge.cjs'), ...guardrails },
    { name: 'multica-cicd-worker', script: path.join(runtimeRoot, 'multica-cicd-worker.cjs'), ...guardrails },
    { name: 'multica-archiver', script: path.join(runtimeRoot, 'multica-archiver.cjs'), ...guardrails },
    { name: 'merged-pr-recovery-sweep', script: path.join(runtimeRoot, 'merged-pr-recovery-sweep.cjs'), ...guardrails },
    { name: 'multica-relay-advance', script: relayWrapper, ...guardrails,
      env: { GSP_BELT_ENV_FILE: process.env.GSP_BELT_ENV_FILE } },
    { name: 'gsp-multica-worker', script: process.env.BELT_WORKER_SCRIPT ?? path.join(runtimeRoot, 'gsp-multica/fleet/multica-daemon-wrapper.sh'), ...guardrails, kill_timeout: 30000,
      env: { MULTICA_DAEMON_MAX_CONCURRENT_TASKS: process.env.MULTICA_DAEMON_MAX_CONCURRENT_TASKS, MULTICA_DAEMON_WORKSPACES_ROOT: process.env.MULTICA_DAEMON_WORKSPACES_ROOT ?? process.env.GSP_WORKSPACES_ROOT ?? CANONICAL_WORKSPACES_ROOT, BELT_SOURCE_ROOT: beltRoot } },
  ],
};
