#!/usr/bin/env bash
set -Eeuo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/opt/gsp/multica-workers}"
. "$root_dir/belt-manifest.sh"
helper_path="$global_bin_root/gsp-belt-git-credential"

# Repo-owned absolute helpers used by deployed daemon entrypoints must have a
# manifest row. Provisioned binaries and compiled service artifacts are out of
# scope and intentionally excluded.
missing=0
for entrypoint in "$root_dir/multica-cicd-worker.cjs" "$root_dir/parity/multica-relay-advance-daemon.cjs"; do
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      /usr/local/bin/gsp-belt-git-credential) path="$helper_path" ;;
      /opt/gsp/.sk/bin/sk|*/server) continue ;;
      *) continue ;;
    esac
    printf '%s\n' "${targets[@]}" | grep -Fxq -- "$path" || {
      printf 'manifest missing deployed executable: %s (from %s)\n' "$path" "$entrypoint" >&2
      missing=1
    }
  done < <(grep -oE '/(usr/local/bin/gsp-belt-git-credential|opt/gsp/[^"'"'"' ]+)' "$entrypoint" | sort -u)
done
exit "$missing"
