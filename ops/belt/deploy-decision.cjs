function deploymentDecision({ live_md5, last_deployed_md5, main_md5 }) {
  if (live_md5 === main_md5) return 'noop';
  if (live_md5 !== last_deployed_md5) return 'refuse';
  return 'deploy';
}

module.exports = { deploymentDecision };
