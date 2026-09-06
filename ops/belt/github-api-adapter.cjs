'use strict';

// The belt must not consume the operator's user quota.  This deliberately
// keeps the GitHub boundary small: every caller gets REST responses (including
// headers) and a file-backed circuit breaker shared by all belt processes.
const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

function parseResponse(raw) {
  const parts = String(raw).split(/\r?\n\r?\n/);
  const body = parts.pop() || '';
  const headers = Object.create(null);
  for (const line of parts.join('\n').split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}

function appJwt({ appId, privateKey, now = Date.now() }) {
  now = typeof now === 'function' ? now() : now;
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const payload = enc({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: appId });
  const input = `${head}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(input);
  return `${input}.${sign.sign(privateKey, 'base64url')}`;
}

function createRateLimitState({ file = process.env.GITHUB_RATE_LIMIT_STATE_FILE || '/tmp/multica-github-rate-limit.json', now = Date.now, alert = () => {} } = {}) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; } };
  const write = value => { fs.mkdirSync(require('path').dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); };
  return {
    cooldown() { const s = read(); return Number(s.cooldown_until || 0); },
    hold(until, remaining, reset) {
      const s = read();
      s.cooldown_until = Math.max(Number(s.cooldown_until || 0), until);
      s.remaining = remaining; s.reset = reset;
      if (remaining < 500 && !s.alerted_for_reset && reset) { s.alerted_for_reset = reset; alert({ remaining, reset }); }
      write(s);
      return s.cooldown_until;
    }
  };
}

function createGithubApi({ env = process.env, run = (args, options) => execFileSync('gh', args, options), state, alert = () => {}, now = Date.now } = {}) {
  const shared = state || createRateLimitState({ alert, now });
  let installationToken = env.GITHUB_APP_INSTALLATION_TOKEN || '';
  let lastRateLimit = { remaining: null, reset: null };
  function token() {
    if (installationToken) return installationToken;
    const key = env.GITHUB_APP_PRIVATE_KEY || (env.GITHUB_APP_PRIVATE_KEY_FILE && fs.readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8'));
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_INSTALLATION_ID || !key) throw new Error('GitHub App configuration missing (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY[_FILE])');
    const jwt = appJwt({ appId: env.GITHUB_APP_ID, privateKey: key, now });
    const raw = run(['api', '-i', '-X', 'POST', `app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`], { encoding: 'utf8', env: { ...env, GH_TOKEN: jwt } });
    const response = parseResponse(raw); const body = JSON.parse(response.body);
    if (!body.token) throw new Error('GitHub App installation token response did not contain token');
    installationToken = body.token;
    return installationToken;
  }
  function api(path, args = []) {
    if (shared.cooldown() > now()) { const e = new Error('GitHub API rate limit cooldown'); e.rateLimited = true; throw e; }
    let raw;
    try {
      raw = run(['api', '-i', ...args, path], { encoding: 'utf8', env: { ...env, GH_TOKEN: token() } });
    } catch (error) {
      const response = parseResponse(`${error.stdout || ''}\n${error.stderr || ''}`);
      const remaining = Number(response.headers['x-ratelimit-remaining']);
      const reset = Number(response.headers['x-ratelimit-reset']) * 1000;
      // Only an actual rate-limit signal may open the circuit. Matching a bare
      // "403" anywhere in the body held every belt process for a full hour on
      // an unrelated error: a hold was written with 7389 requests remaining on
      // 2026-09-06 and blocked every merged-PR check until the quota reset.
      const rateLimited = remaining === 0
        || /\brate limit\b|\bsecondary rate\b|\babuse detection\b/i.test(response.body);
      if (rateLimited) {
        shared.hold(reset || now() + 3600000, Number.isFinite(remaining) ? remaining : 0, reset);
        error.rateLimited = true;
      }
      throw error;
    }
    const response = parseResponse(raw);
    const remaining = Number(response.headers['x-ratelimit-remaining']);
    const reset = Number(response.headers['x-ratelimit-reset']) * 1000;
    lastRateLimit = { remaining: Number.isFinite(remaining) ? remaining : null, reset: reset || null };
    if (Number.isFinite(remaining) && remaining < 500) shared.hold(reset || now() + 3600000, remaining, reset);
    if (remaining === 0 || /^403$/.test(response.headers['status'] || '')) { const e = new Error('GitHub API rate limit exceeded'); e.rateLimited = true; shared.hold(reset || now() + 3600000, remaining, reset); throw e; }
    return response.body.trim();
  }
  function command(args) {
    if (args[0] === 'api') {
      const path = args.find(a => typeof a === 'string' && (a.startsWith('repos/') || a.startsWith('app/')));
      // api() appends the path itself, so it must not also arrive in the extra
      // args. Leaving it in sent `gh api -i <path> <path>`, which gh rejects, so
      // every REST read the relay daemon made failed with an exit status and no
      // useful message.
      return api(path, args.slice(1).filter(a => a !== '-i' && a !== path));
    }
    if (args[0] === 'pr' && (args[1] === 'view' || args[1] === 'merge')) {
      const repo = args[args.indexOf('-R') + 1]; const num = args[2];
      if (!repo || !num) throw new Error('GitHub PR command missing repository');
      if (args[1] === 'view') return api(`repos/${repo}/pulls/${num}`);
      return api(`repos/${repo}/pulls/${num}/merge`, ['-X', 'PUT', '-f', 'merge_method=squash']);
    }
    throw new Error(`unsupported GitHub command: ${args.join(' ')}`);
  }
  return { api, command, token, state: shared, appJwt, get rateLimit() { return { ...lastRateLimit }; } };
}

module.exports = { createGithubApi, createRateLimitState, parseResponse, appJwt };
