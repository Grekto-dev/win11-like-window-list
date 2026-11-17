// One taskbar button. Built from plain Clutter actors (see tileArt.js for why): a Cairo canvas under the
// icon (tile, stacked page, attention flash), the icon, and a Cairo canvas above it (running indicator,
// progress bar). Only the notification badge, which needs text, is a St widget, created on first use.
// Geometry and states follow docs/REFERENCE.md (measured from Windows 11). Works on horizontal and
// vertical panels.
const { Clutter, St } = imports.gi;

const { TileArt } = require('./tileArt');
const { appName, appIcon } = require('./util');

const EASE_OUT = Clutter.AnimationMode.EASE_OUT_QUAD;
const EASE_CUBIC = Clutter.AnimationMode.EASE_OUT_CUBIC;
const DEFAULT_ACCENT = '#4cc2ff';

class TaskButton {
    constructor(applet, id, app, fallbackName) {
        this.applet = applet;
        this.id = id;
        this.app = app;                  // Cinnamon.App or null
        this.fallbackName = fallbackName || id;
        this.windows = [];
        this.pinned = false;
        this.focused = false;
        this.attention = false;
        this.destroyed = false;
        this.removing = false;
        this.dragging = false;
        this.hover = false;
        this.progress = -1;              // 0..100, -1 = none
        this.pulse = false;
        this.badgeCount = 0;
        this._indicatorLen = -1;
        this._indicatorKey = null;
        this._multi = null;
        this._pressed = false;
        this._down = 0;                  // mouse button pressed on this button, 0 = none
        this._badge = null;

        // No layout manager: every child has the size of the button and is clipped with it.
        this.actor = new Clutter.Actor({ reactive: true });
        this.actor._delegate = this;

        this.art = new TileArt(this);
        this.tile = this.art.actor;
        this.iconBin = new Clutter.Actor({ layout_manager: new Clutter.BinLayout() });
        this.iconBin.set_pivot_point(0.5, 0.5);
        [this.tile, this.iconBin, this.art.top].forEach(a => this.actor.add_child(a));

        this.applyMetrics();
        this.buildIcon();

        // A plain actor has no click logic of its own. Handlers that return EVENT_PROPAGATE let the drag
        // controller (connected later) see the press; the connect_after handlers then swallow the event,
        // as St.Button did, so it does not reach the panel and open its own context menu.
        this.actor.connect('button-press-event', (a, event) => {
            this._down = event.get_button();
            if (this._down === 1) this._setPressed(true);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('button-release-event', (a, event) => {
            const b = event.get_button();
            this._setPressed(false);
            // Inside by geometry, not by the enter/leave flag: those events can be missed when the pointer
            // arrives while another actor holds a grab, and a lost click is worse than a lost highlight.
            const [ex, ey] = event.get_coords();
            const [x, y] = this.actor.get_transformed_position();
            const [w, h] = this.actor.get_transformed_size();
            const clicked = this._down === b && ex >= x && ex < x + w && ey >= y && ey < y + h;
            this._down = 0;
            if (clicked) this.applet.onButtonClicked(this, b);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect_after('button-press-event', () => Clutter.EVENT_STOP);
        this.actor.connect_after('button-release-event', () => Clutter.EVENT_STOP);
        this.actor.connect('leave-event', () => {
            this._down = 0;
            this.hover = false;
            this._setPressed(false);
            this.updateArt();
            this.applet.onButtonHover(this, false);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('enter-event', () => {
            this.hover = true;
            this.updateArt();
            this.applet.onButtonHover(this, true);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('destroy', () => {
            this.destroyed = true;
        });
    }

    // Drag-and-drop from another program highlights the button it is held over.
    setForcedHover(on) {
        this._forced = on;
        this.updateArt();
    }

    // The pointer may have moved while this button could not see it (a drag holds the grab): trust the
    // pointer position, not the last enter / leave event.
    refreshHover() {
        if (this.destroyed || this.removing) return;
        const [px, py] = global.get_pointer();
        const [x, y] = this.actor.get_transformed_position();
        const [w, h] = this.actor.get_transformed_size();
        const inside = px >= x && px < x + w && py >= y && py < y + h;
        if (inside === this.hover) return;
        this.hover = inside;
        this.updateArt();
    }

    // ------------------------------------------------------------- notification badge

    // Created on first use: it is the only part that needs a St widget (text), and most buttons never
    // show one.
    get badge() {
        if (!this._badge) {
            this._badge = new St.Widget({
                style_class: 'win11-tb-badge',
                layout_manager: new Clutter.BinLayout(),
                visible: false,
            });
            this._badgeLabel = new St.Label({
                style_class: 'win11-tb-badge-label',
                text: '',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._badge.add_child(this._badgeLabel);
            this.actor.add_child(this._badge);
            this._layoutBadge();
        }
        return this._badge;
    }

    get badgeLabel() {
        this.badge;
        return this._badgeLabel;
    }

    get name() {
        return this.app ? appName(this.app, this.applet.language) : this.fallbackName;
    }

    // ---------------------------------------------------------------- geometry

    applyMetrics() {
        const m = this.applet.metrics;
        this.actor.set_size(m.tileW, m.tileH);
        this.art.resize(m.tileW, m.tileH);
        this.iconBin.set_size(m.tileW, m.tileH);
        this._layoutBadge();

        this._indicatorLen = -1;
        this._indicatorKey = null;
        this._multi = null;
        this._applyMulti();
        this._applyIndicator(false);
        this._applyProgress();
    }

    // Notification badge: centred on the top-right corner of the icon.
    _layoutBadge() {
        const a = this._badge;
        if (!a) return;
        const m = this.applet.metrics;
        const bs = Math.max(m.px(12), Math.round(m.icon * 2 / 3));
        a.set_size(bs, bs);
        a.set_position(Math.round((m.tileW - bs) / 2 + m.icon / 2 - m.px(2)), Math.round((m.tileH - bs) / 2 - m.icon / 2));
    }

    _applyMulti() {
        const multi = this.windows.length > 1;
        if (multi === this._multi) return;
        this._multi = multi;
        this.art.setMulti(multi);
    }

    // Tile levels for the current hover / press / focus state (see tileArt.js).
    updateArt(animate = true) {
        if (this.destroyed) return;
        let name = 'idle';
        if (this._pressed === true) name = 'pressed';
        else if (this.focused) name = this.hover || this._forced ? 'focusHover' : 'focused';
        else if (this.hover || this._forced) name = 'hover';
        this.art.setState(name, animate && this.applet.animHighlight);
    }

    // -------------------------------------------------------------------- icon

    _newIcon(size) {
        return appIcon(this.app, size);
    }

    buildIcon() {
        const icon = this._newIcon(this.applet.metrics.icon);
        icon.set_x_expand(true);
        icon.set_y_expand(true);
        icon.set_x_align(Clutter.ActorAlign.CENTER);
        icon.set_y_align(Clutter.ActorAlign.CENTER);
        this.iconBin.destroy_all_children();
        this.iconBin.add_child(icon);
        this.iconChild = icon;
    }

    createDragIcon() {
        return this._newIcon(this.applet.metrics.icon);
    }

    // Stage rectangle of the icon itself.
    iconRect() {
        const c = this.iconChild;
        const [x, y] = c.get_transformed_position();
        const [w, h] = c.get_transformed_size();
        return { x, y, w, h };
    }

    // ------------------------------------------------------------------ states

    // Called for every button on every focus / window change, so it does nothing unless something this
    // button shows has actually changed.
    update(windows, pinned, focused, attention) {
        const old = this.windows;
        const same = old.length === windows.length && old.every((w, i) => w === windows[i]);
        const epoch = this.applet.stateEpoch;
        if (same && pinned === this.pinned && focused === this.focused && attention === this.attention && epoch === this._epoch) return;
        const focusChanged = focused !== this.focused || epoch !== this._epoch;
        const countChanged = old.length !== windows.length;
        this._epoch = epoch;
        this.windows = windows;
        this.pinned = pinned;
        this.focused = focused;
        this.attention = attention;

        if (focusChanged) this.updateArt();
        if (countChanged) {
            this._applyMulti();
            this._applyProgress();
        }
        this._applyIndicator(this.applet.animHighlight);
        this.art.setFlash(attention, this.applet.animPulse);
    }

    // Running indicator: 6 px grey when idle, 16 px accent when focused, pink when asking for attention.
    _applyIndicator(animate) {
        const m = this.applet.metrics;
        const running = this.windows.length > 0 && !this.dragging && !this._progressVisible;
        const len = this.focused ? m.indicatorActive : m.indicatorIdle;
        let color = '';
        if (this.attention) color = 'attention';
        else if (this.focused) color = this.applet.accentColor || DEFAULT_ACCENT;
        const key = len + '|' + running + '|' + color;
        if (key === this._indicatorKey) return;        // nothing about the indicator changed
        this._indicatorKey = key;
        this.art.setIndicator(len, running ? 1 : 0, color, animate && this._indicatorLen >= 0);
        this._indicatorLen = len;
    }

    // ---------------------------------------------------------------- progress

    setProgress(value, pulse) {
        if (value === this.progress && pulse === this.pulse) return;
        this.progress = value;
        this.pulse = pulse;
        this._applyProgress();
        this._applyIndicator(false);
    }

    get _progressVisible() {
        return this.applet.showProgress && !this.dragging && this.windows.length > 0
            && (this.pulse || this.progress > 0);
    }

    // While a window reports progress, the bar replaces the running indicator.
    _applyProgress() {
        if (!this._progressVisible) {
            this.art.setProgress('none');
        } else if (this.pulse) {
            this.art.setProgress('pulse');
        } else {
            const len = Math.round(this.applet.metrics.icon * Math.min(100, this.progress) / 100);
            this.art.setProgress('bar', 0, len);
        }
    }

    // ------------------------------------------------------------------ badges

    setBadge(count) {
        if (count === this.badgeCount) return;
        this.badgeCount = count;
        this._showBadge();
    }

    _showBadge() {
        const show = this.badgeCount > 0 && this.applet.showBadges && !this.dragging;
        if (!show) {
            if (this._badge) this._badge.visible = false;
            return;
        }
        this.badge.visible = true;
        this.badgeLabel.set_text(this.badgeCount > 99 ? '99+' : String(this.badgeCount));
    }

    _setPressed(pressed) {
        if (this.destroyed || this.dragging) return;
        if (this._pressed !== pressed) {
            this._pressed = pressed;
            this.updateArt();
        }
        const target = pressed ? 0.85 : 1;
        if (this.iconBin.scale_x === target) return;
        this.iconBin.ease({
            scale_x: target,
            scale_y: target,
            duration: this.applet.animButtons ? 100 : 0,
            mode: EASE_OUT,
        });
    }

    // Launch feedback: the icon hops up a few pixels and settles.
    playLaunchBounce() {
        if (!this.applet.animate || !this.applet.launchAnimation || this.destroyed) return;
        const m = this.applet.metrics;
        const prop = m.horizontal ? 'translation_y' : 'translation_x';
        const lift = -m.px(5) * (m.side === St.Side.RIGHT ? -1 : 1);
        const up = { duration: 160, mode: EASE_OUT };
        up[prop] = m.horizontal ? -m.px(5) : lift;
        up.onComplete = () => {
            if (this.destroyed) return;
            const down = { duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BOUNCE };
            down[prop] = 0;
            this.iconBin.ease(down);
        };
        this.iconBin.remove_all_transitions();
        this.iconBin.ease(up);
    }

    // ---------------------------------------------------------------- dragging

    // While dragged, the real icon, tile and indicator are hidden and a floating icon is shown.
    setDragging(on) {
        this.dragging = on;
        this._pressed = false;
        this.iconBin.remove_all_transitions();
        this.iconBin.scale_x = 1;
        this.iconBin.scale_y = 1;
        this.iconBin.translation_x = 0;
        this.iconBin.translation_y = 0;
        this.iconBin.opacity = on ? 0 : 255;
        this.tile.opacity = on ? 0 : 255;
        this._showBadge();
        this._applyProgress();
        this._applyIndicator(false);
        if (!on) this.refreshHover();           // the grab may have hidden the pointer's leave / enter
        this.updateArt(false);
    }

    // Slides the button from `delta` px (along axis) away from its new layout position.
    slideFrom(delta) {
        if (!delta || this.destroyed) return;
        const prop = this.applet.metrics.horizontal ? 'translation_x' : 'translation_y';
        const cur = this.actor[prop] || 0;
        this.actor.remove_transition(prop.replace('_', '-'));
        this.actor[prop] = cur + delta;
        if (!this.applet.animButtons) {
            this.actor[prop] = 0;
            return;
        }
        const t = { duration: 250, mode: EASE_CUBIC };
        t[prop] = 0;
        this.actor.ease(t);
    }

    // ---------------------------------------------------------------- lifetime

    // New button: the group recentres first, then the icon rises into place (see REFERENCE.md).
    animateIn() {
        if (!this.applet.animButtons) return;
        const m = this.applet.metrics;
        const H = m.horizontal;
        this.actor.set_clip_to_allocation(true);
        if (H) this.actor.set_width(0);
        else this.actor.set_height(0);
        this.iconBin.opacity = 0;
        const grow = { duration: 180, mode: EASE_CUBIC };
        if (H) grow.width = m.tileW;
        else grow.height = m.tileH;
        grow.onComplete = () => {
            if (this.destroyed) return;
            this.actor.set_clip_to_allocation(false);
            const prop = H ? 'translation_y' : 'translation_x';
            this.iconBin[prop] = H ? m.px(10) : (m.side === St.Side.RIGHT ? -m.px(10) : m.px(10));
            const rise = { opacity: 255, duration: 160, mode: EASE_CUBIC };
            rise[prop] = 0;
            this.iconBin.ease(rise);
        };
        this.actor.ease(grow);
    }

    // The icon drops and fades first, then the slot collapses.
    destroy(animated) {
        if (this.destroyed || this.removing) return;
        this.art.destroy();
        const finish = () => {
            if (!this.destroyed) this.actor.destroy();
            this.destroyed = true;
        };
        if (animated && this.applet.animButtons) {
            const m = this.applet.metrics;
            const H = m.horizontal;
            this.removing = true;
            this.actor.set_reactive(false);
            this.art.top.opacity = 0;
            this.tile.opacity = 0;
            const prop = H ? 'translation_y' : 'translation_x';
            const drop = { opacity: 0, duration: 130, mode: EASE_CUBIC };
            drop[prop] = H ? m.px(10) : (m.side === St.Side.RIGHT ? -m.px(10) : m.px(10));
            drop.onComplete = () => {
                if (this.destroyed) return;
                this.actor.set_clip_to_allocation(true);
                const shrink = { duration: 200, mode: EASE_CUBIC, onComplete: finish };
                if (H) shrink.width = 0;
                else shrink.height = 0;
                this.actor.ease(shrink);
            };
            this.iconBin.ease(drop);
        } else {
            finish();
        }
    }
}

module.exports = { TaskButton };
