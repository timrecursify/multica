'use strict';

const DEFAULTS = Object.freeze({
  secretsEnvFile: '/home/newadmin/.secrets/multica-remote/remote-bridge.env',
  pgModule: '/home/newadmin/node_modules/pg',
  secretsDir: '/home/newadmin/.secrets',
  daemonDir: '/home/newadmin/multica-daemon',
  workspacesRoot: '/home/newadmin/multica-workspaces-gsp',
});

function resolvePaths(env = process.env) {
  return {
    secretsEnvFile: env.GSP_BELT_SECRETS_ENV_FILE || DEFAULTS.secretsEnvFile,
    pgModule: env.GSP_BELT_PG_MODULE || DEFAULTS.pgModule,
    secretsDir: env.GSP_BELT_SECRETS_DIR || DEFAULTS.secretsDir,
    daemonDir: env.MULTICA_DAEMON_DIR || DEFAULTS.daemonDir,
    workspacesRoot: env.GSP_WORKSPACES_ROOT || env.GSP_BELT_WORKSPACES_ROOT || DEFAULTS.workspacesRoot,
  };
}

function parseEnvFile(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
}

module.exports = { DEFAULTS, resolvePaths, parseEnvFile };
