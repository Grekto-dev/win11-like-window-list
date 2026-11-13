// Text tooltip for buttons without windows (pinned apps that are not running).
const { Clutter, St } = imports.gi;
const Main = imports.ui.main;

const { placeNear, preferredSize } = require('./popup');

class TaskTip {
    constructor(applet) {
        this.applet = applet;
        this.actor = null;
    }

    show(button, text) {
        this.hide(true);
        if (!text) return;
        const m = this.applet.metrics;
        const actor = new St.BoxLayout({ style_class: 'win11-tb-tip', reactive: false });
        actor.add_child(new St.Label({ text: text, y_align: Clutter.ActorAlign.CENTER }));
        Main.layoutManager.addChrome(actor, { affectsInputRegion: false });
        actor.opacity = 0;
        const [w, h] = preferredSize(actor);
        const [x, y] = placeNear(this.applet, button.actor, w, h, m.px(13));
        actor.set_position(x, y);
        actor.ease({
            opacity: 255,
            duration: this.applet.animate ? 100 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        if (!this.applet.animate) actor.opacity = 255;
        this.actor = actor;
    }

    hide(immediate) {
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
            actor.ease({
                opacity: 0,
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: done,
            });
        }
    }

    destroy() {
        this.hide(true);
    }
}

module.exports = { TaskTip };
