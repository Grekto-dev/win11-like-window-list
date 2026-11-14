#!/usr/bin/python3
"""Load generator for profiling: N apps (each its own WM class = its own button) with W windows each.
usage: loadwin.py APPS [WINDOWS_PER_APP] [TITLE_HZ]   (title_hz > 0: every window rewrites its title that often,
like a terminal showing the current command). Stdin line 'quit' ends it."""
import sys, gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib
apps = int(sys.argv[1]); per = int(sys.argv[2]) if len(sys.argv) > 2 else 1; hz = float(sys.argv[3]) if len(sys.argv) > 3 else 0
wins = []
for a in range(apps):
    for k in range(per):
        w = Gtk.Window(title='WL load %d.%d' % (a, k))
        w.set_default_size(300, 200); w.move(60 + (a * 37) % 900, 80 + (k * 50 + a * 11) % 400)
        w.set_wmclass('wlload%d' % a, 'WlLoad%d' % a)
        w.add(Gtk.Label(label='load %d.%d' % (a, k)))
        w.show_all(); wins.append(w)
n = [0]
def spam():
    n[0] += 1
    for i, w in enumerate(wins): w.set_title('WL load %d $ cmd %d' % (i, n[0]))
    return True
if hz > 0: GLib.timeout_add(int(1000 / hz), spam)
GLib.io_add_watch(sys.stdin, GLib.IO_IN, lambda f, c: (Gtk.main_quit(), False)[1] if f.readline().strip() in ('quit', '') else True)
GLib.timeout_add(240000, Gtk.main_quit)
Gtk.main()
