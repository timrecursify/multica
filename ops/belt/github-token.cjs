const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_HELPER = '/usr/local/bin/gsp-belt-git-credential';
let failureLogged = false;
// '' means "not pinned": keep inheriting the unit's $HOME. A non-empty value is
// the fallback home a previous mint had to fall back to, reused from then on so
// a broken $HOME cache costs one extra mint per process, not one per call.
let pinnedHome = '';
let discoveredHome;

// The helper caches every minted token under $HOME/.cache, and it runs
// `set -euo pipefail`. A unit hardened with ProtectSystem=strict gets a
// read-only $HOME unless the unit names it in ReadWritePaths, so the cache
// write fails *after* the token was minted: the helper aborts non-zero, the
// mint reports failure, and the caller falls back to an unauthenticated `gh`
// that answers "To get started with GitHub CLI, please run: gh auth login".
// multica-relay-advance carries the ReadWritePaths grant; multica-cicd-worker
// carries only /var/lib/gsp-multica/runtime/receipts, so its every cold-cache
// `gh api` failed that way. Retry against a directory this process can really
// write, so the credential path stops depending on a unit-file grant.
function writableCacheHome() {
  if (discoveredHome !== undefined) return discoveredHome;
  discoveredHome = '';
  for (const dir of [process.env.GSP_BELT_TOKEN_CACHE_HOME, process.env.MULTICA_RECEIPT_ROOT, os.tmpdir()]) {
    if (!dir || dir === process.env.HOME) continue;
    try {
      const cache = path.join(dir, '.cache');
      fs.mkdirSync(cache, { recursive: true });
      fs.accessSync(cache, fs.constants.W_OK);
      discoveredHome = dir;
      break;
    } catch (_) { /* unwritable too; try the next candidate */ }
  }
  return discoveredHome;
}

function runHelper(helper, repo, home) {
  const output = execFileSync(helper, ['token', repo], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1e6,
    ...(home ? { env: { ...process.env, HOME: home } } : {})
  });
  return String(output).trim().split(/\r?\n/)[0] || '';
}

function mintGithubToken(repo) {
  const helper = process.env.GSP_BELT_GIT_CREDENTIAL || DEFAULT_HELPER;
  const fallback = writableCacheHome();
  const homes = pinnedHome ? [pinnedHome] : ['', ...(fallback ? [fallback] : [])];
  let detail = 'returned no token';
  for (const home of homes) {
    try {
      const token = runHelper(helper, repo, home);
      if (token) {
        if (home) pinnedHome = home;
        failureLogged = false;
        return token;
      }
    } catch (error) {
      detail = error && error.message ? error.message : error;
    }
  }
  if (!failureLogged) {
    console.error(`[github-token] ${helper} mint failed for ${repo}: ${String(detail).slice(0, 200)}`);
    failureLogged = true;
  }
  return '';
}

function repoFromGhArgs(args) {
  for (const arg of args || []) {
    const match = String(arg).match(/(?:^|\/)repos\/[^/]+\/([\w.-]+)(?:\/|$)/);
    if (match) return match[1];
  }
  const index = (args || []).indexOf('-R');
  if (index >= 0 && args[index + 1]) {
    const parts = String(args[index + 1]).split('/');
    if (parts.length === 2 && /^[\w.-]+$/.test(parts[1])) return parts[1];
  }
  return '';
}

module.exports = { mintGithubToken, repoFromGhArgs };
