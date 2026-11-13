const GLib = imports.gi.GLib;

// Single-shot cancellable timer.
class Timer {
    constructor() {
        this.id = 0;
    }

    get pending() {
        return this.id !== 0;
    }

    set(ms, fn) {
        this.clear();
        this.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, ms), () => {
            this.id = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    clear() {
        if (this.id) {
            GLib.source_remove(this.id);
            this.id = 0;
        }
    }
}

// Normalises a desktop-file id such as "app.desktop:flatpak" to "app.desktop".
function normalizeId(id) {
    return String(id).split(':')[0];
}

module.exports = { Timer, normalizeId };
