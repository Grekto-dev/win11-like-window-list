const { GLib, St } = imports.gi;

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

// ---- names that follow the applet's language, not the system's
// App and action names come from the .desktop file, normally in the system language. The applet has its
// own language setting, so read them from the file ourselves: the unlocalised key (English) or the
// pt_BR one. Falls back to whatever Gio gives when the file cannot be read.
const LOCALE_OF = { 'pt-BR': 'pt_BR' };
const _keyFiles = new Map();

function _keyFile(info) {
    const path = info && typeof info.get_filename === 'function' ? info.get_filename() : null;
    if (!path) return null;
    if (!_keyFiles.has(path)) {
        const kf = new GLib.KeyFile();
        try {
            kf.load_from_file(path, GLib.KeyFileFlags.NONE);
            _keyFiles.set(path, kf);
        } catch (e) {
            _keyFiles.set(path, null);
        }
    }
    return _keyFiles.get(path);
}

function _name(info, group, fallback, lang) {
    const kf = _keyFile(info);
    if (!kf) return fallback;
    try {
        const loc = LOCALE_OF[lang];
        return (loc ? kf.get_locale_string(group, 'Name', loc) : kf.get_string(group, 'Name')) || fallback;
    } catch (e) {
        return fallback;
    }
}

function appName(app, lang) {
    const info = app.get_app_info();
    return info ? _name(info, 'Desktop Entry', app.get_name(), lang) : app.get_name();
}

function actionName(info, action, lang) {
    return _name(info, 'Desktop Action ' + action, info.get_action_name(action), lang);
}

// ---- icons
// An app icon as a plain actor: St.TextureCache.load_gicon costs ≈ 0.2 ms to create and add, an St.Icon
// ≈ 1.1 ms. Apps without a launcher (window-backed) have no GIcon, so they use the St route.
function appIcon(app, size) {
    if (app) {
        try {
            const info = app.is_window_backed() ? null : app.get_app_info();
            const gicon = info ? info.get_icon() : null;
            if (gicon) {
                const icon = St.TextureCache.get_default().load_gicon(null, gicon, size, 1, global.ui_scale || 1);
                if (icon) {
                    icon.set_size(size, size);
                    return icon;
                }
            }
            const tex = app.create_icon_texture(size);
            if (tex) return tex;
        } catch (e) { /* fall through */ }
    }
    return new St.Icon({ icon_name: 'application-x-executable', icon_size: size });
}

module.exports = { Timer, normalizeId, appName, actionName, appIcon };
