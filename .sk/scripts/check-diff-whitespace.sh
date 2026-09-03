#!/usr/bin/env bash
# Hermetic whitespace check for the Multica repository (sk repo test profile
# `diff-whitespace`). Rejects trailing whitespace in tracked source and
# documentation text and names the offending file and line. Uses a committed
# stable listing so discovery never depends on git or the caller's working
# tree.
set -u

repo_root="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
failures=0

# ripgrep performs one efficient bounded traversal and reports path/line for
# every match; the explicit globs keep discovery hermetic and exclude runtime
# state and dependency trees.
matches=$(rg -n --hidden --no-ignore-vcs \
    --glob '!.git/**' --glob '!.sk/run/**' --glob '!node_modules/**' \
    --glob '*.{sh,bash,md,mdx,ts,tsx,js,mjs,cjs,go,sql,json,yml,yaml,css,html,toml,py,txt,ps1,tpl,mod,sum}' \
    --glob '{Makefile,Dockerfile,Dockerfile.web,LICENSE,NOTICE,.gitattributes,.gitignore,.dockerignore,.npmrc,.vercelignore}' \
    '[[:blank:]]$' "$repo_root" || true)
if [[ -n "$matches" ]]; then
    while IFS= read -r match; do
        printf '%s: trailing whitespace\n' "${match#"$repo_root/"}" >&2
        failures=$((failures + 1))
    done <<< "$matches"
fi

if ((failures > 0)); then
    printf 'diff-whitespace: %d trailing-whitespace violations\n' "$failures" >&2
    exit 1
fi

printf 'diff-whitespace: no trailing whitespace in tracked text\n'
