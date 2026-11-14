#!/usr/bin/env python3
"""Live tests against the running Cinnamon session (DISPLAY=:0, applet loaded on a panel).

Drives the shell through org.Cinnamon.Eval and the pointer through XTEST; creates small GTK test windows.
Run:  python3 tests/live_suite.py [section ...]       (no arguments = everything)
It restores the applet settings file at the end and never touches other applets.
"""
import ctypes, json, os, pathlib, re, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
UUID = 'win11-window-list@cinnamon'
_LIST = "imports.ui.appletManager.getRunningInstancesForUuid('%s')" % UUID
A = _LIST + "[0]"           # re-bound to a fixed instance id below (the order of the list can change)
ERRLOG = pathlib.Path.home() / '.xsession-errors'
results = []
_children = []


# ---------------------------------------------------------------- plumbing
def ev(js):
    o = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.Cinnamon', '--object-path', '/org/Cinnamon',
                        '--method', 'org.Cinnamon.Eval', js], capture_output=True, text=True).stdout.replace('\\', '')
    m = re.search(r"\(\w+, '\"?(.*?)\"?'\)", o, re.S)
    return m.group(1) if m else o.strip()


def evj(js):
    try:
        return json.loads(ev('JSON.stringify(%s)' % js).replace('\\"', '"'))
    except Exception:
        return None


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + ((' -- ' + str(detail)) if detail and not cond else ''))
    return cond


x11 = ctypes.CDLL('libX11.so.6')
xt = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XStringToKeysym.restype = ctypes.c_ulong
_d = ctypes.c_void_p(x11.XOpenDisplay(os.environ.get('DISPLAY', ':0').encode()))


def mv(x, y):
    xt.XTestFakeMotionEvent(_d, -1, int(x), int(y), 0); x11.XFlush(_d)


def btn(b, down):
    xt.XTestFakeButtonEvent(_d, b, 1 if down else 0, 0); x11.XFlush(_d)


def key(name):
    ks = x11.XStringToKeysym(name.encode())
    kc = x11.XKeysymToKeycode(_d, ks)
    xt.XTestFakeKeyEvent(_d, kc, 1, 0); xt.XTestFakeKeyEvent(_d, kc, 0, 0); x11.XFlush(_d)


def glide(x0, y0, x1, y1, n=8, dt=.03):
    for i in range(1, n + 1):
        mv(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); time.sleep(dt)


def wait(pred, limit=4.0, step=.05):
    t0 = time.time()
    while time.time() - t0 < limit:
        r = pred()
        if r:
            return r
        time.sleep(step)
    return None


def log_offset():
    return ERRLOG.stat().st_size


def log_since(off):
    with open(ERRLOG, 'rb') as f:
        f.seek(off)
        txt = f.read().decode('utf8', 'replace')
    return [l for l in txt.splitlines() if re.search(r'JS ERROR|win11-window-list|Stack trace|tileArt|taskButton|flyout\.js|applet\.js', l)
            and not re.search(r'Loaded applet|Reloading applet|Upgrading|upgraded', l)]


def spawn_windows(n):
    p = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'tests/helpers/testwin.py'), str(n)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _children.append(p)
    wait(lambda: len(wl_windows()) >= n, 6)
    time.sleep(.5)
    return p


def spawn_other():
    """A window of a second app class (WlSkip): something else to move the focus to."""
    p = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'tests/helpers/otherwin.py'), 'normal'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _children.append(p)
    wait(lambda: evj("%s.liveButtons().some(b=>b.id==='win:WlSkip')" % A), 6)
    time.sleep(.6)
    return p


def wl_windows():
    return evj("global.get_window_actors().map(a=>a.meta_window).filter(w=>w.get_wm_class()=='WlTest').map(w=>w.get_title())") or []


def close_windows():
    for p in _children:
        p.terminate()
    _children.clear()
    wait(lambda: not wl_windows(), 4)


def button(prefix):
    return "%s.liveButtons().find(b=>b.id.startsWith('%s'))" % (A, prefix)


def center(prefix):
    r = evj("(()=>{let b=%s;let [x,y]=b.actor.get_transformed_position();let [w,h]=b.actor.get_transformed_size();return [Math.round(x+w/2),Math.round(y+h/2)]})()" % button(prefix))
    return tuple(r) if r else None


def activate(prefix):
    ev("(()=>{let b=%s;imports.ui.main.activateWindow(b.windows[0],global.get_current_time());return 1})()" % button(prefix))
    time.sleep(.6)


def shell_state():
    return evj("""(()=>{let a=%s;let f=a.flyout;let M=imports.ui.main;
      return {flyout:f.isOpen,peek:f._peeking,hidden:f._hidden.length,clones:f._clones.size,modal:M.modalCount,menu:a.menu.isOpen,
              opac0:global.get_window_actors().filter(w=>w.opacity===0&&!w.meta_window.minimized&&w.visible).length,
              drag:!!a._drag}})()""" % A) or {}


def settle():
    mv(2500, 300); time.sleep(.5)
    ev("(()=>{let a=%s;a.flyout.close(true);a.menu.close(true);return 1})()" % A)


SETTINGS = pathlib.Path.home() / '.config/cinnamon/spices' / UUID
INSTANCE = None


def bind_instance():
    """Pick the instance the tests drive (the one on the primary monitor if there are several) and pin A to it."""
    global A, INSTANCE
    iid = ev("''+(%s.find(a=>a.panel.monitorIndex===global.display.get_primary_monitor())||%s[0]).instance_id" % (_LIST, _LIST))
    if iid.isdigit():
        INSTANCE = int(iid)
        A = "%s.find(a=>a.instance_id==%d)" % (_LIST, INSTANCE)


def settings_file():
    if INSTANCE is not None and (SETTINGS / ('%d.json' % INSTANCE)).exists():
        return SETTINGS / ('%d.json' % INSTANCE)
    ids = sorted(SETTINGS.glob('*.json'))
    return ids[0] if ids else None


def set_cfg(**kw):
    f = settings_file()
    d = json.loads(f.read_text())
    for k, v in kw.items():
        d[k.replace('_', '-')]['value'] = v
    f.write_text(json.dumps(d, indent=4))
    ev("%s.settings.remoteUpdate('x',null)" % A)
    time.sleep(.7)


# ---------------------------------------------------------------- sections
def s_health():
    print('\n== health')
    check('applet instance is running', ev("''+!!%s" % A) == 'true')
    n = evj("%s.liveButtons().length" % A)
    check('buttons exist', n and n > 0, n)
    check('no modal grab left over', evj("imports.ui.main.modalCount") == 0)
    check('settings file present and parses', settings_file() is not None and json.loads(settings_file().read_text()))
    st = shell_state()
    check('idle shell state clean', not st.get('flyout') and not st.get('peek') and st.get('opac0') == 0, st)


