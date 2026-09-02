'use strict';
// Shim: the canonical relay-advance daemon lives at ops/belt/parity (see ops/gsp-belt/MANIFEST.md).
// Keeping one implementation guarantees RECONCILE_DISPATCH_HOLD and v3 routing apply on every launch path (GSP-1825).
const daemon = require('../../belt/parity/multica-relay-advance-daemon.cjs');
if (require.main === module) daemon.startDaemon();
module.exports = daemon;
