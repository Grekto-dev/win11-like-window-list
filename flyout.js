// Thumbnail flyout shown above a taskbar button (Windows 11 "preview cards").
const { Clutter, St, Pango } = imports.gi;
const Main = imports.ui.main;
const WindowUtils = imports.misc.windowUtils;

const { Timer } = require('./util');
const { placeNear, slideOffset, preferredSize, monitorRect } = require('./popup');

const EASE_OUT = Clutter.AnimationMode.EASE_OUT_QUAD;
const CLOSE_DELAY = 300;     // ms between leaving button/flyout and closing
const CARD_W = 216;          // card width, preview is CARD_W - 16
const PREVIEW_W = 200;
const PREVIEW_MAX_H = 150;
const LIST_ROW_W = 260;

class Flyout {
    constructor(applet) {
        this.applet = applet;
        this.actor = null;
        this.button = null;
        this.sticky = false;
        this.listMode = false;
        this._cards = new Map();   // MetaWindow -> {card, label}
        this._closeTimer = new Timer();
        this._peekTimer = new Timer();
        this._peekClone = null;
        this._peekWindow = null;
        this._captureId = 0;
        this._grabbed = false;
    }

    get isOpen() {
        return this.actor !== null;
    }

    // ------------------------------------------------------------------ opening

    open(button, sticky) {
        if (!button || button.windows.length === 0) return;
        this._closeTimer.clear();
        const switching = this.isOpen;
        if (sticky) this.sticky = true;
        this.button = button;

        if (!this.actor) {
            this.actor = new St.BoxLayout({
                style_class: 'win11-tb-flyout',
                reactive: true,
                track_hover: true,
            });
            this.actor.connect('enter-event', () => {
                this._closeTimer.clear();
                return Clutter.EVENT_PROPAGATE;
            });
            this.actor.connect('leave-event', () => {
                this.scheduleClose();
                return Clutter.EVENT_PROPAGATE;
            });
            Main.layoutManager.addChrome(this.actor);
            this.actor.opacity = 0;
        }

        this._rebuild();
        this._reposition();

        if (!switching) {
            const m = this.applet.metrics;
            const [dx, dy] = slideOffset(this.applet, m.px(10));
            this.actor.remove_all_transitions();
            this.actor.translation_x = dx;
            this.actor.translation_y = dy;
            this.actor.ease({
                opacity: 255,
                translation_x: 0,
                translation_y: 0,
                duration: this.applet.animate ? 167 : 0,
                mode: EASE_OUT,
            });
            if (!this.applet.animate) this.actor.opacity = 255;
        } else {
            this.actor.opacity = 255;
        }
        if (this.sticky) this._armOutside();
    }

    // Window list of the current button changed (open/close/title...).
    sync() {
        if (!this.isOpen) return;
        if (!this.button || this.button.destroyed || this.button.windows.length === 0) {
            this.close(true);
            return;
        }
        this._rebuild();
        this._reposition();
    }

    updateTitle(metaWindow) {
        const entry = this._cards.get(metaWindow);
        if (entry) entry.label.set_text(metaWindow.get_title() || '');
    }

    // ------------------------------------------------------------------ closing

    scheduleClose() {
        if (this.sticky || !this.isOpen) return;
        this._closeTimer.set(CLOSE_DELAY, () => this.close());
    }

    cancelClose() {
        this._closeTimer.clear();
    }

    close(immediate) {
        this._closeTimer.clear();
        this._peekTimer.clear();
        this._unpeek(true);
        this._disarmOutside();
        this.sticky = false;
        this.button = null;
        this._cards.clear();

        const actor = this.actor;
        this.actor = null;
        if (!actor) return;
        actor.remove_all_transitions();
        const done = () => {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        };
        if (immediate || !this.applet.animate) {
            done();
        } else {
            actor.set_reactive(false);
            actor.ease({ opacity: 0, duration: 100, mode: EASE_OUT, onComplete: done });
        }
    }

    destroy() {
        this.close(true);
    }

    // ---------------------------------------------------------------- building

    _rebuild() {
        const btn = this.button;
        const m = this.applet.metrics;
        const windows = btn.windows.slice();
        const mon = monitorRect(btn.actor);
        const perRow = Math.max(1, Math.floor((mon.width - 2 * m.px(8)) / m.px(CARD_W)));
        const wasList = this.listMode;
        this.listMode = windows.length > perRow;

        this._unpeek(true);
        this._cards.clear();
        this.actor.destroy_all_children();
        this.actor.set_vertical(this.listMode);
        if (wasList !== this.listMode) this.actor.remove_style_class_name('win11-tb-flyout-list');
        if (this.listMode) this.actor.add_style_class_name('win11-tb-flyout-list');

        windows.forEach(w => {
            const entry = this.listMode ? this._makeRow(w) : this._makeCard(w);
            this.actor.add_child(entry.card);
            this._cards.set(w, entry);
        });
    }

    _makeIcon(size) {
        const btn = this.button;
        if (btn.app) {
            try {
                return btn.app.create_icon_texture(size);
            } catch (e) { /* fall through */ }
        }
        return new St.Icon({ icon_name: 'application-x-executable', icon_size: size });
    }

