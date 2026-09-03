#!/usr/bin/env bash
# Hermetic CI-equivalent backend check for `sk repo test --profile backend`.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
default_database_url='postgres://multica:multica@localhost:5432/multica?sslmode=disable'
default_redis_test_url='redis://localhost:6379/1'
DATABASE_URL=${DATABASE_URL:-$default_database_url}
REDIS_TEST_URL=${REDIS_TEST_URL:-$default_redis_test_url}
export DATABASE_URL REDIS_TEST_URL

loopback_url() {
    local value=$1 scheme=$2 host
    host=$(python3 -c 'import sys, urllib.parse; u = urllib.parse.urlparse(sys.argv[1]); print(u.hostname or "")' "$value") || return 1
    [[ $value == "$scheme"* ]] && [[ $host == localhost || $host == 127.0.0.1 || $host == ::1 ]]
}

require_loopback_services() {
    if ! loopback_url "$DATABASE_URL" 'postgres://'; then
        printf 'backend: DATABASE_URL must name a loopback PostgreSQL service\n' >&2
        exit 2
    fi
    if ! loopback_url "$REDIS_TEST_URL" 'redis://'; then
        printf 'backend: REDIS_TEST_URL must name a loopback Redis service\n' >&2
        exit 2
    fi
    if ! command -v pg_isready >/dev/null 2>&1 || ! pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
        printf 'backend: local PostgreSQL is unreachable (DATABASE_URL)\n' >&2
        exit 2
    fi
    if ! command -v redis-cli >/dev/null 2>&1 || ! redis-cli -u "$REDIS_TEST_URL" ping >/dev/null 2>&1; then
        printf 'backend: local Redis is unreachable (REDIS_TEST_URL)\n' >&2
        exit 2
    fi
}

run_step() {
    local name=$1 status
    shift
    if "$@"; then
        return 0
    else
        status=$?
    fi
    printf 'backend: %s failed (exit %d)\n' "$name" "$status" >&2
    exit "$status"
}

run_server_step() {
    local name=$1 status
    shift
    if (cd "$repo_root/server" && "$@"); then
        return 0
    else
        status=$?
    fi
    printf 'backend: %s failed (exit %d)\n' "$name" "$status" >&2
    exit "$status"
}

cd "$repo_root"
require_loopback_services
run_step 'helm configuration test' bash scripts/helm-config.test.sh
run_server_step 'go build' go build ./...
run_server_step 'migration' go run ./cmd/migrate up
run_step 'Go test wrapper verification' bash scripts/test-go.test.sh
run_step 'Go race tests' bash scripts/test-go.sh --race
printf 'backend: CI-equivalent checks passed\n'
