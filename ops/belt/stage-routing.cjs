const config = require('./stage-routing.json');

function globRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAny(path, globs) {
  return globs.some((glob) => globRegex(glob).test(path));
}

function classifyStageRoute({ repo, files, state }, rules = config) {
  const paths = (Array.isArray(files) ? files : [])
    .filter((path) => !matchesAny(path, rules.non_execution_paths || []));
  if (paths.some((path) => matchesAny(path, rules.risk_paths || []))) {
    return { kind: 'risk', toStage: 'In Review' };
  }
  const runtime = rules.repositories?.[repo]?.runtime_paths || [];
  if (paths.some((path) => matchesAny(path, runtime))) {
    return { kind: 'runtime', toStage: 'CI/CD & Deploy' };
  }
  if (state === 'MERGED') return { kind: 'merge_only', toStage: 'Done' };
  return { kind: 'merge_only', toStage: null, reason: 'non_runtime_pr_not_merged' };
}

module.exports = { classifyStageRoute, globRegex };
