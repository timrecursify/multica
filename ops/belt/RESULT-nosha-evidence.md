# NO-SHA completion evidence findings

## Batch 1: baseline verification

- `origin/main` is `2615b57a73130a0f63df21f644a8d9dde49e2ddf`; work is on `fix/nosha-real-evidence`.
- `multica-bridge.cjs` lines 1900-1918 require a no-PR Done request to carry no changed files, `noDeployRoute: 'no_pr'`, and `workProductEvidence` containing `NO-SHA`; the gate remains untouched.
- `multica-relay-advance-daemon.cjs` currently derives `NO-SHA` from task-result/comment prose and does not send `checkoutClean` or `changedFiles` for the no-PR route.
- `buildCompletionRoute` checks linked PR records and recent comment URLs before returning `no_pr`, but it does not independently inspect the checkout.

## Batch 2: implementation and first focused test

- The daemon now marks `no_pr` as verified only after route discovery finds neither a linked PR nor a PR URL in recent issue comments.
- Completion evidence no longer trusts `NO-SHA` in worker results or comments. It inspects `git status --porcelain --untracked-files=all`, sends the observed `checkoutClean` and `changedFiles`, and emits its own `NO-SHA` attestation only for a verified no-PR route with an observed clean checkout and zero changed files.
- The first focused test invocation did not run because this checkout has no installed `pg` package (`MODULE_NOT_FOUND`); this is an environment/dependency precondition, not a test assertion failure.

## Batch 3: dependency setup and daemon suite

- `pnpm install --frozen-lockfile` completed without lockfile changes.
- The daemon suite executed 112 tests: 90 passed, 7 failed, and 15 skipped. Five failures require the unavailable PostgreSQL fixture at `127.0.0.1:15436`; one existing transition-policy matrix assertion and one source-shape assertion failed.
- The source-shape failure was caused by inserting `noPrVerified` between the legacy `kind` and `toStage` properties; their original adjacency is restored. The new clean/dirty evidence tests passed.

## Batch 4: focused and bridge verification

- Focused daemon tests passed: 4/4, covering clean no-PR evidence, dirty checkout refusal evidence, an open PR not being classified `no_pr`, and the existing direct-Done route contract.
- Bridge tests matched the stated baseline exactly: 129 tests, 125 passed and the four known database-dependent tests failed (comment-reply lifetime cap, two concurrency tests, operator Human Review release). No bridge gate file was changed.
- Syntax validation and `git diff --check` passed.
- The checkout inspector defaults to the explicit belt/source checkout environment when provided and otherwise the launcher's inherited working directory; it does not inspect the copied non-git runtime bundle.

## Batch 5: delivery

- Commit `f0ee8651b` was pushed on `fix/nosha-real-evidence` and PR #876 was opened against `main`.
- No deployment, merge, configuration change, database write, or credential rotation was performed.
