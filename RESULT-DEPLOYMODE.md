# Deploy mode/ownership defect

## Step 1 — source and coordination

- Observed: `origin/main` was fetched and branch `fix/belt-deploy-runtime-file-perms` was created from it.
- Observed: cited `ops/belt/deploy.sh` ranges matched the reported defect; ordinary targets had no ownership/mode normalization after `cp --preserve=mode`.
- Observed: the existing `systemd-active-mainpid-runtime-parity-v1` probe was not changed.
- Unverified: no other deploy path writes managed runtime targets; falsifying check: `git grep` of all target writes in `ops/belt/deploy.sh` (completed; copy, rollback, backup, and receipt paths were identified).

## Step 2 — deployed metadata

- Observed: `/etc/systemd/system/multica-relay-advance.service` declares `User=gsp-multica` and `Group=gsp-multica`; `systemctl show` reports the same for bridge and relay.
- Observed: current deployed regular runtime files are service-readable, with `.cjs`/data files observed at `0644`; the deployed relay launcher is `0755`.
- Observed: current runtime directories are not a safe ownership reference (`gsp-multica-bridge` and `multica-cicd-worker` directories are root-owned), so the fix uses the verified explicit service owner/group.
- Observed: the requested bridge-side `human-review-routing.cjs` path was absent on the live host; the relay-side path was likewise not present in the examined target set. This does not falsify the service identity or the existing-file metadata.

## Step 3 — implementation and checks

- Changed `ops/belt/deploy.sh:509-515`: every ordinary runtime target is now explicitly `chown gsp-multica:gsp-multica`; shell launchers use observed `0755`, other runtime files use observed `0644`.
- Changed `ops/belt/deploy.sh:531-539`: before any restart, each selected target is tested for readability as `gsp-multica`; failure diagnostic is exactly `Pre-restart readability check failed: gsp-multica cannot read <path>`.
- Observed: `bash -n ops/belt/deploy.sh` passed.
- Observed: `shellcheck ops/belt/deploy.sh` completed with pre-existing warnings (SC1091, SC2154, SC2004); no new syntax error was reported.
- Observed: `timeout --foreground --kill-after=5 45 ops/belt/deploy.test.sh` passed; TAP reported 56 tests, 0 failures.
