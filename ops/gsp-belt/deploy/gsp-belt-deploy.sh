#!/bin/bash
# GSP belt deploy / cutover — immutable release selection with preflight + rollback.
#
#   bash gsp-belt-deploy.sh --ref <commit> [--checkout <dir>] [--release <dir>]
#                          [--preflight] [--dry-run]
#
# Semantics:
#   * RELEASE selection is immutable; the ONLY thing a deploy changes is which
#     release the GSP belt PM2 apps execute from.
#   * Every manifest file and required env name is validated BEFORE any PM2
#     mutation. --preflight enumerates all affected apps/files and stops without
#     touching PM2.
#   * Before mutating, the current pm2 script path of every in-scope app is
#     captured. On reload or health-verification failure those previous paths are
#     re-materialized as an ecosystem and the apps reload again — rollback is a
#     script-path selection, never restoration from .bak files.
#   * --ref may be a commit, branch, or tag; resolved to an immutable SHA. The
#     release dir defaults to <checkout>/releases/<sha>, so rolling back is
#     "select a prior ref" = a different release dir.
#
# Runtime is installed from an arbitrary checkout by copying ops/gsp-belt into a
# stable release dir. All tracked scripts are self-relative; only the rendered
# ecosystem (and env variables) pin the actual release path at runtime.
set -euo pipefail

PM2="${PM2:-pm2}"
MANIFEST_REL="ops/gsp-belt/MANIFEST.md"
RENDERED_ECO_REL="ops/gsp-belt/fleet/ecosystem.gsp-belt.config.js"
ECO_TEMPLATE_REL="ops/gsp-belt/fleet/ecosystem.gsp-belt.config.js.in"
FINGERPRINT_REL="ops/gsp-belt/scripts/belt-fingerprint.sh"
APPS_DEFAULT="gsp-multica-bridge,gsp-multica-worker,multica-cicd-worker,multica-archiver,multica-relay-advance"
REQUIRED_ENV_NAMES_DEFAULT="DATABASE_URL,RELAY_AGENT_SECRET,GSP_WORKSPACE_ID,MULTICA_WORKSPACE_ID"

checkout_root=""; release_dir=""; do_preflight=false; do_dryrun=false; ref=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) ref="$2"; shift 2;;
    --release) release_dir="$2"; shift 2;;
    --checkout) checkout_root="$2"; shift 2;;
    --preflight) do_preflight=true; shift;;
    --dry-run) do_dryrun=true; shift;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; sed -n '2,20p' "$0"; exit 2;;
  esac
done
[[ -n "$ref" ]] || { echo "Error: --ref is required" >&2; exit 2; }
if [[ -z "$checkout_root" ]]; then
  checkout_root="$(cd "$(dirname "$0")/../../.." && pwd)"
fi

REQUIRED_ENV_NAMES="${REQUIRED_ENV_NAMES:-$REQUIRED_ENV_NAMES_DEFAULT}"
APPS="${APPS:-$APPS_DEFAULT}"
IFS=',' read -r -a app_arr <<< "$APPS"

# The env file is operator-controlled and may contain secrets.  Load it only
# into this process so preflight can validate names without printing values.
if [[ -n "${GSP_BELT_ENV_FILE:-}" ]]; then
  [[ -r "$GSP_BELT_ENV_FILE" ]] || { echo "Error: GSP_BELT_ENV_FILE is not readable" >&2; exit 2; }
  set -a
  # shellcheck disable=SC1090
  source "$GSP_BELT_ENV_FILE"
  set +a
fi

# ---- resolve immutable source ref ----
if ! (cd "$checkout_root" && git rev-parse --verify --quiet "$ref^{commit}" >/dev/null); then
  echo "Error: ref '$ref' is not a commit in $checkout_root" >&2; exit 2
fi
commit_sha="$(cd "$checkout_root" && git rev-parse "$ref^{commit}")"
echo "source commit     = $commit_sha"

# ---- validate manifest + required env names BEFORE any mutation ----
echo "== validation (no PM2 mutation yet) =="
fail=0
for base in "$MANIFEST_REL" "$ECO_TEMPLATE_REL" "$FINGERPRINT_REL"; do
  [[ -f "$checkout_root/$base" ]] || { echo "  REQUIRED MISSING: $base"; fail=1; }
done
mapfile -t manifest_files < <(sed -nE 's/^\| `([^`]*)` .*/\1/p' "$checkout_root/$MANIFEST_REL" 2>/dev/null | sort -u)
for rel in "${manifest_files[@]}"; do
  [[ -n "$rel" ]] || continue
  [[ -f "$checkout_root/$rel" ]] || { echo "  MANIFEST source untracked/missing: $rel"; fail=1; }
