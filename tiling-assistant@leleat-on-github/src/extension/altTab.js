'use strict';

const { altTab: AltTab, main: Main, switcherPopup: SwitcherPopup } = imports.ui;
const { Gio, GLib, GObject, Meta, Shell, St } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Settings } = Me.imports.src.common;
const Util = Me.imports.src.extension.utility.Util;

/**
 * Optionally, override GNOME's altTab / appSwitcher to group tileGroups
 */
var Override = class AltTabOverride {
    constructor() {
        this._originalAltTab = AltTab.AppSwitcherPopup;

        if (Settings.getBoolean(Settings.TILEGROUPS_IN_APP_SWITCHER))
            AltTab.AppSwitcherPopup = TilingAppSwitcherPopup;

        Settings.changed(Settings.TILEGROUPS_IN_APP_SWITCHER, () => {
            AltTab.AppSwitcherPopup = Settings.getBoolean(Settings.TILEGROUPS_IN_APP_SWITCHER)
                ? TilingAppSwitcherPopup
                : this._originalAltTab;
        });
    }

    destroy() {
        AltTab.AppSwitcherPopup = this._originalAltTab;
    }
};

const TilingAppSwitcherPopup = GObject.registerClass(
class TilingAppSwitcherPopup extends AltTab.AppSwitcherPopup {
    _init() {
        SwitcherPopup.SwitcherPopup.prototype._init.call(this);

        this._thumbnails = null;
        this._thumbnailTimeoutId = 0;
        this._currentWindow = -1;

        this.thumbnailsVisible = false;

        this._switcherList = new TilingAppSwitcher(this);
        this._items = this._switcherList.icons;
    }

    // Called when closing an entire app / tileGroup
    _quitApplication(index) {
        const item = this._items[index];
        if (!item)
            return;

        item.cachedWindows.forEach(w => w.delete(global.get_current_time()));
        item.cachedWindows = [];
        this._switcherList._removeIcon(item); // tileGroups
    }

    // Called when closing a window with the thumbnail switcher
    _windowRemoved(thumbnailSwitcher, n) {
        const item = this._items[this._selectedIndex];
        if (!item)
            return;

        if (item.cachedWindows.length) {
            const newIndex = Math.min(n, item.cachedWindows.length - 1);
            this._select(this._selectedIndex, newIndex);

            // Update AppIcons for tileGroups with multiple AppIcons
            const winTracker = Shell.WindowTracker.get_default();
            const apps = item.cachedWindows.map(w => winTracker.get_window_app(w));
            const uniqueApps = [...new Set(apps)];
            for (let i = item.appIcons.length - 1; i >= 0; i--) {
                if (!uniqueApps.includes(item.appIcons[i].app)) {
                    item.appIcons[i].destroy();
                    item.appIcons.splice(i, 1);
                    item.chains[Math.max(0, i - 1)].destroy();
                    item.chains.splice(Math.max(0, i - 1), 1);
                }
            }
        }
    }
});

const TilingAppSwitcher = GObject.registerClass(
class TilingAppSwitcher extends AltTab.AppSwitcher {
    _init(altTabPopup) {
        // Don't make the SwitcherButtons squares since 1 SwitcherButton
        // may contain multiple AppIcons for a tileGroup.
        const squareItems = false;
        SwitcherPopup.SwitcherList.prototype._init.call(this, squareItems);

        this.icons = [];
        this._arrows = [];
        this._curApp = -1;
        this._apps = [];
        this._altTabPopup = altTabPopup;
        this._mouseTimeOutId = 0;

        const settings = new Gio.Settings({ schema_id: 'org.gnome.shell.app-switcher' });
        const workspace = settings.get_boolean('current-workspace-only')
            ? global.workspace_manager.get_active_workspace()
            : null;
        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
        const winTracker = Shell.WindowTracker.get_default();

        // Group windows based on their tileGroup, if tileGroup.length > 1.
        // Otherwise group them based on their respective apps.
        const groupedWindows = allWindows.reduce((allGroups, w) => {
            for (const group of allGroups) {
                if (w.isTiled && Util.getTileGroupFor(w).length > 1) {
                    if (Util.getTileGroupFor(w).includes(group[0])) {
                        group.push(w);
                        return allGroups;
                    }
                } else if ((!group[0].isTiled || group[0].isTiled && Util.getTileGroupFor(group[0]).length <= 1) &&
                         winTracker.get_window_app(group[0]) === winTracker.get_window_app(w)) {
                    group.push(w);
                    return allGroups;
                }
            }

            const newGroup = [w];
            allGroups.push(newGroup);
            return allGroups;
        }, []);

        // Construct the AppIcons and add them to the popup.
        groupedWindows.forEach(group => {
            const item = new AppSwitcherItem(group);
            this._addIcon(item);
        });

        // Listen for the app stop state in case the app got closed outside
        // of the app switcher along with closing via the app switcher
        const allApps = allWindows.map(w => winTracker.get_window_app(w));
        this._apps = [...new Set(allApps)];
        this._stateChangedIds = this._apps.map(app => app.connect('notify::state', () => {
            if (app.state !== Shell.AppState.RUNNING) {
                const index = this.icons.findIndex(icon => {
                    // TODO: Doesn't work for tileGroups...
                    // Currently, we just manually remove the tileGroup in
                    // _appSwitcherPopupQuitApplication()
                    return icon.appIcons.every(appIcon => appIcon.app === app);
                });
                if (index === -1)
                    return;

                this._removeIcon(this.icons[index]);
            }
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
const AppSwitcherItem = GObject.registerClass(
class AppSwitcherItem extends St.BoxLayout {
    _init(windows) {
        super._init({ vertical: false });

        const winTracker = Shell.WindowTracker.get_default();

        this.cachedWindows = windows;
        this.appIcons = [];
        this.chains = [];
        const uniqueApps = windows.reduce((apps, w) => {
            const a = winTracker.get_window_app(w);
            !apps.includes(a) && apps.push(a);
            return apps;
        }, []);
        uniqueApps.forEach((app, idx) => {
            // AppIcon
            const appIcon = new AppIcon(app);
            this.add_child(appIcon);
            this.appIcons.push(appIcon);

            if (idx >= uniqueApps.length - 1)
                return;

            // Chain icon
            const path = Me.dir.get_child('media/insert-link-symbolic.svg').get_path();
            const chain = new St.Icon({
                gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(path) }),
                icon_size: 18
            });
            this.add_child(chain);
            this.chains.push(chain);
        });

        // Compatibility with AltTab.AppIcon
        this.set_size = size => this.appIcons.forEach(i => i.set_size(size));
        this.label = this.appIcons[0].label;
        this.app = {
            // Only raise the first window since we split up apps and tileGroups
            activate_window: (window, timestamp) => {
                Main.activateWindow(this.cachedWindows[0], timestamp);
            },
            // Listening to the app-stop now happens in the custom _init func
            connect: () => {}
        };
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
