import { Atk, Clutter, Gio, GLib, GObject, Meta, Shell, St } from '../gi.js';
import { Main } from '../shell.js';

import * as SwitcherPopup from './switcherPopup.js';

const THUMBNAIL_DEFAULT_SIZE = 256;
const THUMBNAIL_FADE_TIME = 100; // milliseconds
const THUMBNAIL_POPUP_TIME = 500; // milliseconds

export const baseIconSizes = [96, 64, 48, 32, 22];
export const APP_ICON_HOVER_TIMEOUT = 200; // milliseconds

function _createWindowClone(window, size) {
    let [width, height] = window.get_size();
    let scale = Math.min(1.0, size / width, size / height);
    return new Clutter.Clone({
        source: window,
        width: width * scale,
        height: height * scale,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        // usual hack for the usual bug in ClutterBinLayout...
        x_expand: true,
        y_expand: true,
    });
}

export function getWindows(workspace) {
    // We ignore skip-taskbar windows in switchers, but if they are attached
    // to their parent, their position in the MRU list may be more appropriate
    // than the parent; so start with the complete list ...
    let windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace);
    // ... map windows to their parent where appropriate ...
    return windows.map(w => {
        return w.is_attached_dialog() ? w.get_transient_for() : w;
    // ... and filter out skip-taskbar windows and duplicates
    }).filter((w, i, a) => !w.skip_taskbar && a.indexOf(w) === i);
}