def s_lifecycle():
    print('\n== lifecycle (15 reloads must not leak)')
    def snap():
        return evj("""(()=>{let M=imports.ui.main;let count=a=>1+a.get_children().reduce((s,c)=>s+count(c),0);
          return {stage:count(global.stage),overlay:global.overlay_group.get_n_children(),chrome:M.layoutManager._chrome._trackedActors.length,
                  dnd:imports.ui.dnd.dragMonitors.length,keys:Object.keys(M.keybindingManager.bindings||{}).length,
                  opac:global.get_window_actors().filter(w=>w.opacity!==255).length}})()""")
    # warm up once so lazily created actors do not count as a leak
    for _ in range(2):
        ev("imports.ui.extension.reloadExtension('%s', imports.ui.extension.Type.APPLET)" % UUID); time.sleep(1.5)
    before = snap()
    off = log_offset()
    for _ in range(15):
        ev("imports.ui.extension.reloadExtension('%s', imports.ui.extension.Type.APPLET)" % UUID); time.sleep(1.2)
    time.sleep(1)
    after = snap()
    check('applet loads after reloads', ev("''+!!%s" % A) == 'true')
    for k in ('overlay', 'chrome', 'dnd', 'keys', 'opac'):
        check('no growth in ' + k, after[k] <= before[k], (before[k], after[k]))
    check('stage actors do not grow (+5 tolerated)', after['stage'] <= before['stage'] + 5, (before['stage'], after['stage']))
    errs = log_since(off)
    check('no errors logged while reloading', not errs, errs[:3])


def s_settings_fuzz():
    print('\n== every setting changed and restored')
    f = settings_file()
    backup = f.read_text()
    schema = json.loads((ROOT / 'settings-schema.json').read_text())
    off = log_offset()
    try:
        for k, v in schema.items():
            if k == 'layout1' or not isinstance(v, dict) or v.get('type') in (None, 'generic', 'section', 'page'):
                continue
            if k in ('pinned-apps', 'pinned-imported'):
                continue
            t = v['type']
            cur = json.loads(f.read_text())[k]['value']
            if t in ('switch', 'checkbox'):
                alts = [not cur]
            elif t == 'combobox':
                alts = [o for o in v['options'].values() if o != cur][:2]
            elif t in ('spinbutton', 'scale'):
                alts = [v['min'], v['max']]
            elif t == 'colorchooser':
                alts = ['rgb(255,0,0)']
            else:
                alts = []
            for a in alts:
                set_cfg(**{k: a})
                st = evj("(()=>{let a=%s;return {n:a.liveButtons().length,ok:!a.destroyed}})()" % A)
                check('%s=%r keeps the applet alive' % (k, a), st and st['ok'] and st['n'] > 0, st)
            set_cfg(**{k: cur})
    finally:
        f.write_text(backup)
        ev("%s.settings.remoteUpdate('x',null)" % A)
        time.sleep(.8)
    errs = log_since(off)
    check('no errors logged by setting changes', not errs, errs[:3])


def s_windows():
    print('\n== window lifecycle')
    off = log_offset()
    spawn_windows(3)
    check('3 test windows exist', len(wl_windows()) == 3, wl_windows())
    n = evj("(()=>{let b=%s;return b?b.windows.length:0})()" % button('win:WlTest'))
    check('one button groups the 3 windows', n == 3, n)
    check('button is stacked (multi)', ev("''+%s.art.multi" % button('win:WlTest')) == 'true')
    pos = center('win:WlTest')
    # activate one window and check the focus flag
    activate('win:WlTest')
    check('focus shows on the button', ev("''+%s.focused" % button('win:WlTest')) == 'true')
    # minimize / restore by clicking the button
    mv(*pos); time.sleep(.3); btn(1, True); btn(1, False); time.sleep(.8)
    # 3 windows -> click opens the flyout (sticky) instead of toggling; close it
    check('click on a multi-window button opens the flyout', ev("''+%s.flyout.isOpen" % A) == 'true')
    settle()
    # closing windows one at a time updates the group
    subprocess.run(['wmctrl', '-c', 'WL test 3']); time.sleep(.8)
    n = evj("(()=>{let b=%s;return b?b.windows.length:0})()" % button('win:WlTest'))
    check('closing one window leaves 2', n == 2, n)
    subprocess.run(['wmctrl', '-c', 'WL test 2']); time.sleep(.8)
    check('with one window the stack indicator disappears', ev("''+%s.art.multi" % button('win:WlTest')) == 'false')
    subprocess.run(['wmctrl', '-c', 'WL test 1']); time.sleep(1.2)
    check('button disappears with its last window', evj("%s.liveButtons().filter(b=>b.id.startsWith('win:WlTest')).length" % A) == 0)
    close_windows()
    # rapid open/close
    for _ in range(4):
        spawn_windows(2); close_windows()
    time.sleep(1.5)
    check('rapid open/close leaves no stray button', evj("%s.liveButtons().filter(b=>b.id.startsWith('win:WlTest')).length" % A) == 0)
    errs = log_since(off)
    check('no errors logged by window changes', not errs, errs[:3])


