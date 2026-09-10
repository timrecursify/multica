# Bridge Fix 3 Results

## Batch 1

- Verified: run `34481739633` job `102885956516` is `belt-runtime` and failed; its failed log is unavailable while the run remains in progress.
- Changed: widened `/relay/advance` issue identifier validation to accept hexadecimal UUID-shaped identifiers without RFC 4122 version/variant restrictions, including the legacy 13-digit ticket-form fixture, while retaining rejection of non-shaped input and workspace scoping for decimal ticket numbers.
- Changed: preserved UUID resolution through the issue lookup and did not modify the lifetime budget exemption.
- Commands: `node --check ops/belt/multica-bridge.cjs`; `NODE_PATH=/home/newadmin/belt-check/multica/node_modules node --test ops/belt/multica-bridge.test.cjs --test-name-pattern='same-stage replay|capped Spec re-entry'`.
- Outcome: targeted same-stage replay and capped Spec re-entry tests passed; full suite comparison is 128 passed / 5 failed after versus the mapped 8 failures before. Remaining failures include unavailable integration database and one unrelated source-pattern assertion.
- Assumption: the 13-digit legacy ticket-form identifier is a legitimate compatibility shape; falsifier: a production caller or database fixture demonstrates it must be rejected or cannot resolve through the existing issue lookup.

## Batch 2

- Verified: commit `6d52595fc7145c3d0fff51697f3fbebe4a61446b` is pushed to PR 940’s existing branch.
- Verified: CI run `34482675075` was created for that exact commit and is pending.
- Assumption: CI will validate the compatibility branch against its service database; falsifier: the belt-runtime job fails on the identifier-shape, same-stage, or capped-Spec cases.
