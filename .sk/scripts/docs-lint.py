#!/usr/bin/env python3
"""Hermetic documentation lint for the Multica repository.

Consumed by the ``sk repo test --profile docs-lint`` declaration. Enumerates
candidate documentation files from the committed ``.sk/tracked-docs.txt``
listing (never git, never the caller environment) and applies the committed
ruleset in ``.sk/scripts/docs-rules.toml``. Each violation is reported as
``path:line: message`` on stderr. Exits nonzero when any rule fires.

The ruleset is deliberately small and offline: rules never download rules or
rely on network access at test time.
"""

from __future__ import annotations

import os
import re
import sys
import tomllib


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TRACKED = os.path.join(ROOT, ".sk", "tracked-docs.txt")
RULES = os.path.join(ROOT, ".sk", "scripts", "docs-rules.toml")


def enabled_rules():
    with open(RULES, "rb") as handle:
        data = tomllib.load(handle)
    rules = data.get("rules", {})
    return {name for name, value in rules.items() if value is True}


def docs_files():
    with open(TRACKED, encoding="utf-8") as handle:
        files = [line.strip() for line in handle if line.strip()]
    return [path for path in files if os.path.isfile(os.path.join(ROOT, path))]


def lint_file(path, rules):
    abs_path = os.path.join(ROOT, path)
    with open(abs_path, "rb") as handle:
        raw = handle.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return []

    issues = []
    lines = text.splitlines()

    if "trailing-whitespace" in rules:
        for number, line in enumerate(lines, start=1):
            if line.rstrip(" \t") != line and line.strip(" \t") != "":
                issues.append((number, "trailing-whitespace"))

    if "tab" in rules:
        for number, line in enumerate(lines, start=1):
            if "\t" in line:
                issues.append((number, "tab-character"))

    if "crlf" in rules:
        if "\r" in text:
            issues.append((1, "crlf-line-ending"))

    if "unclosed-fence" in rules:
        opener = None
        for number, line in enumerate(lines, start=1):
            match = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
            if not match:
                continue
            char = match.group(1)[0]
            if opener is None:
                opener = (number, char)
            elif opener[1] == char:
                opener = None
        if opener is not None:
            issues.append((opener[0], "unclosed-code-fence"))

    return issues


def main(argv):
    if set(argv[1:]) and set(argv[1:]) != {"--json"}:
        print(f"usage: {__file__} [--json]", file=sys.stderr)
        return 2
    rules = enabled_rules()
    if not rules:
        print("docs-lint: no rules enabled in .sk/scripts/docs-rules.toml", file=sys.stderr)
        return 2

    findings = []
    for path in docs_files():
        for number, message in lint_file(path, rules):
            findings.append((path, number, message))

    if "--json" in argv[1:]:
        import json

        payload = {
            "checked": len(docs_files()),
            "violations": [
                {"path": path, "line": number, "rule": message}
                for path, number, message in findings
            ],
        }
        print(json.dumps(payload, sort_keys=True))
    else:
        for path, number, message in findings:
            print(f"{path}:{number}: {message}", file=sys.stderr)
        print(f"docs-lint: checked {len(docs_files())} files, {len(findings)} violations")

    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