export const AppSwitcherPopup = GObject.registerClass(
class AppSwitcherPopup extends SwitcherPopup.SwitcherPopup {
    _init() {
        super._init();

        this._thumbnails = null;
        this._thumbnailTimeoutId = 0;
        this._currentWindow = -1;

        this.thumbnailsVisible = false;

        const apps = Shell.AppSystem.get_default().get_running();

        this._switcherList = new AppSwitcher(apps, this);
        this._items = this._switcherList.icons;
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);

        // Allocate the thumbnails
        // We try to avoid overflowing the screen so we base the resulting size on
        // those calculations
        if (this._thumbnails) {
            const childBox = this._switcherList.get_allocation_box();
            const primary = Main.layoutManager.primaryMonitor;

            const leftPadding = this.get_theme_node().get_padding(St.Side.LEFT);
            const rightPadding = this.get_theme_node().get_padding(St.Side.RIGHT);
            const bottomPadding = this.get_theme_node().get_padding(St.Side.BOTTOM);
            const hPadding = leftPadding + rightPadding;

            const icon = this._items[this._selectedIndex];
            const [posX] = icon.get_transformed_position();
            const thumbnailCenter = posX + icon.width / 2;
            const [, childNaturalWidth] = this._thumbnails.get_preferred_width(-1);
            childBox.x1 = Math.max(primary.x + leftPadding, Math.floor(thumbnailCenter - childNaturalWidth / 2));
            if (childBox.x1 + childNaturalWidth > primary.x + primary.width - hPadding) {
                const offset = childBox.x1 + childNaturalWidth - primary.width + hPadding;
                childBox.x1 = Math.max(primary.x + leftPadding, childBox.x1 - offset - hPadding);
            }

            const spacing = this.get_theme_node().get_length('spacing');

            childBox.x2 = childBox.x1 +  childNaturalWidth;
            if (childBox.x2 > primary.x + primary.width - rightPadding)
                childBox.x2 = primary.x + primary.width - rightPadding;
            childBox.y1 = this._switcherList.allocation.y2 + spacing;
            this._thumbnails.addClones(primary.y + primary.height - bottomPadding - childBox.y1);
            const [, childNaturalHeight] = this._thumbnails.get_preferred_height(-1);
            childBox.y2 = childBox.y1 + childNaturalHeight;
            this._thumbnails.allocate(childBox);
        }
    }

    _initialSelection(backward, binding) {
        if (binding === 'switch-group') {
            if (backward)
                this._select(0, this._items[0].cachedWindows.length - 1);
            else if (this._items[0].cachedWindows.length > 1)
                this._select(0, 1);
            else
                this._select(0, 0);
        } else if (binding === 'switch-group-backward') {
            this._select(0, this._items[0].cachedWindows.length - 1);
        } else if (binding === 'switch-applications-backward') {
            this._select(this._items.length - 1);
        } else if (this._items.length === 1) {
            this._select(0);
        } else if (backward) {
            this._select(this._items.length - 1);
        } else {
            this._select(1);
        }
    }

    _nextWindow() {
        // We actually want the second window if we're in the unset state
        if (this._currentWindow === -1)
            this._currentWindow = 0;
        return SwitcherPopup.mod(
            this._currentWindow + 1,
            this._items[this._selectedIndex].cachedWindows.length);
    }

    _previousWindow() {
        // Also assume second window here
        if (this._currentWindow === -1)
            this._currentWindow = 1;
        return SwitcherPopup.mod(
            this._currentWindow - 1,
            this._items[this._selectedIndex].cachedWindows.length);
    }

    _closeAppWindow(appIndex, windowIndex) {
        const appIcon = this._items[appIndex];
        if (!appIcon)
            return;

        const window = appIcon.cachedWindows[windowIndex];
        if (!window)
            return;

        window.delete(global.get_current_time());
    }

    _quitApplication(appIndex) {
        const appIcon = this._items[appIndex];
        if (!appIcon)
            return;

        appIcon.app.request_quit();
    }

    _keyPressHandler(keysym, action) {
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        if (action === Meta.KeyBindingAction.SWITCH_GROUP) {
            if (!this._thumbnailsFocused)
                this._select(this._selectedIndex, 0);
            else
                this._select(this._selectedIndex, this._nextWindow());
        } else if (action === Meta.KeyBindingAction.SWITCH_GROUP_BACKWARD) {
            this._select(this._selectedIndex, this._previousWindow());
        } else if (action === Meta.KeyBindingAction.SWITCH_APPLICATIONS) {
            this._select(this._next());
        } else if (action === Meta.KeyBindingAction.SWITCH_APPLICATIONS_BACKWARD) {
            this._select(this._previous());
        } else if (keysym === Clutter.KEY_q || keysym === Clutter.KEY_Q) {
            this._quitApplication(this._selectedIndex);
        } else if (this._thumbnailsFocused) {
            if (keysym === Clutter.KEY_Left)
                this._select(this._selectedIndex, rtl ? this._nextWindow() : this._previousWindow());
            else if (keysym === Clutter.KEY_Right)
                this._select(this._selectedIndex, rtl ? this._previousWindow() : this._nextWindow());
            else if (keysym === Clutter.KEY_Up)
                this._select(this._selectedIndex, null, true);
            else if (keysym === Clutter.KEY_w || keysym === Clutter.KEY_W || keysym === Clutter.KEY_F4)
                this._closeAppWindow(this._selectedIndex, this._currentWindow);
            else
                return Clutter.EVENT_PROPAGATE;
        } else if (keysym === Clutter.KEY_Left) {
            this._select(rtl ? this._next() : this._previous());
        } else if (keysym === Clutter.KEY_Right) {
            this._select(rtl ? this._previous() : this._next());
        } else if (keysym === Clutter.KEY_Down) {
            this._select(this._selectedIndex, 0);
        } else {
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_STOP;
    }

    _scrollHandler(direction) {
        if (direction === Clutter.ScrollDirection.UP) {
            if (this._thumbnailsFocused) {
                if (this._currentWindow === 0 || this._currentWindow === -1)
                    this._select(this._previous());
                else
                    this._select(this._selectedIndex, this._previousWindow());
            } else {
                const nwindows = this._items[this._selectedIndex].cachedWindows.length;
                if (nwindows > 1)
                    this._select(this._selectedIndex, nwindows - 1);
                else
                    this._select(this._previous());
            }
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            if (this._thumbnailsFocused) {
                if (this._currentWindow === this._items[this._selectedIndex].cachedWindows.length - 1)
                    this._select(this._next());
                else
                    this._select(this._selectedIndex, this._nextWindow());
            } else {
                const nwindows = this._items[this._selectedIndex].cachedWindows.length;
                if (nwindows > 1)
                    this._select(this._selectedIndex, 0);
                else
                    this._select(this._next());
            }
        }
    }

    _itemActivatedHandler(n) {
        // If the user clicks on the selected app, activate the
        // selected window; otherwise (eg, they click on an app while
        // !mouseActive) activate the clicked-on app.
        if (n === this._selectedIndex && this._currentWindow >= 0)
            this._select(n, this._currentWindow);
        else
            this._select(n);
    }

    _windowActivated(thumbnailSwitcher, n) {
        const appIcon = this._items[this._selectedIndex];
        Main.activateWindow(appIcon.cachedWindows[n]);
        this.fadeAndDestroy();
    }

    _windowEntered(thumbnailSwitcher, n) {
        if (!this.mouseActive)
            return;

        this._select(this._selectedIndex, n);
    }

    _windowRemoved(thumbnailSwitcher, n) {
        const appIcon = this._items[this._selectedIndex];
        if (!appIcon)
            return;

        if (appIcon.cachedWindows.length > 0) {
            const newIndex = Math.min(n, appIcon.cachedWindows.length - 1);
            this._select(this._selectedIndex, newIndex);
        }
    }

    _finish(timestamp) {
        const appIcon = this._items[this._selectedIndex];
        if (this._currentWindow < 0)
            appIcon.app.activate_window(appIcon.cachedWindows[0], timestamp);
        else if (appIcon.cachedWindows[this._currentWindow])
            Main.activateWindow(appIcon.cachedWindows[this._currentWindow], timestamp);

        super._finish(timestamp);
    }

    _onDestroy() {
        if (this._thumbnailTimeoutId !== 0)
            GLib.source_remove(this._thumbnailTimeoutId);

        super._onDestroy();
    }

    _isActorOutside(actor) {
        return super._isActorOutside(actor) &&
               !this._thumbnails?.contains(actor);
    }

    /**
     * _select:
     *
     * @param {number} app index of the app to select
     * @param {number} [window] index of which of `app`'s windows to select
     * @param {boolean} [forceAppFocus] optional flag, see below
     *
     * Selects the indicated `app`, and optional `window`, and sets
     * this._thumbnailsFocused appropriately to indicate whether the
     * arrow keys should act on the app list or the thumbnail list.
     *
     * If `app` is specified and `window` is unspecified or %null, then
     * the app is highlighted (ie, given a light background), and the
     * current thumbnail list, if any, is destroyed. If `app` has
     * multiple windows, and `forceAppFocus` is not %true, then a
     * timeout is started to open a thumbnail list.
     *
     * If `app` and `window` are specified (and `forceAppFocus` is not),
     * then `app` will be outlined, a thumbnail list will be created
     * and focused (if it hasn't been already), and the `window`'th
     * window in it will be highlighted.
     *
     * If `app` and `window` are specified and `forceAppFocus` is %true,
     * then `app` will be highlighted, and `window` outlined, and the
     * app list will have the keyboard focus.
     */
    _select(app, window, forceAppFocus) {
        if (app !== this._selectedIndex || window == null) {
            if (this._thumbnails)
                this._destroyThumbnails();
        }

        if (this._thumbnailTimeoutId !== 0) {
            GLib.source_remove(this._thumbnailTimeoutId);
            this._thumbnailTimeoutId = 0;
        }

        this._thumbnailsFocused = (window != null) && !forceAppFocus;

        this._selectedIndex = app;
        this._currentWindow = window ? window : -1;
        this._switcherList.highlight(app, this._thumbnailsFocused);

        if (window != null) {
            if (!this._thumbnails)
                this._createThumbnails();
            this._currentWindow = window;
            this._thumbnails.highlight(window, forceAppFocus);
        } else if (this._items[this._selectedIndex].cachedWindows.length > 1 &&
                   !forceAppFocus) {
            this._thumbnailTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                THUMBNAIL_POPUP_TIME,
                this._timeoutPopupThumbnails.bind(this));
            GLib.Source.set_name_by_id(this._thumbnailTimeoutId, '[gnome-shell] this._timeoutPopupThumbnails');
        }
    }

    _timeoutPopupThumbnails() {
        if (!this._thumbnails)
            this._createThumbnails();
        this._thumbnailTimeoutId = 0;
        this._thumbnailsFocused = false;
        return GLib.SOURCE_REMOVE;
    }

    _destroyThumbnails() {
        const thumbnailsActor = this._thumbnails;
        this._thumbnails.ease({
            opacity: 0,
            duration: THUMBNAIL_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                thumbnailsActor.destroy();
                this.thumbnailsVisible = false;
            },
        });
        this._thumbnails = null;
        this._switcherList.removeAccessibleState(this._selectedIndex, Atk.StateType.EXPANDED);
    }

    _createThumbnails() {
        this._thumbnails = new ThumbnailSwitcher(this._items[this._selectedIndex].cachedWindows);
        this._thumbnails.connect('item-activated', this._windowActivated.bind(this));
        this._thumbnails.connect('item-entered', this._windowEntered.bind(this));
        this._thumbnails.connect('item-removed', this._windowRemoved.bind(this));
        this._thumbnails.connect('destroy', () => {
            this._thumbnails = null;
            this._thumbnailsFocused = false;
        });

        this.add_child(this._thumbnails);

        // Need to force an allocation so we can figure out whether we
        // need to scroll when selecting
        this._thumbnails.get_allocation_box();

        this._thumbnails.opacity = 0;
        this._thumbnails.ease({
            opacity: 255,
            duration: THUMBNAIL_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.thumbnailsVisible = true;
            },
        });

        this._switcherList.addAccessibleState(this._selectedIndex, Atk.StateType.EXPANDED);
    }
});

