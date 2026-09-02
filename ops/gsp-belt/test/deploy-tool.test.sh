#!/bin/bash
# Behavioral test for gsp-belt-deploy.sh against a fake pm2 and a temp git host.
#   bash ops/gsp-belt/test/deploy-tool.test.sh
# Proves: (a) dry-run succeeds without mutating pm2 state; (b) missing-input /
# manifest refusals happen before any mutation; (c) a simulated reload/health
# failure triggers automatic rollback to the previous release dir.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy/gsp-belt-deploy.sh"
FAKE="$ROOT/test/fake-pm2.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export PM2="$FAKE"
export FAKE_PM2_STATE="$WORK/pm2.json"
# Initialize fake pm2 state (mirrors current home-directory install).
"$FAKE" jlist >/dev/null
export REQUIRED_ENV_NAMES="DATABASE_URL,RELAY_AGENT_SECRET,GSP_WORKSPACE_ID,MULTICA_WORKSPACE_ID"
export DATABASE_URL="postgres://test/multica"
export RELAY_AGENT_SECRET="test-relay"
export GSP_WORKSPACE_ID="00000000-0000-4000-8000-000000000001"
export MULTICA_WORKSPACE_ID="00000000-0000-4000-8000-000000000001"

# Set up a tiny git host representing the reviewed checkout.
HOST="$WORK/host"; RELEASE1="$WORK/releases/sha1"; RELEASE2="$WORK/releases/sha2"
mkdir -p "$HOST"
mkdir -p "$HOST/ops" && cp -R "$ROOT" "$HOST/ops/gsp-belt"
# The fixture is intentionally mutated to create bad and restored refs.  A
# managed clean checkout may be read-only, so make only this disposable copy
# writable; the source checkout remains untouched.
chmod -R u+w "$HOST/ops/gsp-belt"
git -C "$HOST" init -q
git -C "$HOST" add -A
git -C "$HOST" -c user.email=t@t -c user.name=t commit -qm base

sha1="$(git -C "$HOST" rev-parse HEAD)"

# --- (a) dry-run succeeds, pm2 untouched ---
export FAKE_FAIL_FLAG=""
if "$DEPLOY" --ref "$sha1" --checkout "$HOST" --release "$RELEASE1" --dry-run; then
  echo "PASS: dry-run exits 0"
else
  echo "FAIL: dry-run exit != 0"; cp "$FAKE_PM2_STATE" "$WORK/dry.json"; cat "$WORK/dry.json"; exit 1
fi
if python3 - "$FAKE_PM2_STATE" <<'PY'
import json,sys
apps=json.load(open(sys.argv[1]))
assert all(a['pm2_env']['pm_exec_path'].startswith('/old') for a in apps), apps
print("PASS: dry-run did not mutate pm2 state")
PY
then :; else echo "FAIL: dry-run mutated pm2 state"; exit 1; fi

# --- (b) --preflight enumerates without mutating ---
if "$DEPLOY" --ref "$sha1" --checkout "$HOST" --release "$RELEASE2" --preflight; then
  echo "PASS: preflight exits 0"
else
  echo "FAIL: preflight exit != 0"; exit 1
fi
if python3 - "$FAKE_PM2_STATE" <<'PY'
import json,sys
apps=json.load(open(sys.argv[1]))
assert all(a['pm2_env']['pm_exec_path'].startswith('/old') for a in apps), apps
print("PASS: preflight did not mutate pm2 state")
PY
then :; else echo "FAIL: preflight mutated pm2 state"; exit 1; fi

# --- (c) missing-input refusal happens BEFORE any mutation ---
# Remove a manifest-required file in a NEW ref and confirm deploy refuses.
git -C "$HOST" rm -q ops/gsp-belt/bridge/multica-bridge.cjs
git -C "$HOST" -c user.email=t@t -c user.name=t commit -qm "remove bridge"
badsha="$(git -C "$HOST" rev-parse HEAD)"
set +e
"$DEPLOY" --ref "$badsha" --checkout "$HOST" --release "$WORK/never" >"$WORK/missing.log" 2>&1
dep_rc=$?
set -e
if [[ $dep_rc -ne 0 ]] && grep -q "MANIFEST source untracked/missing" "$WORK/missing.log"; then
  echo "PASS: missing-input refused before mutation"
