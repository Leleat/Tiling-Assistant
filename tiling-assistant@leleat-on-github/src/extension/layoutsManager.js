import { Clutter, Gio, GObject, Meta, Shell, St } from '../dependencies/gi.js';
import {
    _,
    Extension,
    Main,
    PanelMenu,
    PopupMenu
} from '../dependencies/shell.js';

import { Layout, Settings } from '../common.js';
import { Rect, Util } from './utility.js';
import { TilingWindowManager as Twm } from './tilingWindowManager.js';

/**
 * Here are the classes to handle PopupLayouts on the shell / extension side.
 * See src/prefs/layoutsPrefs.js for more details and general info about layouts.
 * In summary, a Layout is an array of LayoutItems. A LayoutItem is a JS Object
 * and has a rect, an appId and a loopType. Only the rect is mandatory. AppId may
 * be null or a String. Same for the LoopType. If a layout is activated, we will
 * loop / step through each LayoutItem and spawn a Tiling Popup one after the
 * other for the rects and offer to tile a window to that rect. If an appId is
 * defined, instead of calling the Tiling Popup, we tile (a new Instance of)
 * the app to the rect. If a LoopType is defined, instead of going to the next
 * item / rect, we spawn a Tiling Popup on the same item / rect and all the
 * tiled windows will share that spot evenly (a la 'Master and Stack').
 *
 * Additionally, there the user can select a 'favorite' layout among the
 * PopupLayouts. That layout will then be used as an fixed alternative mode to
 * the Edge Tiling.
 */

export default class TilingLayoutsManager {
    constructor() {
        // this._items is an array of LayoutItems (see explanation above).
        // this._currItem is 1 LayoutItem. A LayoutItem's rect only hold ratios
        // from 0 - 1. this._currRect is a Rect scaled to the workArea.
        this._items = [];
        this._currItem = null;
        this._currRect = null;

        // Preview to show where the window will tile to, similar
        // to the tile preview when dnding to the screen edges
        this._rectPreview = null;

        // Keep track of the windows which were already tiled with the current
        // layout and the remaining windows. Special-case windows, which were tiled
        // within a loop since they need to be re-adjusted for each new window
        // tiled to the same spot. The looped array is cleared after each 'step' /
        // LayoutItem change.
        this._tiledWithLayout = [];
        this._tiledWithLoop = [];
        this._remainingWindows = [];

        // Bind the keyboard shortcuts for each layout and the layout searchers
        this._keyBindings = [];

        for (let i = 0; i < 20; i++) {
            this._keyBindings.push(`activate-layout${i}`);
            Main.wm.addKeybinding(
                `activate-layout${i}`,
                Settings.getGioObject(),
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL,
                this.startLayouting.bind(this, i)
            );
        }

        this._keyBindings.push('search-popup-layout');
        Main.wm.addKeybinding(
            'search-popup-layout',
            Settings.getGioObject(),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            this.openPopupSearch.bind(this)
        );

        // Add panel indicator
        this._panelIndicator = new PanelIndicator();
        Main.panel.addToStatusArea(
            'tiling-assistant@leleat-on-github',
            this._panelIndicator);
        this._settingsId = Settings.changed('show-layout-panel-indicator', () => {
            this._panelIndicator.visible = Settings.getBoolean('show-layout-panel-indicator');
        });
        this._panelIndicator.visible = Settings.getBoolean('show-layout-panel-indicator');
        this._panelIndicator.connect('layout-activated', (src, idx) => this.startLayouting(idx));
    }

    destroy() {
        Settings.disconnect(this._settingsId);
        this._finishLayouting();
        this._keyBindings.forEach(key => Main.wm.removeKeybinding(key));
        this._panelIndicator.destroy();
        this._panelIndicator = null;
    }

    /**
     * Opens a popup window so the user can activate a layout by name
     * instead of the keyboard shortcut.
     */
    openPopupSearch() {
        const layouts = Util.getLayouts();
        if (!layouts.length) {
            // Translators: This is a notification that pops up when a keyboard shortcut to activate a user-defined tiling layout is activated but no layout was defined by the user.
            Main.notify('Tiling Assistant', _('No valid layouts defined.'));
            return;
        }

        const search = new LayoutSearch(layouts);
        search.connect('item-activated', (s, index) => this.startLayouting(index));
    }

