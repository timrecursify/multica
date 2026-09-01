#!/usr/bin/env bash
# Writes the small, portable provenance document consumed by noc2-deploy.sh.
set -euo pipefail

usage() { echo "usage: $0 --sha SHA --image DIGEST --binary FILE --output FILE [--workflow-run URL]" >&2; exit 64; }
sha='' image='' binary='' output='' workflow_run=''
while (($#)); do case "$1" in
  --sha) sha=${2-}; shift 2;; --image) image=${2-}; shift 2;; --binary) binary=${2-}; shift 2;;
  --output) output=${2-}; shift 2;; --workflow-run) workflow_run=${2-}; shift 2;; *) usage;; esac; done
[[ $sha =~ ^[0-9a-f]{40}$ && $image =~ ^sha256:[0-9a-f]{64}$ && -f $binary && -n $output ]] || usage
checksum=$(sha256sum "$binary" | awk '{print $1}')
tmp=$(mktemp "${output}.tmp.XXXXXX")
printf '{"repository_sha":"%s","image_digest":"%s","binary_sha256":"%s","workflow_run":"%s","build_time":"%s"}\n' \
  "$sha" "$image" "$checksum" "$workflow_run" "$(date -u +%FT%TZ)" > "$tmp"
mv -f -- "$tmp" "$output"
