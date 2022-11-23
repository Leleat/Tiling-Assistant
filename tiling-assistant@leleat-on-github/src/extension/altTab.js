'use strict';

const { altTab: AltTab, main: Main, switcherPopup: SwitcherPopup } = imports.ui;
const { Gio, GLib, GObject, Meta, Shell, St } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Settings } = Me.imports.src.common;
const Twm = Me.imports.src.extension.tilingWindowManager.TilingWindowManager;

/**
 * Optionally, override GNOME's altTab / appSwitcher to group tileGroups
 */
var Override = class AltTabOverride {
    constructor() {
        this._originalAltTab = AltTab.AppSwitcherPopup;

        if (Settings.getBoolean(Settings.TILEGROUPS_IN_APP_SWITCHER))
            AltTab.AppSwitcherPopup = TilingAppSwitcherPopup;

        this._settingsId = Settings.changed(Settings.TILEGROUPS_IN_APP_SWITCHER, () => {
            AltTab.AppSwitcherPopup = Settings.getBoolean(Settings.TILEGROUPS_IN_APP_SWITCHER)
                ? TilingAppSwitcherPopup
                : this._originalAltTab;
        });
    }

    destroy() {
        Settings.disconnect(this._settingsId);
        AltTab.AppSwitcherPopup = this._originalAltTab;
    }
};

var TilingAppSwitcherPopup = GObject.registerClass(
class TilingAppSwitcherPopup extends AltTab.AppSwitcherPopup {
    _init() {
        SwitcherPopup.SwitcherPopup.prototype._init.call(this);

        this._thumbnails = null;
        this._thumbnailTimeoutId = 0;
        this._currentWindow = -1;

        this.thumbnailsVisible = false;

        const settings = new Gio.Settings({ schema_id: 'org.gnome.shell.app-switcher' });
        const workspace = settings.get_boolean('current-workspace-only')
            ? global.workspace_manager.get_active_workspace()
            : null;
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);

        this._switcherList = new TilingAppSwitcher(this, windows);
        this._items = this._switcherList.icons;
    }

    // Called when closing an entire app / tileGroup
    _quitApplication(index) {
        const item = this._items[index];
        if (!item)
            return;

        item.cachedWindows.forEach(w => w.delete(global.get_current_time()));
        item.cachedWindows = [];
        this._switcherList._removeIcon(item);
    }

    // Called when closing a window with the thumbnail switcher
    // meaning that .cachedWindow of an item was updated via signals
    _windowRemoved(thumbnailSwitcher, n) {
        const item = this._items[this._selectedIndex];
        if (!item)
            return;

        if (item.cachedWindows.length) {
            const newIndex = Math.min(n, item.cachedWindows.length - 1);
            this._select(this._selectedIndex, newIndex);
        }

        item.updateAppIcons();
    }
});

var TilingAppSwitcher = GObject.registerClass(
class TilingAppSwitcher extends AltTab.AppSwitcher {
    _init(altTabPopup, windows) {
        // Don't make the SwitcherButtons squares since 1 SwitcherButton
        // may contain multiple AppIcons for a tileGroup.
        const squareItems = false;
        SwitcherPopup.SwitcherList.prototype._init.call(this, squareItems);

        this.icons = [];
        this._arrows = [];
        this._apps = [];
        this._altTabPopup = altTabPopup;
        this._delayedHighlighted = -1;
        this._mouseTimeOutId = 0;

        const winTracker = Shell.WindowTracker.get_default();
        let groupedWindows;

        // Group windows based on their tileGroup, if tileGroup.length > 1.
        // Otherwise group them based on their respective apps.
        if (Settings.getBoolean(Settings.TILEGROUPS_IN_APP_SWITCHER)) {
            groupedWindows = windows.reduce((allGroups, w) => {
                for (const group of allGroups) {
                    if (w.isTiled && Twm.getTileGroupFor(w).length > 1) {
                        if (Twm.getTileGroupFor(w).includes(group[0])) {
                            group.push(w);
                            return allGroups;
                        }
                    } else if ((!group[0].isTiled || group[0].isTiled && Twm.getTileGroupFor(group[0]).length <= 1) &&
                            winTracker.get_window_app(group[0]) === winTracker.get_window_app(w)) {
                        group.push(w);
                        return allGroups;
                    }
                }
                const newGroup = [w];
                allGroups.push(newGroup);
                return allGroups;
            }, []);

        // Group windows based on apps
        } else {
            groupedWindows = windows.reduce((allGroups, w) => {
                for (const group of allGroups) {
                    if (winTracker.get_window_app(group[0]) === winTracker.get_window_app(w)) {
                        group.push(w);
                        return allGroups;
                    }
                }

                const newGroup = [w];
                allGroups.push(newGroup);
                return allGroups;
            }, []);
        }

        // Construct the AppIcons and add them to the popup.
        groupedWindows.forEach(group => {
            const item = new AppSwitcherItem(group);
            item.connect('all-icons-removed', () => this._removeIcon(item));
            this._addIcon(item);
        });

        // Listen for the app stop state in case the app got closed outside
        // of the app switcher along with closing via the app switcher
        const allApps = windows.map(w => winTracker.get_window_app(w));
        this._apps = [...new Set(allApps)];
        this._stateChangedIds = this._apps.map(app => app.connect('notify::state', () => {
            if (app.state !== Shell.AppState.RUNNING)
                this.icons.forEach(item => item.removeApp(app));
        }));

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._mouseTimeOutId !== 0)
            GLib.source_remove(this._mouseTimeOutId);

        this._stateChangedIds?.forEach((id, index) => this._apps[index].disconnect(id));
        this._stateChangedIds = [];
        this._apps = [];
    }

    _removeIcon(item) {
        const index = this.icons.findIndex(i => i === item);
        if (index === -1)
            return;

        this._arrows[index].destroy();
        this._arrows.splice(index, 1);

        this.icons.splice(index, 1);
        this.removeItem(index);
    }
});

