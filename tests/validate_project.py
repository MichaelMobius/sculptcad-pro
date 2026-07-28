from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / 'index.html').read_text(encoding='utf-8')
ids = re.findall(r'\bid="([^"]+)"', html)
duplicates = sorted({item for item in ids if ids.count(item) > 1})

dom = (ROOT / 'src/core/dom.js').read_text(encoding='utf-8')
refs = re.findall(r"\$\('([^']+)'\)", dom)
missing_refs = sorted(set(refs) - set(ids))

missing_imports = []
js_files = sorted((ROOT / 'src').rglob('*.js'))
for source in js_files:
    text = source.read_text(encoding='utf-8')
    for relative in re.findall(r"(?:from\s+|import\s*)['\"](\.[^'\"]+)['\"]", text):
        target = (source.parent / relative).resolve()
        if not target.suffix:
            target = target.with_suffix('.js')
        if not target.exists():
            missing_imports.append((str(source.relative_to(ROOT)), relative))

syntax_errors = []
for source in js_files:
    result = subprocess.run(['node', '--check', str(source)], capture_output=True, text=True)
    if result.returncode:
        syntax_errors.append((str(source.relative_to(ROOT)), result.stderr.strip()))

print(f'HTML ids: {len(ids)} ({len(set(ids))} únicos)')
print(f'Referencias DOM: {len(refs)}')
print(f'Módulos JS: {len(js_files)}')

if duplicates or missing_refs or missing_imports or syntax_errors:
    print('Duplicados:', duplicates)
    print('Referencias ausentes:', missing_refs)
    print('Imports ausentes:', missing_imports)
    print('Errores de sintaxis:', syntax_errors)
    sys.exit(1)

print('Validación estática correcta.')
