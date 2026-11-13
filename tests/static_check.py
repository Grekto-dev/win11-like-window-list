#!/usr/bin/env python3
"""Static checks that need no running Cinnamon: syntax, JSON, settings keys, translations, i18n tables."""
import json, re, subprocess, sys, gettext, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
errors = []


def err(msg):
    errors.append(msg)
    print('FAIL', msg)


def ok(msg):
    print('ok  ', msg)


# 1. JavaScript syntax
for f in sorted(root.glob('*.js')):
    r = subprocess.run(['node', '--check', str(f)], capture_output=True, text=True)
    if r.returncode:
        err('syntax %s: %s' % (f.name, r.stderr.strip().splitlines()[0]))
ok('node --check on %d files' % len(list(root.glob('*.js'))))

# 2. JSON files and metadata
schema = json.loads((root / 'settings-schema.json').read_text())
meta = json.loads((root / 'metadata.json').read_text())
for k in ('uuid', 'name', 'description', 'website', 'max-instances'):
    if k not in meta:
        err('metadata.json lacks ' + k)
ok('metadata.json and settings-schema.json parse')

# 3. every key used in applet.js exists in the schema, every schema key is bound
src = (root / 'applet.js').read_text()
bound = set(re.findall(r"bindProperty\(IN, '([a-z0-9-]+)'", src))
bound |= set(re.findall(r"bindProperty\((?:IN|BOTH),\s*'([a-z0-9-]+)'", src))
keys = {k for k, v in schema.items() if isinstance(v, dict) and 'type' in v and v['type'] not in ('page', 'section', 'layout')}
keys -= {'layout1'}
for k in sorted(bound - keys):
    err('bound but not in schema: ' + k)
storage_only = {'pinned-apps', 'pinned-imported', 'recent-reset'}
for k in sorted(keys - bound - storage_only):
    err('in schema but never bound: ' + k)
ok('%d settings keys consistent between applet.js and schema' % len(bound))

# 4. layout references existing keys / sections / pages
layout = schema['layout1']
for pg in layout['pages']:
    if pg not in layout:
        err('layout page missing: ' + pg)
        continue
    for sec in layout[pg]['sections']:
        if sec not in layout:
            err('layout section missing: ' + sec)
            continue
        for k in layout[sec]['keys']:
            if k not in schema:
                err('layout key missing in schema: ' + k)
ok('layout pages/sections/keys resolve')

# 5. every default of a combobox is one of its options; dependencies exist
for k, v in schema.items():
    if not isinstance(v, dict) or v.get('type') != 'combobox':
        continue
    if v['default'] not in v['options'].values():
        err('combobox default not in options: ' + k)
for k, v in schema.items():
    dep = v.get('dependency') if isinstance(v, dict) else None
    if dep:
        name = re.sub(r'^!', '', dep).split('=')[0]      # Cinnamon accepts "key", "!key" and "key=value"
        if name not in schema:
            err('dependency missing: %s -> %s' % (k, dep))
ok('combobox defaults and dependencies')

# 6. translations of the settings window
mo = root / 'locale/pt_BR/LC_MESSAGES/win11-window-list@cinnamon.mo'
po = (root / 'po/pt_BR.po').read_text()
tmp = pathlib.Path('/tmp/_wl_check.mo')
r = subprocess.run(['msgfmt', '--check', '-o', str(tmp), str(root / 'po/pt_BR.po')], capture_output=True, text=True)
if r.returncode:
    err('msgfmt: ' + r.stderr.strip())
if mo.exists() and mo.read_bytes() != tmp.read_bytes():
    err('compiled .mo is out of date: run scripts/build-locale.sh')
cat = gettext.GNUTranslations(open(tmp, 'rb'))
skip = {'px', 'ms', 'English', 'Português (Brasil)', 'Manual'}
strings = []
for k, v in layout.items():
    if isinstance(v, dict) and 'title' in v:
        strings.append(v['title'])
for k, v in schema.items():
    if k == 'layout1' or not isinstance(v, dict):
        continue
    strings += [v.get(f) for f in ('description', 'tooltip', 'units')]
    strings += list((v.get('options') or {}).keys())
for s in strings:
    if s and s not in skip and cat.gettext(s) == s:
        err('untranslated: ' + s)
ok('%d schema strings translated' % len([s for s in strings if s]))

# 7. runtime string tables
i18n = (root / 'i18n.js').read_text()
tables = re.findall(r"(?:^|\n)\s*(?:en|'pt-BR'):\s*\{(.*?)\n\s*\},?", i18n, re.S)
sets = [set(re.findall(r'(\w+):', t)) for t in tables]
if len(sets) != 2 or sets[0] != sets[1]:
    err('i18n tables differ: %s' % (sets,))
used = set(re.findall(r"\btr\('(\w+)'\)", ''.join(p.read_text() for p in root.glob('*.js'))))
for k in sorted(used - sets[0]):
    err('tr() key not in table: ' + k)
ok('i18n tables: %d keys, all used keys defined' % len(sets[0]))

# 8. stylesheet braces balanced
css = (root / 'stylesheet.css').read_text()
if css.count('{') != css.count('}'):
    err('stylesheet.css braces unbalanced')
ok('stylesheet braces balanced')

# 9. no debug leftovers
for f in sorted(root.glob('*.js')):
    for n, line in enumerate(f.read_text().splitlines(), 1):
        if re.search(r'\b(DEBUG|debugger|console\.log|print\()', line):
            err('debug leftover %s:%d: %s' % (f.name, n, line.strip()))
ok('no debug leftovers')

print('\n%d problem(s)' % len(errors))
sys.exit(1 if errors else 0)
