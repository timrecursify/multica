#!/usr/bin/env bash
set -Eeuo pipefail
git diff --check -- . ':!pnpm-lock.yaml'
