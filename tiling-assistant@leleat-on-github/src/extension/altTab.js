import {
    Atk,
    Clutter,
    Gio,
    GLib,
    GObject,
    Meta,
    Shell,
    St
} from '../dependencies/gi.js';
import {
    AltTab,
    Extension,
    Main,
    SwitcherPopup
} from '../dependencies/shell.js';
import {
    baseIconSizes,
    APP_ICON_HOVER_TIMEOUT
} from '../dependencies/unexported/altTab.js';

import { Settings } from '../common.js';
import { TilingWindowManager as Twm } from './tilingWindowManager.js';

/**
 * Optionally, override GNOME's altTab / appSwitcher to group tileGroups
 */
export default class AltTabOverride {
    constructor() {
        if (Settings.getBoolean('tilegroups-in-app-switcher'))
            this._overrideNativeAppSwitcher();

        this._settingsId = Settings.changed('tilegroups-in-app-switcher', () => {
            if (Settings.getBoolean('tilegroups-in-app-switcher'))
                this._overrideNativeAppSwitcher();
            else
                this._restoreNativeAppSwitcher();
        });
    }

    destroy() {
        Settings.disconnect(this._settingsId);
        this._restoreNativeAppSwitcher();
    }

    _overrideNativeAppSwitcher() {
        Main.wm.setCustomKeybindingHandler(
            'switch-applications',
            Shell.ActionMode.NORMAL,
            this._startSwitcher.bind(this)
        );
    }

    _restoreNativeAppSwitcher() {
        Main.wm.setCustomKeybindingHandler(
            'switch-applications',
            Shell.ActionMode.NORMAL,
            Main.wm._startSwitcher.bind(Main.wm)
        );
    }

    /**
     * Copy-pasta from windowManager.js. Removed unused stuff...
     *
     * @param {*} display -
     * @param {*} window -
     * @param {*} binding -
     */
    _startSwitcher(display, window, binding) {
        if (Main.wm._workspaceSwitcherPopup !== null)
            Main.wm._workspaceSwitcherPopup.destroy();

        const tabPopup = new TilingAppSwitcherPopup();

        if (!tabPopup.show(binding.is_reversed(), binding.get_name(), binding.get_mask()))
            tabPopup.destroy();
    }
}

