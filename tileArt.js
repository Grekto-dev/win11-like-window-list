// Everything a taskbar button paints itself, as two Cairo canvases made of plain Clutter actors:
//
//  * `actor`  (below the icon): the tile (fill + 1 px border), the "back page" that peeks out behind it
//    when the app has several windows, and the attention flash;
//  * `top`    (above the icon): the running indicator and the progress bar.
//
// Why not St widgets: a St.Widget costs ≈ 0.8 ms to add to the shell (it resolves its style against the
// whole theme) against ≈ 0.02 ms for a Clutter.Actor, and a button used to have six of them. Drawing
// these parts ourselves also lets one frame-clock timeline animate all of them.
//
// Levels are the ones measured on Windows 11 (docs/REFERENCE.md, "Tile states"): white overlay alphas
// for the fill and for the top / side / bottom parts of the border. Negative = black overlay.
const { Clutter, St, GLib } = imports.gi;
const Cairo = imports.cairo;

const LEVELS = {
    //            fill   top    side   bottom
    idle:       [0,      0,     0,     0],
    hover:      [0.065,  0.043, 0,     0],
    pressed:    [0.045,  0,     0,     0],
    focused:    [0.063,  0.067, 0.019, 0.024],
    focusHover: [0.088,  0.017, 0,     -0.10],
};

const FADE_MS = 150;        // tile level transition
const INDICATOR_MS = 200;   // indicator grows / shrinks / fades
const PULSE_MS = 1100;      // indeterminate progress loop
const FLASH_MS = 1000;      // one half of the attention flash cycle

const IDLE_COLOR = [1, 1, 1, 0.55];
const ACCENT_COLOR = [0x4c / 255, 0xc2 / 255, 1, 1];
const ATTENTION_COLOR = [1, 0x99 / 255, 0xa4 / 255, 1];
const TRACK_COLOR = [1, 1, 1, 0.28];
const FLASH_COLOR = [1, 106 / 255, 72 / 255, 0.45];

const easeCubic = t => 1 - Math.pow(1 - t, 3);
const easeSine = t => -(Math.cos(Math.PI * t) - 1) / 2;

