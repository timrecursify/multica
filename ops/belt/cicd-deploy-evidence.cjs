const fs = require('fs');
const { execFileSync } = require('child_process');

const beltReceiptDir = process.env.CICD_BELT_RECEIPT_DIR || '/var/lib/gsp/gsp-multica/deploy-receipts';
const backendContainer = 'gsp-multica-v2-backend-1';
// This is an owned, fetched sk-cli clone, deliberately not the Multica worktree.
const skCheckout = process.env.CICD_SK_CHECKOUT || '/var/lib/gsp/worktrees/sk-cli-cicd';
const multicaCheckout = process.env.CICD_MULTICA_CHECKOUT || __dirname + '/../..';

function command(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 20000 }).trim();
}

function skInstalled(mergeSha, run = command) {
  try {
    const installed = run('sk', ['--version']).match(/\b[0-9a-f]{7,40}\b/i)?.[0];
    return !!installed && !run('git', ['-C', skCheckout, 'merge-base', '--is-ancestor', mergeSha, installed]);
  } catch (_) { return false; }
}

function receiptContainsMerge(pr, run, read = fs.readdirSync, readFile = fs.readFileSync) {
  try {
    return read(beltReceiptDir).some(name => {
      const receipt = JSON.parse(readFile(`${beltReceiptDir}/${name}`, 'utf8'));
      return receipt.repo === pr.repo && receipt.outcome !== 'refused' && receipt.source_sha &&
        !run('git', ['-C', multicaCheckout, 'merge-base', '--is-ancestor', pr.mergeCommit.oid, receipt.source_sha]);
    });
  } catch (_) { return false; }
}

function multicaInstalled(pr, run = command, read = fs.readdirSync, readFile = fs.readFileSync) {
  let files = [];
  try { files = JSON.parse(run('gh', ['api', `repos/${pr.repo}/pulls/${pr.num}/files?per_page=100`])).map(f => f.filename); }
  catch (_) { return false; }
  const belt = files.some(f => f.startsWith('ops/belt/'));
  // Monorepo deployable application paths are server/ and apps/web/.
  const app = files.some(f => /^(server|apps\/web)\//.test(f));
  if (belt && receiptContainsMerge(pr, run, read, readFile)) return true;
  if (!app) return false;
  try {
    const image = run('docker', ['inspect', '--format', '{{.Image}}', backendContainer]);
    return Date.parse(run('docker', ['image', 'inspect', '--format', '{{.Created}}', image])) > Date.parse(pr.mergedAt);
  } catch (_) { return false; }
}

function deployed(pr, dependencies = {}) {
  const run = dependencies.run || command;
  if (pr.repo === 'timrecursify/sk-cli') return skInstalled(pr.mergeCommit.oid, run);
  if (pr.repo === 'timrecursify/multica') return multicaInstalled(pr, run, dependencies.read, dependencies.readFile);
  return false;
}

module.exports = { deployed, skInstalled, multicaInstalled, receiptContainsMerge };
