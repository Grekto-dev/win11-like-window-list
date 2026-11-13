#!/bin/sh
# Installs the applet for the current user: ./install.sh [--link]
#   (default) copies the files to ~/.local/share/cinnamon/applets/win11-window-list@cinnamon
#   --link    symlinks this checkout instead (for development)
set -e
cd "$(dirname "$0")"
UUID=win11-window-list@cinnamon
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets/$UUID"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
if [ "$1" = "--link" ]; then
    ln -sfn "$(pwd)" "$DEST"
else
    ./scripts/build-locale.sh >/dev/null 2>&1 || true
    mkdir -p "$DEST"
    cp -r *.js *.json *.css LICENSE README.md locale po docs "$DEST"/
fi
echo "Installed to $DEST"
echo "Now add \"Win11-Like Window List\" in System Settings > Applets (and remove the Grouped window list from that panel)."