    _makeHeader(w, closeBtnOpacity) {
        const m = this.applet.metrics;
        const header = new St.BoxLayout({ style_class: 'win11-tb-card-header', x_expand: true });
        header.add_child(this._makeIcon(m.px(16)));

        const label = new St.Label({
            style_class: 'win11-tb-card-title',
            text: w.get_title() || '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        header.add_child(label);

        const close = new St.Button({
            style_class: 'win11-tb-card-close',
            reactive: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: closeBtnOpacity,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: m.px(16) }),
        });
        close.set_size(m.px(24), m.px(24));
        close.connect('clicked', () => {
            w.delete(global.get_current_time());
            return Clutter.EVENT_STOP;
        });
        header.add_child(close);
        return { header, label, close };
    }

    _wireCard(card, w, close, always) {
        card.connect('button-release-event', (actor, event) => {
            if (close.contains(event.get_source())) return Clutter.EVENT_PROPAGATE;
            const b = event.get_button();
            if (b === 1) {
                this.applet.activateWindow(w);
                this.close();
            } else if (b === 2) {
                w.delete(global.get_current_time());
            }
            return Clutter.EVENT_STOP;
        });
        card.connect('notify::hover', () => {
            if (!always) close.opacity = card.hover ? 255 : 0;
            if (card.hover) this._schedulePeek(w);
            else this._cancelPeek(w);
        });
    }

    _makeCard(w) {
        const m = this.applet.metrics;
        const card = new St.BoxLayout({
            style_class: 'win11-tb-card',
            vertical: true,
            reactive: true,
            track_hover: true,
        });
        card.set_width(m.px(CARD_W));
        const { header, label, close } = this._makeHeader(w, 0);
        card.add_child(header);

        const preview = new St.Bin({
            style_class: 'win11-tb-card-preview',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        const winActor = w.get_compositor_private();
        const maxW = m.px(PREVIEW_W);
        const maxH = m.px(PREVIEW_MAX_H);
        let pw = maxW;
        let ph = Math.round(maxW * 9 / 16);
        if (winActor) {
            const [aw, ah] = winActor.get_size();
            if (aw > 0 && ah > 0) {
                const s = Math.min(maxW / aw, maxH / ah);
                pw = Math.max(1, Math.round(aw * s));
                ph = Math.max(1, Math.round(ah * s));
            }
            const clone = WindowUtils.getCloneOrContent(winActor, pw, ph);
            if (clone) preview.set_child(clone);
        }
        preview.set_size(maxW, ph);
        card.add_child(preview);

        this._wireCard(card, w, close, false);
        return { card, label };
    }

    // Compact row used when there are too many windows for the preview cards.
    _makeRow(w) {
        const m = this.applet.metrics;
        const card = new St.BoxLayout({
            style_class: 'win11-tb-card win11-tb-row',
            reactive: true,
            track_hover: true,
        });
        card.set_width(m.px(LIST_ROW_W));
        const { header, label, close } = this._makeHeader(w, 0);
        header.x_expand = true;
        card.add_child(header);
        this._wireCard(card, w, close, false);
        return { card, label };
    }

    _reposition() {
        const m = this.applet.metrics;
        const btn = this.button;
        if (!btn || !this.actor) return;
        const [w, h] = preferredSize(this.actor);
        const [x, y] = placeNear(this.applet, btn.actor, w, h, m.px(13));
        this.actor.set_position(x, y);
    }

    // -------------------------------------------------------------------- peek

    _schedulePeek(w) {
        if (!this.applet.enablePeek) return;
        this._peekTimer.set(this.applet.peekDelay, () => this._peek(w));
    }

    _cancelPeek(w) {
        this._peekTimer.clear();
        if (this._peekWindow === w) this._unpeek(false);
    }

    _peek(w) {
        this._unpeek(true);
        const actor = w.get_compositor_private();
        if (!actor) return;
        const clone = WindowUtils.getCloneOrContent(actor);
        if (!clone) return;
        const [x, y] = actor.get_position();
        const [cw, ch] = actor.get_size();
        clone.opacity = 0;
        clone.set_position(x, y);
        clone.set_size(cw, ch);
        global.overlay_group.add_child(clone);
        global.overlay_group.set_child_above_sibling(clone, null);
        clone.ease({ opacity: 255, duration: this.applet.animate ? 150 : 0, mode: EASE_OUT });
        this._peekClone = clone;
        this._peekWindow = w;
    }

    _unpeek(immediate) {
        const clone = this._peekClone;
        this._peekClone = null;
        this._peekWindow = null;
        if (!clone) return;
        const done = () => {
            if (clone.get_parent()) clone.get_parent().remove_child(clone);
            clone.destroy();
        };
        if (immediate || !this.applet.animate) {
            clone.remove_all_transitions();
            done();
        } else {
            clone.ease({ opacity: 0, duration: 100, mode: EASE_OUT, onComplete: done });
        }
    }

    // -------------------------------------------- sticky flyout: outside click / Esc

    // A modal grab makes clicks on other windows reach the stage, so they can dismiss the flyout.
    _armOutside() {
        if (this._captureId) return;
        if (!this._grabbed && this.actor && Main.pushModal(this.actor)) this._grabbed = true;
        this._captureId = global.stage.connect('captured-event', (stage, event) => {
            const type = event.type();
            if (type === Clutter.EventType.BUTTON_PRESS) {
                const src = event.get_source();
                const inside = (this.actor && this.actor.contains(src))
                    || (this.button && this.button.actor.contains(src));
                if (!inside) this.close();
            } else if (type === Clutter.EventType.KEY_PRESS) {
                if (event.get_key_symbol() === Clutter.KEY_Escape) this.close();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _disarmOutside() {
        if (this._grabbed && this.actor) {
            Main.popModal(this.actor);
            this._grabbed = false;
        }
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
    }
}

module.exports = { Flyout };