def s_flyout_peek():
    print('\n== flyout and peek')
    off = log_offset()
    spawn_windows(2)
    settle()
    bx, by = center('win:WlTest')
    mv(bx - 6, by - 3); time.sleep(.05); mv(bx, by)
    check('flyout opens on hover', wait(lambda: ev("''+%s.flyout.isOpen" % A) == 'true', 2))
    time.sleep(.6)
    cards = evj("(()=>{let f=%s.flyout;return [...f._cards.values()].map(e=>{let [x,y]=e.card.get_transformed_position();let [w,h]=e.card.get_transformed_size();return [Math.round(x+w/2),Math.round(y+h/2)]})})()" % A)
    check('flyout has one card per window', cards and len(cards) == 2, cards)
    glide(bx, by, bx, cards[0][1], 8); glide(bx, cards[0][1], cards[0][0], cards[0][1], 4)
    check('card gets hover (input region valid)', wait(lambda: ev("''+[...%s.flyout._cards.values()][0].card.hover" % A) == 'true', 1.5))
    for mode in ('isolate', 'overlay'):
        set_cfg(peek_mode=mode)
        settle(); mv(bx - 6, by - 3); time.sleep(.05); mv(bx, by); time.sleep(1.2)
        glide(bx, by, bx, cards[0][1], 8); glide(bx, cards[0][1], cards[0][0], cards[0][1], 4)
        check('peek starts (%s)' % mode, wait(lambda: shell_state().get('peek'), 2))
        st = shell_state()
        check('peek %s hides %s other windows' % (mode, 'all' if mode == 'isolate' else 'no'),
              (st['hidden'] > 0) if mode == 'isolate' else (st['hidden'] == 0), st)
        glide(cards[0][0], cards[0][1], cards[1][0], cards[1][1], 4)
        time.sleep(.6)
        check('peek follows to the second card (%s)' % mode, shell_state().get('peek'))
        glide(cards[1][0], cards[1][1], cards[1][0], cards[1][1] - 150, 5)
        time.sleep(.8)
        st = shell_state()
        check('leaving the cards ends the peek (%s)' % mode, not st.get('peek') and st.get('hidden') == 0 and st.get('opac0') == 0, st)
        settle()
    set_cfg(peek_mode='isolate')
    # window closing while peeked
    settle(); mv(bx - 6, by - 3); time.sleep(.05); mv(bx, by); time.sleep(1.2)
    glide(bx, by, bx, cards[1][1], 8); glide(bx, cards[1][1], cards[1][0], cards[1][1], 4)
    wait(lambda: shell_state().get('peek'), 2)
    subprocess.run(['wmctrl', '-c', 'WL test 2']); time.sleep(1.2)
    st = shell_state()
    settle()
    st2 = shell_state()
    check('closing the peeked window does not wedge the screen', st2.get('opac0') == 0 and st2.get('hidden') == 0 and st2.get('clones') == 0, (st, st2))
    # stress: sweep the pointer across the bar several times
    for _ in range(6):
        glide(2000, by, 3300, by, 30, .01); glide(3300, by, 2000, by, 30, .01)
    settle()
    st = shell_state()
    check('pointer sweeps leave a clean state', not st.get('flyout') and not st.get('peek') and st.get('modal') == 0 and st.get('opac0') == 0, st)
    close_windows()
    errs = log_since(off)
    check('no errors logged by flyout/peek', not errs, errs[:3])


def s_tile_art():
    print('\n== tile art levels')
    spawn_windows(2)
    spawn_other()
    settle()
    bx, by = center('win:WlTest')
    activate('win:WlTest')
    settle()
    lv = lambda: evj("%s.art._to" % button('win:WlTest'))
    check('focused level', lv() == [0.063, 0.067, 0.019, 0.024], lv())
    mv(bx, by); time.sleep(.5)
    check('focused+hover level', lv() == [0.088, 0.017, 0, -0.1], lv())
    settle()
    activate('win:WlSkip')
    settle()
    check('idle level when another app is focused', lv() == [0, 0, 0, 0], lv())
    mv(bx, by); time.sleep(.5)
    check('hover level', lv() == [0.065, 0.043, 0, 0], lv())
    btn(1, True); time.sleep(.25)
    check('pressed level', lv() == [0.045, 0, 0, 0], lv())
    btn(1, False); settle()
    close_windows()


def s_pin_drag():
    print('\n== pin, unpin and reorder')
    off = log_offset()
    spawn_windows(1)
    settle()
    before = evj("%s.pinnedApps" % A) or []
    check('there is at least one pinned app to test with', before, before)
    if not before:
        close_windows(); return
    target = before[-1]
    ev("(()=>{let a=%s;let b=a.liveButtons().find(b=>b.id==='%s');a.unpin(b);return 1})()" % (A, target)); time.sleep(.8)
    mid = evj("%s.pinnedApps" % A)
    check('unpin takes it out of the pins', target not in mid and len(mid) == len(before) - 1, (before, mid))
    f = settings_file()
    check('unpin is saved in the settings file', target not in json.loads(f.read_text())['pinned-apps']['value'])
    ev("(()=>{let a=%s;a._savePinned(%s);a._queueRefresh();return 1})()" % (A, json.dumps(before))); time.sleep(.8)
    check('pinning again restores the list', evj("%s.pinnedApps" % A) == before, evj("%s.pinnedApps" % A))
    # drag reorder: drag the last button two places to the left
    ids = evj("%s.liveButtons().map(b=>b.id)" % A)
    src = ids[-1]
    sx, sy = center(src[:10])
    dx = -2 * 44
    mv(sx - 6, sy); time.sleep(.2); mv(sx, sy); time.sleep(.3); btn(1, True); time.sleep(.2)
    for i in range(1, 25):
        mv(sx + dx * i / 24, sy); time.sleep(.05)
    time.sleep(.5)
    check('drag in progress is tracked', evj("!!%s._drag" % A) or evj("%s._dragging" % A))
    btn(1, False); time.sleep(1.2)
    ids2 = evj("%s.liveButtons().map(b=>b.id)" % A)
    check('button moved left by dragging', ids2.index(src) < ids.index(src), (ids, ids2))
    check('no drag state left behind', not shell_state().get('drag') and shell_state().get('modal') == 0, shell_state())
    close_windows()
    # dragging a pinned button re-orders the pins (as on Windows): the same apps must still be pinned
    check('the same apps stay pinned after the drag', sorted(evj("%s.pinnedApps" % A)) == sorted(before), evj("%s.pinnedApps" % A))
    ev("(()=>{let a=%s;a._savePinned(%s);a._queueRefresh();return 1})()" % (A, json.dumps(before))); time.sleep(.8)
    errs = log_since(off)
    check('no errors logged by pin/drag', not errs, errs[:3])


def s_attention():
    print('\n== attention (urgency hint and demands-attention)')
    off = log_offset()
    p = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'tests/helpers/testwin.py'), '2', 'urgent', '3500'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _children.append(p)
    wait(lambda: len(wl_windows()) >= 2, 6)
    spawn_other()
    time.sleep(1.0)                      # let both windows finish mapping before moving the focus away
    activate('win:WlSkip')
    seen = []
    t0 = time.time()
    while time.time() - t0 < 6.5:
        seen.append(evj("(()=>{let b=%s;return b?{att:b.attention,fo:b.art.info().flash,w:b.art.info().frontW,want:%s.metrics.tileW-%s.metrics.stackInset}:null})()" % (button('win:WlTest'), A, A)))
        time.sleep(.15)
    att = [x for x in seen if x and x['att']]
    check('urgency hint marks the button', att, (len(seen), seen[:2], seen[-2:]))
    check('flash pulses', att and max(x['fo'] for x in att) > 100, att[:2])
    check('flash follows the (shorter) front tile of a stack', att and {x['w'] for x in att} == {att[0]['want']}, att[:1])
    activate('win:WlTest'); time.sleep(1)
    check('attention clears when the app is focused', evj("%s.attention" % button('win:WlTest')) is False)
    close_windows()
    errs = log_since(off)
    check('no errors logged by attention', not errs, errs[:3])


