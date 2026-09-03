const guardrails = { min_uptime: 60000, max_restarts: 5, exp_backoff_restart_delay: 5000, autorestart: true, kill_timeout: 10000 };
module.exports = {
  apps: [
    { name: 'gsp-multica-bridge', script: '/home/newadmin/gsp-multica/multica-bridge.cjs', ...guardrails },
    { name: 'multica-cicd-worker', script: '/home/newadmin/multica-cicd-worker.cjs', ...guardrails },
    { name: 'multica-archiver', script: '/home/newadmin/multica-archiver.cjs', ...guardrails },
    { name: 'merged-pr-recovery-sweep', script: '/home/newadmin/merged-pr-recovery-sweep.cjs', ...guardrails },
    { name: 'gsp-multica-worker', script: '/home/newadmin/gsp-multica/fleet/multica-daemon-wrapper.sh', ...guardrails, kill_timeout: 30000,
      env: { MULTICA_DAEMON_MAX_CONCURRENT_TASKS: process.env.MULTICA_DAEMON_MAX_CONCURRENT_TASKS ?? '32', MULTICA_DAEMON_WORKSPACES_ROOT: process.env.MULTICA_DAEMON_WORKSPACES_ROOT ?? '/home/newadmin/multica-workspaces-gsp' } },
  ],
};