export const TilingAppSwitcherPopup = GObject.registerClass(
class TilingAppSwitcherPopup extends AltTab.AppSwitcherPopup {
    _init() {
        SwitcherPopup.SwitcherPopup.prototype._init.call(this);

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

export const TilingAppSwitcher = GObject.registerClass(
class TilingAppSwitcher extends SwitcherPopup.SwitcherList {
    _init(altTabPopup, windows) {
        // Don't make the SwitcherButtons squares since 1 SwitcherButton
        // may contain multiple AppIcons for a tileGroup.
        super._init(false);

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
        if (Settings.getBoolean('tilegroups-in-app-switcher')) {
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

    _setIconSize() {
        let j = 0;
        while (this._items.length > 1 && this._items[j].style_class !== 'item-box')
            j++;

        let themeNode = this._items[j].get_theme_node();
        this._list.ensure_style();

        let iconPadding = themeNode.get_horizontal_padding();
        let iconBorder = themeNode.get_border_width(St.Side.LEFT) + themeNode.get_border_width(St.Side.RIGHT);
        let [, labelNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
        let iconSpacing = labelNaturalHeight + iconPadding + iconBorder;
        let totalSpacing = this._list.spacing * (this._items.length - 1);

        // We just assume the whole screen here due to weirdness happening with the passed width
        let primary = Main.layoutManager.primaryMonitor;
        let parentPadding = this.get_parent().get_theme_node().get_horizontal_padding();
        let availWidth = primary.width - parentPadding - this.get_theme_node().get_horizontal_padding();

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let iconSizes = baseIconSizes.map(s => s * scaleFactor);
        let iconSize = baseIconSizes[0];

        if (this._items.length > 1) {
            for (let i = 0; i < baseIconSizes.length; i++) {
                iconSize = baseIconSizes[i];
                let height = iconSizes[i] + iconSpacing;
                let w = height * this._items.length + totalSpacing;
                if (w <= availWidth)
                    break;
            }
        }

        this._iconSize = iconSize;

        for (let i = 0; i < this.icons.length; i++) {
            // eslint-disable-next-line eqeqeq
            if (this.icons[i].icon != null)
                break;
            this.icons[i].set_size(iconSize);
        }
    }

    vfunc_get_preferred_height(forWidth) {
        if (!this._iconSize)
            this._setIconSize();

        return super.vfunc_get_preferred_height(forWidth);
    }

    vfunc_allocate(box) {
        // Allocate the main list items
        super.vfunc_allocate(box);

        let contentBox = this.get_theme_node().get_content_box(box);

        let arrowHeight = Math.floor(this.get_theme_node().get_padding(St.Side.BOTTOM) / 3);
        let arrowWidth = arrowHeight * 2;

        // Now allocate each arrow underneath its item
        let childBox = new Clutter.ActorBox();
        for (let i = 0; i < this._items.length; i++) {
            let itemBox = this._items[i].allocation;
            childBox.x1 = contentBox.x1 + Math.floor(itemBox.x1 + (itemBox.x2 - itemBox.x1 - arrowWidth) / 2);
            childBox.x2 = childBox.x1 + arrowWidth;
            childBox.y1 = contentBox.y1 + itemBox.y2 + arrowHeight;
            childBox.y2 = childBox.y1 + arrowHeight;
            this._arrows[i].allocate(childBox);
        }
    }

    // We override SwitcherList's _onItemMotion method to delay
    // activation when the thumbnail list is open
    _onItemMotion(item) {
        if (item === this._items[this._highlighted] ||
            item === this._items[this._delayedHighlighted])
            return Clutter.EVENT_PROPAGATE;

        const index = this._items.indexOf(item);

        if (this._mouseTimeOutId !== 0) {
            GLib.source_remove(this._mouseTimeOutId);
            this._delayedHighlighted = -1;
            this._mouseTimeOutId = 0;
        }

        if (this._altTabPopup.thumbnailsVisible) {
            this._delayedHighlighted = index;
            this._mouseTimeOutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                APP_ICON_HOVER_TIMEOUT,
                () => {
                    this._enterItem(index);
                    this._delayedHighlighted = -1;
                    this._mouseTimeOutId = 0;
                    return GLib.SOURCE_REMOVE;
                });
            GLib.Source.set_name_by_id(this._mouseTimeOutId, '[gnome-shell] this._enterItem');
        } else {
            this._itemEntered(index);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _enterItem(index) {
        let [x, y] = global.get_pointer();
        let pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
        if (this._items[index].contains(pickedActor))
            this._itemEntered(index);
    }

    // We override SwitcherList's highlight() method to also deal with
    // the AppSwitcher->ThumbnailSwitcher arrows. Apps with only 1 window
    // will hide their arrows by default, but show them when their
    // thumbnails are visible (ie, when the app icon is supposed to be
    // in justOutline mode). Apps with multiple windows will normally
    // show a dim arrow, but show a bright arrow when they are
    // highlighted.
    highlight(n, justOutline) {
        if (this.icons[this._highlighted]) {
            if (this.icons[this._highlighted].cachedWindows.length === 1)
                this._arrows[this._highlighted].hide();
            else
                this._arrows[this._highlighted].remove_style_pseudo_class('highlighted');
        }

        super.highlight(n, justOutline);

        if (this._highlighted !== -1) {
            if (justOutline && this.icons[this._highlighted].cachedWindows.length === 1)
                this._arrows[this._highlighted].show();
            else
                this._arrows[this._highlighted].add_style_pseudo_class('highlighted');
        }
    }

    _addIcon(appIcon) {
        this.icons.push(appIcon);
        let item = this.addItem(appIcon, appIcon.label);

        appIcon.app.connectObject('notify::state', app => {
            if (app.state !== Shell.AppState.RUNNING)
                this._removeIcon(app);
        }, this);

        let arrow = new St.DrawingArea({ style_class: 'switcher-arrow' });
        arrow.connect('repaint', () => SwitcherPopup.drawArrow(arrow, St.Side.BOTTOM));
        this.add_child(arrow);
        this._arrows.push(arrow);

        if (appIcon.cachedWindows.length === 1)
            arrow.hide();
        else
            item.add_accessible_state(Atk.StateType.EXPANDABLE);
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
const AppSwitcherItem = GObject.registerClass({
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
        const path = Extension.lookupByURL(import.meta.url)
            .dir.get_child('media/insert-link-symbolic.svg')
            .get_path();
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