    /**
     * Starts tiling to a Popup Layout.
     *
     * @param {number} index the index of the layout we start tiling to.
     */
    startLayouting(index) {
        const layout = Util.getLayouts()?.[index];
        if (!layout)
            return;

        const allWs = Settings.getBoolean('tiling-popup-all-workspace');
        this._remainingWindows = Twm.getWindows(allWs);
        this._items = new Layout(layout).getItems();
        this._currItem = null;

        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = activeWs.get_work_area_for_monitor(monitor);
        this._rectPreview?.destroy();
        this._rectPreview = new St.Widget({
            style_class: 'tile-preview',
            opacity: 0,
            x: workArea.x + workArea.width / 2,
            y: workArea.y + workArea.height / 2
        });
        Main.layoutManager.addChrome(this._rectPreview);

        this._step();
    }

    _finishLayouting() {
        this._items = [];
        this._currItem = null;
        this._currRect = null;

        this._rectPreview?.destroy();
        this._rectPreview = null;

        this._tiledWithLayout = [];
        this._tiledWithLoop = [];
        this._remainingWindows = [];
    }

    _step(loopType = null) {
        // If we aren't looping on the current item, we need to prepare for the
        // step by getting the next item / rect. If we are looping, we stay on
        // the current item / rect and open a new Tiling Popup for that rect.
        if (!loopType) {
            // We're at the last item and not looping, so there are no more items.
            if (this._currItem === this._items.at(-1)) {
                this._finishLayouting();
                return;
            }

            const currIdx = this._items.indexOf(this._currItem);
            this._currItem = this._items[currIdx + 1];

            // Scale the item's rect to the workArea
            const activeWs = global.workspace_manager.get_active_workspace();
            const monitor = global.display.get_current_monitor();
            const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
            const rectRatios = this._currItem.rect;
            this._currRect = new Rect(
                workArea.x + Math.floor(rectRatios.x * workArea.width),
                workArea.y + Math.floor(rectRatios.y * workArea.height),
                Math.ceil(rectRatios.width * workArea.width),
                Math.ceil(rectRatios.height * workArea.height)
            );

            // Try to compensate possible rounding errors when scaling up the
            // rect by aligning it with the rects, which were already tiled
            // using this layout and the workArea.
            this._tiledWithLayout.forEach(w => this._currRect.tryAlignWith(w.tiledRect));
            this._currRect.tryAlignWith(workArea);
        }

        const appId = this._currItem.appId;
        appId ? this._openAppTiled(appId) : this._openTilingPopup();
    }

    _openAppTiled(appId) {
        const app = Shell.AppSystem.get_default().lookup_app(appId);
        if (!app) {
            // Translators: This is a notification that pops up when a keyboard shortcut to activate a user-defined tiling layout is activated and the user attached an app to a tile so that a new instance of that app will automatically open in the tile. But that app seems to have been uninstalled since the definition of the layout.
            Main.notify('Tiling Assistant', _('Popup Layouts: App not found.'));
            this._finishLayouting();
            return;
        }

        const winTracker = Shell.WindowTracker.get_default();
        const idx = this._remainingWindows.findIndex(w => winTracker.get_window_app(w) === app);
        const window = this._remainingWindows[idx];
        idx !== -1 && this._remainingWindows.splice(idx, 1);

        if (window) {
            Twm.tile(window, this._currRect, {
                openTilingPopup: false,
                skipAnim: true
            });
        } else if (app.can_open_new_window()) {
            Twm.openAppTiled(app, this._currRect);
        }

        this._step();
    }

