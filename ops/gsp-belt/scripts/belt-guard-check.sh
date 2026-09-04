#!/bin/bash
# belt-guard-check — automated deployment guard. Fails when ANY of:
#   1. a manifest source is untracked or missing in the selected ref;
#   2. a deployed source differs from the selected Git ref (drift);
#   3. the ecosystem references an unmanaged home-directory script;
#   4. a secret-shaped value is embedded in tracked runtime/config;
#   5. deploy preflight/required env names are missing.
#
#   bash ops/gsp-belt/scripts/belt-guard-check.sh --checkout <dir> [--release <dir>]
#
# Exit 0 = all guards pass; exit 1 = a guard failed (details printed).
set -euo pipefail

checkout_root=""; release_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --checkout) checkout_root="$2"; shift 2;;
    --release) release_dir="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -n "$checkout_root" ]] || { echo "usage: belt-guard-check.sh --checkout DIR [--release DIR]" >&2; exit 2; }
if [[ -n "$release_dir" && ! -d "$release_dir" ]]; then echo "release dir missing: $release_dir" >&2; exit 1; fi

B_ROOT="$checkout_root/ops/gsp-belt"
fail=0

# 0. Manifest present.
MANIFEST="$B_ROOT/MANIFEST.md"
[[ -f "$MANIFEST" ]] || { echo "guard: MANIFEST missing: $MANIFEST"; fail=1; }

# 1. Every manifest source exists as a tracked file in the ref.
if [[ -f "$MANIFEST" ]]; then
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    if [[ ! -f "$checkout_root/$rel" ]]; then echo "guard[untracked/missing]: $rel"; fail=1; fi
  done < <(sed -nE 's/^\| `([^`]*)` .*/\1/p' "$MANIFEST" | sort -u)
fi

# 1b. Migration provenance must describe the exact tracked bytes.  The
# provenance table uses full SHA-256 values, so a documentation drift is a
# deploy-blocking failure rather than a misleading audit trail.
if [[ -f "$MANIFEST" ]]; then
  while IFS='|' read -r _ raw_file raw_hash _; do
    rel="$(echo "$raw_file" | tr -d ' `')"
    expected="$(echo "$raw_hash" | tr -d ' `')"
    [[ "$rel" == ops/gsp-belt/* && "$expected" =~ ^[0-9a-f]{64}$ ]] || continue
    actual="$(sha256sum "$checkout_root/$rel" | cut -d' ' -f1)"
    if [[ "$actual" != "$expected" ]]; then
      echo "guard[provenance]: $rel checksum differs from MANIFEST.md"
      fail=1
    fi
  done < "$MANIFEST"
fi

# 2. Deployed release matches source (drift), if a release is supplied.
if [[ -n "$release_dir" && -f "$MANIFEST" ]]; then
  sed -nE 's/^\| `([^`]*)` .*/\1/p' "$MANIFEST" | sort -u | while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    src="$checkout_root/$rel"; dep="$release_dir/ops/gsp-belt/${rel#ops/gsp-belt/}"
    if [[ ! -f "$dep" ]]; then echo "guard[drift]: deployed missing $rel"; return 1; fi
    if ! cmp -s "$src" "$dep"; then echo "guard[drift]: $rel deployed differs from source"; return 1; fi
  done
  [[ $? -eq 0 ]] || fail=1
fi

# 3. Ecosystem must not reference an unmanaged home-directory script.
ECO_TEMPLATE="$B_ROOT/fleet/ecosystem.gsp-belt.config.js.in"
if [[ -f "$ECO_TEMPLATE" ]]; then
  if grep -qE "/home/newadmin/[^'\"[:space:]]*\.(cjs|js|sh)" "$ECO_TEMPLATE"; then
    echo "guard[unmanaged-script]: ecosystem template references /home/newadmin script"
    fail=1
  fi
fi
# Also guard the rendered per-app wrapper/worker scripts: no tracked runtime
# file may reference /home/newadmin as an executable script path (unmanaged).
for f in "$B_ROOT"/fleet/*.sh "$B_ROOT"/relay/*.cjs "$B_ROOT"/relay/*.sh "$B_ROOT"/worker/*.cjs; do
  [[ -f "$f" ]] || continue
  if grep -qE "(exec|script)[[:space:]]*[:=]?[[:space:]]*/home/newadmin/.*\.(cjs|js|sh)" "$f"; then
    echo "guard[unmanaged-script]: $f references /home/newadmin script path"
    fail=1
  fi
done

# 4. No secret-shaped value embedded in tracked runtime/config.
SECRET_RE="(api[_-]?key|access[_-]?token|secret|password\b)[[:space:]]*=[[:space:]]*[A-Za-z0-9_+/=.-]{16,}"
secret_hits=$(grep -riInE --include='*.cjs' --include='*.js' --include='*.sh' --include='*.in' --include='*.json' \
  -E "$SECRET_RE" "$B_ROOT" 2>/dev/null \
  | grep -viE '\.env\.example|process\.env|config\[|\.env|getenv|RELAY_AGENT_SECRET|JWT_SECRET' \
  | grep -vE '/test/' || true)
if [[ -n "$secret_hits" ]]; then echo "guard[secret-embedded]:$secret_hits"; fail=1; fi

# 5. Required env names are present (deploy preflight compatibility).
REQUIRED="DATABASE_URL RELAY_AGENT_SECRET ARCHIVER_AGENT_SECRET GSP_WORKSPACE_ID MULTICA_WORKSPACE_ID"
for name in $REQUIRED; do
  if [[ -z "${!name:-}" ]]; then echo "guard[env-missing]: $name"; fail=1; fi
done

if [[ $fail -eq 0 ]]; then echo "guard: ALL CHECKS PASS"; else echo "guard: FAILED"; fi
exit $fail
