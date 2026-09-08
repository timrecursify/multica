#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "${1:-$(dirname -- "${BASH_SOURCE[0]}")}" && pwd)"
runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/opt/gsp/multica-workers}"
. "$root_dir/belt-manifest.sh"

[[ "${#sources[@]}" -eq "${#targets[@]}" ]] || {
  echo 'manifest arrays are not index-aligned' >&2
  exit 1
}

invalid=0
for index in "${!sources[@]}"; do
  source_file="${sources[$index]}"
  [[ "$source_file" == *.cjs ]] || continue
  while IFS= read -r dependency; do
    [[ "$dependency" == ./* || "$dependency" == ../* ]] || continue
    dependency_source="$(realpath -m -- "$(dirname -- "$source_file")/$dependency")"
    dependency_target="$(realpath -m -- "$(dirname -- "${targets[$index]}")/$dependency")"
    if [[ ! -f "$dependency_source" && -f "${dependency_source}.cjs" ]]; then
      dependency_source+='.cjs'
      dependency_target+='.cjs'
    fi
    printf '%s\n' "${targets[@]}" | grep -Fxq -- "$dependency_target" || {
      echo "${targets[$index]} requires $dependency_target, which the manifest does not deploy" >&2
      invalid=1
    }
  done < <(grep -oE "require\([[:space:]]*[\"'][^\"']+[\"'][[:space:]]*\)" "$source_file" |
    sed -E "s/^require\([[:space:]]*[\"']([^\"']+)[\"'][[:space:]]*\)$/\1/")
done

exit "$invalid"
