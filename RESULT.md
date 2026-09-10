Outcome: Implemented durable rollup dependencies and opened PR #775 at f41e1dd6f; merge is blocked only by the independently failing origin/main rec-2 expected-red contract, and no deployment or migration was performed.

Wakeup design
- Every advance and orphan-enqueue selector excludes any issue that has children, so a rollup cannot receive a paid builder.
- The bridge persists metadata.rollup_dependency with sorted child IDs/statuses, failed child IDs, a material-state version, retry condition, and reconciler as the named wakeup owner.
- Each reconciler cycle compares the durable child snapshot. A changed child state increments the version; the transaction that observes the last terminal child locks the parent and aggregates it exactly once.
- Cycles remain blocked and auditable. Failed/nonterminal children remain blocked. Once all children are terminal, the parent becomes Done if any child is Done; otherwise it becomes Cancelled.
- Relay responses are classified as accepted, accepted-deferred, refused, or failed. Accepted-deferred receipts remain pending with the returned version/time condition instead of becoming failures.

Live observation
- Before: 78 rollup_has_open_children events per 10 minutes at 2026-09-07 14:15Z, supplied in the lane measurement.
- Current read-only snapshot: 0 nonterminal parents with open children and 0 detected parent cycles.
- Current two-minute journal observation: 0 rollup_has_open_children events.
- Post-deploy after count: unverified because release is supervisor-owned and this lane was forbidden to deploy; the current zero cannot be attributed to unshipped code.

Verification
- Reconciler: 26/26 passed.
- Bridge: 112 passed, 4 intentional integration skips, 0 failed.
- Daemon rollup contracts: 3/3 passed.
- Unattended rollup lifecycle contract: passed.
- pnpm lint: passed with existing warnings only.
- PR CI: belt-runtime and scoped checks pass; unattended-lifecycle is red only on rec-2 fabricated-deployment-evidence XPASS. The same failure is present on origin/main run 34135530039, job 101785559133; PR rerun job 101792920445.

PR: https://github.com/timrecursify/multica/pull/775
