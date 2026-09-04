#!/usr/bin/bash
# Fixture-only regression coverage for repository profiles and backend dispatch.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/multica-repo-profiles.XXXXXX")
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/.sk/scripts" "$fixture/scripts" "$fixture/server" "$fixture/bin" "$fixture/no-prereq"
cp "$root/.sk/repo.toml" "$fixture/.sk/repo.toml"
cp "$root/.sk/scripts/check-backend.sh" "$fixture/.sk/scripts/"
cp "$root/.sk/scripts/check-bash-syntax.sh" "$fixture/.sk/scripts/"
cp "$root/.sk/scripts/check-diff-whitespace.sh" "$fixture/.sk/scripts/"
cp "$root/.sk/scripts/docs-lint.py" "$root/.sk/scripts/docs-rules.toml" "$fixture/.sk/scripts/"

cat >"$fixture/bin/pg_isready" <<'EOF'
#!/usr/bin/bash
printf 'pg_isready %s|%s\n' "$PWD" "$*" >>"$CALLS"
EOF
cat >"$fixture/bin/redis-cli" <<'EOF'
#!/usr/bin/bash
printf 'redis-cli %s|%s\n' "$PWD" "$*" >>"$CALLS"
EOF
cat >"$fixture/bin/go" <<'EOF'
#!/usr/bin/bash
printf 'go %s|%s|%s|%s\n' "$PWD" "$*" "$DATABASE_URL" "$REDIS_TEST_URL" >>"$CALLS"
[ "${FAIL_GO_BUILD:-}" != 1 ] || { [ "$1" != build ] || exit 47; }
EOF
cat >"$fixture/bin/bash" <<'EOF'
#!/usr/bin/bash
printf 'bash %s|%s\n' "$PWD" "$*" >>"$CALLS"
EOF
chmod 755 "$fixture/bin/"*

calls="$fixture/calls"
PATH="$fixture/bin:$PATH" CALLS="$calls" DATABASE_URL='postgres://multica:multica@localhost:5432/multica?sslmode=disable' REDIS_TEST_URL='redis://localhost:6379/1' /usr/bin/bash "$fixture/.sk/scripts/check-backend.sh"
expected="pg_isready $fixture|-d postgres://multica:multica@localhost:5432/multica?sslmode=disable
redis-cli $fixture|-u redis://localhost:6379/1 ping
bash $fixture|scripts/helm-config.test.sh
go $fixture/server|build ./...|postgres://multica:multica@localhost:5432/multica?sslmode=disable|redis://localhost:6379/1
go $fixture/server|run ./cmd/migrate up|postgres://multica:multica@localhost:5432/multica?sslmode=disable|redis://localhost:6379/1
bash $fixture|scripts/test-go.test.sh
bash $fixture|scripts/test-go.sh --race"
[ "$(cat "$calls")" = "$expected" ] || { cat "$calls" >&2; exit 1; }

set +e
PATH="$fixture/bin:$PATH" CALLS="$calls" DATABASE_URL='postgres://db.example/multica' REDIS_TEST_URL='redis://localhost:6379/1' /usr/bin/bash "$fixture/.sk/scripts/check-backend.sh" >"$fixture/out" 2>&1
status=$?
set -e
[ "$status" -eq 2 ] && grep -q 'must name a loopback' "$fixture/out"

set +e
PATH="$fixture/bin:$PATH" CALLS="$calls" env -u DATABASE_URL -u REDIS_TEST_URL /usr/bin/bash "$fixture/.sk/scripts/check-backend.sh" >"$fixture/out" 2>&1
status=$?
set -e
[ "$status" -eq 2 ] && grep -q 'DATABASE_URL and REDIS_TEST_URL must be set (no default is guessed)' "$fixture/out"

set +e
PATH="$fixture/bin:$PATH" CALLS="$calls" DATABASE_URL='postgres://multica:multica@localhost:5432/multica?sslmode=disable' REDIS_TEST_URL='redis://localhost:6379/1' FAIL_GO_BUILD=1 /usr/bin/bash "$fixture/.sk/scripts/check-backend.sh" >"$fixture/out" 2>&1
status=$?
set -e
[ "$status" -eq 47 ] && grep -q 'go build failed (exit 47)' "$fixture/out"

set +e
ln -s /usr/bin/python3 "$fixture/no-prereq/python3"
PATH="$fixture/no-prereq" CALLS="$calls" DATABASE_URL='postgres://multica:multica@localhost:5432/multica?sslmode=disable' REDIS_TEST_URL='redis://localhost:6379/1' /usr/bin/bash "$fixture/.sk/scripts/check-backend.sh" >"$fixture/out" 2>&1
status=$?
set -e
[ "$status" -eq 2 ] && grep -q 'PostgreSQL is unreachable' "$fixture/out"

printf 'bad.sh\n' >"$fixture/.sk/tracked-sh.txt"
printf 'if then\n' >"$fixture/bad.sh"
set +e
/usr/bin/bash "$fixture/.sk/scripts/check-bash-syntax.sh" >"$fixture/out" 2>&1
status=$?
set -e
[ "$status" -eq 1 ] && grep -q 'bad.sh: bash -n failed' "$fixture/out"
printf 'bad.txt  \n' >"$fixture/bad.txt"
set +e
/usr/bin/bash "$fixture/.sk/scripts/check-diff-whitespace.sh" >"$fixture/out" 2>&1
status=$?
set -e
[ "$status" -eq 1 ] && grep -q 'bad.txt:1: trailing whitespace' "$fixture/out"
printf 'bad.md\n' >"$fixture/.sk/tracked-docs.txt"
printf 'bad\ttext\n' >"$fixture/bad.md"
set +e
python3 "$fixture/.sk/scripts/docs-lint.py" >"$fixture/out" 2>&1
status=$?
set -e
[ "$status" -eq 1 ] && grep -q 'bad.md:1: tab-character' "$fixture/out"

# Direct argv and checkout-relative working directory prevent caller command or path escape.
grep -Fq 'command_argv = ["/usr/bin/bash", ".sk/scripts/check-backend.sh"]' "$fixture/.sk/repo.toml"
grep -Fq 'working_directory = "."' "$fixture/.sk/repo.toml"
printf 'repo-profiles.test.sh: PASS\n'
