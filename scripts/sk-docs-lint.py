import pathlib, re, sys
for p in pathlib.Path('.').rglob('*.md'):
 if any(part in {'.git','node_modules'} for part in p.parts): continue
 for n,line in enumerate(p.read_text(encoding='utf-8').splitlines(),1):
  if re.search(r'\[[^]]+\]\(\s*\)', line):
   print(f'{p}:{n}: empty documentation link'); sys.exit(1)
