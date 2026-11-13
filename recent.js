// Recent files of an application, for the jump list ("Recente" section in Windows 11).
const { Gtk, Gio, GLib } = imports.gi;

function rememberRecent() {
    try {
        const s = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.privacy' });
        return s.get_boolean('remember-recent-files');
    } catch (e) {
        return true;
    }
}

function baseName(path) {
    return String(path || '').split('/').pop();
}

// Names under which an application may have registered files in the recent list.
function namesFor(app) {
    const names = new Set();
    const add = v => {
        if (v) names.add(String(v).toLowerCase());
    };
    try {
        add(app.get_name());
        const id = String(app.get_id() || '').split(':')[0].replace(/\.desktop$/, '');
        add(id);
        add(id.split('.').pop());
        const info = app.get_app_info();
        if (info) {
            add(info.get_name());
            const exec = info.get_executable ? info.get_executable() : null;
            add(baseName(exec));
        }
    } catch (e) { /* use what we have */ }
    return names;
}

// Up to `max` existing, non-private recent files that `app` registered, newest first.
function recentFor(app, max) {
    if (!app || max <= 0 || !rememberRecent()) return [];
    const names = namesFor(app);
    const out = [];
    try {
        Gtk.RecentManager.get_default().get_items().forEach(item => {
            let apps = [];
            try {
                apps = item.get_applications() || [];
            } catch (e) { return; }
            if (!apps.some(a => names.has(String(a).toLowerCase()))) return;
            if (item.get_private_hint && item.get_private_hint()) return;
            if (!item.exists()) return;
            out.push({
                name: item.get_display_name(),
                uri: item.get_uri(),
                gicon: item.get_gicon(),
                modified: item.get_modified(),
            });
        });
    } catch (e) {
        return [];
    }
    out.sort((a, b) => b.modified - a.modified);
    return out.slice(0, max);
}

module.exports = { recentFor, rememberRecent };
