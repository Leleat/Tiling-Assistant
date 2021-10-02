'use strict';

const { Clutter, GObject, Meta, Shell, St } = imports.gi;
const { altTab: AltTab, main: Main, switcherPopup: SwitcherPopup } = imports.ui;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Direction, Orientation } = Me.imports.src.common;
const Util = Me.imports.src.extension.utility.Util;

/**
 * Classes for the Tiling Popup, which opens when tiling a window
 * and there is free screen space to fill with other windows.
 * Mostly based on GNOME's altTab.js
 */

var TilingSwitcherPopup = GObject.registerClass({ // eslint-disable-line no-unused-vars
    Signals: {
        // Bool indicates wether the Tiling Popup was canceled
        // (or if a window was tiled with this popup)
        'closed': { param_types: [GObject.TYPE_BOOLEAN] }
    }
}, class TilingSwitcherPopup extends SwitcherPopup.SwitcherPopup {

    /**
     * @param {Meta.Windows[]} openWindows an array of Meta.Windows, which this
     *      popup offers to tile.
     * @param {Rect} freeScreenRect the Rect, which the popup will tile a window
     *      to. The popup will be centered in this rect.
     * @param {boolean} allowConsecutivePopup allow the popup to create another
     *      Tiling Popup, if there is still unambiguous free screen space after
     *      this popup tiled a window.
     */
    _init(openWindows, freeScreenRect, allowConsecutivePopup = true) {
        this._freeScreenRect = freeScreenRect;
        this._shadeBG = null;

        super._init();

        this._thumbnails = null;
        this._thumbnailTimeoutId = 0;
        this._currentWindow = -1;
        this.thumbnailsVisible = false;
        // The window, which was tiled with the Tiling Popup after it's closed
        // or null, if the popup was closed with tiling a window
        this.tiledWindow = null;
        this._allowConsecutivePopup = allowConsecutivePopup;

        const apps = Shell.AppSystem.get_default().get_running();
        this._switcherList = new TSwitcherList(openWindows, apps, this);
        this._items = this._switcherList.icons;

        // Destroy popup when touching outside of popup
        this.connect('touch-event', () => {
            if (Meta.is_wayland_compositor())
                this.fadeAndDestroy();

            return Clutter.EVENT_PROPAGATE;
        });
    }

    /**
     * @param {Array} tileGroup an array of Meta.Windows. When the popup
     *      appears it will shade the background. These windows will won't
     *      be affected by that.
     * @returns if the popup was successfully shown.
     */
    show(tileGroup) {
        if (!this._items.length)
            return false;

        if (!Main.pushModal(this)) {
            // Probably someone else has a pointer grab, try again with keyboard
            const alreadyGrabbed = Meta.ModalOptions.POINTER_ALREADY_GRABBED;
            if (!Main.pushModal(this, { options: alreadyGrabbed }))
                return false;
        }

        this._haveModal = true;

        this._switcherList.connect('item-activated', this._itemActivated.bind(this));
        this._switcherList.connect('item-entered', this._itemEntered.bind(this));
        this._switcherList.connect('item-removed', this._itemRemoved.bind(this));
        this.add_actor(this._switcherList);

        // Need to force an allocation so we can figure out
        // whether we need to scroll when selecting
        this.visible = true;
        this.get_allocation_box();

        this._select(0);

        Main.osdWindowManager.hideAll();

        this._shadeBackground(tileGroup);
        this.opacity = 0;
        this.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        return true;
    }

    _shadeBackground(tileGroup) {
        const tiledWindow = tileGroup[0];
        const activeWs = global.workspace_manager.get_active_workspace();
        const mon = tiledWindow?.get_monitor();
        const currMon = global.display.get_current_monitor();
        const workArea = tiledWindow?.get_work_area_for_monitor(mon)
                ?? activeWs.get_work_area_for_monitor(currMon);

        this._shadeBG = new St.Widget({
            style: 'background-color : black',
            x: workArea.x,
            y: workArea.y,
            width: workArea.width,
            height: workArea.height,
            opacity: 0
        });
        global.window_group.add_child(this._shadeBG);
        this._shadeBG.ease({
            opacity: 180,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        if (!tiledWindow)
            return;

        // Clones to correctly shade the background for consecutive tiling.
        for (let i = 1; i < tileGroup.length; i++) {
            const wActor = tileGroup[i].get_compositor_private();
            const clone = new Clutter.Clone({
                source: wActor,
                x: wActor.x,
                y: wActor.y
            });
            global.window_group.add_child(clone);
            wActor.hide();
            this.connect('destroy', () => {
                wActor.show();
                clone.destroy();
            });
        }

        const tActor = tiledWindow.get_compositor_private();
        global.window_group.set_child_above_sibling(tActor, this._shadeBG);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const freeScreenRect = this._freeScreenRect;
        const childBox = new Clutter.ActorBox();

        const leftPadding = this.get_theme_node().get_padding(St.Side.LEFT);
        const rightPadding = this.get_theme_node().get_padding(St.Side.RIGHT);
        const hPadding = leftPadding + rightPadding;

        const [, childNaturalHeight] = this._switcherList.get_preferred_height(
            freeScreenRect.width - hPadding);
        const [, childNaturalWidth] = this._switcherList.get_preferred_width(childNaturalHeight);

        childBox.x1 = Math.max(freeScreenRect.x + leftPadding,
            freeScreenRect.x + Math.floor((freeScreenRect.width - childNaturalWidth) / 2));
        childBox.x2 = Math.min(freeScreenRect.x2 - rightPadding,
            childBox.x1 + childNaturalWidth);
        childBox.y1 = freeScreenRect.y + Math.floor((freeScreenRect.height - childNaturalHeight) / 2);
        childBox.y2 = childBox.y1 + childNaturalHeight;

        this._switcherList.allocate(childBox);

        if (this._thumbnails) {
            const childBox = this._switcherList.get_allocation_box();
            const focusedWindow = global.display.focus_window;
            const monitor = global.display.get_monitor_geometry(
                focusedWindow?.get_monitor() ?? global.display.get_current_monitor()
            );

            const leftPadding = this.get_theme_node().get_padding(St.Side.LEFT);
            const rightPadding = this.get_theme_node().get_padding(St.Side.RIGHT);
            const bottomPadding = this.get_theme_node().get_padding(St.Side.BOTTOM);
            const hPadding = leftPadding + rightPadding;

            const icon = this._items[this._selectedIndex];
            const [posX] = icon.get_transformed_position();
            const thumbnailCenter = posX + icon.width / 2;
            const [, childNaturalWidth] = this._thumbnails.get_preferred_width(-1);
            childBox.x1 = Math.max(monitor.x + leftPadding,
                Math.floor(thumbnailCenter - childNaturalWidth / 2)
            );
            if (childBox.x1 + childNaturalWidth > monitor.x + monitor.width - hPadding) {
                const offset = childBox.x1 + childNaturalWidth - monitor.width + hPadding;
                childBox.x1 = Math.max(monitor.x + leftPadding, childBox.x1 - offset - hPadding);
            }

            const spacing = this.get_theme_node().get_length('spacing');

            childBox.x2 = childBox.x1 + childNaturalWidth;
            if (childBox.x2 > monitor.x + monitor.width - rightPadding)
                childBox.x2 = monitor.x + monitor.width - rightPadding;
            childBox.y1 = this._switcherList.allocation.y2 + spacing;
            this._thumbnails.addClones(monitor.y + monitor.height - bottomPadding - childBox.y1);
            const [, childNaturalHeight] = this._thumbnails.get_preferred_height(-1);
            childBox.y2 = childBox.y1 + childNaturalHeight;

            this._thumbnails.allocate(childBox);
        }
    }

    vfunc_button_press_event(buttonEvent) {
        const btn = buttonEvent.button;
        if ( btn === Clutter.BUTTON_MIDDLE || btn === Clutter.BUTTON_SECONDARY) {
            this._finish(global.get_current_time());
            return Clutter.EVENT_PROPAGATE;
        }

        return super.vfunc_button_press_event(buttonEvent);
    }

    _nextWindow() {
        return AltTab.AppSwitcherPopup.prototype._nextWindow.apply(this);
    }

    _previousWindow() {
        return AltTab.AppSwitcherPopup.prototype._previousWindow.apply(this);
    }

    _keyPressHandler(keysym) {
        const moveUp = Util.isDirection(keysym, Direction.N);
        const moveDown = Util.isDirection(keysym, Direction.S);
        const moveLeft = Util.isDirection(keysym, Direction.W);
        const moveRight = Util.isDirection(keysym, Direction.E);

        if (this._thumbnailsFocused) {
            if (moveLeft)
                this._select(this._selectedIndex, this._previousWindow());
            else if (moveRight)
                this._select(this._selectedIndex, this._nextWindow());
            else if (moveUp || moveDown)
                this._select(this._selectedIndex, null, true);
            else
                return Clutter.EVENT_PROPAGATE;
        } else if (moveLeft) {
            this._select(this._previous());
        } else if (moveRight) {
            this._select(this._next());
        } else if (moveDown || moveUp) {
            this._select(this._selectedIndex, 0);
        } else {
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_STOP;
    }

    _scrollHandler(...params) {
        return AltTab.AppSwitcherPopup.prototype._scrollHandler.apply(this, params);
    }

    _itemActivatedHandler(...params) {
        return AltTab.AppSwitcherPopup.prototype._itemActivatedHandler.apply(this, params);
    }

    _itemEnteredHandler(...params) {
        return AltTab.AppSwitcherPopup.prototype._itemEnteredHandler.apply(this, params);
    }

    _windowActivated(thumbnailSwitcher, n) {
        const window = this._items[this._selectedIndex].cachedWindows[n];
        this._tileWindow(window);
        this.fadeAndDestroy();
    }

    _windowEntered(...params) {
        return AltTab.AppSwitcherPopup.prototype._windowEntered.apply(this, params);
    }

    _windowRemoved(...params) {
        return AltTab.AppSwitcherPopup.prototype._windowRemoved.apply(this, params);
    }

    _finish(timestamp) {
        const appIcon = this._items[this._selectedIndex];
        const window = appIcon.cachedWindows[Math.max(0, this._currentWindow)];
        this._tileWindow(window);
        super._finish(timestamp);
    }

    fadeAndDestroy() {
        const canceled = !this.tiledWindow;
        this.emit('closed', canceled);

        this._shadeBG?.destroy();
        this._shadeBG = null;
        super.fadeAndDestroy();
    }

    _onDestroy() {
        return AltTab.AppSwitcherPopup.prototype._onDestroy.apply(this);
    }

    _select(...params) {
        return AltTab.AppSwitcherPopup.prototype._select.apply(this, params);
    }

    _tileWindow(window) {
        let rect = this._freeScreenRect;

        // Halve the tile rect.
        // If isShiftPressed, then put the window at the top / left side;
        // if isAltPressed, then put it at the bottom / right side.
        // The orientation depends on the available screen space.
        const isShiftPressed = Util.isModPressed(Clutter.ModifierType.SHIFT_MASK);
        const isAltPressed = Util.isModPressed(Clutter.ModifierType.MOD1_MASK);
        if (isShiftPressed || isAltPressed) {
            // Prefer vertical a bit more (because screens are usually horizontal)
            const vertical = rect.width >= rect.height * 1.25;
            const size = vertical ? 'width' : 'height';
            const orientation = vertical ? Orientation.V : Orientation.H;
            const idx = isShiftPressed ? 0 : 1;
            rect = rect.getUnitAt(idx, rect[size] / 2, orientation);
        }

        this.tiledWindow = window;

        window.change_workspace(global.workspace_manager.get_active_workspace());
        window.move_to_monitor(global.display.get_current_monitor());
        Util.tile(window, rect, { openTilingPopup: this._allowConsecutivePopup });
        window.activate(global.get_current_time());
    }

    _timeoutPopupThumbnails() {
        return AltTab.AppSwitcherPopup.prototype._timeoutPopupThumbnails.apply(this);
    }

    _destroyThumbnails() {
        return AltTab.AppSwitcherPopup.prototype._destroyThumbnails.apply(this);
    }

    _createThumbnails() {
        return AltTab.AppSwitcherPopup.prototype._createThumbnails.apply(this);
    }

    // Dont _finish(), if no mods are pressed
    _resetNoModsTimeout() {
    }
});

const TSwitcherList = GObject.registerClass(class TilingSwitcherList extends SwitcherPopup.SwitcherList {

    _init(openWindows, apps, altTabPopup) {
        super._init(true);

        this.icons = [];
        this._arrows = [];

        const winTracker = Shell.WindowTracker.get_default();
        for (const app of apps) {
            const appIcon = new AltTab.AppIcon(app);
            appIcon.cachedWindows = openWindows.filter(w => {
                return winTracker.get_window_app(w) === app;
            });

            if (appIcon.cachedWindows.length)
                this._addIcon(appIcon);
        }

        this._curApp = -1;
        this._altTabPopup = altTabPopup;
        this._mouseTimeOutId = 0;

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        return AltTab.AppSwitcher.prototype._onDestroy.apply(this);
    }

    _setIconSize() {
        let j = 0;
        while (this._items.length > 1 && this._items[j].style_class != 'item-box')
            j++;

        const themeNode = this._items[j].get_theme_node();
        this._list.ensure_style();

        const iconPadding = themeNode.get_horizontal_padding();
        const iconBorder = themeNode.get_border_width(St.Side.LEFT)
            + themeNode.get_border_width(St.Side.RIGHT);
        const [, labelNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
        const iconSpacing = labelNaturalHeight + iconPadding + iconBorder;
        const totalSpacing = this._list.spacing * (this._items.length - 1);

        const freeScreenRect = this._altTabPopup._freeScreenRect;
        const parentPadding = this.get_parent().get_theme_node().get_horizontal_padding();
        const availWidth = freeScreenRect.width - parentPadding
            - this.get_theme_node().get_horizontal_padding();

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const baseIconSizes = [96, 64, 48, 32, 22];
        const iconSizes = baseIconSizes.map(s => s * scaleFactor);
        let iconSize = baseIconSizes[0];

        if (this._items.length > 1) {
            for (let i = 0; i < baseIconSizes.length; i++) {
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

    vfunc_get_preferred_height(...params) {
        return AltTab.AppSwitcher.prototype.vfunc_get_preferred_height.apply(this, params);
    }

    vfunc_allocate(...params) {
        return AltTab.AppSwitcher.prototype.vfunc_allocate.apply(this, params);
    }

    _onItemEnter(...params) {
        return AltTab.AppSwitcher.prototype._onItemEnter.apply(this, params);
    }

    _enterItem(...params) {
        return AltTab.AppSwitcher.prototype._enterItem.apply(this, params);
    }

    highlight(...params) {
        return AltTab.AppSwitcher.prototype.highlight.apply(this, params);
    }

    _addIcon(...params) {
        return AltTab.AppSwitcher.prototype._addIcon.apply(this, params);
    }

    _removeIcon(...params) {
        return AltTab.AppSwitcher.prototype._removeIcon.apply(this, params);
    }
});