else
  echo "FAIL: missing-input not refused (rc=$dep_rc)"; cat "$WORK/missing.log"; exit 1
fi
if [[ ! -d "$WORK/never" ]]; then echo "PASS: release not created"; else echo "FAIL: release created despite refusal"; exit 1; fi

# Restore for the rollback case: the file was deleted by the "remove bridge"
# commit, so restore it from the parent revision.
prev="${badsha}^"
git -C "$HOST" checkout -q "$prev" -- ops/gsp-belt/bridge/multica-bridge.cjs
git -C "$HOST" add -A
git -C "$HOST" -c user.email=t@t -c user.name=t commit -qm "restore"
goodsha="$(git -C "$HOST" rev-parse HEAD)"

# --- (d) an uncommitted worktree divergence never reaches the release ---
printf '\n// UNCOMMITTED_WORKTREE_MARKER\n' >> "$HOST/ops/gsp-belt/worker/multica-cicd-worker.cjs"
printf '\n// UNCOMMITTED_TEMPLATE_MARKER\n' >> "$HOST/ops/gsp-belt/fleet/ecosystem.gsp-belt.config.js.in"

# --- (e) successful deploy: apps resolve into selected immutable release ---
unset FAKE_FAIL_FLAG
if "$DEPLOY" --ref "$goodsha" --checkout "$HOST" --release "$RELEASE1"; then
  echo "PASS: deploy exits 0"
else
  echo "FAIL: deploy exit != 0"; exit 1
fi
if ! grep -q "UNCOMMITTED_WORKTREE_MARKER" "$RELEASE1/ops/gsp-belt/worker/multica-cicd-worker.cjs" \
  && ! grep -q "UNCOMMITTED_TEMPLATE_MARKER" "$RELEASE1/ops/gsp-belt/fleet/ecosystem.gsp-belt.config.js.in" \
  && ! grep -q "UNCOMMITTED_TEMPLATE_MARKER" "$RELEASE1/ops/gsp-belt/fleet/ecosystem.gsp-belt.config.js"; then
  echo "PASS: release bytes came from committed ref, not worktree"
else
  echo "FAIL: uncommitted worktree bytes reached release"; exit 1
fi
python3 - "$FAKE_PM2_STATE" "$RELEASE1" <<'PY'
import json,sys
apps=json.load(open(sys.argv[1]))
rel=sys.argv[2]
for a in apps:
    assert a['pm2_env']['pm_exec_path'].startswith(rel), (a['name'], a['pm2_env']['pm_exec_path'])
print("PASS: all apps resolve into selected release")
PY

# --- (f) simulated reload failure triggers automatic rollback ---
export FAKE_FAIL_FLAG="$WORK/failflag"
if "$DEPLOY" --ref "$goodsha" --checkout "$HOST" --release "$RELEASE2" >"$WORK/rollback.log" 2>&1; then
  echo "NOTE: deploy unexpectedly succeeded despite simulated failure; inspecting"
  cat "$WORK/rollback.log"
  exit 1
fi
grep -q "ROLLBACK" "$WORK/rollback.log" || { echo "FAIL: no rollback marker"; cat "$WORK/rollback.log"; exit 1; }
echo "PASS: simulated failure produced a rollback marker in output"
python3 - "$FAKE_PM2_STATE" "$RELEASE1" <<'PY'
import json,sys
apps=json.load(open(sys.argv[1]))
rel=sys.argv[2]
# A healthy status alone would not prove rollback: each app must again consume
# the exact paths captured before the failed release2 reload.
for a in apps:
    assert a['pm2_env']['status'] == 'online', a
    assert a['pm2_env']['pm_exec_path'].startswith(rel), (a['name'], a['pm2_env']['pm_exec_path'])
print("PASS: apps online and restored to the prior release paths")
PY

echo ""
echo "ALL DEPLOY-TOOL TESTS PASSED"
exit 0