const _colors = new Map();
function parseColor(css) {
    if (!css) return null;
    let c = _colors.get(css);
    if (c === undefined) {
        const [ok, col] = Clutter.Color.from_string(css);
        c = ok ? [col.red / 255, col.green / 255, col.blue / 255, col.alpha / 255] : null;
        _colors.set(css, c);
    }
    return c;
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

function rgba(cr, c, alpha = 1) {
    cr.setSourceRGBA(c[0], c[1], c[2], c[3] * alpha);
}

// A plain actor whose content is a Cairo canvas; `draw(cr, w, h)` paints on a cleared surface.
function makeCanvas(draw) {
    const canvas = new Clutter.Canvas();
    const actor = new Clutter.Actor();
    actor.set_content(canvas);
    canvas.connect('draw', (c, cr, w, h) => {
        try {
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            draw(cr, w, h);
        } finally {
            cr.$dispose();
        }
        return true;
    });
    return { actor, canvas };
}

class TileArt {
    constructor(button) {
        this.button = button;
        const base = makeCanvas((cr, w, h) => this._paintBase(cr, w, h));
        const top = makeCanvas((cr, w, h) => this._paintTop(cr, w, h));
        this._base = base.canvas;
        this._top = top.canvas;
        this.actor = base.actor;
        this.top = top.actor;

        this.multi = false;
        // tile levels
        this._now = LEVELS.idle.slice();
        this._from = LEVELS.idle.slice();
        this._to = LEVELS.idle.slice();
        this._lvT0 = -1;
        // running indicator: [length along the bar, alpha]
        this._ind = [0, 0];
        this._indFrom = [0, 0];
        this._indTo = [0, 0];
        this._indT0 = -1;
        this.indicatorCss = '';
        this.indicatorColor = IDLE_COLOR;
        // progress: 'none' | 'bar' (fill [from, from + len) of the track) | 'pulse'
        this.progress = { mode: 'none', from: 0, len: 0 };
        this._flash = 0;                 // 0..1 of the flash colour's own alpha
        this._flashing = false;

        this._tl = null;                 // drives the level / indicator transitions
        this._pulseTl = null;
        this._flashTl = null;
        this.actor.connect('destroy', () => this.destroy());
    }

    // ------------------------------------------------------------------ size

    resize(w, h) {
        [this.actor, this.top].forEach(a => a.set_size(w, h));
        this._base.set_size(w, h);
        this._top.set_size(w, h);
    }

    destroy() {
        [this._tl, this._pulseTl, this._flashTl].forEach(t => {
            if (t) t.stop();
        });
        this._tl = this._pulseTl = this._flashTl = null;
    }

    // ------------------------------------------------------------ transitions

    // One timeline, started whenever something begins to move; it ends itself when everything arrived.
    // It runs on the compositor's frame clock: a step per frame actually drawn, no extra wake-ups, and
    // a slow machine simply takes bigger steps.
    _kick() {
        if (!this._tl) {
            this._tl = new Clutter.Timeline({ duration: 1000 });
            this._tl.connect('new-frame', () => this._step());
        }
        this._tl.rewind();
        this._tl.start();
    }

    _step() {
        const now = GLib.get_monotonic_time() / 1000;
        let busy = false;
        if (this._lvT0 >= 0) {
            const t = Math.min(1, (now - this._lvT0) / FADE_MS);
            this._now = this._from.map((v, i) => v + (this._to[i] - v) * t);
            this._base.invalidate();
            if (t >= 1) this._lvT0 = -1;
            else busy = true;
        }
        if (this._indT0 >= 0) {
            const t = easeCubic(Math.min(1, (now - this._indT0) / INDICATOR_MS));
            this._ind = this._indFrom.map((v, i) => v + (this._indTo[i] - v) * t);
            this._top.invalidate();
            if (t >= 1) this._indT0 = -1;
            else busy = true;
        }
        if (!busy && this._tl) this._tl.stop();
    }

    // Called whenever hover / pressed / focused changes.
    setState(name, animate) {
        const to = LEVELS[name] || LEVELS.idle;
        if (to.every((v, i) => v === this._to[i])) return;
        this._from = this._now.slice();
        this._to = to.slice();
        if (!animate) {
            this._lvT0 = -1;
            this._now = to.slice();
            this._base.invalidate();
            return;
        }
        this._lvT0 = GLib.get_monotonic_time() / 1000;
        this._kick();
    }

    setMulti(multi) {
        if (this.multi === multi) return;
        this.multi = multi;
        this._base.invalidate();
    }

    // Running indicator: `len` px along the bar, `alpha` 0..1, colour as a CSS string (empty = idle grey).
    setIndicator(len, alpha, color, animate) {
        this.indicatorCss = color || '';
        this.indicatorColor = color === 'attention' ? ATTENTION_COLOR
            : color ? (parseColor(color) || ACCENT_COLOR) : IDLE_COLOR;
        if (len === this._indTo[0] && alpha === this._indTo[1]) {
            this._top.invalidate();                       // only the colour may have changed
            return;
        }
        this._indFrom = this._ind.slice();
        this._indTo = [len, alpha];
        if (!animate || (this._ind[0] === 0 && this._ind[1] === 0 && alpha === 0)) {
            this._indT0 = -1;
            this._ind = [len, alpha];
            this._top.invalidate();
            return;
        }
        this._indT0 = GLib.get_monotonic_time() / 1000;
        this._kick();
        this._top.invalidate();
    }

    // Progress bar replacing the indicator: mode 'bar' fills [from, from + len); 'pulse' loops; 'none'.
    setProgress(mode, from = 0, len = 0) {
        const p = this.progress;
        if (p.mode === mode && (mode === 'pulse' || (p.from === from && p.len === len))) return;
        p.mode = mode;
        if (mode !== 'pulse') {
            p.from = from;
            p.len = len;
        }
        if (mode === 'pulse') this._startPulse();
        else this._stopPulse();
        this._top.invalidate();
    }

    _startPulse() {
        if (this._pulseTl) return;
        const tl = new Clutter.Timeline({ duration: PULSE_MS });
        tl.set_repeat_count(-1);
        tl.connect('new-frame', t => {
            const p = t.get_progress();
            const L = this.button.applet.metrics.icon;
            const head = 1 - Math.pow(1 - Math.min(1, p / 0.7), 3);
            const tail = p < 0.3 ? 0 : Math.pow(Math.min(1, (p - 0.3) / 0.7), 3);
            const a = Math.round(tail * L);
            const b = Math.round(head * L);
            this.progress.from = a;
            this.progress.len = Math.max(2, b - a);
            this._top.invalidate();
        });
        this._pulseTl = tl;
        tl.start();
    }

    _stopPulse() {
        if (!this._pulseTl) return;
        this._pulseTl.stop();
        this._pulseTl = null;
    }

    // Attention flash: the orange overlay rises once, then breathes between 110/255 and full strength
    // (≈ 2 s period, see REFERENCE.md). Without animation it simply stays lit.
    setFlash(on, animate) {
        if (on === this._flashing) return;
        this._flashing = on;
        if (this._flashTl) {
            this._flashTl.stop();
            this._flashTl = null;
        }
        if (!on) {
            this._flash = 0;
            this._base.invalidate();
            return;
        }
        if (!animate) {
            this._flash = 1;
            this._base.invalidate();
            return;
        }
        const t0 = GLib.get_monotonic_time() / 1000;
        const tl = new Clutter.Timeline({ duration: 2 * FLASH_MS });
        tl.set_repeat_count(-1);
        tl.connect('new-frame', () => {
            const t = (GLib.get_monotonic_time() / 1000 - t0) / FLASH_MS;
            let v;
            if (t < 1) {
                v = easeSine(t);
            } else {
                const u = (t - 1) % 2;
                const low = 110 / 255;
                v = u < 1 ? 1 - (1 - low) * easeSine(u) : low + (1 - low) * easeSine(u - 1);
            }
            this._flash = v;
            this._base.invalidate();
        });
        this._flashTl = tl;
        tl.start();
    }

    // For tests and diagnostics.
    info() {
        const m = this.button.applet.metrics;
        const [tw] = this._frontSize(m);
        return {
            multi: this.multi,
            levels: this._now.slice(),
            indicator: { len: this._ind[0], alpha: this._ind[1], css: this.indicatorCss },
            progress: Object.assign({}, this.progress),
            flash: Math.round(this._flash * 255),
            frontW: tw,
            frontH: this._frontSize(m)[1],
        };
    }

    // ---------------------------------------------------------------- painting

    static color(cr, a) {
        cr.setSourceRGBA(a < 0 ? 0 : 1, a < 0 ? 0 : 1, a < 0 ? 0 : 1, Math.abs(a));
    }

    // Fill plus border of one rounded rectangle (border: top -> sides -> bottom gradient, 1 px, inside).
    _shape(cr, x, y, w, h, r, hair) {
        const [fill, top, side, bottom] = this._now;
        roundedRect(cr, x, y, w, h, r);
        TileArt.color(cr, fill);
        cr.fill();
        if (!top && !side && !bottom) return;
        const g = new Cairo.LinearGradient(0, y, 0, y + h);
        const stop = (o, a) => g.addColorStopRGBA(o, a < 0 ? 0 : 1, a < 0 ? 0 : 1, a < 0 ? 0 : 1, Math.abs(a));
        // Hard stops: the first pixel row is exactly `top`, the last exactly `bottom`, the rest `side`.
        const e = Math.min(0.25, hair / h);
        const eps = 0.001;
        stop(0, top);
        stop(e, top);
        stop(e + eps, side);
        stop(1 - e - eps, side);
        stop(1 - e, bottom);
        stop(1, bottom);
        roundedRect(cr, x + hair / 2, y + hair / 2, w - hair, h - hair, Math.max(0, r - hair / 2));
        cr.setSource(g);
        cr.setLineWidth(hair);
        cr.stroke();
    }

    // Size of the front tile: shorter along the bar when a page peeks out behind it.
    _frontSize(m) {
        const w = m.tileW;
        const h = m.tileH;
        if (!this.multi) return [w, h];
        return m.horizontal ? [w - m.stackInset, h] : [w, h - m.stackInset];
    }

    _paintBase(cr, w, h) {
        const m = this.button.applet.metrics;
        const r = m.px(4.5);   // measured corner: slightly rounder than the nominal 4 px
        const hair = Math.max(1, m.px(1));
        const [fill, top, side, bottom] = this._now;
        const [tw, th] = this._frontSize(m);

        if (fill || top || side || bottom) {
            if (!this.multi) {
                this._shape(cr, 0, 0, w, h, r, hair);
            } else {
                const inset = m.stackInset;
                const gap = Math.max(1, inset - m.backW);   // empty band between front tile and page

                // Back page: the full-size rounded tile minus the front tile grown by the gap.
                cr.save();
                roundedRect(cr, 0, 0, w, h, r);
                cr.clip();
                cr.rectangle(0, 0, w, h);
                roundedRect(cr, -gap, -gap, tw + 2 * gap, th + 2 * gap, r + gap);
                cr.setFillRule(Cairo.FillRule.EVEN_ODD);
                cr.clip();
                this._shape(cr, 0, 0, w, h, r, hair);
                cr.restore();

                this._shape(cr, 0, 0, tw, th, r, hair);
            }
        }
        if (this._flash > 0) {
            roundedRect(cr, 0, 0, tw, th, m.px(4));
            rgba(cr, FLASH_COLOR, this._flash);
            cr.fill();
        }
    }

    // Rectangle `along` px long and `thick` px thick on the screen-edge side of the button, centred along
    // the bar, `shift` px further along it.
    _edgeRect(m, w, h, along, thick, shift = 0) {
        const edge = m.indicatorEdge;
        if (m.horizontal) {
            const y = m.side === St.Side.TOP ? edge : h - thick - edge;
            return [Math.round((w - along) / 2 + shift), y, Math.round(along), thick];
        }
        const x = m.side === St.Side.LEFT ? edge : w - thick - edge;
        return [x, Math.round((h - along) / 2 + shift), thick, Math.round(along)];
    }

    _paintTop(cr, w, h) {
        const m = this.button.applet.metrics;
        const p = this.progress;
        if (p.mode !== 'none') {
            const hair = Math.max(1, m.px(1));
            const [x, y, rw, rh] = this._edgeRect(m, w, h, m.icon, hair);
            roundedRect(cr, x, y, rw, rh, 1);
            rgba(cr, TRACK_COLOR);
            cr.fill();
            if (p.len > 0) {
                const [fx, fy, fw, fh] = this._edgeRect(m, w, h, p.len, m.indicatorH, p.from - m.icon / 2 + p.len / 2);
                roundedRect(cr, fx, fy, fw, fh, m.px(2));
                rgba(cr, ACCENT_COLOR);
                cr.fill();
            }
            return;
        }
        const [len, alpha] = this._ind;
        if (alpha <= 0 || len <= 0) return;
        const [x, y, rw, rh] = this._edgeRect(m, w, h, len, m.indicatorH);
        roundedRect(cr, x, y, rw, rh, m.px(2));
        rgba(cr, this.indicatorColor, alpha);
        cr.fill();
    }
}

module.exports = { TileArt };
