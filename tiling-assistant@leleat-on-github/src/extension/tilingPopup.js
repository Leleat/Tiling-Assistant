import { Clutter, GObject, Meta, St } from '../dependencies/gi.js';
import { Main, SwitcherPopup } from '../dependencies/shell.js';

import { Direction, Orientation } from '../common.js';
import { Util } from './utility.js';
import { TilingWindowManager as Twm } from './tilingWindowManager.js';
import * as AltTab from './altTab.js';

/**
 * Classes for the Tiling Popup, which opens when tiling a window
 * and there is free screen space to fill with other windows.
 * Mostly based on GNOME's altTab.js
 */

export const TilingSwitcherPopup = GObject.registerClass({
    Signals: {
        // Bool indicates whether the Tiling Popup was canceled
        // (or if a window was tiled with this popup)
        'closed': { param_types: [GObject.TYPE_BOOLEAN] }
    }
}, class TilingSwitcherPopup extends AltTab.TilingAppSwitcherPopup {
    /**
     * @param {Meta.Windows[]} openWindows an array of Meta.Windows, which this
     *      popup offers to tile.
     * @param {Rect} freeScreenRect the Rect, which the popup will tile a window
     *      to. The popup will be centered in this rect.
     * @param {boolean} allowConsecutivePopup allow the popup to create another
     *      Tiling Popup, if there is still unambiguous free screen space after
     *      this popup tiled a window.
     * @param {boolean} skipAnim
     */
    _init(openWindows, freeScreenRect, allowConsecutivePopup = true, skipAnim = false) {
        this._freeScreenRect = freeScreenRect;
        this._shadeBG = null;
        this._monitor = -1;

        SwitcherPopup.SwitcherPopup.prototype._init.call(this);

        this._thumbnails = null;
        this._thumbnailTimeoutId = 0;
        this._currentWindow = -1;
        this.thumbnailsVisible = false;
        // The window, which was tiled with the Tiling Popup after it's closed
        // or null, if the popup was closed with tiling a window
        this.tiledWindow = null;
        this._allowConsecutivePopup = allowConsecutivePopup;
        this._skipAnim = skipAnim;

        this._switcherList = new TSwitcherList(this, openWindows);
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
        this._monitor = tileGroup[0]?.get_monitor() ?? global.display.get_current_monitor();

        if (!this._items.length)
            return false;

        const grab = Main.pushModal(this);
        // We expect at least a keyboard grab here
        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            return false;
        }

        this._grab = grab;
        this._haveModal = true;

        this._switcherList.connect('item-activated', this._itemActivated.bind(this));
        this._switcherList.connect('item-entered', this._itemEntered.bind(this));
        this._switcherList.connect('item-removed', this._itemRemoved.bind(this));
        this.add_child(this._switcherList);

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
        const workArea = activeWs.get_work_area_for_monitor(this._monitor);

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
            const cbox = this._switcherList.get_allocation_box();
            const monitor = global.display.get_monitor_geometry(this._monitor);

            const leftPadd = this.get_theme_node().get_padding(St.Side.LEFT);
            const rightPadd = this.get_theme_node().get_padding(St.Side.RIGHT);
            const bottomPadding = this.get_theme_node().get_padding(St.Side.BOTTOM);
            const hPadd = leftPadd + rightPadd;

            const icon = this._items[this._selectedIndex];
            const [posX] = icon.get_transformed_position();
            const thumbnailCenter = posX + icon.width / 2;
            const [, cNatWidth] = this._thumbnails.get_preferred_width(-1);
            cbox.x1 = Math.max(monitor.x + leftPadd,
                Math.floor(thumbnailCenter - cNatWidth / 2)
            );
            if (cbox.x1 + cNatWidth > monitor.x + monitor.width - hPadd) {
                const offset = cbox.x1 + cNatWidth - monitor.width + hPadd;
                cbox.x1 = Math.max(monitor.x + leftPadd, cbox.x1 - offset - hPadd);
            }

            const spacing = this.get_theme_node().get_length('spacing');

            cbox.x2 = cbox.x1 + cNatWidth;
            if (cbox.x2 > monitor.x + monitor.width - rightPadd)
                cbox.x2 = monitor.x + monitor.width - rightPadd;
            cbox.y1 = this._switcherList.allocation.y2 + spacing;
            this._thumbnails.addClones(monitor.y + monitor.height - bottomPadding - cbox.y1);
            const [, cNatHeight] = this._thumbnails.get_preferred_height(-1);
            cbox.y2 = cbox.y1 + cNatHeight;

            this._thumbnails.allocate(cbox);
        }
    }

    vfunc_button_press_event(buttonEvent) {
        const btn = buttonEvent.get_button();
        if (btn === Clutter.BUTTON_MIDDLE || btn === Clutter.BUTTON_SECONDARY) {
            this._finish(global.get_current_time());
            return Clutter.EVENT_PROPAGATE;
        }

        return super.vfunc_button_press_event(buttonEvent);
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

    _windowActivated(thumbnailSwitcher, n) {
        const window = this._items[this._selectedIndex].cachedWindows[n];
        this._tileWindow(window);
        this.fadeAndDestroy();
    }

    _finish(timestamp) {
        const appIcon = this._items[this._selectedIndex];
        const window = appIcon.cachedWindows[Math.max(0, this._currentWindow)];
        this._tileWindow(window);
        SwitcherPopup.SwitcherPopup.prototype._finish.call(this, timestamp);
    }

    fadeAndDestroy() {
        if (this._alreadyDestroyed)
            return;

        this._alreadyDestroyed = true;

        const canceled = !this.tiledWindow;
        this.emit('closed', canceled);

        this._shadeBG?.destroy();
        this._shadeBG = null;
        super.fadeAndDestroy();
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

        // We want to activate/focus the window after it was tiled with the
        // Tiling Popup. Calling activate/focus() after tile() doesn't seem to
        // work for GNOME Terminal if it is maximized before trying to tile it.
        // It won't be tiled properly in that case for some reason... Instead
        // activate first but clear the tiling signals before so that the old
        // tile group won't be accidentally raised.
        Twm.clearTilingProps(window.get_id());
        window.activate(global.get_current_time());
        Twm.tile(window, rect, {
            monitorNr: this._monitor,
            openTilingPopup: this._allowConsecutivePopup,
            skipAnim: this._skipAnim
        });
    }

    // Dont _finish(), if no mods are pressed
    _resetNoModsTimeout() {
    }
});

const TSwitcherList = GObject.registerClass(
class TilingSwitcherList extends AltTab.TilingAppSwitcher {
    _setIconSize() {
        let j = 0;
        while (this._items.length > 1 && this._items[j].style_class !== 'item-box')
            j++;

        const themeNode = this._items[j].get_theme_node();
        this._list.ensure_style();

        const iconPadding = themeNode.get_horizontal_padding();
        const iconBorder = themeNode.get_border_width(St.Side.LEFT) +
            themeNode.get_border_width(St.Side.RIGHT);
        const [, labelNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
        const iconSpacing = labelNaturalHeight + iconPadding + iconBorder;
        const totalSpacing = this._list.spacing * (this._items.length - 1);

        const freeScreenRect = this._altTabPopup._freeScreenRect;
        const parentPadding = this.get_parent().get_theme_node().get_horizontal_padding();
        const availWidth = freeScreenRect.width - parentPadding -
            this.get_theme_node().get_horizontal_padding();

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

        for (let i = 0; i < this.icons.length; i++)
            this.icons[i].set_size(iconSize);
    }
});
