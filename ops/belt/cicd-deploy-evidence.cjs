const fs = require('fs');
const { execFileSync } = require('child_process');

const beltReceiptDir = '/home/newadmin/gsp-multica/deploy-receipts';
const beltVerify = '/home/newadmin/gsp-multica/ops/belt/verify.sh';
const backendContainer = 'gsp-multica-v2-backend-1';
const skCheckout = process.env.CICD_SK_CHECKOUT || '/home/newadmin/worktrees/fcicd';

function command(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 20000 }).trim();
}

function newer(path, mergedAt, stat = fs.statSync) {
  try { return stat(path).mtimeMs > Date.parse(mergedAt); } catch (_) { return false; }
}

function skInstalled(mergeSha, run = command) {
  try {
    const installed = run('sk', ['--version']).match(/\b[0-9a-f]{7,40}\b/i)?.[0];
    return !!installed && !run('git', ['-C', skCheckout, 'merge-base', '--is-ancestor', mergeSha, installed]);
  } catch (_) { return false; }
}

function multicaInstalled(pr, run = command, stat = fs.statSync, read = fs.readdirSync) {
  let files = [];
  try { files = JSON.parse(run('gh', ['api', `repos/${pr.repo}/pulls/${pr.num}/files?per_page=100`])).map(f => f.filename); }
  catch (_) { return false; }
  const belt = files.some(f => f.startsWith('ops/belt/'));
  const app = files.some(f => /^(api|server|web)\//.test(f));
  if (belt) {
    try {
      if (read(beltReceiptDir).some(name => newer(`${beltReceiptDir}/${name}`, pr.mergedAt, stat))) return true;
    } catch (_) { /* no receipt */ }
    if (newer(beltVerify, pr.mergedAt, stat)) return true;
  }
  if (!app) return false;
  try {
    const image = run('docker', ['inspect', '--format', '{{.Image}}', backendContainer]);
    return Date.parse(run('docker', ['image', 'inspect', '--format', '{{.Created}}', image])) > Date.parse(pr.mergedAt);
  } catch (_) { return false; }
}

function deployed(pr, dependencies = {}) {
  const run = dependencies.run || command;
  if (pr.repo === 'timrecursify/sk-cli') return skInstalled(pr.mergeCommit.oid, run);
  if (pr.repo === 'timrecursify/multica') return multicaInstalled(pr, run, dependencies.stat, dependencies.read);
  return false;
}

module.exports = { deployed, skInstalled, multicaInstalled };