export const AppIcon = GObject.registerClass(
class AppIcon extends St.BoxLayout {
    _init(app) {
        super._init({
            style_class: 'alt-tab-app',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this.app = app;
        this.icon = null;
        this._iconBin = new St.Bin();

        this.add_child(this._iconBin);
        this.label = new St.Label({
            text: this.app.get_name(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
    }

    set_size(size) {
        this.icon = this.app.create_icon_texture(size);
        this._iconBin.child = this.icon;
    }
});

const AppSwitcher = GObject.registerClass(
class AppSwitcher extends SwitcherPopup.SwitcherList {
    _init(apps, altTabPopup) {
        super._init(true);

        this.icons = [];
        this._arrows = [];

        const windowTracker = Shell.WindowTracker.get_default();
        const settings = new Gio.Settings({schema_id: 'org.gnome.shell.app-switcher'});

        let workspace = null;
        if (settings.get_boolean('current-workspace-only')) {
            const workspaceManager = global.workspace_manager;

            workspace = workspaceManager.get_active_workspace();
        }

        const allWindows = getWindows(workspace);

        // Construct the AppIcons, add to the popup
        for (let i = 0; i < apps.length; i++) {
            const appIcon = new AppIcon(apps[i]);
            // Cache the window list now; we don't handle dynamic changes here,
            // and we don't want to be continually retrieving it
            appIcon.cachedWindows = allWindows.filter(
                w => windowTracker.get_window_app(w) === appIcon.app);
            if (appIcon.cachedWindows.length > 0)
                this._addIcon(appIcon);
        }

        this._altTabPopup = altTabPopup;
        this._delayedHighlighted = -1;
        this._mouseTimeOutId = 0;

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._mouseTimeOutId !== 0)
            GLib.source_remove(this._mouseTimeOutId);

        this.icons.forEach(
            icon => icon.app.disconnectObject(this));
    }

    _setIconSize() {
        let j = 0;
        while (this._items.length > 1 && this._items[j].style_class !== 'item-box')
            j++;

        const themeNode = this._items[j].get_theme_node();
        this._list.ensure_style();

        const iconPadding = themeNode.get_horizontal_padding();
        const iconBorder = themeNode.get_border_width(St.Side.LEFT) + themeNode.get_border_width(St.Side.RIGHT);
        const [, labelNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
        const iconSpacing = labelNaturalHeight + iconPadding + iconBorder;
        const totalSpacing = this._list.spacing * (this._items.length - 1);

        // We just assume the whole screen here due to weirdness happening with the passed width
        const primary = Main.layoutManager.primaryMonitor;
        const parentPadding = this.get_parent().get_theme_node().get_horizontal_padding();
        const availWidth = primary.width - parentPadding - this.get_theme_node().get_horizontal_padding();

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const iconSizes = baseIconSizes.map(s => s * scaleFactor);
        let iconSize = baseIconSizes[0];

        if (this._items.length > 1) {
            for (let i =  0; i < baseIconSizes.length; i++) {
                iconSize = baseIconSizes[i];
                const height = iconSizes[i] + iconSpacing;
                const w = height * this._items.length + totalSpacing;
                if (w <= availWidth)
                    break;
            }
        }

        this._iconSize = iconSize;

        for (let i = 0; i < this.icons.length; i++) {
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

        const contentBox = this.get_theme_node().get_content_box(box);

        const arrowHeight = Math.floor(this.get_theme_node().get_padding(St.Side.BOTTOM) / 3);
        const arrowWidth = arrowHeight * 2;

        // Now allocate each arrow underneath its item
        const childBox = new Clutter.ActorBox();
        for (let i = 0; i < this._items.length; i++) {
            const itemBox = this._items[i].allocation;
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
        const [x, y] = global.get_pointer();
        const pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
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
        const item = this.addItem(appIcon, appIcon.label);

        appIcon.app.connectObject('notify::state', app => {
            if (app.state !== Shell.AppState.RUNNING)
                this._removeIcon(app);
        }, this);

        const arrow = new St.DrawingArea({style_class: 'switcher-arrow'});
        arrow.connect('repaint', () => SwitcherPopup.drawArrow(arrow, St.Side.BOTTOM));
        this.add_child(arrow);
        this._arrows.push(arrow);

        if (appIcon.cachedWindows.length === 1)
            arrow.hide();
        else
            item.add_accessible_state(Atk.StateType.EXPANDABLE);
    }

    _removeIcon(app) {
        const index = this.icons.findIndex(icon => {
            return icon.app === app;
        });
        if (index === -1)
            return;

        this._arrows[index].destroy();
        this._arrows.splice(index, 1);

        this.icons.splice(index, 1);
        this.removeItem(index);
    }
});

const ThumbnailSwitcher = GObject.registerClass(
class ThumbnailSwitcher extends SwitcherPopup.SwitcherList {
    _init(windows) {
        super._init(false);

        this._labels = [];
        this._thumbnailBins = [];
        this._clones = [];
        this._windows = windows;

        for (let i = 0; i < windows.length; i++) {
            const box = new St.BoxLayout({
                style_class: 'thumbnail-box',
                orientation: Clutter.Orientation.VERTICAL,
            });

            const bin = new St.Bin({style_class: 'thumbnail'});

            box.add_child(bin);
            this._thumbnailBins.push(bin);

            const title = windows[i].get_title();
            const name = new St.Label({
                text: title,
                // St.Label doesn't support text-align
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._labels.push(name);
            box.add_child(name);

            this.addItem(box, name);
        }

        this.connect('destroy', this._onDestroy.bind(this));
    }

    addClones(availHeight) {
        if (!this._thumbnailBins.length)
            return;
        let totalPadding = this._items[0].get_theme_node().get_horizontal_padding() + this._items[0].get_theme_node().get_vertical_padding();
        totalPadding += this.get_theme_node().get_horizontal_padding() + this.get_theme_node().get_vertical_padding();
        const [, labelNaturalHeight] = this._labels[0].get_preferred_height(-1);
        const spacing = this._items[0].child.get_theme_node().get_length('spacing');
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const thumbnailSize = THUMBNAIL_DEFAULT_SIZE * scaleFactor;

        availHeight = Math.min(availHeight - labelNaturalHeight - totalPadding - spacing, thumbnailSize);
        let binHeight = availHeight + this._items[0].get_theme_node().get_vertical_padding() + this.get_theme_node().get_vertical_padding() - spacing;
        binHeight = Math.min(thumbnailSize, binHeight);

        for (let i = 0; i < this._thumbnailBins.length; i++) {
            const mutterWindow = this._windows[i].get_compositor_private();
            if (!mutterWindow)
                continue;

            const clone = _createWindowClone(mutterWindow, thumbnailSize);
            this._thumbnailBins[i].set_height(binHeight);
            this._thumbnailBins[i].child = clone;

            mutterWindow.connectObject('destroy',
                source => this._removeThumbnail(source, clone), this);
            this._clones.push(clone);
        }

        // Make sure we only do this once
        this._thumbnailBins = [];
    }

    _removeThumbnail(source, clone) {
        const index = this._clones.indexOf(clone);
        if (index === -1)
            return;

        this._clones.splice(index, 1);
        this._windows.splice(index, 1);
        this._labels.splice(index, 1);
        this.removeItem(index);

        if (this._clones.length > 0)
            this.highlight(SwitcherPopup.mod(index, this._clones.length));
        else
            this.destroy();
    }

    _onDestroy() {
        this._clones.forEach(
            clone => clone?.source.disconnectObject(this));
    }
});
