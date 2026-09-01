#!/usr/bin/env bash
# Build one immutable Linux daemon artifact. CI invokes this only from the
# checked-out commit; operators must deploy the emitted manifest and binary.
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
output_dir="${1:?usage: $0 OUTPUT_DIR}"
source_sha="$(git -C "$root_dir" rev-parse HEAD)"
case "$source_sha" in [0-9a-f][0-9a-f]*) ;; *) exit 64 ;; esac

mkdir -p -- "$output_dir"
binary="$output_dir/multica-linux-amd64"
build_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
(cd "$root_dir/server" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -trimpath -ldflags "-s -w -X main.version=gsp-${source_sha} -X main.commit=${source_sha} -X main.date=${build_date}" \
  -o "$binary" ./cmd/multica)
chmod 0755 -- "$binary"
binary_sha="$(sha256sum "$binary" | awk '{print $1}')"
cat >"$output_dir/daemon-artifact.env" <<EOF
SOURCE_SHA=$source_sha
BINARY_SHA256=$binary_sha
GOOS=linux
GOARCH=amd64
EOF
"$binary" version --output json >"$output_dir/version.json"
grep -Fq "\"commit\": \"$source_sha\"" "$output_dir/version.json"
printf 'artifact=%s source_sha=%s binary_sha256=%s\n' "$output_dir" "$source_sha" "$binary_sha"
