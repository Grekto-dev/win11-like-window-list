#!/bin/sh
# Compiles po/pt_BR.po into locale/pt_BR/LC_MESSAGES/<uuid>.mo (the applet copies it to
# ~/.local/share/locale when Portuguese is selected, where Cinnamon's settings window looks for it).
set -e
cd "$(dirname "$0")/.."
UUID=win11-window-list@cinnamon
mkdir -p locale/pt_BR/LC_MESSAGES
msgfmt --check -o "locale/pt_BR/LC_MESSAGES/$UUID.mo" po/pt_BR.po
echo "built locale/pt_BR/LC_MESSAGES/$UUID.mo"
