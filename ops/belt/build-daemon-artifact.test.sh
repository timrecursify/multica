#!/usr/bin/env bash
# Verify a workflow-style relative output path remains rooted at the checkout.
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_name="daemon-artifact-output-root-$$"
output_rel="dist/$test_name-relative"
output_dir="$root_dir/$output_rel"
absolute_dir="$root_dir/dist/$test_name-absolute"
outside_dir="$(mktemp -d)"
symlink_name="$test_name-symlink"
in_root_symlink_name="$test_name-in-root-symlink"
fake_bin="$(mktemp -d)"
source_sha="$(git -C "$root_dir" rev-parse HEAD)"

cleanup() {
  rm -rf -- "$fake_bin" "$output_dir" "$absolute_dir" "$outside_dir" \
    "$root_dir/dist/$symlink_name" "$root_dir/dist/$in_root_symlink_name"
}
trap cleanup EXIT

cat >"$fake_bin/go" <<EOF
#!/usr/bin/env bash
set -euo pipefail
output=""
while (( \$# )); do
  if [[ "\$1" == "-o" ]]; then
    output="\$2"
    shift 2
    continue
  fi
  shift
done
[[ -n "\$output" ]]
mkdir -p -- "\$(dirname -- "\$output")"
printf '%s\\n' '#!/usr/bin/env bash' 'printf '\''{"commit": "${source_sha}"}\\n'\''' >"\$output"
chmod 0755 -- "\$output"
EOF
chmod 0755 -- "$fake_bin/go"

build_artifact() {
  (
    cd -- "$root_dir"
    PATH="$fake_bin:$PATH" ops/belt/build-daemon-artifact.sh "$1"
  )
}

expect_reject() {
  local output_arg="$1"
  if build_artifact "$output_arg"; then
    printf 'unexpected artifact output acceptance: %s\n' "$output_arg" >&2
    exit 1
  fi
}

build_artifact "$output_rel"

[[ -x "$output_dir/multica-linux-amd64" ]]
[[ -f "$output_dir/daemon-artifact.env" ]]
[[ -f "$output_dir/version.json" ]]
[[ ! -e "$root_dir/server/$output_rel/multica-linux-amd64" ]]
grep -Fqx "SOURCE_SHA=$source_sha" "$output_dir/daemon-artifact.env"

build_artifact "$absolute_dir"
[[ -x "$absolute_dir/multica-linux-amd64" ]]

expect_reject "../$test_name-traversal"
[[ ! -e "$(dirname -- "$root_dir")/$test_name-traversal" ]]

ln -s -- "$outside_dir" "$root_dir/dist/$symlink_name"
expect_reject "dist/$symlink_name/escape"
[[ ! -e "$outside_dir/escape/multica-linux-amd64" ]]

ln -s -- "$root_dir/dist" "$root_dir/dist/$in_root_symlink_name"
expect_reject "dist/$in_root_symlink_name/redirect"
[[ ! -e "$root_dir/dist/redirect/multica-linux-amd64" ]]
printf 'PASS artifact output accepts canonical in-root paths and rejects escapes\n'
