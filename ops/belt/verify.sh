#!/usr/bin/env bash
# shellcheck disable=SC2154 # Public arrays come from belt-manifest.sh.
set -Eeuo pipefail

requested_commit="${1:-}"
if [[ ! "$requested_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <40-character source commit>" >&2
  exit 2
fi
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$root_dir/../.." && pwd)"
runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/opt/gsp/multica-workers}"
systemd_root="${BELT_SYSTEMD_ROOT:-}"
resolved_commit="$(git -C "$repo_root" rev-parse --verify --quiet "${requested_commit}^{commit}")" || {
  echo "Unresolvable source commit: $requested_commit" >&2
  exit 1
}
[[ "$resolved_commit" == "$requested_commit" ]] || { echo "Source commit did not resolve exactly" >&2; exit 1; }
# shellcheck disable=SC1091
. "$root_dir/belt-manifest.sh"
status=0

fail() {
  echo "$*" >&2
  status=1
}

contains_word() {
  local words="$1" wanted="$2" word
  for word in $words; do [[ "$word" == "$wanted" ]] && return 0; done
  return 1
}

manifest_has_target() {
  local wanted="$1" target
  for target in "${targets[@]}"; do [[ "$target" == "$wanted" ]] && return 0; done
  return 1
}

unit_contents() {
  local unit="$1" file
  if [[ -z "$systemd_root" ]]; then
    systemctl cat "$unit"
    return
  fi
  [[ -f "$systemd_root/$unit" ]] || return 1
  sed -n '1,$p' "$systemd_root/$unit"
  for file in "$systemd_root/$unit.d"/*.conf; do
    [[ -f "$file" ]] || continue
    sed -n '1,$p' "$file"
  done
}

unit_execstart() {
  unit_contents "$1" | awk '
    /^ExecStart=/ {
      value = substr($0, 11)
      if (value == "") current = ""
      else current = value
    }
    END { if (current != "") print current }
  '
}

entry_owns_unit() {
  contains_word "${belt_entry_units[$1]}" "$2"
}

verify_unit() {
  local unit="$1" exec_start command token path index owner binary_ok=0
  local -a argv=()
  exec_start="$(unit_execstart "$unit")" || { fail "Cannot read systemd ExecStart: $unit"; return; }
  if [[ -z "$systemd_root" && "$runtime_root" != /opt/gsp/multica-workers ]]; then
    exec_start="${exec_start//\/opt\/gsp\/multica-workers/$runtime_root}"
  fi
  [[ -n "$exec_start" ]] || { fail "Missing systemd ExecStart: $unit"; return; }
  read -r -a argv <<<"$exec_start"
  command="${argv[0]#-}"
  for index in "${!belt_entry_names[@]}"; do
    entry_owns_unit "$index" "$unit" || continue
    contains_word "${belt_entry_binary_artifacts[$index]}" "$command" && binary_ok=1
  done
  (( binary_ok )) || fail "Undeclared ExecStart binary for $unit: $command"
  for token in "${argv[@]:1}"; do
    path="${token%\"}"; path="${path#\"}"
    [[ "$path" == "$runtime_root/"* ]] || continue
    manifest_has_target "$path" || { fail "Undeclared executed file for $unit: $path"; continue; }
    owner=0
    while IFS= read -r mapped_unit; do [[ "$mapped_unit" == "$unit" ]] && owner=1; done \
      < <(belt_manifest_units_for_entry "$path")
    (( owner )) || fail "Manifest unit mismatch for $unit: $path"
  done
  echo "ExecStart: $unit $exec_start"
}

verify_entry() {
  local index="$1" sibling binary unit schema sum
  schema="${belt_entry_env_schemas[$index]}"
  [[ -n "${belt_env_schemas[$schema]-}" ]] || fail "Missing env-key schema: ${belt_entry_names[$index]}"
  manifest_has_target "${belt_entry_executables[$index]}" || \
    fail "Executable absent from deployment manifest: ${belt_entry_executables[$index]}"
  for sibling in ${belt_entry_required_siblings[$index]}; do
    manifest_has_target "$sibling" || fail "Required sibling absent from deployment manifest: $sibling"
  done
  for unit in ${belt_entry_units[$index]}; do
    contains_word "${belt_known_units[*]}" "$unit" || fail "Unknown consuming unit for ${belt_entry_names[$index]}: $unit"
  done
  for binary in ${belt_entry_binary_artifacts[$index]}; do
    if [[ ! -f "$binary" ]]; then
      if [[ "$runtime_root" != /opt/gsp/multica-workers && "$binary" == "$runtime_root/"* ]]; then
        echo "Binary fixture omitted: ${belt_entry_names[$index]} $binary"
      else
        fail "Missing binary artifact: $binary"
      fi
      continue
    fi
    sum="$(sha256sum "$binary" | awk '{print $1}')"
    echo "Binary: ${belt_entry_names[$index]} $binary sha256=$sum"
  done
  echo "Entry: ${belt_entry_names[$index]} executable=${belt_entry_executables[$index]} units=${belt_entry_units[$index]} env_schema=$schema"
}

verify_source_target() {
  local index="$1" source_rel target_file sum
  source_rel="$(belt_manifest_source_rel "${sources[$index]}")" || {
    fail "Source outside manifest roots: ${sources[$index]}"
    return
  }
  target_file="${targets[$index]}"
  git -C "$repo_root" cat-file -e "$resolved_commit:$source_rel" 2>/dev/null || {
    fail "Missing selected commit blob: $source_rel"
    return
  }
  [[ -f "$target_file" ]] || { fail "Missing runtime file: $target_file"; return; }
  if git -C "$repo_root" show "$resolved_commit:$source_rel" | cmp -s -- - "$target_file"; then
    sum="$(sha256sum "$target_file" | awk '{print $1}')"
    echo "Match: $target_file sha256=$sum"
  else
    fail "Drift: $target_file"
  fi
}

[[ "${#sources[@]}" -eq "${#targets[@]}" ]] || fail "Manifest source/target arrays are not aligned"
for index in "${!belt_entry_names[@]}"; do verify_entry "$index"; done
for unit in "${belt_units[@]}"; do verify_unit "$unit"; done
for index in "${!sources[@]}"; do verify_source_target "$index"; done
exit "$status"
