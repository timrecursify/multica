#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import pathlib,sys
for path in pathlib.Path('.').rglob('*'):
 if not path.is_file() or '.git' in path.parts: continue
 path=str(path)
 try:
  for n,line in enumerate(open(path,encoding='utf-8'),1):
   if line.rstrip('\n\r').endswith((' ','\t')): print(f'{path}:{n}: trailing whitespace'); sys.exit(1)
 except (UnicodeDecodeError,IsADirectoryError): pass
PY
