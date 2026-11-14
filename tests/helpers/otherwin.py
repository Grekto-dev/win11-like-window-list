#!/usr/bin/python3
import gi,sys
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, GLib, Gdk
kind=sys.argv[1]
w=Gtk.Window(title="WL "+kind); w.set_default_size(300,200); w.set_wmclass("wlskip","WlSkip")  # a second app class, for tests with two apps
if kind=='skip': w.set_skip_taskbar_hint(True)
if kind=='dialog': w.set_type_hint(Gdk.WindowTypeHint.DIALOG)
if kind=='utility': w.set_type_hint(Gdk.WindowTypeHint.UTILITY)
if kind=='splash': w.set_type_hint(Gdk.WindowTypeHint.SPLASHSCREEN)
if kind=='normal': pass
w.add(Gtk.Label(label=kind)); w.show_all()
GLib.timeout_add(9000, Gtk.main_quit)
Gtk.main()