    async _openTilingPopup() {
        // There are no open windows left to tile using the Tiling Popup.
        // However there may be items with appIds, which we want to open.
        // So continue...
        if (!this._remainingWindows.length) {
            this._step();
            return;
        }

        // Animate the rect preview
        this._rectPreview.ease({
            x: this._currRect.x,
            y: this._currRect.y,
            width: this._currRect.width,
            height: this._currRect.height,
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        // Create the Tiling Popup
        const TilingPopup = await import('./tilingPopup.js');
        const popup = new TilingPopup.TilingSwitcherPopup(
            this._remainingWindows,
            this._currRect,
            // If this._currItem is the last item and we don't loop over it,
            // allow the Tiling Popup itself to spawn another instance of
            // a Tiling Popup, if there is free screen space.
            this._currItem === this._items.at(-1) && !this._currItem.loopType,
            true
        );
        const stacked = global.display.sort_windows_by_stacking(this._tiledWithLayout);
        const tileGroup = stacked.reverse();
        if (!popup.show(tileGroup)) {
            popup.destroy();
            this._finishLayouting();
            return;
        }

        popup.connect('closed', this._onTilingPopupClosed.bind(this));
    }

    _onTilingPopupClosed(tilingPopup, canceled) {
        if (canceled) {
            if (this._currItem.loopType) {
                this._tiledWithLoop = [];
                this._step();
            } else {
                this._finishLayouting();
            }
        } else {
            const tiledWindow = tilingPopup.tiledWindow;
            this._tiledWithLayout.push(tiledWindow);
            const i = this._remainingWindows.indexOf(tiledWindow);
            this._remainingWindows.splice(i, 1);

            // Make all windows, which were tiled during the current loop,
            // share the current rect evenly -> like the 'Stack' part of a
            // 'Master and Stack'
            if (this._currItem.loopType) {
                this._tiledWithLoop.push(tiledWindow);
                this._tiledWithLoop.forEach((w, idx) => {
                    const rect = this._currRect.copy();
                    const [pos, dimension] = this._currItem.loopType === 'h'
                        ? ['y', 'height']
                        : ['x', 'width'];
                    rect[dimension] /= this._tiledWithLoop.length;
                    rect[pos] += idx * rect[dimension];
                    Twm.tile(w, rect, { openTilingPopup: false, skipAnim: true });
                });
            }

            this._step(this._currItem.loopType);
        }
    }
}

/**
 * The GUI class for the Layout search.
 */
const LayoutSearch = GObject.registerClass({
    Signals: { 'item-activated': { param_types: [GObject.TYPE_INT] } }
}, class TilingLayoutsSearch extends St.Widget {
    _init(layouts) {
        const activeWs = global.workspace_manager.get_active_workspace();
        super._init({
            reactive: true,
            x: Main.uiGroup.x,
            y: Main.uiGroup.y,
            width: Main.uiGroup.width,
            height: Main.uiGroup.height
        });
        Main.uiGroup.add_child(this);

        const grab = Main.pushModal(this);
        // We expect at least a keyboard grab here
        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            return false;
        }

        this._grab = grab;
        this._haveModal = true;
        this._focused = -1;
        this._items = [];

        this.connect('button-press-event', () => this.destroy());

        const popup = new St.BoxLayout({
            style_class: 'switcher-list',
            vertical: true,
            width: 500
        });
        this.add_child(popup);

        const fontSize = 16;
        const entry = new St.Entry({
            style: `font-size: ${fontSize}px;\
                    border-radius: 16px;
                    margin-bottom: 12px;`,
            // Translators: This is the placeholder text for a search field.
            hint_text: ` ${_('Type to search...')}`
        });
        const entryClutterText = entry.get_clutter_text();
        entryClutterText.connect('key-press-event', this._onKeyPressed.bind(this));
        entryClutterText.connect('text-changed', this._onTextChanged.bind(this));
        popup.add_child(entry);

        this._items = layouts.map(layout => {
            const item = new SearchItem(layout._name, fontSize);
            item.connect('button-press-event', this._onItemClicked.bind(this));
            popup.add_child(item);
            return item;
        });

        if (!this._items.length) {
            this.destroy();
            return;
        }

        const monitor = global.display.get_current_monitor();
        const workArea = activeWs.get_work_area_for_monitor(monitor);
        popup.set_position(workArea.x + workArea.width / 2 - popup.width / 2,
            workArea.y + workArea.height / 2 - popup.height / 2);

        entry.grab_key_focus();
        this._focus(0);
    }

    destroy() {
        if (this._haveModal) {
            Main.popModal(this._grab);
            this._haveModal = false;
        }

        super.destroy();
    }

    _onKeyPressed(clutterText, event) {
        const keySym = event.get_key_symbol();
        if (keySym === Clutter.KEY_Escape) {
            this.destroy();
            return Clutter.EVENT_STOP;
        } else if (keySym === Clutter.KEY_Return ||
                keySym === Clutter.KEY_KP_Enter ||
                keySym === Clutter.KEY_ISO_Enter) {
            this._activate();
            return Clutter.EVENT_STOP;
        } else if (keySym === Clutter.KEY_Down) {
            this._focusNext();
            return Clutter.EVENT_STOP;
        } else if (keySym === Clutter.KEY_Up) {
            this._focusPrev();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onTextChanged(clutterText) {
        const filterText = clutterText.get_text();
        this._items.forEach(item => {
            item.text.toLowerCase().includes(filterText.toLowerCase())
                ? item.show()
                : item.hide();
        });
        const nextVisibleIdx = this._items.findIndex(item => item.visible);
        this._focus(nextVisibleIdx);
    }

    _onItemClicked(item) {
        this._focused = this._items.indexOf(item);
        this._activate();
    }

    _focusPrev() {
        this._focus((this._focused + this._items.length - 1) % this._items.length);
    }

    _focusNext() {
        this._focus((this._focused + 1) % this._items.length);
    }

    _focus(newIdx) {
        const prevItem = this._items[this._focused];
        const newItem = this._items[newIdx];
        this._focused = newIdx;

        prevItem?.remove_style_class_name('tiling-layout-search-highlight');
        newItem?.add_style_class_name('tiling-layout-search-highlight');
    }

    _activate() {
        this._focused !== -1 && this.emit('item-activated', this._focused);
        this.destroy();
    }
});

/**
 * An Item representing a Layout within the Popup Layout search.
 */
const SearchItem = GObject.registerClass(
class TilingLayoutsSearchItem extends St.Label {
    _init(text, fontSize) {
        super._init({
            // Translators: This is the text that will be displayed as the name of the user-defined tiling layout if it hasn't been given a name.
            text: `   ${text || _('Nameless layout...')}`,
            style: `font-size: ${fontSize}px;\
                text-align: left;\
                padding: 8px\
                margin-bottom: 2px`,
            reactive: true
        });
    }
});

/**
 * A panel indicator to activate and favoritize a layout.
 */
const PanelIndicator = GObject.registerClass({
    Signals: { 'layout-activated': { param_types: [GObject.TYPE_INT] } }
}, class PanelIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Layout Indicator (Tiling Assistant)');

        const path = Extension.lookupByURL(import.meta.url)
            .dir
            .get_child('media/preferences-desktop-apps-symbolic.svg')
            .get_path();
        const gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(path) });
        this.add_child(new St.Icon({
            gicon,
            style_class: 'system-status-icon'
        }));

        const menuAlignment = 0.0;
        this.setMenu(new PopupMenu.PopupMenu(this, menuAlignment, St.Side.TOP));
    }