done
for name in ${REQUIRED_ENV_NAMES//,/ }; do
  [[ -n "${!name:-}" ]] || { echo "  env missing: $name"; fail=1; }
done
if [[ $fail -ne 0 ]]; then echo "PREFLIGHT FAILED — no mutation performed"; exit 1; fi

if [[ -z "$release_dir" ]]; then release_dir="$checkout_root/releases/$commit_sha"; fi
echo "release dir       = $release_dir"
echo "affected apps     = ${app_arr[*]}"
echo "manifest files    = ${#manifest_files[@]}"

# Enumerate the files each app's script resolves to within the release, for the
# preflight summary (read-only).
list_release_files() {
  local base="$1"
  local r
  for r in "${manifest_files[@]}"; do
    [[ -n "$r" ]] || continue
    echo "  $base/${r#ops/gsp-belt/}"
  done
}

if $do_preflight; then
  echo "affected files (inside release):"
  list_release_files "$release_dir"
  echo ""
  echo "PREFLIGHT OK — apps/files enumerated; PM2 untouched."
  exit 0
fi

# Dry-run proves the source/ref and validation path without creating a release
# or changing PM2.  This also makes it safe to run from a read-only checkout.
if $do_dryrun; then
  echo "DRY-RUN OK — no release or PM2 state changed."
  exit 0
fi

# ---- capture current (prior) script paths BEFORE mutating anything ----
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/gsp-belt-deploy.XXXXXX")"
trap 'rm -rf "$state_dir"' EXIT
prior_json="$state_dir/prior-pm2.json"
"$PM2" jlist >"$prior_json" 2>/dev/null || true
declare -A prev_paths
for app in "${app_arr[@]}"; do
  prev_paths["$app"]="$(python3 -c "import json,sys
try: d=json.load(open('$prior_json'))
except: d=[]
r=[x['pm2_env'].get('pm_exec_path') for x in d if x['name']=='$app']
print(r[0] if r else '')" 2>/dev/null || true)"
done

# ---- install immutable release (idempotent, deterministic) ----
mkdir -p "$release_dir/ops/gsp-belt"
cp -R "$checkout_root/ops/gsp-belt/." "$release_dir/ops/gsp-belt/"
rm -f "$release_dir/$RENDERED_ECO_REL"
gsp_release="$release_dir/ops/gsp-belt"
sed "s|__GSP_BELT_RELEASE__|$gsp_release|g" \
  "$checkout_root/$ECO_TEMPLATE_REL" > "$release_dir/$RENDERED_ECO_REL"

deploy_eco() { # deploy_eco <rendered-eco-path>; returns 0 when pm2 accepted it
  "$PM2" startOrReload "$1" >/dev/null 2>&1
}

# ---- apply the selected release ----
if ! deploy_eco "$release_dir/$RENDERED_ECO_REL"; then
  echo "DEPLOY FAILED (pm2 rejected ecosystem) — rolling back"
  rollback_paths=1
else
  echo "== reload issued; verifying resolved script paths =="
  current_json="$state_dir/current-pm2.json"
  "$PM2" jlist >"$current_json" 2>/dev/null || true
  ok=true
  for app in "${app_arr[@]}"; do
    resolved="$(python3 -c "import json,sys
try: d=json.load(open('$current_json'))
except: d=[]
r=[x['pm2_env'].get('pm_exec_path') for x in d if x['name']=='$app']
print(r[0] if r else '')" 2>/dev/null || true)"
    st="$(python3 -c "import json,sys
try: d=json.load(open('$current_json'))
except: d=[]
r=[x['pm2_env'].get('status') for x in d if x['name']=='$app']
print(r[0] if r else '')" 2>/dev/null || true)"
    echo "  $app -> $resolved (status=$st)"
    case "$resolved" in
      "$gsp_release/"*) : ;;
      *) echo "    ERROR: $app resolved outside selected release ($resolved)"; ok=false;;
    esac
    [[ "$st" == "online" ]] || { echo "    ERROR: $app not online (status=$st)"; ok=false; }
  done
  rollback_paths=0
  [[ "$ok" == "true" ]] && { echo "DEPLOY OK — apps resolve into $gsp_release"; exit 0; }
fi

# ---- rollback: re-materialize an ecosystem pointing back at prior script paths ----
echo "DEPLOY/VERIFY FAILED — rolling back to previous script paths"
rollback_eco="$release_dir/rollback-ecosystem.gsp-belt.config.js"
python3 - "$checkout_root/$ECO_TEMPLATE_REL" "$rollback_eco" "${app_arr[*]}" "$prior_json" <<'PY'
import json, sys, re
template, out, apps, prev_json = sys.argv[1], sys.argv[2], sys.argv[3].split(), sys.argv[4]
try:
    cur = {a['name']: a['pm2_env'].get('pm_exec_path') for a in json.load(open(prev_json))}
except Exception:
    cur = {}
src = open(template).read()
for name in apps:
    prior = cur.get(name, '')
    if not prior:
        continue
    # Replace this app's script path with its previous (prior-deploy) path.
    pat = re.compile(r"(\{\s*name:\s*'%s'.*?script:\s*')([^']*)(')" % re.escape(name), re.S)
    src = pat.sub(lambda m: m.group(1) + prior + m.group(3), src)
open(out, 'w').write(src)
print("rollback ecosystem wrote prior paths for:", ", ".join(apps))
PY
if deploy_eco "$rollback_eco"; then
  echo "ROLLBACK COMPLETE — previous script paths restored."
else
  echo "ROLLBACK FAILED — manual intervention required (apps left in mixed state)."
fi
exit 1
