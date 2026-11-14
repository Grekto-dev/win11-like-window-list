// Thumbnail flyout shown above a taskbar button (Windows 11 "preview cards").
const { Clutter, St, Pango, Meta, Cinnamon } = imports.gi;
const Main = imports.ui.main;
const WindowUtils = imports.misc.windowUtils;

const { Timer } = require('./util');
const { placeNear, preferredSize, monitorRect, revealFromPanel } = require('./popup');

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
        this._peekTimer = new Timer();      // delay before the first peek
        this._peekEndTimer = new Timer();   // grace period while the pointer crosses between cards
        this._peekClone = null;
        this._peekWindow = null;
        this._peeking = false;
        this._peekIsolated = true;          // mode of the peek in progress
        this._hidden = [];                  // [windowActor, original opacity] hidden during a peek
        this._clones = new Set();           // every peek clone we created (crossfades overlap)
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
            // Slides up from under the panel (≈ 250 ms, strong ease-out), clipped by the panel edge.
            revealFromPanel(this.applet, this.actor, 250, Clutter.AnimationMode.EASE_OUT_QUINT);
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
        this._peekEndTimer.clear();
        this._endPeek();
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
            actor.ease({ opacity: 0, duration: 50, mode: EASE_OUT, onComplete: done });
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

        this._endPeek();
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
            this._onCardHover(w, card.hover);
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

    // Where a dragged item (coming from another program, so without Clutter hover events) is: over one of
    // the cards -> { card, window }; over the flyout but not a card -> { inside: true }; else null.
    hitTest(x, y) {
        if (!this.actor) return null;
        const inside = a => {
            const [ax, ay] = a.get_transformed_position();
            const [aw, ah] = a.get_transformed_size();
            return x >= ax && x < ax + aw && y >= ay && y < ay + ah;
        };
        if (!inside(this.actor)) return null;
        for (const [w, entry] of this._cards) {
            if (inside(entry.card)) return { card: entry.card, window: w };
        }
        return { inside: true };
    }

    // -------------------------------------------------------------------- peek
    // Windows 11 "Aero Peek" (measured in the VM, see docs/REFERENCE.md): with the pointer on a thumbnail
    // card for ~0.4 s every other window disappears at once and only that window is shown, in place,
    // even if it is minimized; moving to another card of the same flyout crossfades (~130 ms) without a
    // new delay; leaving the cards restores everything immediately. The desktop stays visible.

    _onCardHover(w, hovered) {
        if (!this.applet.enablePeek) return;
        if (hovered) {
            this._peekEndTimer.clear();
            if (this._peeking) this._switchPeek(w);
            else this._peekTimer.set(this.applet.peekDelay, () => this._beginPeek(w));
        } else {
            this._peekTimer.clear();
            if (this._peeking) this._peekEndTimer.set(70, () => this._endPeek());
        }
    }

    // Peek style changed while a peek is showing: show the same window again in the new style.
    restartPeek() {
        const w = this._peekWindow;
        if (!this._peeking || !w) return;
        this._peekTimer.clear();
        this._endPeek();
        this._beginPeek(w);
    }

    // Called when the peek option is switched off while a peek is showing.
    endPeekNow() {
        this._peekTimer.clear();
        this._endPeek();
    }

    _canPeek(w) {
        const actor = w.get_compositor_private();
        if (!actor) return false;
        return w.is_on_all_workspaces() || w.get_workspace() === global.workspace_manager.get_active_workspace();
    }

    _makeClone(w) {
        const actor = w.get_compositor_private();
        const clone = WindowUtils.getCloneOrContent(actor);
        if (!clone) return null;
        const r = w.get_buffer_rect();
        const [aw, ah] = actor.get_size();
        clone.set_position(r.x, r.y);
        clone.set_size(aw, ah);
        clone.opacity = 0;
        Cinnamon.util_set_hidden_from_pick(clone, true);
        global.overlay_group.add_child(clone);
        global.overlay_group.set_child_above_sibling(clone, null);
        this._clones.add(clone);
        return clone;
    }

    _fadeMs() {
        return this.applet.animate ? 120 : 0;
    }

    _hideActor(a) {
        if (!a) return;
        const ms = this._fadeMs();
        if (!this._hidden.some(([x]) => x === a)) {
            if (a.opacity === 0) return;                 // already invisible for other reasons
            if (a._wlPeekOpacity === undefined) a._wlPeekOpacity = a.opacity;
            this._hidden.push([a, a._wlPeekOpacity]);
        }
        a.remove_all_transitions();
        if (ms) a.ease({ opacity: 0, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        else a.opacity = 0;
    }

    _hideOthers(target) {
        const targetActor = target.get_compositor_private();
        global.get_window_actors().forEach(a => {
            const type = a.meta_window.get_window_type();
            if (a === targetActor || type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK) return;
            if (a.meta_window.is_override_redirect()) return;   // menus, tooltips
            this._hideActor(a);
        });
    }

    _fadeBack([a, opacity]) {
        const ms = this._fadeMs();
        try {
            a.remove_all_transitions();
            const done = () => { delete a._wlPeekOpacity; };
            if (ms) a.ease({ opacity: opacity, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: done });
            else { a.opacity = opacity; done(); }
        } catch (e) { /* window closed while peeking */ }
    }

    _restoreOthers() {
        const hidden = this._hidden;
        this._hidden = [];
        hidden.forEach(entry => this._fadeBack(entry));
    }

    _beginPeek(w) {
        if (!this.isOpen || this._peeking || !this._canPeek(w)) return;
        const clone = this._makeClone(w);
        if (!clone) return;
        this._peeking = true;
        this._peekWindow = w;
        this._peekClone = clone;
        // 'isolate': every other window fades out and only this one is shown, in place.
        // 'overlay': nothing else changes; the window is shown above whatever is on screen.
        this._peekIsolated = this.applet.peekMode !== 'overlay';
        const ms = this._peekIsolated ? this._fadeMs() : (this.applet.animate ? 200 : 0);
        if (ms) clone.ease({ opacity: 255, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        else clone.opacity = 255;
        if (this._peekIsolated) this._hideOthers(w);
    }

    _switchPeek(w) {
        if (w === this._peekWindow) return;
        if (!this._canPeek(w)) return;
        const old = this._peekClone;
        const clone = this._makeClone(w);
        if (!clone) return;
        if (this._peekIsolated) {
            // Only the two windows involved change: the new target is shown, the old one is hidden.
            const newActor = w.get_compositor_private();
            const keep = [];
            this._hidden.forEach(entry => {
                if (entry[0] === newActor) this._fadeBack(entry);
                else keep.push(entry);
            });
            this._hidden = keep;
            this._hideActor(this._peekWindow && this._peekWindow.get_compositor_private());
        }
        this._peekWindow = w;
        this._peekClone = clone;
        const ms = this.applet.animate ? 130 : 0;
        clone.ease({ opacity: 255, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        if (old) {
            old.ease({
                opacity: 0,
                duration: ms,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._dropClone(old),
            });
            if (!ms) this._dropClone(old);
        }
        if (!ms) clone.opacity = 255;
    }

    _dropClone(clone) {
        this._clones.delete(clone);
        try {
            clone.remove_all_transitions();
            if (clone.get_parent()) clone.get_parent().remove_child(clone);
            clone.destroy();
        } catch (e) { /* already gone */ }
    }

    _endPeek() {
        this._peekEndTimer.clear();
        this._peekClone = null;
        this._peekWindow = null;
        this._peeking = false;
        this._restoreOthers();
        const ms = !this._peekIsolated && this.applet.animate ? 120 : 0;
        Array.from(this._clones).forEach(c => {
            if (!ms) {
                this._dropClone(c);
                return;
            }
            this._clones.delete(c);
            c.remove_all_transitions();
            c.ease({ opacity: 0, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => this._dropClone(c) });
        });
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