    vfunc_event(event) {
        if (this.menu &&
            (event.type() === Clutter.EventType.TOUCH_BEGIN ||
             event.type() === Clutter.EventType.BUTTON_PRESS)
        ) {
            this._updateItems();
            this.menu.toggle();
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _updateItems() {
        this.menu.removeAll();

        const layouts = Util.getLayouts();
        if (!layouts.length) {
            // Translators: This is a placeholder text within a popup, if the user didn't define a tiling layout.
            const item = new PopupMenu.PopupMenuItem(_('No valid layouts defined.'));
            item.setSensitive(false);
            this.menu.addMenuItem(item);
        } else {
            // Update favorites with monitor count and fill with '-1', if necessary
            const tmp = Settings.getStrv('favorite-layouts');
            const count = Math.max(Main.layoutManager.monitors.length, tmp.length);
            const favorites = [...new Array(count)].map((m, monitorIndex) => {
                return tmp[monitorIndex] ?? '-1';
            });
            Settings.setStrv('favorite-layouts', favorites);

            // Create popup menu items
            layouts.forEach((layout, idx) => {
                const name = layout._name || `Layout ${idx + 1}`;
                const item = new PopupFavoriteMenuItem(name, idx);
                item.connect('activate', () => {
                    Main.overview.hide();
                    this.emit('layout-activated', idx);
                });
                item.connect('favorite-changed', this._updateItems.bind(this));
                this.menu.addMenuItem(item);
            });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsButton = new PopupMenu.PopupImageMenuItem(_('Preferences'), 'emblem-system-symbolic');
        // Center button without changing the size (for the hover highlight)
        settingsButton._icon.set_x_expand(true);
        settingsButton.label.set_x_expand(true);
        settingsButton.connect('activate',
            () => Extension.lookupByURL(import.meta.url).openPreferences());
        this.menu.addMenuItem(settingsButton);
    }
});

/**
 * A PopupMenuItem for the PopupMenu of the PanelIndicator.
 */
const PopupFavoriteMenuItem = GObject.registerClass({
    Signals: { 'favorite-changed': { param_types: [GObject.TYPE_INT] } }
}, class PopupFavoriteMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, layoutIndex) {
        super._init();

        this.add_child(new St.Label({
            text,
            x_expand: true
        }));

        const favorites = Settings.getStrv('favorite-layouts');
        Main.layoutManager.monitors.forEach((m, monitorIndex) => {
            const favoriteButton = new St.Button({
                child: new St.Icon({
                    icon_name: favorites[monitorIndex] === `${layoutIndex}` ? 'starred-symbolic' : 'non-starred-symbolic',
                    style_class: 'popup-menu-icon'
                })
            });
            this.add_child(favoriteButton);

            // Update gSetting with new Favorite (act as a toggle button)
            favoriteButton.connect('clicked', () => {
                const currFavorites = Settings.getStrv('favorite-layouts');
                currFavorites[monitorIndex] = currFavorites[monitorIndex] === `${layoutIndex}` ? '-1' : `${layoutIndex}`;
                Settings.setStrv('favorite-layouts', currFavorites);
                this.emit('favorite-changed', monitorIndex);
            });
        });
    }
});
