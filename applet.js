// Win11-Like Window List — Cinnamon applet.
// Reproduces the Windows 11 taskbar window buttons (see docs/REFERENCE.md).
const Applet = imports.ui.applet;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const DND = imports.ui.dnd;
const { Clutter, St, GLib, Gio, Gtk, Cinnamon } = imports.gi;

const { tr } = require('./i18n');
const { Timer, normalizeId } = require('./util');
const { TaskButton } = require('./taskButton');
const { Flyout } = require('./flyout');
const { ContextMenu } = require('./contextMenu');
const { TaskTip } = require('./tooltip');

const TIP_DELAY = 700;           // ms before the text tooltip of a button without windows
const PIN_ICONS = ['view-pin-symbolic', 'pin-symbolic', 'emblem-pinned-symbolic'];
const UNPIN_ICONS = ['view-unpin-symbolic', 'unpin-symbolic', 'view-pin-symbolic', 'pin-symbolic'];

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
        this._runOrder = [];            // ids of unpinned running apps, in display order
        this._attention = new Set();    // MetaWindows asking for attention
        this._mru = [];                 // most recently focused first
        this._wsig = new Map();         // MetaWindow -> signal ids
        this._gsig = [];                // [object, id]
        this._refreshId = 0;
        this._statesId = 0;
        this._hoverButton = null;
        this._flyoutTimer = new Timer();
        this._tipTimer = new Timer();
        this._dragging = false;

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.actor.set_track_hover(false);
        this.actor.set_style_class_name('win11-tb-applet');
        this.actor.set_style('padding: 0; margin: 0;');

        this._bindSettings();
        this._computeMetrics();

        this.box = new St.BoxLayout({
            style_class: 'win11-tb-box',
            vertical: !this._horizontal(),
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this.box);

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
        s.bindProperty(BOTH, 'pinned-apps', 'pinnedApps', () => this._queueRefresh());
        s.bindProperty(BOTH, 'pinned-imported', 'pinnedImported', null);
        s.bindProperty(IN, 'show-all-workspaces', 'showAllWorkspaces', () => this._queueRefresh());
        s.bindProperty(IN, 'show-all-monitors', 'showAllMonitors', () => this._queueRefresh());
        s.bindProperty(IN, 'super-num-hotkeys', 'superNumHotkeys', () => this._bindHotkeys());
        s.bindProperty(IN, 'icon-size', 'iconSize', () => this._onMetricsChanged());
        s.bindProperty(IN, 'indicator-color', 'accentColor', () => this._queueStates());
        s.bindProperty(IN, 'hover-delay', 'hoverDelay', null);
        s.bindProperty(IN, 'enable-peek', 'enablePeek', null);
        s.bindProperty(IN, 'peek-delay', 'peekDelay', null);
        s.bindProperty(IN, 'enable-animations', 'enableAnimations', null);
        s.bindProperty(IN, 'launch-animation', 'launchAnimation', null);
    }

    get animate() {
        return this.enableAnimations;
    }

    _horizontal() {
        return this.orientation === St.Side.TOP || this.orientation === St.Side.BOTTOM;
    }

    _computeMetrics() {
        const scale = global.ui_scale || 1;
        const px = n => Math.round(n * scale);
        const panelH = this.panel_height || px(48);
        const tileH = Math.min(px(40), Math.max(px(24), panelH - px(4)));
        const tileW = panelH >= px(44) ? px(40) : tileH;
        this.metrics = {
            px: px,
            tileW: tileW,
            tileH: tileH,
            icon: Math.min(px(this.iconSize || 24), tileH - px(6)),
            backW: px(3),
            stackInset: px(5),
            indicatorIdle: px(6),
            indicatorActive: px(16),
            indicatorH: px(3),
            indicatorBottom: px(1),
            gap: px(4),
        };
    }

    _onMetricsChanged() {
        this._computeMetrics();
        this._buttons.forEach(b => {
            b.applyMetrics();
            b.buildIcon();
        });
    }

    // -------------------------------------------------------------- applet hooks

    on_applet_added_to_panel() {
        this._importPinned();
        this._connectGlobals();
        global.display.list_windows(0).forEach(w => this._watchWindow(w));
        this._refresh(true);
        this.ready = true;
        this._bindHotkeys();
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
    }

    on_panel_icon_size_changed() {
        // The icon size is this applet's own setting; the panel hint is ignored.
    }

    _destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this._flyoutTimer.clear();
        this._tipTimer.clear();
        if (this._refreshId) GLib.source_remove(this._refreshId);
        if (this._statesId) GLib.source_remove(this._statesId);
        this._refreshId = 0;
        this._statesId = 0;
        this._unbindHotkeys();
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

    _pinnedIds() {
        const seen = new Set();
        const out = [];
        (this.pinnedApps || []).forEach(id => {
            const n = normalizeId(id);
            if (!seen.has(n)) {
                seen.add(n);
                out.push(n);
            }
        });
        return out;
    }

    // ------------------------------------------------------------ signal wiring

    _connectGlobals() {
        const c = (obj, name, cb) => {
            try {
                this._gsig.push([obj, obj.connect(name, cb)]);
            } catch (e) { /* signal not available in this Cinnamon version */ }
        };
        c(global.display, 'window-created', (d, w) => {
            this._watchWindow(w);
            this._queueRefresh();
        });
        c(global.display, 'notify::focus-window', () => this._onFocusChanged());
        c(global.display, 'window-demands-attention', (d, w) => this._onAttention(w));
        c(global.display, 'window-marked-urgent', (d, w) => this._onAttention(w));
        c(global.display, 'window-entered-monitor', () => this._queueRefresh());
        c(global.display, 'window-left-monitor', () => this._queueRefresh());
        c(global.window_manager, 'map', () => this._queueRefresh());
        c(global.workspace_manager, 'active-workspace-changed', () => this._queueRefresh());
        c(this.appSystem, 'installed-changed', () => this._queueRefresh());
        c(St.TextureCache.get_default(), 'icon-theme-changed', () => this._buttons.forEach(b => b.buildIcon()));
    }

    _watchWindow(w) {
        if (!w || this._wsig.has(w)) return;
        const ids = [];
        const c = (name, cb) => ids.push(w.connect(name, cb));
        c('unmanaged', () => {
            this._unwatchWindow(w);
            this._attention.delete(w);
            this._mru = this._mru.filter(x => x !== w);
            this._queueRefresh();
        });
        c('notify::minimized', () => this._queueStates());
        c('notify::appears-focused', () => this._onWindowFocusProp(w));
        c('notify::title', () => this.flyout.updateTitle(w));
        c('workspace-changed', () => this._queueRefresh());
        c('notify::wm-class', () => this._queueRefresh());
        c('notify::gtk-application-id', () => this._queueRefresh());
        c('notify::demands-attention', () => this._onAttention(w));
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

    _onAttention(w) {
        if (!w || this._isFocused(w)) return;
        if (w.demands_attention === false && !this._attention.has(w)) {
            // Property cleared: nothing to flash.
            this._queueStates();
            return;
        }
        this._attention.add(w);
        this._queueStates();
    }

    // ------------------------------------------------------- window bookkeeping

    _accepts(w) {
        if (!Main.isInteresting(w)) return false;
        if (!this.showAllWorkspaces && !w.is_on_all_workspaces()) {
            const ws = w.get_workspace();
            if (ws !== global.workspace_manager.get_active_workspace()) return false;
        }
        if (!this.showAllMonitors && this.panel && w.get_monitor() !== this.panel.monitorIndex) return false;
        return true;
    }

    _isFocused(w) {
        if (!w || w.minimized) return false;
        if (w.appears_focused) return true;
        const f = global.display.focus_window;
        return !!f && w !== f && w.is_ancestor_of_transient(f);
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

    _refresh(initial) {
        if (this.destroyed) return;
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

        // Display order: pinned (saved order), then unpinned running apps.
        const pinned = this._pinnedIds();
        const pinnedSet = new Set(pinned);
        const order = [];
        const apps = new Map();
        pinned.forEach(id => {
            const g = groups.get(id);
            const app = (g && g.app) || this.appSystem.lookup_app(id);
            if (!app) return; // desktop file is gone; keep the pin, show nothing
            apps.set(id, app);
            order.push(id);
        });

        this._runOrder = this._runOrder.filter(id => groups.has(id) && !pinnedSet.has(id));
        const firstSeen = Array.from(groups.values())
            .filter(g => !pinnedSet.has(g.id) && !this._runOrder.includes(g.id))
            .sort((a, b) => a.windows[0].get_stable_sequence() - b.windows[0].get_stable_sequence());
        firstSeen.forEach(g => this._runOrder.push(g.id));
        this._runOrder.forEach(id => {
            apps.set(id, groups.get(id).app);
            order.push(id);
        });

        // Reconcile buttons.
        const wanted = new Set(order);
        this._buttons.forEach((btn, id) => {
            if (wanted.has(id)) return;
            if (this.flyout.button === btn) this.flyout.close(true);
            if (this._hoverButton === btn) this._hoverButton = null;
            btn.destroy(!initial);
            this._buttons.delete(id);
        });

        order.forEach((id, i) => {
            let btn = this._buttons.get(id);
            const g = groups.get(id);
            const app = apps.get(id);
            if (!btn) {
                btn = this._createButton(id, app, g ? g.title : id);
                this._buttons.set(id, btn);
                this.box.insert_child_at_index(btn.actor, i);
                if (!initial) btn.animateIn();
            } else {
                if (app && btn.app !== app) {
                    btn.app = app;
                    btn.buildIcon();
                }
                if (this.box.get_child_at_index(i) !== btn.actor) this.box.set_child_at_index(btn.actor, i);
            }
        });

        this._groups = groups;
        this._applyStates();
        this.flyout.sync();
    }

    _applyStates() {
        if (this.destroyed || !this._groups) return;
        const pinned = new Set(this._pinnedIds());
        this._buttons.forEach((btn, id) => {
            const g = this._groups.get(id);
            const windows = g ? g.windows : [];
            const focused = windows.some(w => this._isFocused(w));
            const attention = !focused && windows.some(w => this._attention.has(w));
            btn.update(windows, pinned.has(id), focused, attention);
        });
    }

    _liveButtons() {
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
        btn.draggable = DND.makeDraggable(btn.actor, { restoreOnSuccess: false });
        btn.draggable.connect('drag-begin', () => {
            this._dragging = true;
            this._cancelHover();
            this.flyout.close(true);
            this.menu.close(true);
            btn.actor.opacity = 110;
        });
        btn.draggable.connect('drag-end', () => {
            this._dragging = false;
            if (!btn.destroyed) btn.actor.opacity = 255;
            this._queueRefresh();
        });
        return btn;
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
        this._runOrder = this._runOrder.filter(id => id !== btn.id);
        this.pinnedApps = ids;
        this._queueRefresh();
    }

    unpin(btn) {
        const ids = this._pinnedIds().filter(id => id !== btn.id);
        if (btn.windows.length && !this._runOrder.includes(btn.id)) this._runOrder.unshift(btn.id);
        this.pinnedApps = ids;
        this._queueRefresh();
    }

    // --------------------------------------------------------------- jump list

    _themedIcon(names) {
        const theme = Gtk.IconTheme.get_default();
        const name = names.find(n => theme.has_icon(n));
        return name ? new St.Icon({ icon_name: name, icon_size: this.metrics.px(16), style_class: 'win11-tb-menu-icon' }) : null;
    }

    _menuItems(btn) {
        const items = [];
        const app = btn.app;
        const info = app ? app.get_app_info() : null;

        if (info && typeof info.list_actions === 'function') {
            const actions = info.list_actions();
            if (actions.length) {
                items.push({ kind: 'header', label: tr('tasks') });
                actions.forEach(a => items.push({
                    kind: 'item',
                    label: info.get_action_name(a),
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

    _bindHotkeys() {
        this._unbindHotkeys();
        if (!this.superNumHotkeys || !this.panel) return;
        // One panel per desktop answers the keys: the one on the primary monitor.
        if (this.panel.monitorIndex !== Main.layoutManager.primaryIndex) return;
        for (let i = 1; i < 10; i++) {
            const n = i;
            Main.keybindingManager.addHotKey('win11tb-key-' + this.instanceId + '-' + n, '<Super>' + n,
                () => this._onNumberKey(n, false));
            Main.keybindingManager.addHotKey('win11tb-new-' + this.instanceId + '-' + n, '<Super><Shift>' + n,
                () => this._onNumberKey(n, true));
        }
    }

    _onNumberKey(n, fresh) {
        const btn = this._liveButtons()[n - 1];
        if (!btn) return;
        if (fresh) this.newWindow(btn);
        else this.activateButton(btn);
    }

    // ------------------------------------------------------------- drag and drop

    handleDragOver(source, actor, x, y, time) {
        if (!(source instanceof TaskButton)) return DND.DragMotionResult.CONTINUE;
        const horizontal = this._horizontal();
        // The DND code hands over coordinates relative to the applet actor.
        const [ax, ay] = this.actor.get_transformed_position();
        const [bx, by] = this.box.get_transformed_position();
        const pos = horizontal ? ax + x - bx : ay + y - by;
        const m = this.metrics;
        const pitch = (horizontal ? m.tileW : m.tileH) + m.gap;

        const others = this._liveButtons().filter(b => b !== source);
        const pinnedCount = others.filter(b => b.pinned).length;
        // The slot under the pointer in the current layout (the dragged button still occupies one).
        let idx = Math.max(0, Math.min(others.length, Math.floor(pos / pitch)));
        idx = source.pinned ? Math.min(idx, pinnedCount) : Math.max(idx, pinnedCount);

        const next = others.slice();
        next.splice(idx, 0, source);
        next.forEach((b, i) => {
            if (this.box.get_child_at_index(i) !== b.actor) this.box.set_child_at_index(b.actor, i);
        });
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor, x, y, time) {
        if (!(source instanceof TaskButton)) return false;
        const ordered = this._liveButtons();
        const shown = ordered.filter(b => b.pinned).map(b => b.id);
        const hidden = this._pinnedIds().filter(id => !shown.includes(id));
        this._runOrder = ordered.filter(b => !b.pinned).map(b => b.id);
        this.pinnedApps = shown.concat(hidden);
        return true;
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new Win11WindowList(metadata, orientation, panelHeight, instanceId);
}
