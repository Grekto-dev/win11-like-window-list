// The tile behind a taskbar button (fill + 1 px border) and, when the app has several windows, the
// "back page" peeking out behind it. Drawn with Cairo because the shape of the back page cannot be made
// with CSS: it is a full-size rounded tile whose visible part is whatever lies outside the front tile
// grown by a 2 px gap, so its inner edge follows the front tile's rounded corner.
//
// Levels are the ones measured on Windows 11 (docs/REFERENCE.md, "Tile states"): white overlay alphas
// for the fill and for the top / side / bottom parts of the border. Negative = black overlay.
const { St, GLib } = imports.gi;
const Cairo = imports.cairo;

const LEVELS = {
    //            fill   top    side   bottom
    idle:       [0,      0,     0,     0],
    hover:      [0.065,  0.043, 0,     0],
    pressed:    [0.045,  0,     0,     0],
    focused:    [0.063,  0.067, 0.019, 0.024],
    focusHover: [0.088,  0.017, 0,     -0.10],
};

const FADE_MS = 150;

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

class TileArt {
    constructor(button) {
        this.button = button;
        this.actor = new St.DrawingArea({
            style_class: 'win11-tb-tile',
            x_expand: true,
            y_expand: true,
        });
        this.actor.connect('repaint', () => this._paint());
        this.multi = false;
        this._now = LEVELS.idle.slice();
        this._from = LEVELS.idle.slice();
        this._to = LEVELS.idle.slice();
        this._t0 = 0;
        this._timer = 0;
        this.actor.connect('destroy', () => this._stop());
    }

    // Called whenever hover / pressed / focused / multi-window changes.
    setState(name, animate) {
        const to = LEVELS[name] || LEVELS.idle;
        if (to.every((v, i) => v === this._to[i])) return;
        this._from = this._now.slice();
        this._to = to.slice();
        if (!animate) {
            this._stop();
            this._now = to.slice();
            this.actor.queue_repaint();
            return;
        }
        this._t0 = GLib.get_monotonic_time() / 1000;
        if (!this._timer) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => this._tick());
        }
    }

    setMulti(multi) {
        if (this.multi === multi) return;
        this.multi = multi;
        this.actor.queue_repaint();
    }

    _tick() {
        const t = Math.min(1, (GLib.get_monotonic_time() / 1000 - this._t0) / FADE_MS);
        this._now = this._from.map((v, i) => v + (this._to[i] - v) * t);
        this.actor.queue_repaint();
        if (t >= 1) {
            this._timer = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _stop() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = 0;
    }

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

    _paint() {
        const cr = this.actor.get_context();
        try {
            const [w, h] = this.actor.get_surface_size();
            const m = this.button.applet.metrics;
            const horizontal = m.horizontal;
            const r = m.px(4.5);   // measured corner: slightly rounder than the nominal 4 px
            const hair = Math.max(1, m.px(1));
            const [fill, top, side, bottom] = this._now;
            if (!fill && !top && !side && !bottom) return;

            if (!this.multi) {
                this._shape(cr, 0, 0, w, h, r, hair);
                return;
            }
            const inset = m.stackInset;                 // front tile is this much shorter along the bar
            const gap = Math.max(1, inset - m.backW);   // empty band between front tile and page
            const tw = horizontal ? w - inset : w;
            const th = horizontal ? h : h - inset;

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
        } finally {
            cr.$dispose();
        }
    }
}

module.exports = { TileArt };
