#!/bin/bash
# Git credential helper for the Multica belt.
#
# Mints a GitHub App installation token narrowed to the repository being
# accessed. The installation itself is all-repos with administration:write, so
# the narrowing is the whole point: an unscoped token would hand the belt write
# access to every repository the app can see. Only the repositories the belt
# actually works are allowed, and each token carries contents+pull_requests
# write and metadata read, nothing else.
#
# Two modes:
#   get                       git credential protocol; reads the repository
#                             from the `path=` line git sends when
#                             credential.usehttppath is true.
#   token [<repo>]            print only the token, for `GH_TOKEN=$(...) gh ...`.
#                             `gh` reads no git credential helper of its own, so
#                             a shell that needs `gh` mints the token this way.
set -euo pipefail

ENV_FILE=/etc/gsp/gh-app/gsp.env
CACHE_DIR="${HOME:-/var/lib/gsp-multica}/.cache"
ALLOWED_REPOS="multica sk-cli ppp"
DEFAULT_REPO=multica

mode="${1:-}"
case "$mode" in
  get|token) ;;
  *) exit 0 ;;
esac

repo=""
if [ "$mode" = token ]; then
  repo="${2:-$DEFAULT_REPO}"
else
  # git writes the request as KEY=VALUE lines on stdin. `path` is present only
  # when credential.usehttppath is true; without it fall back to the default.
  while IFS='=' read -r key value; do
    [ "$key" = path ] || continue
    repo="${value##*/}"
    repo="${repo%.git}"
  done
  [ -n "$repo" ] || repo=$DEFAULT_REPO
fi

case " $ALLOWED_REPOS " in
  *" $repo "*) ;;
  *) echo "gsp-belt-git-credential: repository '$repo' is not belt-allowed" >&2; exit 1 ;;
esac

CACHE="$CACHE_DIR/gsp-belt-git-token-$repo"

emit() {
  if [ "$mode" = token ]; then printf "%s\n" "$1"
  else printf "username=x-access-token\npassword=%s\n" "$1"; fi
}

# Reuse a cached token while it has more than five minutes left. Tokens live one
# hour; minting one per git invocation would burn the app rate limit during a
# build that pushes repeatedly.
if [ -r "$CACHE" ]; then
  exp=$(head -1 "$CACHE" 2>/dev/null || echo 0)
  if [ "$exp" -gt "$(( $(date +%s) + 300 ))" ] 2>/dev/null; then
    emit "$(tail -1 "$CACHE")"
    exit 0
  fi
fi

set -a; . "$ENV_FILE"; set +a
b64url() { openssl base64 -A | tr "+/" "-_" | tr -d "="; }
now=$(date +%s)
header=$(printf "%s" "{\"alg\":\"RS256\",\"typ\":\"JWT\"}" | b64url)
payload=$(printf "%s" "{\"iat\":$((now-60)),\"exp\":$((now+540)),\"iss\":\"$GH_APP_ID\"}" | b64url)
sig=$(printf "%s" "$header.$payload" | openssl dgst -sha256 -sign "$GH_APP_PEM" -binary | b64url)

token=$(curl -sS -X POST \
  -H "Authorization: Bearer $header.$payload.$sig" \
  -H "Accept: application/vnd.github+json" \
  -d "{\"repositories\":[\"$repo\"],\"permissions\":{\"contents\":\"write\",\"pull_requests\":\"write\",\"metadata\":\"read\"}}" \
  "https://api.github.com/app/installations/$GH_APP_INSTALLATION_ID/access_tokens" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"token\",\"\"))")

[ -n "$token" ] || { echo "gsp-belt-git-credential: scoped token mint failed for $repo" >&2; exit 1; }

mkdir -p "$CACHE_DIR"
( umask 077; printf "%s\n%s\n" "$((now+3300))" "$token" > "$CACHE" )
emit "$token"
