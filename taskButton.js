// One taskbar button: tile, optional stacked "back" tile, icon, running indicator,
// progress bar and notification badge. Geometry and states follow docs/REFERENCE.md
// (measured from Windows 11). Works on horizontal and vertical panels.
const { Clutter, St, GLib } = imports.gi;

const { TileArt } = require('./tileArt');
const { appName } = require('./util');

const EASE_OUT = Clutter.AnimationMode.EASE_OUT_QUAD;
const EASE_CUBIC = Clutter.AnimationMode.EASE_OUT_CUBIC;
const EASE_SINE = Clutter.AnimationMode.EASE_IN_OUT_SINE;

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
        this.progress = -1;              // 0..100, -1 = none
        this.pulse = false;
        this.badgeCount = 0;
        this._flashing = false;
        this._indicatorLen = -1;
        this._multi = null;
        this._pressed = false;
        this._pulseId = 0;
        this._pulseStart = 0;

        this.actor = new St.Button({
            style_class: 'win11-tb-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            x_fill: true,
            y_fill: true,
        });
        this.actor._delegate = this;

        this.layout = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.actor.set_child(this.layout);

        const fill = {
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        };
        // Tile and, for apps with several windows, the page behind it (one Cairo drawing).
        this.art = new TileArt(this);
        this.tile = this.art.actor;
        this.flash = new St.Widget(Object.assign({ style_class: 'win11-tb-flash', opacity: 0, visible: false }, fill));
        this.iconBin = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.iconBin.set_pivot_point(0.5, 0.5);
        this.indicator = new St.Widget({
            style_class: 'win11-tb-indicator',
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });
        this.track = new St.Widget({
            style_class: 'win11-tb-progress-track',
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.fill = new St.Widget({
            style_class: 'win11-tb-progress-fill',
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.badge = new St.Widget({
            style_class: 'win11-tb-badge',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.badgeLabel = new St.Label({
            style_class: 'win11-tb-badge-label',
            text: '',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.badge.add_child(this.badgeLabel);

        [this.tile, this.flash, this.iconBin, this.indicator, this.track, this.fill, this.badge]
            .forEach(a => this.layout.add_child(a));

        this.applyMetrics();
        this.buildIcon();

        this.actor.connect('button-press-event', (a, event) => {
            if (event.get_button() === 1) this._setPressed(true);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('button-release-event', () => {
            this._setPressed(false);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('leave-event', () => {
            this._setPressed(false);
            this.applet.onButtonHover(this, false);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('enter-event', () => {
            this.applet.onButtonHover(this, true);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('notify::hover', () => this.updateArt());
        this.actor.connect('clicked', (a, button) => this.applet.onButtonClicked(this, button));
        this.actor.connect('destroy', () => {
            this.destroyed = true;
            this._stopPulse();
        });
    }

    get name() {
        return this.app ? appName(this.app, this.applet.language) : this.fallbackName;
    }

    // ---------------------------------------------------------------- geometry

    applyMetrics() {
        const m = this.applet.metrics;
        const H = m.horizontal;
        this.actor.set_size(m.tileW, m.tileH);

        // Indicator and progress bar sit on the screen-edge side of the panel, 1 px inside the tile.
        let ax = Clutter.ActorAlign.CENTER;
        let ay = Clutter.ActorAlign.END;
        let dx = 0;
        let dy = 0;
        switch (m.side) {
            case St.Side.TOP:
                ay = Clutter.ActorAlign.START;
                dy = m.indicatorEdge;
                break;
            case St.Side.LEFT:
                ax = Clutter.ActorAlign.START;
                ay = Clutter.ActorAlign.CENTER;
                dx = m.indicatorEdge;
                break;
            case St.Side.RIGHT:
                ax = Clutter.ActorAlign.END;
                ay = Clutter.ActorAlign.CENTER;
                dx = -m.indicatorEdge;
                break;
            default:
                dy = -m.indicatorEdge;
        }
        [this.indicator, this.track, this.fill].forEach(a => {
            a.set_x_align(ax);
            a.set_y_align(ay);
            a.translation_x = dx;
            a.translation_y = dy;
        });
        const hair = Math.max(1, m.px(1));
        this.track.set_size(H ? m.icon : hair, H ? hair : m.icon);
        this.fill.set_size(H ? 0 : m.indicatorH, H ? m.indicatorH : 0);

        // Notification badge: centred on the top-right corner of the icon.
        const bs = Math.max(m.px(12), Math.round(m.icon * 2 / 3));
        this.badge.set_size(bs, bs);
        this.badge.translation_x = Math.round(m.icon / 2 - m.px(2));
        this.badge.translation_y = -Math.round(m.icon / 2);

        this._indicatorLen = -1;
        this._multi = null;
        this._applyMulti();
        this._applyIndicator(false);
        this._applyProgress();
    }

    _applyMulti() {
        const multi = this.windows.length > 1;
        if (multi === this._multi) return;
        this._multi = multi;
        const m = this.applet.metrics;
        const H = m.horizontal;
        // The attention flash follows the front tile, which is shorter when a page peeks out behind it.
        const a = this.flash;
        a.set_x_align(Clutter.ActorAlign.FILL);
        a.set_y_align(Clutter.ActorAlign.FILL);
        a.set_width(-1);
        a.set_height(-1);
        if (multi) {
            if (H) {
                a.set_x_align(Clutter.ActorAlign.START);
                a.set_width(m.tileW - m.stackInset);
            } else {
                a.set_y_align(Clutter.ActorAlign.START);
                a.set_height(m.tileH - m.stackInset);
            }
        }
        this.art.setMulti(multi);
    }

    // Tile levels for the current hover / press / focus state (see tileArt.js).
    updateArt(animate = true) {
        if (this.destroyed) return;
        const pressed = this._pressed === true;
        const hover = this.actor.hover;
        let name = 'idle';
        if (pressed) name = 'pressed';
        else if (this.focused) name = hover ? 'focusHover' : 'focused';
        else if (hover) name = 'hover';
        this.art.setState(name, animate && this.applet.animate);
    }

    // -------------------------------------------------------------------- icon

    _newIcon(size) {
        let icon = null;
        if (this.app) {
            try {
                icon = this.app.create_icon_texture(size);
            } catch (e) {
                icon = null;
            }
        }
        return icon || new St.Icon({ icon_name: 'application-x-executable', icon_size: size });
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

    update(windows, pinned, focused, attention) {
        this.windows = windows;
        this.pinned = pinned;
        this.focused = focused;
        this.attention = attention;

        this.updateArt();
        if (focused) this.actor.add_style_pseudo_class('focused');
        else this.actor.remove_style_pseudo_class('focused');

        if (attention) this.actor.add_style_pseudo_class('attention');
        else this.actor.remove_style_pseudo_class('attention');

        this._applyMulti();
        this._applyProgress();
        this._applyIndicator(this.applet.animate);
        this._updateFlash();
    }

    _applyIndicator(animate) {
        const m = this.applet.metrics;
        const H = m.horizontal;
        const running = this.windows.length > 0 && !this.dragging && !this._progressVisible;
        const len = this.focused ? m.indicatorActive : m.indicatorIdle;

        const accent = this.applet.accentColor;
        if (this.focused && !this.attention && accent) {
            this.indicator.set_style('background-color: ' + accent + ';');
        } else {
            this.indicator.set_style(null);
        }

        const opacity = running ? 255 : 0;
        this.indicator.remove_all_transitions();
        if (!animate || this._indicatorLen < 0) {
            this.indicator.set_size(H ? len : m.indicatorH, H ? m.indicatorH : len);
            this.indicator.opacity = opacity;
        } else {
            this.indicator.ease(H
                ? { width: len, opacity: opacity, duration: 200, mode: EASE_CUBIC }
                : { height: len, opacity: opacity, duration: 200, mode: EASE_CUBIC });
        }
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
        const visible = this._progressVisible;
        this.track.visible = visible;
        this.fill.visible = visible;
        if (!visible) {
            this._stopPulse();
            return;
        }
        if (this.pulse) {
            this._startPulse();
        } else {
            this._stopPulse();
            const len = Math.round(this.applet.metrics.icon * Math.min(100, this.progress) / 100);
            this._placeFill(0, len);
        }
    }

    // Segment [from, from + len) of the track.
    _placeFill(from, len) {
        const m = this.applet.metrics;
        const centre = from - m.icon / 2 + len / 2;
        if (m.horizontal) {
            this.fill.set_size(Math.max(0, len), m.indicatorH);
            this.fill.translation_x = centre;
        } else {
            this.fill.set_size(m.indicatorH, Math.max(0, len));
            this.fill.translation_y = centre;
        }
    }

    // Indeterminate progress: a segment grows from the left, slides right and shrinks (≈ 1.1 s loop).
    _startPulse() {
        if (this._pulseId) return;
        this._pulseStart = GLib.get_monotonic_time();
        this._pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            if (this.destroyed || !this.pulse) {
                this._pulseId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const t = (((GLib.get_monotonic_time() - this._pulseStart) / 1000) % 1100) / 1100;
            const L = this.applet.metrics.icon;
            const head = 1 - Math.pow(1 - Math.min(1, t / 0.7), 3);
            const tail = t < 0.3 ? 0 : Math.pow(Math.min(1, (t - 0.3) / 0.7), 3);
            const a = Math.round(tail * L);
            const b = Math.round(head * L);
            this._placeFill(a, Math.max(2, b - a));
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPulse() {
        if (this._pulseId) {
            GLib.source_remove(this._pulseId);
            this._pulseId = 0;
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
        this.badge.visible = show;
        if (show) this.badgeLabel.set_text(this.badgeCount > 99 ? '99+' : String(this.badgeCount));
    }

    // ------------------------------------------------------------------- flash

    _updateFlash() {
        if (this.attention && !this._flashing) {
            this._flashing = true;
            this.flash.visible = true;
            this._flashStep(true);
        } else if (!this.attention && this._flashing) {
            this._flashing = false;
            this.flash.remove_all_transitions();
            this.flash.opacity = 0;
            this.flash.visible = false;
        }
    }

    // Pulses the orange overlay (≈ 2 s period, see REFERENCE.md).
    _flashStep(up) {
        if (!this._flashing || this.destroyed) return;
        this.flash.ease({
            opacity: up ? 255 : 110,
            duration: this.applet.animate ? 1000 : 0,
            mode: EASE_SINE,
            onComplete: () => this._flashStep(!up),
        });
        if (!this.applet.animate) this.flash.opacity = 255;
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
            duration: this.applet.animate ? 100 : 0,
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
        if (on) this.actor.add_style_pseudo_class('dragging');
        else this.actor.remove_style_pseudo_class('dragging');
        this.iconBin.remove_all_transitions();
        this.iconBin.scale_x = 1;
        this.iconBin.scale_y = 1;
        this.iconBin.translation_x = 0;
        this.iconBin.translation_y = 0;
        this.iconBin.opacity = on ? 0 : 255;
        this.tile.opacity = on ? 0 : 255;
        if (on) this.flash.opacity = 0;
        this._showBadge();
        this._applyProgress();
        this._applyIndicator(false);
    }

    // Slides the button from `delta` px (along axis) away from its new layout position.
    slideFrom(delta) {
        if (!delta || this.destroyed) return;
        const prop = this.applet.metrics.horizontal ? 'translation_x' : 'translation_y';
        const cur = this.actor[prop] || 0;
        this.actor.remove_transition(prop.replace('_', '-'));
        this.actor[prop] = cur + delta;
        if (!this.applet.animate) {
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
        if (!this.applet.animate) return;
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
        this._flashing = false;
        this._stopPulse();
        const finish = () => {
            if (!this.destroyed) this.actor.destroy();
            this.destroyed = true;
        };
        if (animated && this.applet.animate) {
            const m = this.applet.metrics;
            const H = m.horizontal;
            this.removing = true;
            this.actor.set_reactive(false);
            this.indicator.opacity = 0;
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
