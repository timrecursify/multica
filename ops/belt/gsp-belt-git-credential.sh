#!/bin/bash
# Git credential helper for the Multica belt.
#
# Mints a GitHub App installation token narrowed to timrecursify/multica with
# contents+pull_requests write only. The installation itself is all-repos with
# administration:write, so the narrowing is the whole point: an unscoped token
# would hand the belt write access to every client repo, including ppp.
# Verified 2026-09-06: scoped token returns 404 on timrecursify/ppp.
set -euo pipefail
[ "${1:-}" = "get" ] || exit 0

ENV_FILE=/etc/gsp/gh-app/gsp.env
CACHE="${HOME:-/var/lib/gsp-multica}/.cache/gsp-belt-git-token"

# Reuse a cached token while it has more than five minutes left. Tokens live one
# hour; minting one per git invocation would burn the app rate limit during a
# build that pushes repeatedly.
if [ -r "$CACHE" ]; then
  exp=$(head -1 "$CACHE" 2>/dev/null || echo 0)
  if [ "$exp" -gt "$(( $(date +%s) + 300 ))" ] 2>/dev/null; then
    printf "username=x-access-token\npassword=%s\n" "$(tail -1 "$CACHE")"
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
  -d "{\"repositories\":[\"multica\"],\"permissions\":{\"contents\":\"write\",\"pull_requests\":\"write\",\"metadata\":\"read\"}}" \
  "https://api.github.com/app/installations/$GH_APP_INSTALLATION_ID/access_tokens" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"token\",\"\"))")

[ -n "$token" ] || { echo "gsp-belt-git-credential: scoped token mint failed" >&2; exit 1; }

mkdir -p "$(dirname "$CACHE")"
( umask 077; printf "%s\n%s\n" "$((now+3300))" "$token" > "$CACHE" )
printf "username=x-access-token\npassword=%s\n" "$token"
