#!/usr/bin/python3
"""Profiles the running applet from the inside: wraps its hot methods (count + total/max time) and the
cinnamon process CPU time, runs scenarios, prints a table.  usage: profile.py [scenario ...]
scenarios: idle churn focus title hover   (default: all).  Leaves the settings untouched."""
import sys, time, json, subprocess, os, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import live_suite as L

PROBE = r"""
(()=>{
 const {GLib}=imports.gi;
 const A=imports.ui.appletManager.getRunningInstancesForUuid('win11-window-list@cinnamon');
 const a=A[0];
 globalThis.__prof={};
 globalThis.__depth=0;
 const wrap=(P,names,tag)=>names.forEach(n=>{
   if(typeof P[n]!=='function'||P[n].__w) return;
   const o=P[n];
   const f=function(...x){const t=GLib.get_monotonic_time();__depth++;try{return o.apply(this,x)}finally{
     __depth--;const r=__prof[tag+'.'+n]||(__prof[tag+'.'+n]={c:0,us:0,max:0});const d=GLib.get_monotonic_time()-t;r.c++;r.us+=d;if(d>r.max)r.max=d;
     if(__depth===0){const T=__prof.TOTAL||(__prof.TOTAL={c:0,us:0,max:0});T.c++;T.us+=d;if(d>T.max)T.max=d}}};
   f.__w=1; P[n]=f;});
 wrap(a.constructor.prototype,['_refresh','_queueRefresh','_applyStates','_updateBadges','_queueStates','_onFocusChanged','_onAttention','_watchWindow','_computeOrder','_restack','onButtonHover','_centerInPanel','_createButton','_takePlaceholder','_pinnedIds','_lookupApp','_importPinned','_identify','_accepts','_isFocused','_launcherFor'],'applet');
 const b=a.liveButtons()[0]||a._buttons.values().next().value;
 wrap(b.constructor.prototype,['update','updateArt','_applyIndicator','_applyProgress','setProgress','setBadge','_updateFlash','_applyMulti','buildIcon','animateIn','destroy','applyMetrics'],'btn');
 wrap(b.art.constructor.prototype,['_tick','_paint','setState'],'art');
 wrap(a.flyout.constructor.prototype,['open','sync','updateTitle','_rebuild','_makeCard','_beginPeek','_switchPeek','_endPeek','close'],'flyout');
 return 'ok '+Object.keys(__prof).length;
})()
"""
RESET = "(()=>{for(const k in __prof)delete __prof[k];return 'r'})()"
DUMP = "__prof"


RESULTS = {}


def cpu_ticks():
    pid = int(subprocess.run(['pgrep', '-xo', 'cinnamon'], capture_output=True, text=True).stdout.split()[0])
    f = open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()
    return int(f[11]) + int(f[12])


def run(name, fn):
    L.ev(RESET); c0 = cpu_ticks(); t0 = time.time()
    fn()
    wall = time.time() - t0; cpu = (cpu_ticks() - c0) / os.sysconf('SC_CLK_TCK')
    prof = L.evj(DUMP) or {}
    print('\n=== %s: %.1f s, cinnamon CPU %.2f s (%.1f%%)' % (name, wall, cpu, cpu / wall * 100))
    T = prof.get('TOTAL', {'c': 0, 'us': 0})
    print('   applet JS (top-level entries): %d calls, %.1f ms total = %.2f%% of one core' % (T['c'], T['us'] / 1000, T['us'] / 1e6 / wall * 100))
    RESULTS[name] = T
    rows = sorted(prof.items(), key=lambda kv: -kv[1]['us'])
    print('%-26s %7s %9s %8s %8s' % ('method', 'calls', 'total ms', 'avg us', 'max us'))
    tot = 0
    for k, v in rows:
        if v['c']:
            print('%-26s %7d %9.1f %8.0f %8d' % (k, v['c'], v['us'] / 1000, v['us'] / v['c'], v['max']))
    return prof


def spawn(apps, per=1, hz=0):
    p = subprocess.Popen(['/usr/bin/python3', str(pathlib.Path(__file__).parent / 'loadwin.py'), str(apps), str(per), str(hz)],
                         stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
    L._children.append(p); return p


def stop(p):
    try:
        p.stdin.write('quit\n'); p.stdin.flush()
    except Exception:
        pass
    time.sleep(1.5)


def wins():
    return [w for w in subprocess.run(['wmctrl', '-l'], capture_output=True, text=True).stdout.splitlines() if 'WL load' in w]


def s_idle():
    time.sleep(30)


def s_churn():
    for _ in range(3):
        p = spawn(10, 2); L.wait(lambda: len(wins()) >= 20, 15); time.sleep(1.5); stop(p); time.sleep(1.5)


def s_focus():
    p = spawn(10, 2); L.wait(lambda: len(wins()) >= 20, 15); time.sleep(1.5)
    ids = [w.split()[0] for w in wins()]
    L.ev(RESET); c = 0
    for i in range(80):
        subprocess.run(['wmctrl', '-i', '-a', ids[i % len(ids)]]); time.sleep(.06)
    time.sleep(.5); stop(p)


def s_title():
    p = spawn(10, 2, 10); L.wait(lambda: len(wins()) >= 20, 15); time.sleep(2)
    L.ev(RESET); time.sleep(15); stop(p)


def s_hover():
    p = spawn(10, 2); L.wait(lambda: len(wins()) >= 20, 15); time.sleep(1.5)
    L.ev(RESET)
    pos = L.evj("%s.liveButtons().map(b=>{let [x,y]=b.actor.get_transformed_position();return [Math.round(x+20),Math.round(y+20)]})" % L.A)
    for rep in range(3):
        for (x, y) in pos:
            L.glide(x - 12, y, x, y, n=3, dt=.02); time.sleep(.25)
    L.mv(900, 500); time.sleep(.5); stop(p)


SC = {'idle': s_idle, 'churn': s_churn, 'focus': s_focus, 'title': s_title, 'hover': s_hover}
if __name__ == '__main__':
    L.bind_instance()
    want = sys.argv[1:] or list(SC)
    print(L.ev(PROBE))
    try:
        for n in want:
            run(n, SC[n])
    finally:
        L.close_windows()
        print('\nSUMMARY ' + json.dumps({k: [v['c'], round(v['us'] / 1000, 1)] for k, v in RESULTS.items()}))
