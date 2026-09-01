#!/usr/bin/env bash
# Verify a workflow-style relative output path remains rooted at the checkout.
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_name="daemon-artifact-output-root-$$"
output_rel="dist/$test_name"
output_dir="$root_dir/$output_rel"
fake_bin="$(mktemp -d)"
source_sha="$(git -C "$root_dir" rev-parse HEAD)"

cleanup() {
  rm -rf -- "$fake_bin" "$output_dir"
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

(
  cd -- "$root_dir"
  PATH="$fake_bin:$PATH" ops/belt/build-daemon-artifact.sh "$output_rel"
)

[[ -x "$output_dir/multica-linux-amd64" ]]
[[ -f "$output_dir/daemon-artifact.env" ]]
[[ -f "$output_dir/version.json" ]]
[[ ! -e "$root_dir/server/$output_rel/multica-linux-amd64" ]]
grep -Fqx "SOURCE_SHA=$source_sha" "$output_dir/daemon-artifact.env"
printf 'PASS workflow-relative output anchored at %s\n' "$output_dir"
