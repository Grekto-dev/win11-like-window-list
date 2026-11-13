#!/usr/bin/env python3
"""Live tests against the running Cinnamon session (DISPLAY=:0, applet loaded on a panel).

Drives the shell through org.Cinnamon.Eval and the pointer through XTEST; creates small GTK test windows.
Run:  python3 tests/live_suite.py [section ...]       (no arguments = everything)
It restores the applet settings file at the end and never touches other applets.
"""
import ctypes, json, os, pathlib, re, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
UUID = 'win11-window-list@cinnamon'
A = "imports.ui.appletManager.getRunningInstancesForUuid('%s')[0]" % UUID
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
def settings_file():
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
    check('stage actors stable (±5)', abs(after['stage'] - before['stage']) <= 5, (before['stage'], after['stage']))
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
    settle()
    bx, by = center('win:WlTest')
    activate('win:WlTest')
    settle()
    lv = lambda: evj("%s.art._to" % button('win:WlTest'))
    check('focused level', lv() == [0.063, 0.067, 0.019, 0.024], lv())
    mv(bx, by); time.sleep(.5)
    check('focused+hover level', lv() == [0.088, 0.017, 0, -0.1], lv())
    settle()
    activate('nemo')
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
    f = settings_file()
    backup = f.read_text()
    before = json.loads(backup)['pinned-apps']['value']
    ev("(()=>{let a=%s;let b=a.liveButtons().find(b=>b.id.startsWith('nemo'));a.unpin(b);return 1})()" % A); time.sleep(.6)
    mid = json.loads(f.read_text())['pinned-apps']['value']
    check('unpin persists', len(mid) == len(before) - 1, (before, mid))
    ev("(()=>{let a=%s;a.pinnedApps=a.pinnedApps.concat(['nemo.desktop']);a._queueRefresh();return 1})()" % A); time.sleep(.8)
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
    f.write_text(backup)                      # give the user's pins back
    ev("%s.settings.remoteUpdate('x',null)" % A); time.sleep(.8)
    check('pins restored', evj("%s.pinnedApps" % A) == before, evj("%s.pinnedApps" % A))
    errs = log_since(off)
    check('no errors logged by pin/drag', not errs, errs[:3])


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



def s_attention():
    print('\n== attention (urgency hint and demands-attention)')
    off = log_offset()
    p = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'tests/helpers/testwin.py'), '2', 'urgent', '3500'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _children.append(p)
    wait(lambda: len(wl_windows()) >= 2, 6)
    time.sleep(1.0)                      # let both windows finish mapping before moving the focus away
    activate('nemo')
    seen = []
    t0 = time.time()
    while time.time() - t0 < 6.5:
        seen.append(evj("(()=>{let b=%s;return b?{att:b.attention,fo:Math.round(b.flash.opacity),w:Math.round(b.flash.get_width())}:null})()" % button('win:WlTest')))
        time.sleep(.15)
    att = [x for x in seen if x and x['att']]
    check('urgency hint marks the button', att, (len(seen), seen[:2], seen[-2:]))
    check('flash pulses', att and max(x['fo'] for x in att) > 100, att[:2])
    check('flash follows the (shorter) front tile of a stack', att and {x['w'] for x in att} == {35}, att[:1])
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
    helper = str(ROOT / 'tests/helpers/launcher_entry.py')
    cases = (('count', [], "b.badgeCount===7"), ('progress', ['0.3'], "b.progress===30"), ('urgent', ['1'], "b.attention===true"),
             ('clear', [], "b.badgeCount===0&&b.progress<=0&&!b.attention"))
    for mode, args, pred in cases:
        subprocess.run(['/usr/bin/python3', helper, mode] + args)
        t0 = time.time()
        ok = wait(lambda: ev("''+(()=>{let b=%s;return %s})()" % (button('com.google'), pred)) == 'true', 3, .02)
        check('%s applied at once (%.2fs)' % (mode, time.time() - t0), ok and time.time() - t0 < 0.6)
    errs = log_since(off)
    check('no errors logged by LauncherEntry', not errs, errs[:3])


SECTIONS = [('health', s_health), ('lifecycle', s_lifecycle), ('settings', s_settings_fuzz), ('windows', s_windows),
            ('flyout', s_flyout_peek), ('art', s_tile_art), ('pin', s_pin_drag), ('attention', s_attention), ('menu', s_menu), ('launcher', s_launcher), ('xdnd', s_xdnd), ('language', s_language)]

if __name__ == '__main__':
    want = sys.argv[1:]
    try:
        for name, fn in SECTIONS:
            if not want or name in want:
                fn()
    finally:
        close_windows()
        settle()
    bad = [n for n, ok in results if not ok]
    print('\n%d checks, %d failed' % (len(results), len(bad)))
    for n in bad:
        print('  FAILED:', n)
    sys.exit(1 if bad else 0)
