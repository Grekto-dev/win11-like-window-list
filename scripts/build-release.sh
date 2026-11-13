#!/bin/sh
# Builds dist/win11-window-list@cinnamon-<version>.zip: the applet folder, ready to unzip into
# ~/.local/share/cinnamon/applets/.
set -e
cd "$(dirname "$0")/.."
UUID=win11-window-list@cinnamon
VERSION=$(python3 -c "import json;print(json.load(open('metadata.json'))['version'])")
./scripts/build-locale.sh >/dev/null
rm -rf "dist/$UUID" "dist/$UUID-$VERSION.zip"
mkdir -p "dist/$UUID"
cp -r *.js *.json *.css LICENSE README.md locale po docs "dist/$UUID/"
(cd dist && python3 - "$UUID" "$UUID-$VERSION.zip" <<'PY'
import sys, zipfile, pathlib
src, out = pathlib.Path(sys.argv[1]), sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(src.rglob('*')):
        if p.is_file() and '__pycache__' not in p.parts:
            z.write(p, p.as_posix())
PY
)
rm -rf "dist/$UUID"
echo "dist/$UUID-$VERSION.zip"
