#!/usr/bin/env node
// Production uses one operator-owned environment file and overlays its values
// on the inherited unit environment before starting the deployed daemon.
const fs = require('fs');
const { spawn } = require('child_process');

const CONFIG_PATH = '/etc/gsp/multica/multica-relay-advance.env';
const DAEMON_PATH = '/opt/gsp/multica-workers/multica-relay-advance/app/parity/multica-relay-advance-daemon.cjs';

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`${configPath} does not exist`);
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

function startDaemon({ env = process.env, spawnImpl = spawn, daemonPath = DAEMON_PATH, configPath = CONFIG_PATH } = {}) {
  const config = loadConfig(configPath);
  const child = spawnImpl('/usr/bin/node', [daemonPath], { env: { ...env, ...config }, stdio: 'inherit' });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  return child;
}

if (require.main === module) {
  try { startDaemon(); }
  catch (error) {
    console.error(`[relay-advance-launcher] FATAL: ${error.message}`);
    console.error(`[relay-advance-launcher] Remediation: correct ${CONFIG_PATH}, then restart once corrected.`);
    process.exitCode = 78;
  }
}

module.exports = { CONFIG_PATH, DAEMON_PATH, loadConfig, startDaemon };