def s_xdnd():
    print('\n== dragging files between windows of one app (needs Nemo)')
    if not shutil.which('nemo'):
        print('skip (no nemo)'); return
    off = log_offset()
    base = pathlib.Path('/tmp/wl_dnd_test')
    shutil.rmtree(base, ignore_errors=True)
    (base / 'dnd_a').mkdir(parents=True); (base / 'dnd_b').mkdir()
    (base / 'dnd_a/f1.txt').write_text('1'); (base / 'dnd_a/f2.txt').write_text('2')
    for d in ('dnd_a', 'dnd_b'):
        subprocess.Popen(['nemo', '--no-desktop', str(base / d)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2.2)
    try:
        for d, x in (('dnd_a', 60), ('dnd_b', 900)):
            subprocess.run(['wmctrl', '-r', d, '-b', 'remove,maximized_vert,maximized_horz'])
            subprocess.run(['wmctrl', '-r', d, '-e', '0,%d,80,760,520' % x])
        time.sleep(.5)
        subprocess.run(['wmctrl', '-a', 'dnd_b']); time.sleep(.3); subprocess.run(['wmctrl', '-a', 'dnd_a']); time.sleep(.6)
        focus = lambda: ev("''+global.display.focus_window.get_title()")
        nx, ny = center('nemo')
        # first file icon of the left window
        mv(352, 230); time.sleep(.3); btn(1, True); time.sleep(.2)
        for k in range(1, 6):
            mv(352 + 4 * k, 230 + 5 * k); time.sleep(.1)
        glide(372, 255, nx, ny, 30, .02)
        check('flyout opens while dragging a file over the button', wait(lambda: ev("''+%s.flyout.isOpen" % A) == 'true', 3))
        time.sleep(.5)
        pos = ev("(()=>{let a=%s;for(let [w,e] of a.flyout._cards){if(w.get_title()=='dnd_b'){let [x,y]=e.card.get_transformed_position();let [cw,ch]=e.card.get_transformed_size();return Math.round(x+cw/2)+' '+Math.round(y+ch/2)}}return '0 0'})()" % A)
        cx, cy = [int(v) for v in pos.split()]
        glide(nx, ny, nx, cy, 10); glide(nx, cy, cx, cy, 6)
        check('holding the file on a window card raises that window', wait(lambda: focus() == 'dnd_b', 2.5), focus())
        glide(cx, cy, cx, cy + 110, 8, .03); glide(cx, cy + 110, 1300, 420, 30, .03)
        btn(1, False); time.sleep(1.5)
        check('the file was dropped into the other window', (base / 'dnd_b/f1.txt').exists() and not (base / 'dnd_a/f1.txt').exists(),
              (os.listdir(base / 'dnd_a'), os.listdir(base / 'dnd_b')))
        check('flyout closes after the drop', wait(lambda: ev("''+%s.flyout.isOpen" % A) == 'false', 2))
        check('no modal grab or xdnd monitor left', evj("imports.ui.main.modalCount") == 0 and ev("''+%s._xdndMonitor" % A) == 'null')
    finally:
        btn(1, False)
        for d in ('dnd_a', 'dnd_b'):
            subprocess.run(['wmctrl', '-c', d])
        time.sleep(1)
        shutil.rmtree(base, ignore_errors=True)
        settle()
    errs = log_since(off)
    check('no errors logged by drag and drop', not errs, errs[:3])



def s_menu():
    print('\n== jump list (right-click menu)')
    off = log_offset()
    def open_menu():
        settle()
        ev("(()=>{let a=%s;a.openMenu(%s);return 1})()" % (A, button('win:WlTest'))); time.sleep(.8)
    def item_pos(text):
        r = ev("(()=>{let a=%s;let res='';let walk=x=>{try{if(x.get_text&&x.get_text()=='%s'&&!res){let [px,py]=x.get_transformed_position();let [w,h]=x.get_transformed_size();res=Math.round(px+w/2)+' '+Math.round(py+h/2)}}catch(e){}x.get_children&&x.get_children().forEach(walk)};walk(a.menu.actor);return res})()" % (A, text))
        return [int(v) for v in r.split()] if r and r[0].isdigit() else None
    for how in ('mouse', 'keyboard'):
        close_windows(); spawn_windows(2); open_menu()
        check('menu opens', ev("''+%s.menu.isOpen" % A) == 'true')
        if how == 'mouse':
            x, y = item_pos('Close all windows')
            mv(x, y); time.sleep(.3); btn(1, True); time.sleep(.1); btn(1, False)
        else:
            key('Down'); time.sleep(.2); key('Down'); time.sleep(.3); key('Return')      # 1st item is the app's own entry
        check('"Close all windows" works with the %s' % how, wait(lambda: not wl_windows(), 3))
        check('menu closed and no modal grab after %s' % how, ev("''+%s.menu.isOpen" % A) == 'false' and evj("imports.ui.main.modalCount") == 0)
    close_windows(); spawn_windows(1); open_menu(); key('Escape'); time.sleep(.5)
    check('Esc closes the menu', ev("''+%s.menu.isOpen" % A) == 'false' and evj("imports.ui.main.modalCount") == 0)
    open_menu(); mv(1000, 300); btn(1, True); btn(1, False); time.sleep(.6)
    check('a click outside closes the menu', ev("''+%s.menu.isOpen" % A) == 'false' and evj("imports.ui.main.modalCount") == 0)
    close_windows()
    errs = log_since(off)
    check('no errors logged by the menu', not errs, errs[:3])


def s_launcher():
    print('\n== Unity LauncherEntry: count, progress, urgent')
    off = log_offset()
    spawn_windows(1); spawn_other()          # take the focus away from whatever app is being tested
    helper = str(ROOT / 'tests/helpers/launcher_entry.py')
    app = ev("(()=>{let l=%s.liveButtons().filter(b=>b.app&&b.id.endsWith('.desktop'));let b=l.find(b=>b.windows.length>0&&!b.focused)||l[0];return b?b.id:''})()" % A)
    check('there is a button with a desktop app to test with', app.endswith('.desktop'), app)
    if not app.endswith('.desktop'):
        return
    cases = (('count', [], "b.badgeCount===7"), ('progress', ['0.3'], "b.progress===30"), ('urgent', ['1'], "b.attention===true"),
             ('clear', [], "b.badgeCount===0&&b.progress<=0&&!b.attention"))
    running = evj("(()=>{let b=%s.liveButtons().find(b=>b.id==='%s');return b.windows.length>0&&!b.focused})()" % (A, app))
    for mode, args, pred in cases:
        if mode == 'urgent' and not running:
            print('skip urgent (the app has no unfocused window)'); continue
        subprocess.run(['/usr/bin/python3', helper, mode] + args, env=dict(os.environ, LAUNCHER_APP=app))
        t0 = time.time()
        ok = wait(lambda: ev("''+(()=>{let b=%s.liveButtons().find(b=>b.id==='%s');return %s})()" % (A, app, pred)) == 'true', 3, .02)
        check('%s applied at once (%.2fs)' % (mode, time.time() - t0), ok and time.time() - t0 < 0.6)
    close_windows()
    errs = log_since(off)
    check('no errors logged by LauncherEntry', not errs, errs[:3])


def s_closing():
    print('\n== closing apps: pinned buttons stay, closing buttons do not jump')
    off = log_offset()
    # 1. every pinned app that can be resolved keeps a button even with no window (Flatpak ids included)
    r = evj("(()=>{let a=%s;let live=new Set(a.liveButtons().map(b=>b.id));return a._pinnedIds().map(id=>[id,!!a._lookupApp(id),live.has(id)])})()" % A) or []
    check('all %d resolvable pinned apps have a button' % len(r), all(has for _, ok, has in r if ok), r)
    # 2. closing the middle app: its button stays in its slot while it plays the closing animation
    spawn_windows(1)
    spawn_other()
    ev("""(()=>{let a=%s;globalThis.__rec=[];imports.mainloop.timeout_add(16,()=>{
        globalThis.__rec.push(a.box.get_children().map(k=>{let d=k._delegate;return [d&&d.id?d.id:'?',!!(d&&d.removing),Math.round(k.get_transformed_position()[0])]}));return globalThis.__rec.length<50});return 1})()""" % A)
    time.sleep(.1)
    subprocess.run(['wmctrl', '-c', 'WL test 1'])
    time.sleep(1.3)
    rec = evj("globalThis.__rec") or []
    names = lambda f: [k[0] for k in f]
    frames = [f for f in rec if any(k[0] == 'win:WlTest' and k[1] for k in f)]
    check('the closing button was seen animating', len(frames) > 3, len(frames))
    start = names(rec[0]).index('win:WlTest')
    jumped = [f for f in frames if names(f).index('win:WlTest') != start]
    check('the closing button keeps its place in the list (no jump to the start)', not jumped, jumped[:1])
    check('the other app keeps a button', evj("%s.liveButtons().some(b=>b.id==='win:WlSkip')" % A))
    close_windows()
    errs = log_since(off)
    check('no errors logged while closing', not errs, errs[:3])


def s_sync():
    print('\n== several monitors: bars with "synchronise monitors" follow each other (needs 2 instances)')
    off = log_offset()
    I = lambda n: "imports.ui.appletManager.getRunningInstancesForUuid('%s').find(a=>a.instance_id==%d)" % (UUID, n)
    ids = evj("imports.ui.appletManager.getRunningInstancesForUuid('%s').filter(a=>a._synced).map(a=>a.instance_id)" % UUID) or []
    if len(ids) < 2:
        print('skip (needs two instances with synchronisation on)'); return
    a, b = int(ids[0]), int(ids[1])
    time.sleep(2)                       # let buttons of windows closed by earlier sections finish their animation
    order = lambda n: evj("%s.liveButtons().map(x=>x.id)" % I(n))
    pins = lambda n: evj("%s.pinnedApps" % I(n))
    check('both bars show the same buttons in the same order', order(a) == order(b), (order(a), order(b)))
    check('both bars have the same pins', pins(a) == pins(b), (pins(a), pins(b)))
    saved = pins(a)
    def drag(n, idx, dx):
        r = evj("(()=>{let x=%s.liveButtons()[%d];let [px,py]=x.actor.get_transformed_position();let [w,h]=x.actor.get_transformed_size();return [Math.round(px+w/2),Math.round(py+h/2)]})()" % (I(n), idx))
        sx, sy = r
        mv(sx - 6, sy); time.sleep(.2); mv(sx, sy); time.sleep(.3); btn(1, True); time.sleep(.2)
        for i in range(1, 25):
            mv(sx + dx * i / 24, sy); time.sleep(.05)
        time.sleep(.4); btn(1, False); time.sleep(1.3); mv(2500, 300)
    before = order(a)
    drag(a, len(before) - 1, -2 * 44)
    oa, ob = order(a), order(b)
    check('dragging on bar A reorders bar B too', oa == ob and oa != before, (before, oa, ob))
    before = order(b)
    drag(b, 0, 2 * 44)
    oa, ob = order(a), order(b)
    check('dragging on bar B reorders bar A too', oa == ob and oa != before, (before, oa, ob))
    first = pins(a)[0]
    ev("(()=>{let a=%s;let btn=a.liveButtons().find(x=>x.id==='%s');a.unpin(btn);return 1})()" % (I(a), first)); time.sleep(1)
    check('unpinning on bar A unpins on bar B', first not in (pins(b) or []), pins(b))
    f = {n: json.loads((SETTINGS / ('%d.json' % n)).read_text())['pinned-apps']['value'] for n in (a, b)}
    check('both settings files saved the same pins', f[a] == f[b], f)
    ev("(()=>{let a=%s;a.pinnedApps=%s;a._queueRefresh();return 1})()" % (I(a), json.dumps(saved))); time.sleep(.5)
    ev("(()=>{let a=%s;a._savePinned(%s);return 1})()" % (I(a), json.dumps(saved))); time.sleep(1)
    check('pins restored on both bars', pins(a) == saved and pins(b) == saved, (pins(a), pins(b), saved))
    errs = log_since(off)
    check('no errors logged by synchronisation', not errs, errs[:3])


def s_language():
    print('\n== language')
    f = settings_file()
    backup = f.read_text()
    mo = pathlib.Path.home() / '.local/share/locale/pt_BR/LC_MESSAGES' / (UUID + '.mo')
    try:
        set_cfg(language='pt-BR')
        check('Portuguese catalogue installed', mo.exists())
        check('runtime strings follow the language', ev("imports.ui.extension.importModule&&1") is not None and
              evj("(()=>{let m=imports.ui.appletManager.applets;return 1})()") == 1)
        set_cfg(language='en')
        check('English removes the catalogue', not mo.exists())
    finally:
        f.write_text(backup)
        ev("%s.settings.remoteUpdate('x',null)" % A)
        time.sleep(.8)




def s_liveapply():
    print('\n== every setting takes effect at once (no reload, no reopening)')
    off = log_offset()
    f = settings_file()
    backup = f.read_text()
    helper = str(ROOT / 'tests/helpers/launcher_entry.py')
    spawn_windows(2); spawn_other(); settle()
    app = ev("(()=>{let l=%s.liveButtons().filter(b=>b.app&&b.id.endsWith('.desktop'));let b=l.find(b=>b.windows.length>0)||l[0];return b?b.id:''})()" % A)
    env = dict(os.environ, LAUNCHER_APP=app)
    btnjs = lambda id_: "%s.liveButtons().find(b=>b.id==='%s')" % (A, id_)
    try:
        # icon size
        set_cfg(icon_size_mode='manual', icon_size=18)
        check('icon size manual 18 applies', evj("%s.metrics.icon" % A) == 18 and evj("%s.iconChild.get_height()" % btnjs('win:WlTest')) == 18)
        set_cfg(icon_size=24)
        check('icon size manual 24 applies', evj("%s.metrics.icon" % A) == 24)
        set_cfg(icon_size_mode='auto')
        # accent colour of the focused indicator
        for _ in range(3):
            activate('win:WlTest')
            if wait(lambda: ev("''+%s.focused" % btnjs('win:WlTest')) == 'true', 2):
                break
        set_cfg(indicator_color='rgb(255,0,0)')
        check('indicator colour applies', evj("%s.art.info().indicator.css" % btnjs('win:WlTest')) == 'rgb(255,0,0)', ev("%s.art.info().indicator.css" % btnjs('win:WlTest')))
        # animations
        set_cfg(enable_animations=False)
        check('animations off applies', ev("''+%s.animate" % A) == 'false')
        set_cfg(enable_animations=True)
        check('animations on applies', ev("''+%s.animate" % A) == 'true')
        # badges and progress (a real app button, driven through LauncherEntry)
        if app.endswith('.desktop'):
            subprocess.run(['/usr/bin/python3', helper, 'count'], env=env); time.sleep(.5)
            vis = lambda: ev("''+(%s._badge?%s._badge.visible:false)" % (btnjs(app), btnjs(app)))
            check('badge shows', vis() == 'true')
            set_cfg(show_badges=False); check('show-badges off hides it at once', vis() == 'false')
            set_cfg(show_badges=True); check('show-badges on shows it again at once', vis() == 'true')
            subprocess.run(['/usr/bin/python3', helper, 'progress', '0.4'], env=env); time.sleep(.5)
            track = lambda: 'true' if evj("%s.art.progress.mode!=='none'" % btnjs(app)) else 'false'
            has_win = evj("%s.windows.length>0" % btnjs(app))
            if has_win:
                check('progress bar shows', track() == 'true')
                set_cfg(show_progress=False); check('show-progress off hides it at once', track() == 'false')
                set_cfg(show_progress=True); check('show-progress on shows it again at once', track() == 'true')
            subprocess.run(['/usr/bin/python3', helper, 'clear'], env=env)
        # recent files in the jump list
        recent_btn = ev("(()=>{let a=%s;let r=imports.ui.extension;return ''})()" % A)
        def menu_texts(id_):
            settle()
            ev("(()=>{let a=%s;a.openMenu(%s);return 1})()" % (A, btnjs(id_))); time.sleep(.6)
            t = ev("(()=>{let a=%s;let out=[];let walk=x=>{try{if(x.get_text&&x.get_text())out.push(x.get_text())}catch(e){}x.get_children&&x.get_children().forEach(walk)};walk(a.menu.actor);return JSON.stringify(out)})()" % A)
            settle(); return t
        cand = ev("(()=>{let a=%s;let b=a.liveButtons().find(b=>b.app&&b.id.endsWith('.desktop')&&require_recent(b));return b?b.id:''})()" % A) if False else ''
        for id_ in evj("%s.liveButtons().filter(b=>b.app).map(b=>b.id)" % A) or []:
            set_cfg(show_recent=True)
            if 'Recent' in menu_texts(id_):
                set_cfg(show_recent=False)
                check('show-recent off removes the recent files at once', 'Recent' not in menu_texts(id_))
                set_cfg(show_recent=True, recent_count=1)
                n1 = menu_texts(id_).count('Recent')
                check('recent-count applies at once', 'Recent' in menu_texts(id_))
                set_cfg(recent_count=5)
                break
        else:
            print('skip recent files (no app with recent files)')
        # Super+N (only one bar owns the hotkeys: test that one)
        owner = ev("''+(%s.find(a=>a._hotkeyOwner)||{instance_id:''}).instance_id" % _LIST)
        if owner.isdigit():
            of = SETTINGS / ('%s.json' % owner)
            def set_owner(v):
                d = json.loads(of.read_text()); d['super-num-hotkeys']['value'] = v; of.write_text(json.dumps(d, indent=4))
                ev("%s.find(a=>a.instance_id==%s).settings.remoteUpdate('x',null)" % (_LIST, owner)); time.sleep(.8)
            keys = lambda: evj("[...imports.ui.main.keybindingManager.bindings.values()].filter(e=>e.name&&e.name.startsWith('win11tb-key-%s-')).length" % owner)
            ob = of.read_text()
            try:
                set_owner(True); on = keys()
                set_owner(False); off_ = keys()
                set_owner(True); on2 = keys()
            finally:
                of.write_text(ob); ev("%s.find(a=>a.instance_id==%s).settings.remoteUpdate('x',null)" % (_LIST, owner)); time.sleep(.5)
            check('Super+N off unbinds and on binds again at once', on == 9 and off_ == 0 and on2 == 9, (on, off_, on2))
        else:
            print('skip Super+N (no bar owns the hotkeys)')
        # delays are read at the moment they are used
        set_cfg(hover_delay=1500)
        settle(); bx, by = center('win:WlTest'); mv(bx - 6, by - 3); time.sleep(.05); mv(bx, by); time.sleep(.8)
        early = ev("''+%s.flyout.isOpen" % A)
        late = wait(lambda: ev("''+%s.flyout.isOpen" % A) == 'true', 2.5)
        check('hover delay 1500 ms applies at once', early == 'false' and late)
        set_cfg(hover_delay=400)
        # peek options while a peek is showing
        settle(); mv(bx - 6, by - 3); time.sleep(.05); mv(bx, by); time.sleep(1.0)
        cards = evj("(()=>{let f=%s.flyout;return [...f._cards.values()].map(e=>{let [x,y]=e.card.get_transformed_position();let [w,h]=e.card.get_transformed_size();return [Math.round(x+w/2),Math.round(y+h/2)]})})()" % A)
        glide(bx, by, bx, cards[0][1], 8); glide(bx, cards[0][1], cards[0][0], cards[0][1], 4)
        wait(lambda: shell_state().get('peek'), 2)
        check('peek is showing (isolated)', shell_state().get('hidden', 0) > 0, shell_state())
        set_cfg(peek_mode='overlay'); time.sleep(.5)
        st = shell_state()
        check('switching to "above the others" changes the running peek', st.get('peek') and st.get('hidden') == 0, st)
        set_cfg(peek_mode='isolate'); time.sleep(.5)
        check('switching back hides the others again', shell_state().get('hidden', 0) > 0, shell_state())
        set_cfg(enable_peek=False); time.sleep(.5)
        st = shell_state()
        check('turning peek off ends the running peek', not st.get('peek') and st.get('hidden') == 0 and st.get('opac0') == 0, st)
        set_cfg(enable_peek=True)
        settle()
        # workspaces
        subprocess.run(['wmctrl', '-r', 'WL test 2', '-t', '1']); time.sleep(.8)
        n = lambda: evj("(()=>{let b=%s;return b?b.windows.length:0})()" % btnjs('win:WlTest'))
        set_cfg(show_all_workspaces=False); a1 = n()
        set_cfg(show_all_workspaces=True); a2 = n()
        subprocess.run(['wmctrl', '-r', 'WL test 2', '-t', '0'])
        check('show-all-workspaces applies at once', a1 == 1 and a2 == 2, (a1, a2))
    finally:
        f.write_text(backup)
        ev("%s.settings.remoteUpdate('x',null)" % A); time.sleep(.8)
        subprocess.run(['/usr/bin/python3', helper, 'clear'], env=env)
        close_windows(); settle()
    errs = log_since(off)
    check('no errors logged while applying settings', not errs, errs[:3])


ATSPI = r"""
import gi, sys, json
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
desk = Atspi.get_desktop(0)
def walk(o, out):
    try:
        n, r = o.get_name(), o.get_role_name()
        if n and r in ('page tab', 'label', 'push button', 'toggle button', 'combo box'):
            out.append(n)
        for i in range(o.get_child_count()):
            walk(o.get_child_at_index(i), out)
    except Exception:
        pass
res = []
for i in range(desk.get_child_count()):
    a = desk.get_child_at_index(i)
    if (a.get_name() or '').lower().startswith('xlet-settings'):
        walk(a, res)
print(json.dumps(res))
"""


def settings_texts():
    r = subprocess.run(['/usr/bin/python3', '-c', ATSPI], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return []


def s_language_live():
    print('\n== language: changes at once, also in an open settings window')
    off = log_offset()
    f = settings_file()
    backup = f.read_text()
    mo = pathlib.Path.home() / '.local/share/locale/pt_BR/LC_MESSAGES' / (UUID + '.mo')
    pid = lambda: evj("%s._settingsPid" % A)
    open_pid = lambda: evj("(()=>{let w=%s._settingsWindow();return w?w.get_pid():0})()" % A)
    def menu_texts():
        settle()
        ev("(()=>{let a=%s;a.openMenu(%s);return 1})()" % (A, button('win:WlTest'))); time.sleep(.6)
        t = ev("(()=>{let a=%s;let out=[];let walk=x=>{try{if(x.get_text&&x.get_text())out.push(x.get_text())}catch(e){}x.get_children&&x.get_children().forEach(walk)};walk(a.menu.actor);return JSON.stringify(out)})()" % A)
        settle(); return t
    try:
        set_cfg(language='en')
        spawn_windows(2)
        check('jump list in English', 'Close all windows' in menu_texts())
        ev("%s.configureApplet(0)" % A)
        check('settings window opens', wait(open_pid, 6))
        time.sleep(1.5)
        first = open_pid()
        check('the open settings window is in English', 'Language' in settings_texts() and 'Icons' in settings_texts(), settings_texts()[:6])
        ev("%s.configureApplet(0)" % A); time.sleep(.5)
        check('opening it again only raises the existing window', open_pid() == first)
        set_cfg(language='pt-BR')
        check('jump list switches to Portuguese at once', 'Fechar todas as janelas' in menu_texts())
        check('Portuguese catalogue installed', mo.exists())
        reopened = wait(lambda: open_pid() and open_pid() != first and open_pid(), 8)
        check('the open settings window was reopened by itself', bool(reopened), (first, open_pid()))
        time.sleep(1.5)
        txt = settings_texts()
        check('the reopened settings window is in Portuguese', 'Idioma' in txt and 'Ícones' in txt, txt[:8])
        second = open_pid()
        set_cfg(language='en')
        check('jump list back to English at once', 'Close all windows' in menu_texts())
        reopened = wait(lambda: open_pid() and open_pid() != second and open_pid(), 8)
        time.sleep(1.5)
        check('settings window reopened in English', bool(reopened) and 'Language' in settings_texts(), settings_texts()[:6])
        check('English removes the catalogue', not mo.exists())
    finally:
        subprocess.run(['pkill', '-x', 'xlet-settings'])
        f.write_text(backup)
        ev("%s.settings.remoteUpdate('x',null)" % A); time.sleep(.8)
        close_windows(); settle()
    errs = log_since(off)
    check('no errors logged while switching language', not errs, errs[:3])



def s_language_all():
    print('\n== language: one setting for every bar, and every text follows it')
    off = log_offset()
    import configparser
    insts = [int(i) for i in (evj("%s.map(a=>a.instance_id)" % _LIST) or [])]
    I = lambda n: "%s.find(a=>a.instance_id==%d)" % (_LIST, n)
    saved = {n: (SETTINGS / ('%d.json' % n)).read_text() for n in insts}
    def write(n, lang):
        d = json.loads((SETTINGS / ('%d.json' % n)).read_text()); d['language']['value'] = lang
        (SETTINGS / ('%d.json' % n)).write_text(json.dumps(d, indent=4))
        ev("%s.settings.remoteUpdate('x',null)" % I(n)); time.sleep(1.5)
    def menu_texts(n, id_):
        ev("(()=>{let a=%s;a.menu.close(true);a.flyout.close(true);a.openMenu(a.liveButtons().find(b=>b.id==='%s'));return 1})()" % (I(n), id_)); time.sleep(.7)
        # non-ASCII characters (file names with accents) do not survive the Eval round trip: compare as '?'
        t = ev("(()=>{let a=%s;let out=[];let walk=x=>{try{let s=x.get_text&&x.get_text();if(s){s=s.replace(/[^ -~]/g,'?');if(out.indexOf(s)<0)out.push(s)}}catch(e){}x.get_children&&x.get_children().forEach(walk)};walk(a.menu.actor);return JSON.stringify(out)})()" % I(n))
        ev("%s.menu.close(true)" % I(n)); return json.loads(t.replace('\\"', '"')) if t.startswith('[') else []
    def ctx(n):
        raw = ev("JSON.stringify(%s._applet_context_menu._getMenuItems().map(i=>i.label?i.label.get_text():'-'))" % I(n))
        try:
            return json.loads(raw[raw.index('['):raw.rindex(']') + 1])
        except Exception:
            return []
    try:
        for lang, about in (('pt-BR', 'Sobre...'), ('en', 'About...')):
            write(insts[0], lang)
            for n in insts:
                check('bar %d follows the language set on bar %d (%s)' % (n, insts[0], lang), ev("''+%s.language" % I(n)) == lang)
                check('bar %d right-click menu is in %s' % (n, lang), (ctx(n) or ['?'])[0] == about, ctx(n))
            # app-provided names follow the applet's language, not the system's
            for n in insts[:1]:
                for b in evj("%s.liveButtons().filter(b=>b.app&&b.app.get_app_info()&&b.app.get_app_info().list_actions().length>0).map(b=>[b.id,b.app.get_app_info().get_filename(),b.app.get_app_info().list_actions()])" % I(n)) or []:
                    cp = configparser.RawConfigParser(strict=False); cp.optionxform = str
                    try:
                        cp.read(b[1], encoding='utf8')
                    except Exception:
                        continue
                    for act in b[2]:
                        sec = 'Desktop Action ' + act
                        # Only names the .desktop file carries itself are checked: for the others the
                        # shown text depends on the system's gettext catalogue, not on the file.
                        if lang == 'en':
                            want = cp.get(sec, 'Name', fallback=None)
                        else:
                            want = next((cp.get(sec, k) for k in ('Name[pt_BR]', 'Name[pt]') if cp.has_option(sec, k)), None)
                        if not want:
                            continue
                        want = re.sub(r'[^ -~]', '?', want)
                        got = []
                        for _ in range(4):                  # the jump list fills in while recent files load
                            got = menu_texts(n, b[0])
                            if want in got:
                                break
                        check('%s action "%s" shows "%s" in %s' % (b[0][:18], act, want, lang), want in got, got[:8])
    finally:
        for n, txt in saved.items():
            (SETTINGS / ('%d.json' % n)).write_text(txt)
        for n in insts:
            ev("%s.settings.remoteUpdate('x',null)" % I(n))
        time.sleep(1.5)
        after = [ev("''+%s.language" % I(n)) for n in insts]
        print('languages after restoring the files:', after)
    errs = log_since(off)
    check('no errors logged while switching language on several bars', not errs, errs[:3])



def s_progress():
    print('\n== taskbar progress (a program copying or loading something)')
    off = log_offset()
    p = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'tests/helpers/progwin.py')], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
    _children.append(p)
    send = lambda c: (p.stdin.write(c + '\n'), p.stdin.flush())
    wait(lambda: evj("%s.liveButtons().some(b=>b.id==='win:WlProg')" % A), 8); time.sleep(.8)
    st = lambda: evj("(()=>{let b=%s.liveButtons().find(b=>b.id==='win:WlProg');let i=b.art.info();return {track:i.progress.mode!=='none',w:i.progress.len,x:i.progress.from,tw:b.applet.metrics.icon,ind:Math.round(i.indicator.alpha*255),prog:b.progress,pulse:b.pulse}})()" % A) or {}
    check('no progress bar while nothing is reported', not st().get('track'))
    send('40'); time.sleep(.7); s1 = st()
    check('40 % shows the bar', s1.get('track') and s1.get('prog') == 40, s1)
    check('the fill is 40 % of the track', s1.get('tw') and abs(s1['w'] - 0.4 * s1['tw']) <= 1.5, s1)
    check('the running indicator gives way to the bar', s1.get('ind') == 0, s1)
    send('85'); time.sleep(.7); s2 = st()
    check('the fill grows with the progress', s2.get('w', 0) > s1.get('w', 0) and abs(s2['w'] - 0.85 * s2['tw']) <= 1.5, s2)
    set_cfg(show_progress=False); check('show-progress off hides it', not st().get('track'))
    set_cfg(show_progress=True); check('show-progress on shows it again', st().get('track'))
    send('pulse'); time.sleep(.3)
    xs = []
    for _ in range(14):
        xs.append(st().get('x')); time.sleep(.12)
    check('indeterminate progress: a segment sweeps along the track', len(set(xs)) > 4 and max(xs) - min(xs) > 6, xs)
    send('off'); time.sleep(.7); s3 = st()
    check('the bar goes away when the program is done', not s3.get('track') and s3.get('ind') == 255, s3)
    send('quit')
    close_windows()
    errs = log_since(off)
    check('no errors logged by progress', not errs, errs[:3])


