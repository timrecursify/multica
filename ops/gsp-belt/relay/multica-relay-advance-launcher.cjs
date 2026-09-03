#!/usr/bin/env node
// multica-relay-advance-launcher — reads operator secrets from GSP_BELT_ENV_FILE
// (or the escrow .env example) and spawns the relay-advance daemon from the
// same release directory this launcher was installed into. It is intentionally
// path-relative to __dirname so the same tracked source serves any immutable
// release checkout — no hard-coded host path, nothing to re-render on rollback.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function loadConfig(configPath) {
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
  return config;
}

function startDaemon({ env = process.env, spawnImpl = spawn, daemonPath = path.join(__dirname, 'multica-relay-advance-daemon.cjs') } = {}) {
  const configPath = env.GSP_BELT_ENV_FILE || path.join(__dirname, '..', '.env.example');
  const config = loadConfig(configPath);
  const child = spawnImpl('/usr/bin/node', [daemonPath], { env: { ...env, ...config }, stdio: 'inherit' });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  return child;
}

if (require.main === module) {
  try { startDaemon(); }
  catch (error) {
    console.error(`[relay-advance-launcher] FATAL: ${error.message}`);
    console.error('[relay-advance-launcher] Remediation: set GSP_BELT_ENV_FILE to an operator env file containing the required keys, then restart once corrected.');
    process.exitCode = 78;
  }
}

module.exports = { loadConfig, startDaemon };
