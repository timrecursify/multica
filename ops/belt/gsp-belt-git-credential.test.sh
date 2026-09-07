#!/usr/bin/env bash
# Regression for the belt's scoped GitHub App token.
#
# The QC gate reads commit check runs and the combined commit status through
# this helper's token. When the minted permission set omitted checks:read the
# gate failed every cycle with
#   [qc-gate] ERROR ... Command failed: gh api -i repos/<r>/commits/<sha>/check-runs
#   gh: Resource not accessible by integration (HTTP 403)
# and the ticket's finished work was thrown away and re-attempted. This test
# asserts the minted body still carries every permission those reads need.
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
helper="$root/gsp-belt-git-credential.sh"

fail() { echo "gsp-belt-git-credential: $1" >&2; exit 1; }

# --- the reads the belt makes through this token, and the permission GitHub
# --- names in X-Accepted-Github-Permissions for each (observed 2026-09-06).
declare -A REQUIRED=(
  ['commits/<sha>/check-runs']=checks
  ['commits/<sha>/status']=statuses
  ['pulls/<n>']=pull_requests
  ['pulls/<n>/files']=pull_requests
  ['contents/<path>']=contents
)

# --- hermetic mint: stub curl, sign with a throwaway key -------------------
openssl genrsa -out "$tmp/key.pem" 2048 2>/dev/null
cat > "$tmp/gh.env" <<EOF
GH_APP_ID=12345
GH_APP_INSTALLATION_ID=67890
GH_APP_PEM=$tmp/key.pem
EOF
cat > "$tmp/curl" <<'EOF'
#!/usr/bin/env bash
body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$body" > "$MINT_BODY"
printf '{"token":"ghs_stubtoken"}'
EOF
chmod +x "$tmp/curl"
export MINT_BODY="$tmp/body.json"
export GSP_BELT_GH_ENV="$tmp/gh.env"
export HOME="$tmp/home"

out="$(PATH="$tmp:$PATH" bash "$helper" token sk-cli)"
[[ "$out" == ghs_stubtoken ]] || fail "token mode did not print the minted token: $out"
[[ -s "$MINT_BODY" ]] || fail 'helper minted no token request body'

repos="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["repositories"]))' "$MINT_BODY")"
[[ "$repos" == sk-cli ]] || fail "token was not narrowed to the requested repository: $repos"

for path in "${!REQUIRED[@]}"; do
  perm="${REQUIRED[$path]}"
  have="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["permissions"].get(sys.argv[2], ""))' "$MINT_BODY" "$perm")"
  [[ -n "$have" ]] || fail "repos/<repo>/$path needs $perm, but the minted permission set omits it"
done

# checks and statuses stay read: the belt only GETs them. A write grant here
# would let any belt process publish check runs and commit statuses.
for perm in checks statuses; do
  level="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["permissions"][sys.argv[2]])' "$MINT_BODY" "$perm")"
  [[ "$level" == read ]] || fail "$perm must stay read-only, found $level"
done

# --- the source of truth for REQUIRED: no belt call may write a check run or
# --- a commit status, or the read-only grant above would be wrong.
if grep -RnE "'(POST|PATCH)'.*(check-runs|/statuses)" "$root"/*.cjs "$root"/parity/*.cjs >/dev/null 2>&1; then
  fail 'a belt module writes check runs or commit statuses; the read-only grant is no longer sufficient'
fi

# --- the allow-list still refuses a repository the belt does not work -------
if PATH="$tmp:$PATH" bash "$helper" token not-a-belt-repo >/dev/null 2>&1; then
  fail 'helper minted a token for a repository outside the allow-list'
fi

# --- the cache is reused while it has more than five minutes left -----------
rm -f "$MINT_BODY"
cached="$(PATH="$tmp:$PATH" bash "$helper" token sk-cli)"
[[ "$cached" == ghs_stubtoken ]] || fail "cached read did not return the token: $cached"
[[ ! -e "$MINT_BODY" ]] || fail 'helper re-minted a token that was still fresh'

echo 'gsp-belt-git-credential permission contract passed'
