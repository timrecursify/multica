'use strict';
const assert = require('node:assert/strict');
const { DEFAULTS, resolvePaths, parseEnvFile } = require('../lib/runtime-paths.cjs');

const custom = resolvePaths({
  GSP_BELT_SECRETS_ENV_FILE: '/etc/gsp/multica/remote-bridge.env',
  GSP_BELT_PG_MODULE: '/opt/gsp/multica-workers/node_modules/pg',
  GSP_BELT_SECRETS_DIR: '/etc/gsp/multica',
  MULTICA_DAEMON_DIR: '/opt/gsp/multica-workers',
  GSP_WORKSPACES_ROOT: '/opt/gsp/multica-workspaces',
});
assert.deepEqual(custom, {
  secretsEnvFile: '/etc/gsp/multica/remote-bridge.env',
  pgModule: '/opt/gsp/multica-workers/node_modules/pg',
  secretsDir: '/etc/gsp/multica',
  daemonDir: '/opt/gsp/multica-workers',
  workspacesRoot: '/opt/gsp/multica-workspaces',
});
assert.deepEqual(resolvePaths({}), DEFAULTS);
assert.deepEqual(parseEnvFile('DATABASE_URL=postgres://example\n# ignored\nKEY=value'), {
  DATABASE_URL: 'postgres://example', KEY: 'value',
});
console.log('runtime path overrides and noc2 defaults: ok');
