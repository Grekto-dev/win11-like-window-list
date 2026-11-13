#!/usr/bin/python3
import gi, sys, os, signal
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, GLib
n = int(sys.argv[1]) if len(sys.argv)>1 else 1
wins=[]
for i in range(n):
    w=Gtk.Window(title=f"WL test {i+1}")
    w.set_default_size(420,260); w.move(200+i*60, 200+i*40)
    w.set_wmclass("wltest","WlTest")
    w.add(Gtk.Label(label=f"test window {i+1}"))
    w.connect('destroy', lambda *_: None)
    w.show_all(); wins.append(w)
def urgent():
    for w in wins: w.set_urgency_hint(True)
    return False
if len(sys.argv)>2 and sys.argv[2]=='urgent': GLib.timeout_add(int(sys.argv[3]) if len(sys.argv)>3 else 3000, urgent)
def check():
    if not any(w.get_visible() for w in wins): Gtk.main_quit()
    return True
GLib.timeout_add(500, check)
for w in wins: w.connect('delete-event', lambda w,e: (w.hide(), False)[1])
Gtk.main()
