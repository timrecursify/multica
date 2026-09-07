const { execFileSync } = require('child_process');

const DEFAULT_HELPER = '/usr/local/bin/gsp-belt-git-credential';
let failureLogged = false;

function mintGithubToken(repo) {
  const helper = process.env.GSP_BELT_GIT_CREDENTIAL || DEFAULT_HELPER;
  try {
    const output = execFileSync(helper, ['token', repo], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1e6
    });
    const token = String(output).trim().split(/\r?\n/)[0] || '';
    if (token) return token;
    if (!failureLogged) { console.error(`[github-token] ${helper} returned no token for ${repo}`); failureLogged = true; }
  } catch (error) {
    if (!failureLogged) {
      const detail = error && error.message ? error.message : error;
      console.error(`[github-token] ${helper} mint failed for ${repo}: ${String(detail).slice(0, 200)}`);
      failureLogged = true;
    }
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
