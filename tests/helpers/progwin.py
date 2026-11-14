#!/usr/bin/python3
"""A test window that reports taskbar progress through XApp, like a program copying or loading something.
usage: progwin.py            (then it listens on stdin: "50" = 50 %, "pulse" = indeterminate, "off" = none, "quit")"""
import sys, gi
gi.require_version('Gtk', '3.0')
gi.require_version('XApp', '1.0')
from gi.repository import Gtk, GLib, XApp
w = Gtk.Window(title='WL progress')
w.set_default_size(300, 160)
w.set_wmclass('wlprog', 'WlProg')
w.add(Gtk.Label(label='progress test'))
w.show_all()


def apply(cmd):
    cmd = cmd.strip()
    if cmd == 'quit':
        Gtk.main_quit()
    elif cmd == 'off':
        XApp.set_window_progress_pulse(w, False)
        XApp.set_window_progress(w, 0)
    elif cmd == 'pulse':
        XApp.set_window_progress_pulse(w, True)
    elif cmd:
        XApp.set_window_progress_pulse(w, False)
        XApp.set_window_progress(w, int(cmd))


def on_stdin(fd, cond):
    line = fd.readline()
    if not line:
        Gtk.main_quit()
        return False
    apply(line)
    return True


GLib.io_add_watch(sys.stdin, GLib.IO_IN, on_stdin)
GLib.timeout_add(120000, Gtk.main_quit)
Gtk.main()
