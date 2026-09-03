#!/usr/bin/env bash
# Hermetic contract test for the exact-SHA publication inputs.  It intentionally
# exercises no registry, Docker daemon, PM2 process, or NOC2 path.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
image=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

printf '#!/usr/bin/env bash\nprintf "daemon"\n' >"$tmp/multica-linux-amd64"
chmod 0755 "$tmp/multica-linux-amd64"
"$root/publish-provenance.sh" --sha "$sha" --image "$image" \
  --binary "$tmp/multica-linux-amd64" --workflow-run 'https://example.test/run/1' \
  --output "$tmp/provenance.json"

jq -e --arg sha "$sha" --arg image "$image" '
  .repository_sha == $sha and .image_digest == $image and
  (.binary_sha256 | test("^[0-9a-f]{64}$")) and
  .workflow_run == "https://example.test/run/1" and
  (.build_time | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
' "$tmp/provenance.json" >/dev/null

set +e
"$root/publish-provenance.sh" --sha short --image "$image" \
  --binary "$tmp/multica-linux-amd64" --output "$tmp/bad.json" >/dev/null 2>&1
rc=$?
set -e
[[ $rc -eq 64 && ! -e "$tmp/bad.json" ]]

grep -Fq 'if-no-files-found: error' "$root/../../.github/workflows/noc2-artifacts.yml"
grep -Fq 'fetch-depth: 0' "$root/../../.github/workflows/noc2-artifacts.yml"
printf 'noc2 immutable artifact provenance contract passed\n'
