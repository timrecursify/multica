#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(git rev-parse --show-toplevel)"
go build ./...
if [[ -n "${DATABASE_URL:-}" ]]; then go run ./server/cmd/migrate up; fi
bash scripts/test-go.test.sh
bash scripts/test-go.sh --race
