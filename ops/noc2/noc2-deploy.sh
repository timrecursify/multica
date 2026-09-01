#!/usr/bin/env bash
# Deliberately narrow NOC2 deployment primitive. It is invoked by the audited
# sk surface; callers cannot choose a host, container, daemon path, or tag.
set -Eeuo pipefail
readonly BACKEND=multica-backend DAEMON=/home/newadmin/multica-daemon/server
readonly RECEIPTS=/var/lib/multica/noc2-receipts
usage() { echo "usage: $0 --manifest FILE --sha SHA --idempotency-key KEY [--verify]" >&2; exit 64; }
manifest='' requested='' idem='' verify=0
while (($#)); do case "$1" in
 --manifest) manifest=${2-}; shift 2;; --sha) requested=${2-}; shift 2;; --idempotency-key) idem=${2-}; shift 2;; --verify) verify=1; shift;; *) usage;; esac; done
[[ $requested =~ ^[0-9a-f]{40}$ && $idem =~ ^[A-Za-z0-9._:-]{16,200}$ && -r $manifest ]] || usage
[[ $(hostname) == gsp-noc2 ]] || { echo 'noc2-deploy: unsupported host' >&2; exit 65; }
command -v jq docker pm2 sha256sum >/dev/null || { echo 'noc2-deploy: required command unavailable' >&2; exit 69; }
repo_sha=$(jq -er .repository_sha "$manifest") image=$(jq -er .image_digest "$manifest") binary_sha=$(jq -er .binary_sha256 "$manifest")
[[ $repo_sha == "$requested" && $image =~ ^sha256:[0-9a-f]{64}$ && $binary_sha =~ ^[0-9a-f]{64}$ ]] || { echo 'noc2-deploy: invalid manifest' >&2; exit 65; }
mkdir -p "$RECEIPTS"; receipt="$RECEIPTS/$idem.json"
if [[ -e $receipt ]]; then
  [[ $(jq -er .requested_sha "$receipt") == "$requested" ]] || { echo 'noc2-deploy: idempotency payload mismatch' >&2; exit 65; }
  cat "$receipt"; exit 0
fi
# Read-only verification is useful to the sk verifier and cannot mutate state.
if ((verify)); then
 docker inspect --format '{{.Image}}' "$BACKEND"; "$DAEMON" version; exit 0
fi
# Artifact retrieval is intentionally owned by the audited sk caller: it stages
# the verified binary at this fixed adjacent name before invoking this script.
staged="${DAEMON}.next"; [[ -f $staged && $(sha256sum "$staged" | awk '{print $1}') == "$binary_sha" ]] || { echo 'noc2-deploy: staged binary checksum mismatch' >&2; exit 65; }
old_bin="${DAEMON}.rollback.$idem"; old_image=$(docker inspect --format '{{.Image}}' "$BACKEND")
cp --preserve=mode,timestamps "$DAEMON" "$old_bin"; old_checksum=$(sha256sum "$DAEMON" | awk '{print $1}')
rollback() { cp --preserve=mode,timestamps "$old_bin" "$DAEMON"; docker image inspect "$old_image" >/dev/null && docker update --restart=no "$BACKEND" >/dev/null; pm2 restart gsp-multica-worker >/dev/null; }
trap rollback ERR
mv -f -- "$staged" "$DAEMON"; docker pull "ghcr.io/timrecursify/multica-backend@$image"; docker restart "$BACKEND" >/dev/null; pm2 restart gsp-multica-worker >/dev/null
curl --fail --silent --show-error http://127.0.0.1:3001/health >/dev/null
[[ $(docker inspect --format '{{.Image}}' "$BACKEND") == *"$image"* ]] && "$DAEMON" version | grep -Fq "$requested"
trap - ERR
tmp=$(mktemp "$RECEIPTS/.receipt.XXXXXX")
printf '{"requested_sha":"%s","installed_image":"%s","installed_binary_sha256":"%s","prior_image":"%s","prior_binary_sha256":"%s","timestamp":"%s"}\n' "$requested" "$image" "$binary_sha" "$old_image" "$old_checksum" "$(date -u +%FT%TZ)" > "$tmp"
mv -f -- "$tmp" "$receipt"; cat "$receipt"