SECTIONS = [('health', s_health), ('lifecycle', s_lifecycle), ('settings', s_settings_fuzz), ('windows', s_windows), ('closing', s_closing),
            ('flyout', s_flyout_peek), ('art', s_tile_art), ('pin', s_pin_drag), ('sync', s_sync), ('attention', s_attention), ('menu', s_menu), ('launcher', s_launcher), ('xdnd', s_xdnd), ('language', s_language), ('liveapply', s_liveapply), ('languagelive', s_language_live), ('languageall', s_language_all), ('progress', s_progress)]

if __name__ == '__main__':
    want = sys.argv[1:]
    bind_instance()
    snapshot = {f: json.loads(f.read_text()) for f in SETTINGS.glob('*.json')}
    # The checks read English texts: run in English (the language is one setting for all bars). The
    # snapshot above is restored at the end, which gives the user's language back.
    user_lang = ev("''+%s.language" % A)
    if user_lang and user_lang != 'en':
        set_cfg(language='en')
    try:
        for name, fn in SECTIONS:
            if not want or name in want:
                fn()
    finally:
        close_windows()
        settle()
    # whatever a section did, every bar's settings must be what they were before the run
    for f, before in snapshot.items():
        try:
            now = json.loads(f.read_text())
        except Exception:
            continue
        diff = [k for k in before if isinstance(before[k], dict) and 'value' in before[k] and now.get(k, {}).get('value') != before[k]['value']]
        if diff == ['language'] and user_lang:
            diff = []                      # expected: the run switched to English
            f.write_text(json.dumps(before, indent=4))
            ev("imports.ui.appletManager.getRunningInstancesForUuid('%s').find(a=>a.instance_id==%s).settings.remoteUpdate('x',null)" % (UUID, f.stem))
            time.sleep(1.2)
        check('settings of bar %s unchanged by the run' % f.stem, not diff, diff)
        if diff:
            f.write_text(json.dumps(before, indent=4))
            ev("imports.ui.appletManager.getRunningInstancesForUuid('%s').find(a=>a.instance_id==%s).settings.remoteUpdate('x',null)" % (UUID, f.stem))
    bad = [n for n, ok in results if not ok]
    print('\n%d checks, %d failed' % (len(results), len(bad)))
    for n in bad:
        print('  FAILED:', n)
    sys.exit(1 if bad else 0)
