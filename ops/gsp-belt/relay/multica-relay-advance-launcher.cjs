#!/usr/bin/env node
// multica-relay-advance-launcher — reads operator secrets from GSP_BELT_ENV_FILE
// (or the escrow .env example) and spawns the relay-advance daemon from the
// same release directory this launcher was installed into. It is intentionally
// path-relative to __dirname so the same tracked source serves any immutable
// release checkout — no hard-coded host path, nothing to re-render on rollback.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const configPath = process.env.GSP_BELT_ENV_FILE
  || path.join(__dirname, '..', '.env.example');
if (!fs.existsSync(configPath)) {
  throw new Error(`GSP_BELT_ENV_FILE ${configPath} does not exist; set it to the operator .env`);
}
const config = {};
for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue;
  const delimiter = line.indexOf('=');
  config[line.slice(0, delimiter)] = line.slice(delimiter + 1);
}
for (const key of ['DATABASE_URL', 'RELAY_AGENT_SECRET', 'GSP_WORKSPACE_ID']) {
  if (!config[key]) throw new Error(`${key} is missing from ${configPath}`);
}

const child = spawn('/usr/bin/node', [
  path.join(__dirname, 'multica-relay-advance-daemon.cjs'),
], { env: { ...process.env, ...config }, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