/**
 * Replace AltTab.AppIcon and insert this into the TilingAppSwitcher instead.
 * This may contain multiple AppIcons to represent a tileGroup with chain icons
 * between the AppIcons.
 */
var AppSwitcherItem = GObject.registerClass({
    Signals: { 'all-icons-removed': {} }
}, class AppSwitcherItem extends St.BoxLayout {
    _init(windows) {
        super._init({ vertical: false });

        // A tiled window in a tileGroup of length 1, doesn't get a separate
        // AppSwitcherItem. It gets added to the non-tiled windows' AppSwitcherItem
        const tileGroup = windows[0].isTiled && Twm.getTileGroupFor(windows[0]);
        this.isTileGroup = tileGroup && tileGroup.every(w => windows.includes(w)) && tileGroup?.length > 1;
        this.cachedWindows = windows;
        this.appIcons = [];
        this.chainIcons = [];

        // Compatibility with AltTab.AppIcon
        this.set_size = size => this.appIcons.forEach(i => i.set_size(size));
        this.label = null;
        this.app = {
            // Only raise the first window since we split up apps and tileGroups
            activate_window: (window, timestamp) => {
                Main.activateWindow(this.cachedWindows[0], timestamp);
            },
            // Listening to the app-stop now happens in the custom _init func
            // So prevent signal connection. here.. careful in case signal
            // connection in the future is used for more...
            connectObject: () => {}
        };

        this.updateAppIcons();
    }

    // Re/Create the AppIcons based on the cached window list
    updateAppIcons() {
        this.appIcons.forEach(i => i.destroy());
        this.appIcons = [];
        this.chainIcons.forEach(i => i.destroy());
        this.chainIcons = [];

        const winTracker = Shell.WindowTracker.get_default();
        const path = Me.dir.get_child('media/insert-link-symbolic.svg').get_path();
        const icon = new Gio.FileIcon({ file: Gio.File.new_for_path(path) });

        const apps = this.isTileGroup
            // All apps (even duplicates)
            ? this.cachedWindows.map(w => winTracker.get_window_app(w))
            // Only unique apps
            : this.cachedWindows.reduce((allApps, w) => {
                const a = winTracker.get_window_app(w);
                !allApps.includes(a) && allApps.push(a);
                return allApps;
            }, []);

        apps.forEach((app, idx) => {
            // AppIcon
            const appIcon = new AppIcon(app);
            this.add_child(appIcon);
            this.appIcons.push(appIcon);

            // Add chain to the right AppIcon except for the last AppIcon
            if (idx >= apps.length - 1)
                return;

            // Chain
            const chain = new St.Icon({
                gicon: icon,
                icon_size: 18
            });
            this.add_child(chain);
            this.chainIcons.push(chain);
        });

        if (!this.appIcons.length) {
            this.emit('all-icons-removed');
            return;
        }

        this.label = this.appIcons[0].label;
    }

    // Remove an AppIcon to the corresponding app.
    // This doesn't update cached window list!
    removeApp(app) {
        for (let i = this.appIcons.length - 1; i >= 0; i--) {
            const appIcon = this.appIcons[i];
            if (appIcon.app !== app)
                continue;

            this.appIcons.splice(i, 1);
            appIcon.destroy();
            const chain = this.chainIcons.splice(Math.max(0, i - 1), 1)[0];
            chain?.destroy();
        }

        if (!this.appIcons.length)
            this.emit('all-icons-removed');
    }
});

const AppIcon = GObject.registerClass(
class AppIcon extends AltTab.AppIcon {
    // Don't make the SwitcherButtons squares since 1 SwitcherButton
    // may contain multiple AppIcons for a tileGroup.
    vfunc_get_preferred_width() {
        return this.get_preferred_height(-1);
    }
});
