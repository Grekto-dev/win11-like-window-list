// Win11-Like Window List — Cinnamon applet.
// Reproduces the Windows 11 taskbar window buttons (see docs/REFERENCE.md).
const Applet = imports.ui.applet;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const DND = imports.ui.dnd;
const { Clutter, St, GLib, Gio, Gtk, Cinnamon } = imports.gi;

const { tr, setLanguage } = require('./i18n');
const { Timer, normalizeId, actionName } = require('./util');
const { TaskButton } = require('./taskButton');
const { Flyout } = require('./flyout');
const { ContextMenu } = require('./contextMenu');
const { TaskTip } = require('./tooltip');
const { ReorderDrag } = require('./dragController');
const { recentFor } = require('./recent');
const Shared = require('./shared');

const TIP_DELAY = 700;           // ms before the text tooltip of a button without windows
const BADGE_POLL_SECONDS = 2;
const MIN_ICON = 16;
const PIN_ICONS = ['view-pin-symbolic', 'pin-symbolic', 'emblem-pinned-symbolic'];
const UNPIN_ICONS = ['view-unpin-symbolic', 'unpin-symbolic', 'view-pin-symbolic', 'pin-symbolic'];

function sameList(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Empty slot shown while an app from another widget (the Start menu) is dragged over the bar.
class Placeholder {
    constructor(applet) {
        this.applet = applet;
        this.destroyed = false;
        this.actor = new St.Widget({ style_class: 'win11-tb-placeholder' });
        this.actor._delegate = this;
        const m = applet.metrics;
        this.actor.set_size(m.horizontal ? 0 : m.tileW, m.horizontal ? m.tileH : 0);
        this.actor.ease(m.horizontal
            ? { width: m.tileW, duration: applet.animate ? 150 : 0, mode: Clutter.AnimationMode.EASE_OUT_CUBIC }
            : { height: m.tileH, duration: applet.animate ? 150 : 0, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        if (!applet.animate) this.actor.set_size(m.tileW, m.tileH);
    }

    slideFrom(delta) {
        TaskButton.prototype.slideFrom.call(this, delta);
    }

    remove(animated) {
        if (this.destroyed) return;
        const done = () => {
            this.destroyed = true;
            this.actor.destroy();
        };
        if (animated && this.applet.animate) {
            const m = this.applet.metrics;
            this.actor.set_reactive(false);
            this.actor.ease(Object.assign(m.horizontal ? { width: 0 } : { height: 0 },
                { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: done }));
        } else {
            done();
        }
    }
}

class Win11WindowList extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.metadata = metadata;
        this.instanceId = instanceId;
        this.orientation = orientation;
        this.destroyed = false;
        this.ready = false;

        this.tracker = Cinnamon.WindowTracker.get_default();
        this.appSystem = Cinnamon.AppSystem.get_default();

        this._buttons = new Map();      // id -> TaskButton
        this._btnOrder = [];               // ids in display order (pinned and running mixed, like Windows)
        this._attention = new Set();    // MetaWindows asking for attention
        this._mru = [];                 // most recently focused first
        this._wsig = new Map();         // MetaWindow -> signal ids
        this._gsig = [];                // [object, id]
        this._refreshId = 0;
        this._statesId = 0;
        this._badgeId = 0;
        this._hoverButton = null;
        this._flyoutTimer = new Timer();
        this._tipTimer = new Timer();
        this._drag = null;              // active ReorderDrag
        this._dragging = false;
        this._refreshDeferred = false;
        this._synced = false;
        this._hotkeyOwner = false;
        this._placeholder = null;
        this._placeholderId = null;
        this._groups = null;
        this._launcher = new Map();      // desktop id -> Unity LauncherEntry data (count, progress, urgent)
        this._launcherSub = 0;
        this._xdndKey = null;               // what the dragged item is over: a button or a window card
        this._xdndMarked = null;            // actor currently shown as hovered
        this._xdndTimer = new Timer();
        this._xdndEndId = 0;
        this._xdndBeginId = 0;
        this._xdndMonitor = null;

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.actor.set_track_hover(false);
        this.actor.set_style_class_name('win11-tb-applet');
        this.actor.set_style('padding: 0; margin: 0;');

        this.stateEpoch = 0;                // bumped when a setting changes how every button must look
        this._bindSettings();
        setLanguage(this.language);
        this._computeMetrics();

        this.box = new St.BoxLayout({
            style_class: 'win11-tb-box',
            vertical: !this._horizontal(),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this.box);
        // The panel can allocate its applets more room than the bar; keep the buttons centred in the bar.
        this.actor.connect('notify::allocation', () => this._centerInPanel());
        this.actor.connect('notify::mapped', () => this._centerInPanel());

        this.flyout = new Flyout(this);
        this.menu = new ContextMenu(this);
        this.tip = new TaskTip(this);
    }

    // ----------------------------------------------------------------- settings

    _bindSettings() {
        this.settings = new Settings.AppletSettings(this, this.metadata.uuid, this.instanceId);
        const IN = Settings.BindingDirection.IN;
        const BOTH = Settings.BindingDirection.BIDIRECTIONAL;
        const s = this.settings;
        // Cinnamon cannot compare list values, so it reports 'pinned-apps' as changed on every settings write:
        // refresh only when the list really differs, or any other setting would rebuild the whole bar.
        s.bindProperty(BOTH, 'pinned-apps', 'pinnedApps', () => {
            const now = JSON.stringify(this.pinnedApps);
            if (now === this._pinnedJson) return;
            this._pinnedJson = now;
            this._queueRefresh();
        });
        this._pinnedJson = JSON.stringify(this.pinnedApps);
        s.bindProperty(BOTH, 'pinned-imported', 'pinnedImported', null);
        s.bindProperty(BOTH, 'language', 'language', () => this._onLanguageChanged());
        s.bindProperty(IN, 'show-all-workspaces', 'showAllWorkspaces', () => this._queueRefresh());
        s.bindProperty(IN, 'show-all-monitors', 'showAllMonitors', () => this._queueRefresh());
        s.bindProperty(IN, 'sync-monitors', 'syncMonitors', () => this._applySync());
        s.bindProperty(IN, 'super-num-hotkeys', 'superNumHotkeys', () => this._applyHotkeys());
        s.bindProperty(IN, 'icon-size-mode', 'iconSizeMode', () => this._onMetricsChanged());
        s.bindProperty(BOTH, 'icon-size', 'iconSize', () => this._onMetricsChanged());
        s.bindProperty(IN, 'indicator-color', 'accentColor', () => {
            this.stateEpoch++;
            this._queueStates();
        });
        s.bindProperty(IN, 'hover-delay', 'hoverDelay', null);
        s.bindProperty(IN, 'xdnd-delay', 'xdndDelay', null);
        s.bindProperty(IN, 'enable-peek', 'enablePeek', () => {
            if (!this.enablePeek && this.flyout) this.flyout.endPeekNow();
        });
        s.bindProperty(IN, 'peek-mode', 'peekMode', () => this.flyout && this.flyout.restartPeek());
        s.bindProperty(IN, 'peek-delay', 'peekDelay', null);
        s.bindProperty(IN, 'enable-animations', 'enableAnimations', null);
        s.bindProperty(IN, 'launch-animation', 'launchAnimation', null);
        s.bindProperty(IN, 'show-badges', 'showBadges', () => {
            this._syncBadgeTimer();
            this._updateBadges();
        });
        s.bindProperty(IN, 'show-progress', 'showProgress', () => this._buttons.forEach(b => {
            b._applyProgress();
            b._applyIndicator(false);
        }));
        s.bindProperty(IN, 'show-recent', 'showRecent', null);
        s.bindProperty(IN, 'recent-count', 'recentCount', null);
    }

    get animate() {
        return this.enableAnimations;
    }

    _horizontal() {
        return this.orientation === St.Side.TOP || this.orientation === St.Side.BOTTOM;
    }

    // Panel thickness (the "taskbar size"), the ceiling for icons.
    _thickness() {
        const scale = global.ui_scale || 1;
        const h = this.panel ? this.panel.height : this.panel_height;
        return h || Math.round(48 * scale);
    }

    // Auto mode keeps Windows' proportions (24 px icon in a 40 px tile on a 48 px bar) and scales with the
    // bar; manual mode takes the chosen size. Either way the icon never exceeds the bar size and never
    // drops under MIN_ICON, so it cannot vanish.
    _computeMetrics() {
        const scale = global.ui_scale || 1;
        const px = n => Math.round(n * scale);
        const horizontal = this._horizontal();
        const thickness = this._thickness();
        const minIcon = px(MIN_ICON);
        const wanted = this.iconSizeMode === 'manual' ? px(this.iconSize || 24) : Math.round(thickness / 2);
        const icon = Math.max(minIcon, Math.min(wanted, Math.max(minIcon, thickness)));
        // Square tiles: icon plus 8 px each side, never larger than the bar.
        const tile = Math.min(icon + px(16), Math.max(thickness, icon));
        this.metrics = {
            px: px,
            horizontal: horizontal,
            side: this.orientation,
            thickness: thickness,
            icon: icon,
            tileW: tile,
            tileH: tile,
            backW: px(3),
            stackInset: px(5),
            indicatorIdle: px(6),
            indicatorActive: px(16),
            indicatorH: px(3),
            indicatorEdge: px(1),
            gap: px(4),
        };
    }

    _onMetricsChanged() {
        if (this.destroyed || !this.box) return;
        // Keep a manual size inside the allowed range (the setting shows what is really used).
        if (this.iconSizeMode === 'manual') {
            const cap = Math.max(MIN_ICON, this._thickness());
            const fixed = Math.max(MIN_ICON, Math.min(this.iconSize, cap));
            if (fixed !== this.iconSize) this.iconSize = fixed;
        }
        this._computeMetrics();
        this._buttons.forEach(b => {
            b.applyMetrics();
            b.buildIcon();
        });
        this.flyout.close(true);
    }

    _centerInPanel() {
        if (this.destroyed || !this.panel || !this.box || !this.box.get_stage()) return;
        const H = this._horizontal();
        const [px, py] = this.panel.actor.get_transformed_position();
        const [pw, ph] = this.panel.actor.get_transformed_size();
        const [bx, by] = this.box.get_transformed_position();
        const [bw, bh] = this.box.get_transformed_size();
        const delta = H ? (py + ph / 2) - (by + bh / 2) : (px + pw / 2) - (bx + bw / 2);
        if (Math.abs(delta) < 0.5) return;
        const prop = H ? 'translation_y' : 'translation_x';
        this.box[prop] = Math.round(this.box[prop] + delta);
    }

    // ----------------------------------------------------------------- language

    // The language is one setting for the whole applet: a change on any bar is copied to the others.
    _onLanguageChanged() {
        if (this.destroyed) return;
        this._applyLanguage();
        imports.ui.appletManager.getRunningInstancesForUuid(this.metadata.uuid).forEach(a => {
            if (a === this || a.destroyed || a.language === this.language) return;
            a.language = this.language;           // bidirectional: also saved in that bar's settings file
            a._applyLanguage();
        });
    }

    // Everything that shows text follows the new language at once.
    _applyLanguage() {
        if (this.destroyed) return;
        setLanguage(this.language);
        this.menu.close(true);
        this.flyout.close(true);
        this.tip.hide(true);
        this._syncLocale();
        this._relabelContextMenu();
        this._reopenSettingsWindow();
    }

    // Cinnamon builds the right-click menu of every applet in the system language.
    _relabelContextMenu() {
        const set = (item, text) => {
            try {
                if (item && item.label) item.label.set_text(text);
            } catch (e) { /* menu not built yet */ }
        };
        set(this.context_menu_item_about, tr('about'));
        set(this.context_menu_item_configure, tr('configure'));
        set(this.context_menu_item_remove, tr('remove').replace('%s', this.metadata.name));
    }

    // The settings window of this bar, if open: the one we started (by pid) or, when it was opened from
    // System Settings and this is the only bar, the only window of the settings program with our title.
    _settingsWindow() {
        const wins = global.display.list_windows(0).filter(w => w.get_wm_class() === 'Xlet-settings.py' && w.get_title() === this.metadata.name);
        let w = this._settingsPid ? wins.find(x => x.get_pid() === this._settingsPid) : null;
        if (!w && wins.length === 1 && imports.ui.appletManager.getRunningInstancesForUuid(this.metadata.uuid).length === 1) {
            w = wins[0];
            this._settingsPid = w.get_pid();
        }
        return w || null;
    }

    // The settings window is a separate program whose texts are fixed when it starts: if it is open,
    // close it and open it again in the new language.
    _reopenSettingsWindow() {
        const w = this._settingsWindow();
        if (!w) return;
        w.delete(global.get_current_time());
        let tries = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (this.destroyed) return GLib.SOURCE_REMOVE;
            if (this._settingsWindow() && ++tries < 30) return GLib.SOURCE_CONTINUE;
            this.configureApplet(0);
            return GLib.SOURCE_REMOVE;
        });
    }

    // The settings window is a separate program that finds translations in ~/.local/share/locale.
    // Portuguese: put our compiled catalogue there; English: remove it, so a Portuguese system does not
    // translate a window the user chose to see in English.
    _syncLocale() {
        const uuid = this.metadata.uuid;
        const rel = ['locale', 'pt_BR', 'LC_MESSAGES', uuid + '.mo'];
        const src = Gio.File.new_for_path(GLib.build_filenamev([this.metadata.path].concat(rel)));
        const dest = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir()].concat(rel)));
        try {
            if (this.language !== 'pt-BR') {
                const others = imports.ui.appletManager.getRunningInstancesForUuid(uuid);
                if (others.some(a => a !== this && !a.destroyed && a.language === 'pt-BR')) return;
                if (dest.query_exists(null)) dest.delete(null);
                return;
            }
            if (!src.query_exists(null)) return;
            GLib.mkdir_with_parents(dest.get_parent().get_path(), 0o755);
            src.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (e) {
            global.logError('win11-window-list: locale sync failed: ' + e);
        }
    }

    // Opens the settings window in the applet's own language, whatever the system language is.
    configureApplet(tab = 0) {
        const open = this._settingsWindow();
        if (open) {                                  // already open: bring it forward instead of a second one
            Main.activateWindow(open, global.get_current_time());
            return;
        }
        this._syncLocale();
        try {
            const env = GLib.environ_setenv(GLib.get_environ(), 'LANGUAGE', this.language === 'pt-BR' ? 'pt_BR' : 'en', true);
            const [ok, pid] = GLib.spawn_async(null, ['xlet-settings', 'applet', this.metadata.uuid, '-i', String(this.instance_id), '-t', String(tab)],
                env, GLib.SpawnFlags.SEARCH_PATH, null);
            this._settingsPid = ok ? pid : 0;
        } catch (e) {
            super.configureApplet(tab);
        }
    }

    // -------------------------------------------------------------- applet hooks

    on_applet_added_to_panel() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._relabelContextMenu();
            return GLib.SOURCE_REMOVE;
        });
        this._importPinned();
        this._syncLocale();
        this._connectGlobals();
        global.display.list_windows(0).forEach(w => {
            if (this._relevant(w)) this._watchWindow(w);
        });
        this._applySync(true);
        this._subscribeLauncher();
        this._subscribeXdnd();
        this._refresh(true);
        this.ready = true;
        this._bindHotkeys();
        this._syncBadgeTimer();
    }

    // Notification counts are polled (the shell has no signal for them), but only while badges are shown.
    _syncBadgeTimer() {
        if (this.destroyed) return;
        if (this.showBadges && !this._badgeId) {
            this._badgeId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, BADGE_POLL_SECONDS, () => {
                if (this.destroyed || !this.showBadges) {
                    this._badgeId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._updateBadges();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!this.showBadges && this._badgeId) {
            GLib.source_remove(this._badgeId);
            this._badgeId = 0;
        }
    }

    on_applet_removed_from_panel() {
        this._destroy();
    }

    on_panel_height_changed() {
        this._onMetricsChanged();
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        if (this.box) this.box.set_vertical(!this._horizontal());
        this.flyout.close(true);
        this.menu.close(true);
        this._onMetricsChanged();
    }

    on_panel_icon_size_changed() {
        // The icon size is this applet's own setting; the panel hint is ignored.
    }

    _destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this._drag) this._drag.abort();
        this._flyoutTimer.clear();
        this._tipTimer.clear();
        this._xdndTimer.clear();
        if (this._launcherSub) Gio.DBus.session.signal_unsubscribe(this._launcherSub);
        this._launcherSub = 0;
        if (this._xdndEndId && Main.xdndHandler) Main.xdndHandler.disconnect(this._xdndEndId);
        if (this._xdndBeginId && Main.xdndHandler) Main.xdndHandler.disconnect(this._xdndBeginId);
        this._xdndBeginId = 0;
        this._xdndStop();
        this._xdndEndId = 0;
        [this._refreshId, this._statesId, this._badgeId].forEach(id => {
            if (id) GLib.source_remove(id);
        });
        this._refreshId = this._statesId = this._badgeId = 0;
        this._unbindHotkeys();
        Shared.hotkeyUnregister(this);
        if (this._synced) Shared.leave(this);
        this._synced = false;
        this._gsig.forEach(([obj, id]) => {
            try {
                obj.disconnect(id);
            } catch (e) { /* object already gone */ }
        });
        this._gsig = [];
        Array.from(this._wsig.keys()).forEach(w => this._unwatchWindow(w));
        this.flyout.destroy();
        this.menu.destroy();
        this.tip.destroy();
        // Cinnamon never destroys the right-click menu and the tooltip it creates for every applet: they would
        // stay in the stage after each reload or removal.
        try {
            if (this._menuManager && this._applet_context_menu) {
                this._menuManager.removeMenu(this._applet_context_menu);
                this._applet_context_menu.destroy();
            }
            if (this._applet_tooltip) this._applet_tooltip.destroy();
        } catch (e) {
            global.logError('win11-window-list: context menu cleanup: ' + e);
        }
        if (this._placeholder) this._placeholder.remove(false);
        this._buttons.forEach(b => b.destroy(false));
        this._buttons.clear();
        if (this.settings) this.settings.finalize();
    }

    // ------------------------------------------------------------ pinned import

    // First run: start from the pins of Cinnamon's grouped window list, if present.
    _importPinned() {
        if (this.pinnedImported) return;
        this.pinnedImported = true;
        if (this.pinnedApps && this.pinnedApps.length) return;
        try {
            const dir = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_user_config_dir(), 'cinnamon', 'spices', 'grouped-window-list@cinnamon.org']));
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                if (!info.get_name().endsWith('.json')) continue;
                const [ok, bytes] = dir.get_child(info.get_name()).load_contents(null);
                if (!ok) continue;
                const data = JSON.parse(imports.byteArray.toString(bytes));
                const value = data['pinned-apps'] && data['pinned-apps'].value;
                if (Array.isArray(value) && value.length) {
                    this.pinnedApps = value.map(normalizeId);
                    break;
                }
            }
        } catch (e) { /* no grouped window list settings: start empty */ }
    }

    _uniq(list) {
        const seen = new Set();
        const out = [];
        (list || []).forEach(id => {
            const n = normalizeId(id);
            if (!seen.has(n)) {
                seen.add(n);
                out.push(n);
            }
        });
        return out;
    }

    // Pinned apps in order: this instance's own list, or the shared one when monitors are synchronised.
    _pinnedIds() {
        return this._uniq(this._synced ? Shared.snapshot().pinned : this.pinnedApps);
    }

    // ----------------------------------------------------- monitor synchronisation

    _applySync(initial) {
        if (this.destroyed) return;
        const want = !!this.syncMonitors;
        if (want && !this._synced) {
            const snap = Shared.join(this, this._uniq(this.pinnedApps), this._btnOrder);
            this._synced = true;
            this.pinnedApps = snap.pinned;
            if (snap.order.length) this._btnOrder = snap.order;
        } else if (!want && this._synced) {
            const snap = Shared.snapshot();
            Shared.leave(this);
            this._synced = false;
            this.pinnedApps = snap.pinned;
            this._btnOrder = snap.order;
        }
        if (!initial) this._queueRefresh();
    }

    // Another synchronised instance changed pins or order.
    onSharedChanged() {
        if (this.destroyed || !this._synced) return;
        const snap = Shared.snapshot();
        this.pinnedApps = snap.pinned;
        this._btnOrder = snap.order.slice();
        this._queueRefresh();
    }

    _savePinned(ids) {
        if (!Array.isArray(ids)) return;
        this.pinnedApps = ids;
        if (this._synced) Shared.publish(this, ids, this._btnOrder);
    }

    // ------------------------------------------------------------ signal wiring

    _connectGlobals() {
        const c = (obj, name, cb) => {
            try {
                this._gsig.push([obj, obj.connect(name, cb)]);
            } catch (e) { /* signal not available in this Cinnamon version */ }
        };
        // Tooltips, menus and other helper windows of other programs come and go all the time: only windows
        // that can have a button (or that we already follow) are worth a refresh.
        c(global.display, 'window-created', (d, w) => {
            if (!this._relevant(w)) return;
            this._watchWindow(w);
            this._queueRefresh();
        });
        c(global.display, 'notify::focus-window', () => this._onFocusChanged());
        c(global.display, 'window-demands-attention', (d, w) => this._onAttention(w));
        c(global.display, 'window-marked-urgent', (d, w) => this._onAttention(w));
        c(global.display, 'window-entered-monitor', (d, i, w) => {
            if (this._relevant(w)) this._queueRefresh();
        });
        c(global.display, 'window-left-monitor', (d, i, w) => {
            if (this._relevant(w)) this._queueRefresh();
        });
        c(global.window_manager, 'map', (wm, actor) => {
            if (this._relevant(actor && actor.meta_window)) this._queueRefresh();
        });
        c(global.workspace_manager, 'active-workspace-changed', () => this._queueRefresh());
        c(this.appSystem, 'installed-changed', () => {
            this._appIndex = null;
            this._queueRefresh();
        });
        c(St.TextureCache.get_default(), 'icon-theme-changed', () => this._buttons.forEach(b => b.buildIcon()));
    }

    // Could this window have a button now, or does it already have one?
    _relevant(w) {
        if (!w) return true;
        if (this._wsig.has(w)) return true;
        try {
            return !w.is_override_redirect() && Main.isInteresting(w);
        } catch (e) {
            return true;
        }
    }

    _watchWindow(w) {
        if (!w || this._wsig.has(w)) return;
        const ids = [];
        const c = (name, cb) => {
            try {
                ids.push(w.connect(name, cb));
            } catch (e) { /* property missing */ }
        };
        c('unmanaged', () => {
            this._unwatchWindow(w);
            this._attention.delete(w);
            this._mru = this._mru.filter(x => x !== w);
            this._queueRefresh();
        });
        c('notify::minimized', () => this._queueStates());
        c('notify::appears-focused', () => this._onWindowFocusProp(w));
        c('workspace-changed', () => this._queueRefresh());
        c('notify::wm-class', () => this._queueRefresh());
        c('notify::gtk-application-id', () => this._queueRefresh());
        c('notify::demands-attention', () => this._onAttention(w));
        c('notify::urgent', () => this._onAttention(w));
        c('notify::progress', () => this._queueStates());
        c('notify::progress-pulse', () => this._queueStates());
        this._wsig.set(w, ids);
    }

    _unwatchWindow(w) {
        const ids = this._wsig.get(w);
        if (!ids) return;
        this._wsig.delete(w);
        ids.forEach(id => {
            try {
                w.disconnect(id);
            } catch (e) { /* window already finalized */ }
        });
    }

    _queueRefresh() {
        if (this.destroyed || this._refreshId) return;
        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshId = 0;
            this._refresh(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueStates() {
        if (this.destroyed || this._statesId || this._refreshId) return;
        this._statesId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._statesId = 0;
            this._applyStates();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onFocusChanged() {
        const f = global.display.focus_window;
        if (f) {
            this._mru = this._mru.filter(x => x !== f);
            this._mru.unshift(f);
            this._attention.delete(f);
        }
        this._queueStates();
    }

    _onWindowFocusProp(w) {
        if (w.appears_focused) this._attention.delete(w);
        this._queueStates();
    }

    // A window asks for attention either with _NET_WM_STATE_DEMANDS_ATTENTION (`demands_attention`) or
    // with the older WM_HINTS urgency flag (`urgent`, used by many GTK/Qt apps and terminals).
    _onAttention(w) {
        if (!w || this._isFocused(w)) return;
        if (w.demands_attention || w.urgent) this._attention.add(w);
        else this._attention.delete(w);
        this._queueStates();
    }

    // ------------------------------------------------------- window bookkeeping

    _accepts(w) {
        if (!Main.isInteresting(w)) return false;
        if (!this.showAllWorkspaces && !w.is_on_all_workspaces()) {
            const ws = w.get_workspace();
            if (ws !== global.workspace_manager.get_active_workspace()) return false;
        }
        // Synchronised bars all show every window.
        if (!this._synced && !this.showAllMonitors && this.panel && w.get_monitor() !== this.panel.monitorIndex) return false;
        return true;
    }

    _isFocused(w) {
        if (!w || w.minimized) return false;
        if (w.appears_focused) return true;
        const f = global.display.focus_window;
        return !!f && w !== f && w.is_ancestor_of_transient(f);
    }

    // App for a (normalised) desktop id. Cinnamon files some apps under a suffixed id (Flatpak apps are
    // "com.google.Chrome.desktop:flatpak"), which the plain lookup misses; without this a pinned
    // Flatpak app vanished as soon as its last window closed.
    _lookupApp(id) {
        let app = this.appSystem.lookup_app(id);
        if (app) return app;
        if (!this._appIndex) {
            this._appIndex = new Map();
            this.appSystem.get_all().forEach(a => {
                const key = normalizeId(a.get_id());
                if (!this._appIndex.has(key)) this._appIndex.set(key, a);
            });
        }
        return this._appIndex.get(id) || null;
    }

    // Returns {id, app} for a window; windows without a launcher group by WM class.
    _identify(w) {
        let app = this.tracker.get_window_app(w);
        if (!app) app = this.tracker.get_app_from_pid(w.get_pid());
        if (app && !app.is_window_backed()) {
            return { id: normalizeId(app.get_id()), app: app, backed: false };
        }
        const cls = w.get_wm_class() || ('pid' + w.get_pid());
        return { id: 'win:' + cls, app: app || null, backed: true };
    }

    // Display order: what is already shown keeps its place (pinned and running apps mix freely, as on
    // Windows); a newly pinned app goes after the nearest earlier pinned one, a new window's app goes last.
    _computeOrder(groups, pinnedAll, apps) {
        const pinned = pinnedAll.filter(id => apps.get(id));
        const wanted = new Set(pinned);
        groups.forEach((g, id) => wanted.add(id));
        const base = this._synced ? Shared.snapshot().order : this._btnOrder;
        const order = base.filter(id => wanted.has(id));
        const present = new Set(order);

        pinned.forEach((id, i) => {
            if (present.has(id)) return;
            let at = -1;
            for (let j = i - 1; j >= 0 && at < 0; j--) {
                const k = order.indexOf(pinned[j]);
                if (k >= 0) at = k + 1;
            }
            if (at < 0) {
                let first = -1;
                for (let j = i + 1; j < pinned.length && first < 0; j++) first = order.indexOf(pinned[j]);
                at = first >= 0 ? first : 0;
            }
            order.splice(at, 0, id);
            present.add(id);
        });

        Array.from(groups.values())
            .filter(g => !present.has(g.id))
            .sort((a, b) => a.windows[0].get_stable_sequence() - b.windows[0].get_stable_sequence())
            .forEach(g => {
                order.push(g.id);
                present.add(g.id);
            });
        return order;
    }

    _refresh(initial) {
        if (this.destroyed) return;
        if (this._dragging) {            // do not fight a drag in progress; redo it afterwards
            this._refreshDeferred = true;
            return;
        }
        const groups = new Map();
        global.display.list_windows(0).forEach(w => {
            if (!this._accepts(w)) return;
            this._watchWindow(w);
            const { id, app, backed } = this._identify(w);
            let g = groups.get(id);
            if (!g) {
                g = { id: id, app: app, backed: backed, windows: [], title: w.get_wm_class() || w.get_title() };
                groups.set(id, g);
            }
            g.windows.push(w);
        });
        groups.forEach(g => g.windows.sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence()));

        const pinned = this._pinnedIds();
        const apps = new Map();
        pinned.forEach(id => {
            const g = groups.get(id);
            const app = (g && g.app) || this._lookupApp(id);
            if (app) apps.set(id, app);
        });
        groups.forEach((g, id) => {
            if (!apps.has(id)) apps.set(id, g.app);
        });

        const order = this._computeOrder(groups, pinned, apps);
        this._btnOrder = order;
        if (this._synced && !sameList(order, Shared.snapshot().order)) Shared.publish(this, pinned, order);

        // Reconcile buttons.
        const wanted = new Set(order);
        this._buttons.forEach((btn, id) => {
            if (wanted.has(id)) return;
            if (this.flyout.button === btn) this.flyout.close(true);
            if (this._hoverButton === btn) this._hoverButton = null;
            btn.destroy(!initial);
            this._buttons.delete(id);
        });

        order.forEach(id => {
            let btn = this._buttons.get(id);
            const g = groups.get(id);
            const app = apps.get(id);
            if (!btn) {
                btn = this._createButton(id, app, g ? g.title : id);
                this._buttons.set(id, btn);
                const taken = this._takePlaceholder(id, btn);
                if (!taken) {
                    this.box.add_child(btn.actor);
                    if (!initial) btn.animateIn();
                }
            } else if (app && btn.app !== app) {
                btn.app = app;
                btn.buildIcon();
            }
        });
        this._restack(order.map(id => this._buttons.get(id)));

        this._groups = groups;
        this._applyStates();
        this._updateBadges();
        this.flyout.sync();
    }

    // Puts the live buttons in `list` order. Only the slots they already occupy are reassigned, so a button
    // that is playing its closing animation (or a drop placeholder) stays exactly where it is instead of
    // jumping to the start of the list.
    _restack(list) {
        const kids = this.box.get_children();
        const isLive = a => a._delegate instanceof TaskButton && !a._delegate.removing;
        const slots = [];
        kids.forEach((a, i) => {
            if (isLive(a)) slots.push(i);
        });
        if (slots.length !== list.length) {
            list.forEach(b => this.box.set_child_above_sibling(b.actor, null));
            return;
        }
        if (slots.every((pos, k) => kids[pos] === list[k].actor)) return;
        const target = kids.slice();
        slots.forEach((pos, k) => {
            target[pos] = list[k].actor;
        });
        target.forEach((a, i) => this.box.set_child_at_index(a, i));
    }

    _applyStates() {
        if (this.destroyed || !this._groups) return;
        const pinned = new Set(this._pinnedIds());
        this._buttons.forEach((btn, id) => {
            const g = this._groups.get(id);
            const windows = g ? g.windows : [];
            const focused = windows.some(w => this._isFocused(w));
            const lau = this._launcherFor(btn, windows);
            const attention = !focused && (!!(lau && lau.urgent) || windows.some(w => this._attention.has(w)));
            let progress = lau && lau.progressVisible ? Math.round(lau.progress * 100) : -1;
            let pulse = false;
            windows.forEach(w => {
                if (w.progress_pulse) pulse = true;
                if (typeof w.progress === 'number' && w.progress > progress) progress = w.progress;
            });
            btn.update(windows, pinned.has(id), focused, attention);
            btn.setProgress(progress, pulse);
        });
    }

    _updateBadges() {
        if (this.destroyed) return;
        this._buttons.forEach(btn => {
            let count = 0;
            if (this.showBadges && btn.app) {
                try {
                    count = Main.notificationDaemon.getNotificationCountForApp(btn.app) || 0;
                } catch (e) {
                    count = 0;
                }
                const l = this._launcherFor(btn);
                if (l && l.countVisible) count = Math.max(count, l.count);
            }
            btn.setBadge(count);
        });
    }

    liveButtons() {
        return this.box.get_children()
            .map(a => a._delegate)
            .filter(b => b instanceof TaskButton && !b.removing);
    }

    buttonForActor(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            if (a._delegate instanceof TaskButton) return a._delegate;
        }
        return null;
    }

    // ---------------------------------------------------------- button creation

    _createButton(id, app, fallbackName) {
        const btn = new TaskButton(this, id, app, fallbackName);
        btn.actor.connect('button-press-event', (a, event) => {
            if (event.get_button() !== 1 || btn.removing || this._drag || this.menu.isOpen) {
                return Clutter.EVENT_PROPAGATE;
            }
            this._drag = new ReorderDrag(this, btn, event);
            return Clutter.EVENT_PROPAGATE;
        });
        return btn;
    }

    // ---------------------------------------------------------------- drag hooks

    beginDrag(btn) {
        this._dragging = true;
        this._cancelHover();
        this.flyout.close(true);
        this.menu.close(true);
    }

    dragFinished(drag) {
        if (this._drag === drag) this._drag = null;
        this._dragging = false;
        if (this._refreshDeferred) {
            this._refreshDeferred = false;
            this._queueRefresh();
        }
    }

    // Moves a live button to `slot` (index among live buttons) and slides the ones it passes.
    moveButton(btn, slot) {
        const items = this._slotItems();
        const from = items.indexOf(btn);
        if (from < 0 || slot === from) return;
        this._moveItem(items, from, slot);
    }

    _slotItems() {
        return this.box.get_children()
            .map(a => a._delegate)
            .filter(b => (b instanceof TaskButton && !b.removing) || b instanceof Placeholder);
    }

    _moveItem(items, from, to) {
        const m = this.metrics;
        const pitch = (m.horizontal ? m.tileW : m.tileH) + m.gap;
        const next = items.slice();
        const [it] = next.splice(from, 1);
        next.splice(to, 0, it);
        next.forEach(b => this.box.set_child_above_sibling(b.actor, null));
        next.forEach((b, i) => {
            if (b === it) return;
            const old = items.indexOf(b);
            if (old !== i) b.slideFrom((old - i) * pitch);
        });
    }

    // The order on screen becomes the saved order (pinned apps keep their relative order).
    commitOrder() {
        const order = this.liveButtons().map(b => b.id);
        this._btnOrder = order;
        this._savePinnedFromOrder(this._pinnedIds());
    }

    _savePinnedFromOrder(pinnedIds) {
        const set = new Set(pinnedIds);
        const shown = this._btnOrder.filter(id => set.has(id));
        const hidden = pinnedIds.filter(id => !shown.includes(id));
        this._savePinned(shown.concat(hidden));
    }

    // ------------------------------------------- Unity LauncherEntry (counts, progress, urgent)
    // Linux's counterpart of the Windows taskbar overlay badge and progress bar: apps such as Chrome,
    // Telegram or Nemo publish them on the session bus as com.canonical.Unity.LauncherEntry.Update.

    _subscribeLauncher() {
        this._launcherSub = Gio.DBus.session.signal_subscribe(null, 'com.canonical.Unity.LauncherEntry', 'Update',
            null, null, Gio.DBusSignalFlags.NONE, (conn, sender, path, iface, name, params) => {
                try {
                    const [uri, props] = params.deep_unpack();
                    const id = normalizeId(String(uri).replace(/^application:\/\//, ''));
                    const cur = this._launcher.get(id) || { count: 0, countVisible: false, progress: 0, progressVisible: false, urgent: false };
                    const v = k => (props[k] !== undefined ? props[k].deep_unpack() : undefined);
                    if (v('count') !== undefined) cur.count = Number(v('count'));
                    if (v('count-visible') !== undefined) cur.countVisible = !!v('count-visible');
                    if (v('progress') !== undefined) cur.progress = Number(v('progress'));
                    if (v('progress-visible') !== undefined) cur.progressVisible = !!v('progress-visible');
                    if (v('urgent') !== undefined) cur.urgent = !!v('urgent');
                    this._launcher.set(id, cur);
                    this._updateBadges();               // counts show at once; notifications are polled
                    this._queueStates();
                } catch (e) {
                    global.logError('win11-window-list: bad LauncherEntry update: ' + e);
                }
            });
    }

    _launcherFor(btn, windows = btn.windows) {
        if (!windows.length) return null;            // data of a closed app is stale
        return this._launcher.get(btn.id) || (btn.app ? this._launcher.get(normalizeId(btn.app.get_id())) : null) || null;
    }

    // ------------------------------------- dragging files (from other windows) over the buttons
    // Holding a dragged item over a button brings that app's window forward so the item can be dropped
    // into it; over a button with several windows the thumbnail flyout opens and holding the item over
    // one of its cards brings that particular window forward (also lets you drag between two windows of
    // the same app). Cinnamon cannot receive the drop itself: the item is dropped on the raised window.
    //
    // The pointer position of a drag coming from another program reaches us through a drag monitor
    // (Cinnamon's XdndHandler forwards every position to them), so there is no polling.

    _subscribeXdnd() {
        if (!Main.xdndHandler) return;
        this._xdndBeginId = Main.xdndHandler.connect('drag-begin', () => this._xdndBegin());
        this._xdndEndId = Main.xdndHandler.connect('drag-end', () => this._xdndEnd());
    }

    _xdndBegin() {
        if (this.destroyed) return;
        this.flyout.cancelClose();
        if (this._xdndMonitor) return;
        this._xdndMonitor = { dragMotion: ev => this._xdndMotion(ev) };
        DND.addDragMonitor(this._xdndMonitor);
    }

    // The pointer left the chrome (panel, flyout): the window under it is the drop target now. The gap
    // between the bar and the flyout counts as "left" too, so the flyout only closes after a grace period.
    _xdndEnd() {
        this._xdndTimer.clear();
        this._xdndKey = null;
        this._xdndMark(null);
        this._xdndStop();
        if (this.flyout.isOpen && !this.flyout.sticky) this.flyout.scheduleClose();
    }

    _xdndStop() {
        if (this._xdndMonitor) DND.removeDragMonitor(this._xdndMonitor);
        this._xdndMonitor = null;
        this._xdndTimer.clear();
        this._xdndMark(null);
    }

    _xdndMark(actor) {
        if (this._xdndMarked === actor) return;
        const set = (a, on) => {
            try {
                if (a._delegate instanceof TaskButton) a._delegate.setForcedHover(on);
                else if (on) a.add_style_pseudo_class('hover');
                else a.remove_style_pseudo_class('hover');
            } catch (e) { /* destroyed */ }
        };
        if (this._xdndMarked) set(this._xdndMarked, false);
        this._xdndMarked = actor;
        if (actor) set(actor, true);
    }

    _buttonAt(x, y) {
        return this.liveButtons().find(b => {
            const [bx, by] = b.actor.get_transformed_position();
            const [bw, bh] = b.actor.get_transformed_size();
            return x >= bx && x < bx + bw && y >= by && y < by + bh;
        }) || null;
    }

    _xdndMotion(ev) {
        if (ev.source !== Main.xdndHandler || this.destroyed) return DND.DragMotionResult.CONTINUE;
        this._xdndOver(ev.x, ev.y);
        return DND.DragMotionResult.CONTINUE;
    }

    _xdndOver(x, y) {
        const hit = this.flyout.hitTest(x, y);          // { card, window } | { inside: true } | null
        const btn = hit ? null : this._buttonAt(x, y);
        const key = hit && hit.window ? hit.window : (hit ? this.flyout : btn);
        // Keep the flyout while the item is over it or over its own button; otherwise let it go.
        if (this.flyout.isOpen && !this.flyout.sticky) {
            if (hit || (btn && btn === this.flyout.button)) this.flyout.cancelClose();
            else this.flyout.scheduleClose();
        }
        if (key === this._xdndKey) return;
        this._xdndKey = key;
        this._xdndTimer.clear();

        if (hit && hit.window) {
            this._xdndMark(hit.card);
            const w = hit.window;
            this._xdndTimer.set(this.xdndDelay, () => {
                if (this._xdndKey === w) this.activateWindow(w);
            });
            return;
        }
        this._xdndMark(hit ? null : (btn && btn.windows.length > 0 ? btn.actor : null));
        if (!btn || btn.windows.length === 0) return;
        this._xdndTimer.set(this.xdndDelay, () => {
            if (this._xdndKey !== btn || btn.destroyed) return;
            if (btn.windows.length === 1) {
                this.flyout.close(true);
                this.activateWindow(btn.windows[0]);
            } else {
                this.flyout.open(btn, false);
            }
        });
    }

    // ---------------------------------------------------------------- hover logic

    _cancelHover() {
        this._flyoutTimer.clear();
        this._tipTimer.clear();
        this.tip.hide(true);
    }

    onButtonHover(btn, entered) {
        if (this._dragging || this.destroyed) return;
        if (!entered) {
            if (this._hoverButton === btn) this._hoverButton = null;
            this._cancelHover();
            this.flyout.scheduleClose();
            return;
        }
        this._hoverButton = btn;
        this._cancelHover();
        if (this.menu.isOpen) return;

        if (btn.windows.length > 0) {
            this.flyout.cancelClose();
            if (this.flyout.isOpen) {
                this.flyout.open(btn, false);            // switch buttons without delay
            } else {
                this._flyoutTimer.set(this.hoverDelay, () => {
                    if (this._hoverButton === btn) this.flyout.open(btn, false);
                });
            }
        } else {
            this.flyout.scheduleClose();
            this._tipTimer.set(TIP_DELAY, () => {
                if (this._hoverButton === btn && !this.menu.isOpen) this.tip.show(btn, btn.name);
            });
        }
    }

    // ----------------------------------------------------------------- actions

    onButtonClicked(btn, mouseButton) {
        if (btn.removing || this._dragging) return;
        this._cancelHover();
        const ev = Clutter.get_current_event();
        const state = ev ? ev.get_state() : 0;
        const shift = !!(state & Clutter.ModifierType.SHIFT_MASK);

        if (mouseButton === 3) {
            this.openMenu(btn);
        } else if (mouseButton === 2 || (mouseButton === 1 && shift)) {
            this.newWindow(btn);
        } else if (mouseButton === 1) {
            const n = btn.windows.length;
            if (n === 0) this.newWindow(btn);
            else if (n === 1) this.toggleWindow(btn.windows[0]);
            else this.flyout.open(btn, true);
        }
    }

    newWindow(btn) {
        if (!btn.app) return;
        this.flyout.close(true);
        btn.playLaunchBounce();
        try {
            btn.app.open_new_window(-1);
        } catch (e) {
            global.logError('win11-window-list: cannot open a new window: ' + e);
        }
    }

    activateWindow(w) {
        Main.activateWindow(w, global.get_current_time());
    }

    toggleWindow(w) {
        if (this._isFocused(w)) w.minimize();
        else this.activateWindow(w);
    }

    lastFocusedOf(btn) {
        const hit = this._mru.find(w => btn.windows.includes(w));
        return hit || btn.windows[btn.windows.length - 1];
    }

    // Super+N and similar: one entry point with Windows' semantics.
    activateButton(btn) {
        const n = btn.windows.length;
        if (n === 0) {
            this.newWindow(btn);
        } else if (n === 1) {
            this.toggleWindow(btn.windows[0]);
        } else if (btn.windows.some(w => this._isFocused(w))) {
            const cur = btn.windows.findIndex(w => this._isFocused(w));
            this.activateWindow(btn.windows[(cur + 1) % n]);
        } else {
            this.activateWindow(this.lastFocusedOf(btn));
        }
    }

    closeAll(btn) {
        const t = global.get_current_time();
        btn.windows.slice().forEach(w => w.delete(t));
    }

    pin(btn) {
        if (!btn.app || btn.id.startsWith('win:')) return;
        const ids = this._pinnedIds();
        if (!ids.includes(btn.id)) ids.push(btn.id);
        this._savePinnedFromOrder(ids);
        this._queueRefresh();
    }

    unpin(btn) {
        this._savePinnedFromOrder(this._pinnedIds().filter(id => id !== btn.id));
        this._queueRefresh();
    }

    // --------------------------------------------------------------- jump list

    _themedIcon(names) {
        const theme = Gtk.IconTheme.get_default();
        const name = names.find(n => theme.has_icon(n));
        return name ? new St.Icon({ icon_name: name, icon_size: this.metrics.px(16), style_class: 'win11-tb-menu-icon' }) : null;
    }

    _openRecent(btn, uri) {
        const app = btn.app;
        try {
            const info = app && app.get_app_info();
            if (info) {
                info.launch_uris([uri], global.create_app_launch_context(0, -1));
                return;
            }
        } catch (e) { /* fall back below */ }
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            global.logError('win11-window-list: cannot open ' + uri + ': ' + e);
        }
    }

    _menuItems(btn) {
        const items = [];
        const app = btn.app;
        const info = app ? app.get_app_info() : null;

        const recents = this.showRecent && app ? recentFor(app, this.recentCount) : [];
        if (recents.length) {
            items.push({ kind: 'header', label: tr('recent') });
            recents.forEach(r => items.push({
                kind: 'item',
                label: r.name,
                icon: new St.Icon({ gicon: r.gicon, icon_size: this.metrics.px(16), style_class: 'win11-tb-menu-icon' }),
                ellipsize: true,
                activate: () => this._openRecent(btn, r.uri),
            }));
            items.push({ kind: 'separator' });
        }

        if (info && typeof info.list_actions === 'function') {
            const actions = info.list_actions();
            if (actions.length) {
                items.push({ kind: 'header', label: tr('tasks') });
                actions.forEach(a => items.push({
                    kind: 'item',
                    label: actionName(info, a, this.language),
                    icon: null,
                    activate: () => {
                        try {
                            info.launch_action(a, global.create_app_launch_context(0, -1));
                        } catch (e) {
                            global.logError('win11-window-list: action failed: ' + e);
                        }
                    },
                }));
                items.push({ kind: 'separator' });
            }
        }

        if (app) {
            let icon = null;
            try {
                icon = app.create_icon_texture(this.metrics.px(16));
            } catch (e) { /* no icon */ }
            items.push({ kind: 'item', label: btn.name, icon: icon, activate: () => this.newWindow(btn) });
        }
        if (app && !btn.id.startsWith('win:')) {
            items.push(btn.pinned
                ? { kind: 'item', label: tr('unpin'), icon: this._themedIcon(UNPIN_ICONS), activate: () => this.unpin(btn) }
                : { kind: 'item', label: tr('pin'), icon: this._themedIcon(PIN_ICONS), activate: () => this.pin(btn) });
        }
        if (btn.windows.length) {
            items.push({
                kind: 'item',
                label: btn.windows.length > 1 ? tr('closeAll') : tr('close'),
                icon: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: this.metrics.px(16), style_class: 'win11-tb-menu-icon' }),
                activate: () => this.closeAll(btn),
            });
        }
        return items;
    }

    openMenu(btn) {
        this._cancelHover();
        this.flyout.close(true);
        const items = this._menuItems(btn);
        if (items.length) this.menu.open(btn, items);
    }

    // --------------------------------------------------------------- hotkeys

    _unbindHotkeys() {
        for (let i = 1; i < 10; i++) {
            Main.keybindingManager.removeHotKey('win11tb-key-' + this.instanceId + '-' + i);
            Main.keybindingManager.removeHotKey('win11tb-new-' + this.instanceId + '-' + i);
        }
    }

    isOnPrimary() {
        return !!this.panel && this.panel.monitorIndex === Main.layoutManager.primaryIndex;
    }

    // Called by Shared when the instance that answers Super+N changes.
    setHotkeyOwner(owner) {
        this._hotkeyOwner = owner;
        this._applyHotkeys();
    }

    _bindHotkeys() {
        if (!this.panel) return;
        Shared.hotkeyRegister(this);
        this._applyHotkeys();
    }

    _applyHotkeys() {
        this._unbindHotkeys();
        if (!this.superNumHotkeys || !this._hotkeyOwner || this.destroyed) return;
        for (let i = 1; i < 10; i++) {
            const n = i;
            Main.keybindingManager.addHotKey('win11tb-key-' + this.instanceId + '-' + n, '<Super>' + n,
                () => this._onNumberKey(n, false));
            Main.keybindingManager.addHotKey('win11tb-new-' + this.instanceId + '-' + n, '<Super><Shift>' + n,
                () => this._onNumberKey(n, true));
        }
    }

    _onNumberKey(n, fresh) {
        const btn = this.liveButtons()[n - 1];
        if (!btn) return;
        if (fresh) this.newWindow(btn);
        else this.activateButton(btn);
    }

    // ------------------------------------- apps dragged in from other widgets (Start menu)

    _foreignAppId(source) {
        if (!source || source instanceof TaskButton || source === Main.xdndHandler) return null;
        try {
            if (source.isDraggableApp && typeof source.get_app_id === 'function') return normalizeId(source.get_app_id());
            if (typeof source.getId === 'function') return normalizeId(source.getId());
            if (source.app && typeof source.app.get_id === 'function') return normalizeId(source.app.get_id());
            if (source.itemData && source.itemData.type !== 'folder' && source.itemData.id) return normalizeId(source.itemData.id);
        } catch (e) { /* not an app */ }
        return null;
    }

    // Insertion index (among live buttons) for a pointer position along the bar: the number of
    // buttons whose centre lies before the pointer. Uses layout positions (no slide offset), so it
    // does not move when the centred group grows by the placeholder.
    _insertionIndex(x, y) {
        const H = this.metrics.horizontal;
        const [ax, ay] = this.actor.get_transformed_position();
        const pointer = H ? ax + x : ay + y;
        let count = 0;
        this.liveButtons().forEach(b => {
            const [bx, by] = b.actor.get_transformed_position();
            const [bw, bh] = b.actor.get_transformed_size();
            const centre = H ? bx - (b.actor.translation_x || 0) + bw / 2 : by - (b.actor.translation_y || 0) + bh / 2;
            if (centre < pointer) count++;
        });
        return Math.max(0, Math.min(this.liveButtons().length, count));
    }

    handleDragOver(source, actor, x, y, time) {
        const id = this._foreignAppId(source);
        if (!id) return DND.DragMotionResult.CONTINUE;
        if (this._pinnedIds().includes(id) || !this._lookupApp(id)) return DND.DragMotionResult.CONTINUE;

        const existing = this._buttons.get(id);
        if (existing) return DND.DragMotionResult.COPY_DROP;      // running, not pinned: pinning keeps its place

        const idx = this._insertionIndex(x, y);
        if (!this._placeholder) {
            this._placeholder = new Placeholder(this);
            this._placeholderId = id;
            this.box.add_child(this._placeholder.actor);
            const items = this._slotItems();
            this._moveItem(items, items.length - 1, Math.min(idx, items.length - 1));
        } else {
            const items = this._slotItems();
            const from = items.indexOf(this._placeholder);
            if (from >= 0 && from !== idx) this._moveItem(items, from, Math.min(idx, items.length - 1));
        }
        return DND.DragMotionResult.COPY_DROP;
    }

    handleDragOut() {
        if (!this._placeholder) return;
        this._placeholder.remove(true);
        this._placeholder = null;
        this._placeholderId = null;
    }

    acceptDrop(source, actor, x, y, time) {
        const id = this._foreignAppId(source);
        if (!id || !this._lookupApp(id)) return false;
        const pinned = this._pinnedIds();
        if (pinned.includes(id)) return false;

        const items = this._slotItems();
        let index = this._placeholder ? items.indexOf(this._placeholder) : -1;
        const live = items.filter(b => b instanceof TaskButton).map(b => b.id);
        if (index < 0) index = live.length;
        // Position among real buttons = placeholder index (the placeholder is not in `live`).
        const order = live.filter(v => v !== id);
        const slot = this._placeholder ? items.slice(0, index).filter(b => b instanceof TaskButton).length : (live.indexOf(id) >= 0 ? live.indexOf(id) : order.length);
        order.splice(Math.min(slot, order.length), 0, id);
        this._btnOrder = order;
        this._savePinnedFromOrder(pinned.concat([id]));
        this._queueRefresh();
        return true;
    }

    // A new button takes over the placeholder's slot without a second animation.
    _takePlaceholder(id, btn) {
        const ph = this._placeholder;
        if (!ph || this._placeholderId !== id) return false;
        const kids = this.box.get_children();
        const at = kids.indexOf(ph.actor);
        this._placeholder = null;
        this._placeholderId = null;
        this.box.insert_child_at_index(btn.actor, at);
        ph.destroyed = true;
        ph.actor.destroy();
        return true;
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new Win11WindowList(metadata, orientation, panelHeight, instanceId);
}
