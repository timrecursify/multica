'use strict';

// The belt must not consume the operator's user quota.  This deliberately
// keeps the GitHub boundary small: every caller gets REST responses (including
// headers) and a file-backed circuit breaker shared by all belt processes.
const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

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

function credentialScope(env) {
  if (env.GITHUB_APP_INSTALLATION_ID) {
    return `app:${env.GITHUB_APP_ID || 'unknown'}:${env.GITHUB_APP_INSTALLATION_ID}`;
  }
  const token = env.GITHUB_APP_INSTALLATION_TOKEN || env.GH_TOKEN || '';
  return token ? `token:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 24)}` : 'default';
}

function createRateLimitState({ file = process.env.GITHUB_RATE_LIMIT_STATE_FILE || '/tmp/multica-github-rate-limit.json',
  scope = 'default', alert = () => {} } = {}) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; } };
  const write = value => { fs.mkdirSync(require('path').dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); };
  const scoped = root => root.scopes?.[scope] || (scope === 'default' && !root.scopes ? root : {});
  return {
    cooldown() { return Number(scoped(read()).cooldown_until || 0); },
    hold(until, remaining, reset) {
      const root = read();
      const s = { ...scoped(root) };
      s.cooldown_until = Math.max(Number(s.cooldown_until || 0), until);
      s.remaining = remaining; s.reset = reset;
      if (remaining < 500 && s.alerted_for_reset !== reset && reset) {
        s.alerted_for_reset = reset; alert({ remaining, reset, scope });
      }
      write({ ...root, scopes: { ...(root.scopes || {}), [scope]: s } });
      return s.cooldown_until;
    }
  };
}

function createTtlCache({ ttlMs, now = Date.now } = {}) {
  const values = new Map();
  const inFlight = new Map();
  const stats = { hits: 0, misses: 0, inFlightHits: 0 };
  async function get(key, loader) {
    const cached = values.get(key);
    if (cached && cached.expiresAt > now()) { stats.hits += 1; return cached.value; }
    if (inFlight.has(key)) { stats.inFlightHits += 1; return inFlight.get(key); }
    stats.misses += 1;
    let loaded;
    try { loaded = loader(); } catch (error) { loaded = Promise.reject(error); }
    const pending = Promise.resolve(loaded).then(value => {
      values.set(key, { value, expiresAt: now() + ttlMs });
      return value;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }
  return { get, stats };
}

async function defaultRun(args, options) {
  const result = await execFileAsync('gh', args, options);
  return result.stdout;
}

function rateLimitFacts(response) {
  const remaining = Number(response.headers['x-ratelimit-remaining']);
  const reset = Number(response.headers['x-ratelimit-reset']) * 1000;
  return { remaining, reset };
}

function createGithubApi({ env = process.env, run = defaultRun, state, alert = () => {}, now = Date.now,
  cache, cacheTtlMs = 0, tokenProvider } = {}) {
  const shared = state || createRateLimitState({ alert, scope: credentialScope(env) });
  const reads = cache || (cacheTtlMs > 0 ? createTtlCache({ ttlMs: cacheTtlMs, now }) : null);
  let installationToken = env.GITHUB_APP_INSTALLATION_TOKEN || '';
  let lastRateLimit = { remaining: null, reset: null };
  const stats = { externalCalls: 0, cacheHits: 0 };
  async function token() {
    if (tokenProvider) return tokenProvider();
    if (installationToken) return installationToken;
    const key = env.GITHUB_APP_PRIVATE_KEY || (env.GITHUB_APP_PRIVATE_KEY_FILE && fs.readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8'));
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_INSTALLATION_ID || !key) throw new Error('GitHub App configuration missing (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY[_FILE])');
    const jwt = appJwt({ appId: env.GITHUB_APP_ID, privateKey: key, now });
    stats.externalCalls += 1;
    const raw = await run(['api', '-i', '-X', 'POST', `app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`], { encoding: 'utf8', env: { ...env, GH_TOKEN: jwt } });
    const response = parseResponse(raw); const body = JSON.parse(response.body);
    if (!body.token) throw new Error('GitHub App installation token response did not contain token');
    installationToken = body.token;
    return installationToken;
  }
  async function fetchApi(path, args) {
    if (shared.cooldown() > now()) { const e = new Error('GitHub API rate limit cooldown'); e.rateLimited = true; throw e; }
    let raw;
    try {
      stats.externalCalls += 1;
      raw = await run(['api', '-i', ...args, path], { encoding: 'utf8', env: { ...env, GH_TOKEN: await token() } });
    } catch (error) {
      const response = parseResponse(`${error.stdout || ''}\n${error.stderr || ''}`);
      const { remaining, reset } = rateLimitFacts(response);
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
    const { remaining, reset } = rateLimitFacts(response);
    lastRateLimit = { remaining: Number.isFinite(remaining) ? remaining : null, reset: reset || null };
    if (Number.isFinite(remaining) && remaining < 500) shared.hold(reset || now() + 3600000, remaining, reset);
    if (remaining === 0 || /^403$/.test(response.headers['status'] || '')) { const e = new Error('GitHub API rate limit exceeded'); e.rateLimited = true; shared.hold(reset || now() + 3600000, remaining, reset); throw e; }
    return response.body.trim();
  }
  async function api(path, args = [], { cacheKey } = {}) {
    if (!reads || !cacheKey || args.includes('-X')) return fetchApi(path, args);
    const hits = reads.stats.hits + reads.stats.inFlightHits;
    const value = await reads.get(cacheKey, () => fetchApi(path, args));
    stats.cacheHits += reads.stats.hits + reads.stats.inFlightHits - hits;
    return value;
  }
  async function command(args, options = {}) {
    if (args[0] === 'api') {
      const path = args.find(a => typeof a === 'string' && (a.startsWith('repos/') || a.startsWith('app/')));
      // api() appends the path itself, so it must not also arrive in the extra
      // args. Leaving it in sent `gh api -i <path> <path>`, which gh rejects, so
      // every REST read the relay daemon made failed with an exit status and no
      // useful message.
      return api(path, args.slice(1).filter(a => a !== '-i' && a !== path), options);
    }
    if (args[0] === 'pr' && (args[1] === 'view' || args[1] === 'merge')) {
      const repo = args[args.indexOf('-R') + 1]; const num = args[2];
      if (!repo || !num) throw new Error('GitHub PR command missing repository');
      if (args[1] === 'view') return api(`repos/${repo}/pulls/${num}`);
      return api(`repos/${repo}/pulls/${num}/merge`, ['-X', 'PUT', '-f', 'merge_method=squash']);
    }
    throw new Error(`unsupported GitHub command: ${args.join(' ')}`);
  }
  return { api, command, token, state: shared, stats, appJwt,
    get rateLimit() { return { ...lastRateLimit }; } };
}

module.exports = { createGithubApi, createRateLimitState, createTtlCache, parseResponse, appJwt };
