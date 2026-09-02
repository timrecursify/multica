#!/usr/bin/env bash
echo 'Refusing legacy GSP belt deployment. Use ops/belt/deploy.sh; it fetches origin/main and writes a deployment receipt.' >&2
exit 1
