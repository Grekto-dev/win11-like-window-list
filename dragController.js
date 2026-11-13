// Reordering of taskbar buttons by dragging, modelled on the Windows 11 taskbar (docs/REFERENCE.md):
//  - the drag starts after a few pixels of movement; the tile and indicator disappear and the icon
//    alone grows to 1.2x and follows the pointer along the panel axis only (it never leaves the bar);
//  - neighbours slide aside (~250 ms, ease-out) as soon as the icon reaches their tile;
//  - on release the icon settles into its slot (~200 ms) and the order is saved;
//  - Esc does nothing, and releasing outside the panel still drops into the slot shown.
const { Clutter, Cinnamon, Gtk } = imports.gi;
const Main = imports.ui.main;

const EASE_CUBIC = Clutter.AnimationMode.EASE_OUT_CUBIC;
const DRAG_SCALE = 1.2;

class ReorderDrag {
    constructor(applet, btn, event) {
        this.applet = applet;
        this.btn = btn;
        this.started = false;
        this.finished = false;
        this.ghost = null;
        [this.px0, this.py0] = event.get_coords();
        this.threshold = Gtk.Settings.get_default().gtk_dnd_drag_threshold || 8;
        this.device = event.get_device();
        this.handler = null;
        this.modal = false;
        this.device.grab(btn.actor);
        this._eventId = btn.actor.connect('event', (a, e) => this._onEvent(e));
    }

    _onEvent(event) {
        switch (event.type()) {
            case Clutter.EventType.BUTTON_RELEASE:
                if (this.started) {
                    this._drop();
                    return Clutter.EVENT_STOP;
                }
                this._release();
                return Clutter.EVENT_PROPAGATE;
            case Clutter.EventType.MOTION: {
                const [x, y] = event.get_coords();
                if (!this.started) {
                    if (Math.abs(x - this.px0) > this.threshold || Math.abs(y - this.py0) > this.threshold) {
                        this._start(x, y);
                    }
                    return this.started ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
                }
                this._move(x, y);
                return Clutter.EVENT_STOP;
            }
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    _release() {
        if (this._eventId) {
            if (!this.btn.destroyed) this.btn.actor.disconnect(this._eventId);
            this._eventId = 0;
        }
        if (this.device) {
            this.device.ungrab();
            this.device = null;
        }
        if (this.handler) {
            if (this.modal) Main.popModal(this.handler);
            this.modal = false;
            this.handler.destroy();
            this.handler = null;
        }
        if (!this.started) this.applet.dragFinished(this);
    }

    // Once the drag starts, a modal grab keeps pointer events coming while the pointer is over other
    // windows or outside the panel (same technique as Cinnamon's own drag and drop).
    _takeModalGrab() {
        const handler = new Clutter.Actor({ width: 0, height: 0, reactive: true });
        Main.uiGroup.add_child(handler);
        if (this._eventId) {
            if (!this.btn.destroyed) this.btn.actor.disconnect(this._eventId);
            this._eventId = 0;
        }
        const ev = handler.connect('event', (a, e) => this._onEvent(e));
        this.modal = Main.pushModal(handler);
        if (this.modal && this.device) {
            this.device.ungrab();
            this.device.grab(handler);
            this.handler = handler;
            return;
        }
        // Could not take the modal grab: keep working with the actor grab.
        handler.disconnect(ev);
        handler.destroy();
        if (this.device) this.device.grab(this.btn.actor);
        this._eventId = this.btn.actor.connect('event', (a, e) => this._onEvent(e));
    }

    _start(x, y) {
        const a = this.applet;
        const m = a.metrics;
        const btn = this.btn;
        this.started = true;
        a.beginDrag(btn);
        // St.Button grabbed the pointer on press; resetting it drops that grab, so take it again.
        btn.actor.fake_release();
        this._takeModalGrab();

        const rect = btn.iconRect();
        this.ghost = btn.createDragIcon();
        Main.uiGroup.add_child(this.ghost);
        this.ghost.raise_top();
        Cinnamon.util_set_hidden_from_pick(this.ghost, true);
        this.ghost.set_pivot_point(0.5, 0.5);
        this.ghost.set_position(rect.x, rect.y);
        this.cross = m.horizontal ? rect.y : rect.x;
        this.centre0 = m.horizontal ? rect.x + rect.w / 2 : rect.y + rect.h / 2;
        this.press0 = m.horizontal ? this.px0 : this.py0;
        this.size = m.horizontal ? rect.w : rect.h;

        btn.setDragging(true);
        this.ghost.ease({
            scale_x: DRAG_SCALE,
            scale_y: DRAG_SCALE,
            duration: a.animate ? 100 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._move(x, y);
    }

    _move(x, y) {
        const a = this.applet;
        const m = a.metrics;
        const H = m.horizontal;
        const btn = this.btn;
        if (btn.destroyed || !this.ghost) return;

        const box = a.box;
        const [bx, by] = box.get_transformed_position();
        const [bw, bh] = box.get_transformed_size();
        const start = H ? bx : by;
        const end = start + (H ? bw : bh);
        let centre = this.centre0 + ((H ? x : y) - this.press0);
        centre = Math.max(start, Math.min(end, centre));

        if (H) this.ghost.set_position(centre - this.size / 2, this.cross);
        else this.ghost.set_position(this.cross, centre - this.size / 2);

        // The icon takes a neighbour's slot once it reaches that neighbour's tile.
        const along = H ? m.tileW : m.tileH;
        const pitch = along + m.gap;
        const buttons = a.liveButtons();
        const n = buttons.length;
        const from = buttons.indexOf(btn);
        if (from < 0) return;
        let slot = from;
        while (slot < n - 1 && centre >= start + (slot + 1) * pitch) slot++;
        while (slot > 0 && centre <= start + (slot - 1) * pitch + along) slot--;
        if (slot !== from) a.moveButton(btn, slot);
    }

    _drop() {
        const a = this.applet;
        const btn = this.btn;
        this._release();
        if (this.finished) return;
        a.commitOrder();
        if (btn.destroyed || !this.ghost || !a.animate) {
            this._finish();
            return;
        }
        const t = btn.iconRect();
        this.ghost.ease({
            x: t.x,
            y: t.y,
            scale_x: 1,
            scale_y: 1,
            duration: 200,
            mode: EASE_CUBIC,
            onComplete: () => this._finish(),
        });
    }

    // Called when the button vanishes (window closed) or the applet is torn down.
    abort() {
        if (this.finished) return;
        this._release();
        this._finish();
    }

    _finish() {
        if (this.finished) return;
        this.finished = true;
        if (this.ghost) {
            this.ghost.remove_all_transitions();
            this.ghost.destroy();
            this.ghost = null;
        }
        if (!this.btn.destroyed) this.btn.setDragging(false);
        this.applet.dragFinished(this);
    }
}

module.exports = { ReorderDrag };
