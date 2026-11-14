#!/usr/bin/python3
import os, sys, time
from gi.repository import Gio, GLib
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
def upd(props):
    bus.emit_signal(None,'/com/canonical/unity/launcherentry/1','com.canonical.Unity.LauncherEntry','Update',
        GLib.Variant('(sa{sv})',('application://' + os.environ.get('LAUNCHER_APP', 'com.google.Chrome.desktop'),props)))
mode=sys.argv[1]
if mode=='count': upd({'count':GLib.Variant('x',7),'count-visible':GLib.Variant('b',True)})
elif mode=='progress': upd({'progress':GLib.Variant('d',float(sys.argv[2])),'progress-visible':GLib.Variant('b',True)})
elif mode=='urgent': upd({'urgent':GLib.Variant('b',sys.argv[2]=='1')})
elif mode=='clear': upd({'count-visible':GLib.Variant('b',False),'progress-visible':GLib.Variant('b',False),'urgent':GLib.Variant('b',False)})
bus.flush_sync(None)
