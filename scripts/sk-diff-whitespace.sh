#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import subprocess,sys
for path in subprocess.check_output(['git','ls-files'],text=True).splitlines():
 try:
  for n,line in enumerate(open(path,encoding='utf-8'),1):
   if line.rstrip('\n\r').endswith((' ','\t')): print(f'{path}:{n}: trailing whitespace'); sys.exit(1)
 except (UnicodeDecodeError,IsADirectoryError): pass
PY
