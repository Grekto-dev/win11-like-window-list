#!/bin/sh
# Reloads the applet in the running Cinnamon (all its instances) and prints new errors from ~/.xsession-errors.
UUID=win11-window-list@cinnamon
off=$(wc -c < ~/.xsession-errors)
gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon --method org.Cinnamon.Eval \
  "imports.ui.extension.reloadExtension('$UUID', imports.ui.extension.Type.APPLET)" >/dev/null
sleep 3
tail -c +$((off+1)) ~/.xsession-errors | grep -v '^$' | grep -i -E "win11-window|JS ERROR|Stack trace" | grep -v -E "Loaded applet|Reloading applet" | head -20
