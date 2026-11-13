// One taskbar button: tile, optional stacked "back" tile, icon, running indicator.
// Geometry and states follow docs/REFERENCE.md (measured from Windows 11).
const { Clutter, St } = imports.gi;

const EASE_OUT = Clutter.AnimationMode.EASE_OUT_QUAD;
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
        this._flashing = false;
        this._indicatorWidth = -1;
        this._multi = null;

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
        this.back = new St.Widget(Object.assign({ style_class: 'win11-tb-back', visible: false }, fill));
        this.tile = new St.Widget(Object.assign({ style_class: 'win11-tb-tile' }, fill));
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
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            opacity: 0,
        });

        [this.back, this.tile, this.flash, this.iconBin, this.indicator].forEach(a => this.layout.add_child(a));

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
        this.actor.connect('clicked', (a, button) => this.applet.onButtonClicked(this, button));
        this.actor.connect('destroy', () => {
            this.destroyed = true;
        });
    }

    get name() {
        return this.app ? this.app.get_name() : this.fallbackName;
    }

    // Drag-and-drop protocol (imports.ui.dnd).
    getDragActor() {
        return this.createDragIcon();
    }

    getDragActorSource() {
        return this.actor;
    }

    // ---------------------------------------------------------------- geometry

    applyMetrics() {
        const m = this.applet.metrics;
        this.actor.set_size(m.tileW, m.tileH);
        this.back.set_size(m.backW, Math.max(1, m.tileH - 2 * m.px(1)));
        this.indicator.set_height(m.indicatorH);
        this.indicator.translation_y = -m.indicatorBottom;
        this._indicatorWidth = -1;
        this._multi = null;
        this._applyMulti();
        this._applyIndicator(false);
    }

    _applyMulti() {
        const multi = this.windows.length > 1;
        if (multi === this._multi) return;
        this._multi = multi;
        const m = this.applet.metrics;
        [this.tile, this.flash].forEach(a => {
            if (multi) {
                a.set_x_align(Clutter.ActorAlign.START);
                a.set_width(m.tileW - m.stackInset);
            } else {
                a.set_x_align(Clutter.ActorAlign.FILL);
                a.set_width(-1);
            }
        });
        this.back.visible = multi;
        this.back.set_x_align(Clutter.ActorAlign.END);
        this.back.set_y_align(Clutter.ActorAlign.CENTER);
    }

    // -------------------------------------------------------------------- icon

    buildIcon() {
        const size = this.applet.metrics.icon;
        let icon = null;
        if (this.app) {
            try {
                icon = this.app.create_icon_texture(size);
            } catch (e) {
                icon = null;
            }
        }
        if (!icon) {
            icon = new St.Icon({ icon_name: 'application-x-executable', icon_size: size });
        }
        icon.set_x_expand(true);
        icon.set_y_expand(true);
        icon.set_x_align(Clutter.ActorAlign.CENTER);
        icon.set_y_align(Clutter.ActorAlign.CENTER);
        this.iconBin.destroy_all_children();
        this.iconBin.add_child(icon);
    }

    createDragIcon() {
        const size = this.applet.metrics.icon;
        if (this.app) {
            try {
                return this.app.create_icon_texture(size);
            } catch (e) { /* fall through */ }
        }
        return new St.Icon({ icon_name: 'application-x-executable', icon_size: size });
    }

    // ------------------------------------------------------------------ states

    update(windows, pinned, focused, attention) {
        this.windows = windows;
        this.pinned = pinned;
        this.focused = focused;
        this.attention = attention;

        if (focused) this.actor.add_style_pseudo_class('focused');
        else this.actor.remove_style_pseudo_class('focused');

        if (attention) this.actor.add_style_pseudo_class('attention');
        else this.actor.remove_style_pseudo_class('attention');

        this._applyMulti();
        this._applyIndicator(this.applet.animate);
        this._updateFlash();
    }

    _applyIndicator(animate) {
        const m = this.applet.metrics;
        const running = this.windows.length > 0;
        const width = this.focused ? m.indicatorActive : m.indicatorIdle;

        const accent = this.applet.accentColor;
        if (this.focused && !this.attention && accent) {
            this.indicator.set_style('background-color: ' + accent + ';');
        } else {
            this.indicator.set_style(null);
        }

        const opacity = running ? 255 : 0;
        if (!animate || this._indicatorWidth < 0) {
            this.indicator.remove_all_transitions();
            this.indicator.set_width(width);
            this.indicator.opacity = opacity;
        } else {
            this.indicator.ease({ width: width, opacity: opacity, duration: 150, mode: EASE_OUT });
        }
        this._indicatorWidth = width;
    }

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
        if (this.destroyed) return;
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
        const lift = -this.applet.metrics.px(5);
        this.iconBin.remove_all_transitions();
        this.iconBin.ease({
            translation_y: lift,
            duration: 160,
            mode: EASE_OUT,
            onComplete: () => {
                if (this.destroyed) return;
                this.iconBin.ease({
                    translation_y: 0,
                    duration: 260,
                    mode: Clutter.AnimationMode.EASE_OUT_BOUNCE,
                });
            },
        });
    }

    // ---------------------------------------------------------------- lifetime

    // Slides the button in from zero width.
    animateIn() {
        if (!this.applet.animate) return;
        const m = this.applet.metrics;
        this.actor.set_clip_to_allocation(true);
        this.actor.set_width(0);
        this.actor.opacity = 0;
        this.actor.ease({
            width: m.tileW,
            opacity: 255,
            duration: 180,
            mode: EASE_OUT,
            onComplete: () => {
                if (!this.destroyed) this.actor.set_clip_to_allocation(false);
            },
        });
    }

    destroy(animated) {
        if (this.destroyed || this.removing) return;
        this._flashing = false;
        const finish = () => {
            if (!this.destroyed) this.actor.destroy();
            this.destroyed = true;
        };
        if (animated && this.applet.animate) {
            this.removing = true;
            this.actor.set_reactive(false);
            this.actor.set_clip_to_allocation(true);
            this.actor.ease({
                width: 0,
                opacity: 0,
                duration: 150,
                mode: EASE_OUT,
                onComplete: finish,
            });
        } else {
            finish();
        }
    }
}

module.exports = { TaskButton };
