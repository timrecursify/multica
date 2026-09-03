const assert = require('assert');
const { deploymentDecision } = require('./deploy-decision.cjs');

assert.equal(deploymentDecision({ live_md5: 'last', last_deployed_md5: 'last', main_md5: 'main' }), 'deploy');
assert.equal(deploymentDecision({ live_md5: 'main', last_deployed_md5: 'last', main_md5: 'main' }), 'noop');
assert.equal(deploymentDecision({ live_md5: 'local', last_deployed_md5: 'last', main_md5: 'main' }), 'refuse');
assert.equal(deploymentDecision({ live_md5: 'local', last_deployed_md5: undefined, main_md5: 'main' }), 'refuse');
console.log('deploy decision tests passed');
