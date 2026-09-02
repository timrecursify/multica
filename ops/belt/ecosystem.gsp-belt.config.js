import path from 'node:path';
import { fileURLToPath } from 'node:url';
const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const guardrails = { min_uptime: 60000, max_restarts: 5, exp_backoff_restart_delay: 5000, autorestart: true, kill_timeout: 10000 };
const app = (name, script, extra = {}) => ({ name, script: path.join(release, script), cwd: release, ...guardrails, ...extra });
export default {
  apps: [
    app('gsp-multica-bridge', 'ops/belt/multica-bridge.cjs'),
    app('multica-relay-advance', 'ops/belt/parity/multica-relay-advance-wrapper.sh'),
    app('multica-cicd-worker', 'ops/belt/multica-cicd-worker.cjs'),
    app('multica-archiver', 'ops/belt/multica-archiver.cjs'),
    app('gsp-multica-worker', 'ops/belt/multica-daemon-wrapper.sh', { kill_timeout: 30000,
      env: { MULTICA_DAEMON_MAX_CONCURRENT_TASKS: process.env.MULTICA_DAEMON_MAX_CONCURRENT_TASKS ?? '20', MULTICA_DAEMON_WORKSPACES_ROOT: process.env.MULTICA_DAEMON_WORKSPACES_ROOT ?? '/home/newadmin/multica-workspaces-gsp' } },
    ), ],
};
