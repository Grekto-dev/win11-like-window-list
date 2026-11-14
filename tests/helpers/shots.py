#!/usr/bin/python3
"""Captures the taskbar button in every visual state into DIR (png crops, 1:1), to compare two builds.
usage: shots.py DIR"""
import sys, time, subprocess, pathlib, json
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import live_suite as L
from PIL import Image

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
L.bind_instance()


def rect(prefix='win:WlTest'):
    return L.evj("(()=>{let b=%s;let [x,y]=b.actor.get_transformed_position();let [w,h]=b.actor.get_transformed_size();return [Math.round(x),Math.round(y),Math.round(w),Math.round(h)]})()" % L.button(prefix))


def shot(name, prefix='win:WlTest', pad=6):
    r = rect(prefix)
    subprocess.run(['timeout', '30', 'gnome-screenshot', '-f', '/tmp/_s.png'])
    im = Image.open('/tmp/_s.png').convert('RGB')
    im.crop((r[0] - pad, r[1] - pad, r[0] + r[2] + pad, r[1] + r[3] + pad)).save(out / (name + '.png'))


def park():
    L.mv(1500, 300); time.sleep(.5)


try:
    L.spawn_windows(1); L.settle(); L.spawn_other(); time.sleep(1)
    L.activate('win:WlSkip'); time.sleep(.8); park(); shot('1_idle_single')
    L.activate('win:WlTest'); time.sleep(.8); park(); shot('2_focused_single')
    r = rect(); L.mv(r[0] + r[2] // 2, r[1] + r[3] // 2); time.sleep(.6); shot('3_focused_hover_single'); park()
    L.activate('win:WlSkip'); time.sleep(.8)
    r = rect(); L.mv(r[0] + r[2] // 2, r[1] + r[3] // 2); time.sleep(.6); shot('4_hover_single'); L.btn(1, True); time.sleep(.4); shot('5_pressed_single'); L.btn(1, False); time.sleep(.4); park()
    L.close_windows(); L.settle(); L.spawn_windows(3); L.settle(); L.spawn_other(); time.sleep(1)
    L.activate('win:WlSkip'); time.sleep(.8); park(); shot('6_idle_multi')
    L.activate('win:WlTest'); time.sleep(.8); park(); shot('7_focused_multi')
    r = rect(); L.mv(r[0] + r[2] // 2, r[1] + r[3] // 2); time.sleep(.5); L.mv(r[0] + 8, r[1] + 8); time.sleep(.5)
    L.ev("%s.flyout.close(true)" % L.A); time.sleep(.3); shot('8_focused_hover_multi'); park()
    L.activate('win:WlSkip'); time.sleep(.8)
    L.ev("(()=>{let b=%s;let w=b.windows[0];%s._attention.add(w);%s._queueStates();return 1})()" % (L.button('win:WlTest'), L.A, L.A)); time.sleep(1.6); park(); shot('9_attention_multi')
    L.ev("(()=>{%s._attention.clear();%s._queueStates();return 1})()" % (L.A, L.A)); time.sleep(.5)
    L.set_cfg(indicator_color='rgb(255,0,0)'); L.activate('win:WlTest'); time.sleep(.8); park(); shot('10_custom_accent'); L.set_cfg(indicator_color='')
finally:
    L.close_windows(); L.settle()
print('done', len(list(out.glob('*.png'))))
