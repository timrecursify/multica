#!/usr/bin/env bash
# Run `docker compose` for the checkout-managed self-host stack with the
# repository-root `.env` as the single authoritative configuration source.
#
# `make selfhost`, `make selfhost-build`, `make selfhost-stop`, and
# scripts/selfhost-wait.sh route every Compose invocation through this wrapper
# so that:
#
#   * `.env` is required and readable — a missing or unreadable file fails
#     closed before any Docker call with an actionable, secret-free message.
#     The wrapper never creates or rewrites `.env`; the operator owns it.
#   * The environment handed to Compose is sanitized to operational Docker
#     transport variables only (PATH, HOME, DOCKER_HOST, DOCKER_CONTEXT,
#     DOCKER_CONFIG, XDG_RUNTIME_DIR). Inherited shell values and `make`
#     command-line assignments can therefore never override `.env` during
#     Compose interpolation.
#   * `--env-file .env` is always passed, so Compose itself reads configuration
#     from the same file the operator edits.
#
# The wrapper never prints environment contents.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
  echo "Missing or unreadable self-host configuration file: $ENV_FILE" >&2
  echo "Create it from the example and edit it for your setup, then use 'make selfhost' (or 'make selfhost-build'):" >&2
  echo "  cp .env.example $ENV_FILE" >&2
  exit 1
fi

# Operational Docker transport variables only. Everything else an operator or
# CI may have inherited (PORT, FRONTEND_PORT, JWT_SECRET, ...) is deliberately
# dropped so .env is the one source of application configuration.
env_args=(-i PATH="$PATH" HOME="${HOME:-}")
for var in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG XDG_RUNTIME_DIR; do
  if [ -n "${!var:-}" ]; then
    env_args+=("$var=${!var}")
  fi
done

exec env "${env_args[@]}" docker compose --env-file "$ENV_FILE" "$@"
