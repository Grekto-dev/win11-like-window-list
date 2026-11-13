// Windows 11 style jump list shown on right click of a taskbar button.
const { Clutter, St, Pango } = imports.gi;
const Main = imports.ui.main;

const { placeNear, preferredSize, revealFromPanel } = require('./popup');

const EASE_OUT = Clutter.AnimationMode.EASE_OUT_QUAD;

// items: [{kind: 'header'|'item'|'separator', label, icon (Clutter.Actor|null), activate()}]
class ContextMenu {
    constructor(applet) {
        this.applet = applet;
        this.actor = null;
        this.button = null;
        this._rows = [];        // selectable pills, in order
        this._callbacks = [];
        this._selected = -1;
        this._captureId = 0;
        this._grabbed = false;
    }

    get isOpen() {
        return this.actor !== null;
    }

    open(button, items) {
        this.close(true);
        const m = this.applet.metrics;
        this.button = button;

        const actor = new St.BoxLayout({
            style_class: 'win11-tb-menu',
            vertical: true,
            reactive: true,
            can_focus: true,
        });
        this._rows = [];
        this._callbacks = [];

        items.forEach(item => {
            if (item.kind === 'header') {
                actor.add_child(new St.Label({ style_class: 'win11-tb-menu-header', text: item.label }));
            } else if (item.kind === 'separator') {
                const box = new St.BoxLayout({ x_expand: true });
                box.set_height(m.px(9));
                const line = new St.Widget({
                    style_class: 'win11-tb-menu-sep',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.FILL,
                    y_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                line.set_height(Math.max(1, m.px(1)));
                box.add_child(line);
                actor.add_child(box);
            } else {
                this._addItem(actor, item);
            }
        });

        actor.connect('key-press-event', (a, event) => this._onKey(event));
        Main.layoutManager.addChrome(actor);
        actor.opacity = 0;

        if (!Main.pushModal(actor)) {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
            this.button = null;
            return false;
        }
        this._grabbed = true;
        this.actor = actor;

        const [w, h] = preferredSize(actor);
        const [x, y] = placeNear(this.applet, button.actor, w, h, m.px(14));
        actor.set_position(x, y);
        // Slides up from under the panel (≈ 200 ms), clipped by the panel edge.
        revealFromPanel(this.applet, actor, 200, Clutter.AnimationMode.EASE_OUT_CUBIC);
        actor.grab_key_focus();

        this._captureId = global.stage.connect('captured-event', (stage, event) => this._onCaptured(event));
        return true;
    }

    _addItem(menuActor, item) {
        const m = this.applet.metrics;
        const row = new St.BoxLayout({ x_expand: true });
        row.set_height(m.px(32));

        const pill = new St.BoxLayout({
            style_class: 'win11-tb-menu-item',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.FILL,
            x_expand: true,
        });
        pill.set_height(m.px(28));

        const slot = new St.Widget({ layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER });
        slot.set_size(m.px(16), m.px(16));
        if (item.icon) {
            item.icon.set_x_align(Clutter.ActorAlign.CENTER);
            item.icon.set_y_align(Clutter.ActorAlign.CENTER);
            item.icon.set_x_expand(true);
            item.icon.set_y_expand(true);
            slot.add_child(item.icon);
        }
        pill.add_child(slot);
        const label = new St.Label({
            style_class: 'win11-tb-menu-label',
            text: item.label,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        if (item.ellipsize) label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        pill.add_child(label);

        const index = this._rows.length;
        pill.connect('enter-event', () => {
            this._select(index, false);
            return Clutter.EVENT_PROPAGATE;
        });
        pill.connect('button-release-event', (a, event) => {
            if (event.get_button() !== 1 && event.get_button() !== 3) return Clutter.EVENT_PROPAGATE;
            this._activate(index);
            return Clutter.EVENT_STOP;
        });

        row.add_child(pill);
        menuActor.add_child(row);
        this._rows.push(pill);
        this._callbacks.push(item.activate);
    }

    _select(index, byKeyboard) {
        if (this._selected >= 0 && this._rows[this._selected]) {
            this._rows[this._selected].remove_style_class_name('win11-tb-menu-focus');
        }
        this._selected = index;
        if (byKeyboard && index >= 0 && this._rows[index]) {
            this._rows[index].add_style_class_name('win11-tb-menu-focus');
        }
    }

    _activate(index) {
        const cb = this._callbacks[index];
        this.close();
        if (cb) cb();
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        const n = this._rows.length;
        if (n === 0) return Clutter.EVENT_PROPAGATE;
        switch (sym) {
            case Clutter.KEY_Escape:
                this.close();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
            case Clutter.KEY_Tab:
                this._select(this._selected < 0 ? 0 : (this._selected + 1) % n, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
            case Clutter.KEY_ISO_Left_Tab:
                this._select(this._selected < 0 ? n - 1 : (this._selected + n - 1) % n, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Home:
                this._select(0, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_End:
                this._select(n - 1, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
            case Clutter.KEY_space:
                if (this._selected >= 0) this._activate(this._selected);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    // Press outside closes the menu; a right click on another button opens that button's menu.
    _onCaptured(event) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;
        const src = event.get_source();
        if (this.actor && this.actor.contains(src)) return Clutter.EVENT_PROPAGATE;

        const other = this.applet.buttonForActor(src);
        const rightClick = event.get_button() === 3;
        this.close();
        if (other && rightClick) {
            this.applet.openMenu(other);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    close(immediate) {
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
        const actor = this.actor;
        this.actor = null;
        this.button = null;
        this._rows = [];
        this._callbacks = [];
        this._selected = -1;
        if (!actor) return;
        if (this._grabbed) {
            Main.popModal(actor);
            this._grabbed = false;
        }
        actor.remove_all_transitions();
        const done = () => {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        };
        if (immediate || !this.applet.animate) {
            done();
        } else {
            actor.set_reactive(false);
            actor.ease({ opacity: 0, duration: 50, mode: EASE_OUT, onComplete: done });
        }
    }

    destroy() {
        this.close(true);
    }
}

module.exports = { ContextMenu };
