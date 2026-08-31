#!/usr/bin/env bash
# Hermetic whitespace check for the Multica repository (sk repo test profile
# `diff-whitespace`). Rejects trailing whitespace in tracked source and
# documentation text and names the offending file and line. Uses a committed
# stable listing so discovery never depends on git or the caller's working
# tree.
set -u

repo_root="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
failures=0

text_glob() {
    find "$repo_root" \
        -type f \
        \( -name '*.sh' -o -name '*.bash' -o -name '*.md' -o -name '*.mdx' \
           -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \
           -o -name '*.cjs' -o -name '*.go' -o -name '*.sql' -o -name '*.json' \
           -o -name '*.yml' -o -name '*.yaml' -o -name '*.css' -o -name '*.html' \
           -o -name '*.toml' -o -name '*.py' -o -name '*.txt' -o -name '*.ps1' \
           -o -name '*.tpl' -o -name '*.mod' -o -name '*.sum' -o -name 'Makefile' \
           -o -name 'Dockerfile' -o -name 'Dockerfile.web' -o -name 'LICENSE' \
           -o -name 'NOTICE' -o -name '.gitattributes' -o -name '.gitignore' \
           -o -name '.dockerignore' -o -name '.npmrc' -o -name '.vercelignore' \
        \) \
        -not -path "$repo_root/.git/*" \
        -not -path "$repo_root/.sk/run/*" \
        -not -path "*/node_modules/*" \
        -print
}

check_trailing() {
    local file=$1 line=1
    while IFS= read -r line_text; do
        if [[ $line_text == *[[:blank:]] ]] && [[ $line_text != '' ]]; then
            printf '%s:%s: trailing whitespace\n' "$file" "$line" >&2
            failures=$((failures + 1))
        fi
        line=$((line + 1))
    done < "$file"
}

while IFS= read -r file; do
    check_trailing "$file"
done < <(text_glob)

if ((failures > 0)); then
    printf 'diff-whitespace: %d trailing-whitespace violations\n' "$failures" >&2
    exit 1
fi

printf 'diff-whitespace: no trailing whitespace in tracked text\n'
