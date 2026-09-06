#!/usr/bin/env bash
set -Eeuo pipefail
requested_commit="${1:-}"; [[ "$requested_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Usage: $0 <40-character source commit>" >&2; exit 2; }
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; repo_root="$(cd -- "$root_dir/../.." && pwd)"; runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/var/lib/gsp}"
resolved_commit="$(git -C "$repo_root" rev-parse --verify --quiet "${requested_commit}^{commit}")" || { echo "Unresolvable source commit: $requested_commit" >&2; exit 1; }; [[ "$resolved_commit" == "$requested_commit" ]] || { echo "Source commit did not resolve exactly" >&2; exit 1; }
source_tree="$(mktemp -d "${TMPDIR:-/tmp}/belt-verify.XXXXXX")"; trap 'rm -rf -- "$source_tree"' EXIT; git -C "$repo_root" archive --format=tar "$resolved_commit" | tar -x -C "$source_tree" || { echo "Could not materialize source commit" >&2; exit 1; }
source "$source_tree/ops/belt/release-manifest.sh"
declare -a rels=() targets=()
for i in "${!BELT_MANIFEST_SOURCE_REL[@]}"; do
  rels+=("ops/belt/${BELT_MANIFEST_SOURCE_REL[$i]}")
  targets+=("$runtime_root/${BELT_MANIFEST_TARGET_REL[$i]}")
done
status=0; for i in "${!rels[@]}"; do source_file="$source_tree/${rels[$i]}"; target_file="${targets[$i]}"; [[ -f "$source_file" ]] || { echo "Missing selected commit blob: ${rels[$i]}" >&2; status=1; continue; }; [[ -f "$target_file" ]] || { echo "Missing runtime file: $target_file" >&2; status=1; continue; }; cmp -s -- "$source_file" "$target_file" && echo "Match: $target_file" || { echo "Drift: $target_file" >&2; status=1; }; done; exit "$status"
