'use strict';

const { Clutter, GObject, Meta, St } = imports.gi;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Direction, Orientation, Settings } = Me.imports.src.common;
const Rect = Me.imports.src.extension.geometry.Rect;
const Util = Me.imports.src.extension.utility.Util;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

const SCALE_SIZE = 100;
const Modes = {
    DEFAULT: 1,
    SWAP: 2,
    RESIZE: 4,
    CLOSE: 16
};

/**
 * Classes for the 'Tile Editing Mode'. A mode to manage your tiled windows
 * with your keyboard (and only the keyboard). The Tile Editor gets instanced
 * as soon as the keyboard shortcut is activated. The Handler classes are
 * basically modes / states for the Tile Editor each with a 'on key press' and
 * 'on key released' function.
 */

// eslint-disable-next-line
var TileEditor = GObject.registerClass(class TileEditingMode extends St.Widget {

    _init() {
        const monitor = global.display.get_current_monitor();
        const display = global.display.get_monitor_geometry(monitor);
        super._init({
            x: display.x,
            y: display.y,
            width: display.width,
            height: display.height,
            reactive: true
        });

        this._haveModal = false;
        // The windows managed by the Tile Editor, that means the tiled windows
        // that aren't overlapped by other windows; in other words: the top tile Group
        this._windows = [];
        // The first indicator is used for indicating the active selection by
        // the user. Other indicators may be added and removed depending on the
        // current mode. For example, when swapping windows, there will be a
        // second indicator to show which window will be swapped.
        this._indicators = [];
        this._mode = Modes.DEFAULT;
        // Handler of keyboard events depending on the mode.
        this._keyHandler = null;

        Main.uiGroup.add_child(this);
    }

    open() {
        if (!Main.pushModal(this)) {
            // Probably someone else has a pointer grab, try again with keyboard
            const alreadyGrabbed = Meta.ModalOptions.POINTER_ALREADY_GRABBED;
            if (!Main.pushModal(this, { options: alreadyGrabbed })) {
                this.destroy();
                return;
            }
        }

        this._haveModal = true;
        this._windows = Util.getTopTileGroup(false);

        const openWindows = Util.getWindows();
        if (!openWindows.length || !this._windows.length) {
            const msg = _("Can't enter 'Tile Editing Mode', if no tiled window is visible.");
            Main.notify('Tiling Assistant', msg);
            this.close();
            return;
        }

        // The first window may not be tiled. It just wasn't overlapping a
        // window from the top tile group. So raise the first window of the
        // tile group to get entire tile group to the foreground.
        const window = this._windows[0];
        window.raise();

        // Create the active selection indicator.
        const styleClass = 'tile-editing-mode-select-indicator';
        const selectIndicator = new Indicator(styleClass, window.tiledRect);
        selectIndicator.focus(window.tiledRect, window);
        this._indicators.push(selectIndicator);
        this.add_child(selectIndicator);

        // Enter initial state.
        this._mode = Modes.DEFAULT;
        this._keyHandler = new DefaultKeyHandler(this);
    }

    close() {
        if (this._haveModal) {
            Main.popModal(this);
            this._haveModal = false;
        }

        this._windows = [];
        this._indicators = [];
        this._keyHandler = null;

        // this._selectIndicator may be undefined, if Tile Editing Mode is
        // left as soon as it's entered (e. g. when there's no tile group).
        this._selectIndicator?.window.activate(global.get_current_time());
        this._selectIndicator?.ease({
            x: this._selectIndicator.x + SCALE_SIZE / 2,
            y: this._selectIndicator.y + SCALE_SIZE / 2,
            width: this._selectIndicator.width - SCALE_SIZE,
            height: this._selectIndicator.height - SCALE_SIZE,
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.destroy()
        }) ?? this.destroy();
    }

    vfunc_button_press_event() {
        this.close();
    }

    vfunc_key_press_event(keyEvent) {
        const mods = keyEvent.modifier_state;
        const isCtrlPressed = mods & Clutter.ModifierType.CONTROL_MASK;
        const isSuperPressed = mods & Clutter.ModifierType.MOD4_MASK;

        let newMode;

        if (isSuperPressed)
            newMode = Modes.RESIZE;
        else if (isCtrlPressed)
            newMode = Modes.SWAP;
        else
            newMode = Modes.DEFAULT;

        if (newMode !== this._mode)
            this._switchMode(newMode);

        newMode = this._keyHandler.handleKeyPress(keyEvent);

        if (newMode !== this._mode)
            this._switchMode(newMode);
    }

    vfunc_key_release_event(keyEvent) {
        const newMode = this._keyHandler.handleKeyRelease(keyEvent);
        if (newMode !== this._mode)
            this._switchMode(newMode);
    }

    _switchMode(newMode) {
        if (!newMode)
            return;

        this._mode = newMode;

        // Remove all except the selection indicator.
        // Animate with a scale down and fade effect.
        const lastIdx = this._indicators.length - 1;
        const indicators = this._indicators.splice(1, lastIdx);
        indicators.forEach(i => {
            i.ease({
                x: i.x + SCALE_SIZE / 2,
                y: i.y + SCALE_SIZE / 2,
                width: i.width - SCALE_SIZE,
                height: i.height - SCALE_SIZE,
                opacity: 0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        });

        this._keyHandler.prepareLeave();

        switch (newMode) {
            case Modes.DEFAULT:
                this._keyHandler = new DefaultKeyHandler(this);
                break;

            case Modes.SWAP:
                this._keyHandler = new SwapKeyHandler(this);
                break;

            case Modes.RESIZE:
                this._keyHandler = new ResizeKeyHandler(this);
                break;

            case Modes.CLOSE:
                this.close();
        }
    }

    get indicators() {
        return this._indicators;
    }

    get selectIndicator() {
        return this._indicators[0];
    }

    get windows() {
        return this._windows;
    }
});

/**
 * Indicate the user selection or other stuff.
 */
const Indicator = GObject.registerClass(class TileEditingModeIndicator extends St.Widget {

    /**
     * @param {string} style_class
     * @param {Rect} pos
     */
    _init(style_class, pos) {
        // Start from a scaled down position.
        super._init({
            style_class,
            x: pos.x + SCALE_SIZE / 2,
            y: pos.y + SCALE_SIZE / 2,
            width: pos.width - SCALE_SIZE,
            height: pos.height - SCALE_SIZE,
            opacity: 0
        });

        this.rect = null;
        this.window = null;
    }

    /**
     * Animate the indicator to a specific position.
     *
     * @param {Rect} rect the position the indicator will animate to.
     * @param {Meta.Window|null} window the window at `rect`'s position.
     */
    focus(rect, window = null) {
        const gap = Settings.getInt('window-gap');
        const monitor = global.display.get_current_monitor();
        const display = global.display.get_monitor_geometry(monitor);
        const activeWs = global.workspace_manager.get_active_workspace();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));

        // We need to adjust the indicator here because if the user uses a
        // window `gap`, the tiled windows will shrink by gap / 2 on all sides,
        // so that the gap between 2 windows is 1 full gap. If the tiled windows
        // borders the workArea at the start, we shift the window by gap / 2.
        // So that the gap between 2 windows and the workArea is uniform. Same
        // goes for, if the window ends on the workArea. Adjust the indicator's
        // size accordingly.
        let xAdj = gap / 2;
        let yAdj = gap / 2;
        let widthAdj = -gap;
        let heightAdj = -gap;

        if (rect.x === workArea.x)
            xAdj += gap / 2;
        if (rect.y === workArea.y)
            yAdj += gap / 2;
        if (rect.x === workArea.x)
            widthAdj -= gap / 2;
        if (rect.x2 === workArea.x2)
            widthAdj -= gap / 2;
        if (rect.y === workArea.y)
            heightAdj -= gap / 2;
        if (rect.y2 === workArea.y2)
            heightAdj -= gap / 2;

        this.ease({
            x: rect.x - display.x + xAdj,
            y: rect.y - display.y + yAdj,
            width: rect.width + widthAdj,
            height: rect.height + heightAdj,
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        this.rect = rect;
        this.window = window;
    }
});

/**
 * Base class for other keyboard handlers and the default handler itself.
 *
 * @param {TileEditingMode} tileEditor
 */
const DefaultKeyHandler = class DefaultKeyHandler {

    constructor(tileEditor) {
        this._tileEditor = tileEditor;
    }

    /**
     * Automatically called when leaving a mode.
     */
    prepareLeave() {
    }

    /**
     * Automatically called on a keyEvent.
     *
     * @param {number} keyEvent
     * @returns {Modes} The mode to enter after the event was handled.
     */
    handleKeyPress(keyEvent) {
        const keyVal = keyEvent.keyval;

        // [Directions] to move focus with WASD, hjkl or arrow keys
        const dir = Util.getDirection(keyVal);
        if (dir) {
            this._focusInDir(dir);

        // [E]xpand to fill the available space
        } else if (keyVal === Clutter.KEY_e || keyVal === Clutter.KEY_E) {
            const window = this._selectIndicator.window;
            if (!window)
                return Modes.DEFAULT;

            const tiledRect = this._windows.map(w => w.tiledRect);
            const tileRect = Util.getBestFreeRect(tiledRect, window.tiledRect);
            if (window.tiledRect.equal(tileRect))
                return Modes.DEFAULT;

            const workArea = window.get_work_area_current_monitor();
            const maximize = tileRect.equal(workArea);
            if (maximize && this._windows.length > 1)
                return Modes.DEFAULT;

            Util.tile(window, tileRect, { openTilingPopup: false });

            if (maximize)
                return Modes.CLOSE;

            this._selectIndicator.focus(window.tiledRect, window);

        // [C]ycle through halves of the available space around the window
        } else if ((keyVal === Clutter.KEY_c || keyVal === Clutter.KEY_C)) {
            const window = this._selectIndicator.window;
            if (!window)
                return Modes.DEFAULT;

            const tiledRects = this._windows.map(w => w.tiledRect);
            const fullRect = Util.getBestFreeRect(tiledRects, window.tiledRect);
            const topHalf = fullRect.getUnitAt(0, fullRect.height / 2, Orientation.H);
            const rightHalf = fullRect.getUnitAt(1, fullRect.width / 2, Orientation.V);
            const bottomHalf = fullRect.getUnitAt(1, fullRect.height / 2, Orientation.H);
            const leftHalf = fullRect.getUnitAt(0, fullRect.width / 2, Orientation.V);
            const rects = [topHalf, rightHalf, bottomHalf, leftHalf];
            const currIdx = rects.findIndex(r => r.equal(window.tiledRect));
            const newIndex = (currIdx + 1) % 4;

            Util.tile(window, rects[newIndex], { openTilingPopup: false });
            this._selectIndicator.focus(window.tiledRect, window);

        // [Q]uit a window
        } else if (keyVal === Clutter.KEY_q || keyVal === Clutter.KEY_Q) {
            const window = this._selectIndicator.window;
            if (!window)
                return Modes.DEFAULT;

            this._windows.splice(this._windows.indexOf(window), 1);
            window.delete(global.get_current_time());
            const newWindow = this._windows[0];
            if (!newWindow)
                return Modes.CLOSE;

            this._selectIndicator.focus(newWindow.tiledRect, newWindow);

        // [R]estore a window's size
        } else if (keyVal === Clutter.KEY_r || keyVal === Clutter.KEY_R) {
            const window = this._selectIndicator.window;
            if (!window)
                return Modes.DEFAULT;

            const selectedRect = window.tiledRect.copy();
            this._windows.splice(this._windows.indexOf(window), 1);
            Util.untile(window);
            if (!this._windows.length)
                return Modes.CLOSE;

            // Re-raise tile group, so it isn't below the just-untiled window
            this._windows[0].raise();
            this._selectIndicator.focus(selectedRect, null);

        // [Esc]ape Tile Editing Mode
        } else if (keyVal === Clutter.KEY_Escape) {
            return Modes.CLOSE;

        // [Enter/Space] to activate
        } else if (keyVal === Clutter.KEY_Return || keyVal === Clutter.KEY_space) {
            // a window: quit Tile Editing Mode
            const window = this._selectIndicator.window;
            if (window) {
                return Modes.CLOSE;

            // an empty spot: open Tiling Popup
            } else {
                const notEditing = w => !this._windows.includes(w);
                const allWs = Settings.getBoolean(Settings.POPUP_ALL_WORKSPACES);
                const openWindows = Util.getWindows(allWs).filter(notEditing);
                const { TilingSwitcherPopup } = Me.imports.src.extension.tilingPopup;
                const tilingPopup = new TilingSwitcherPopup(
                    openWindows,
                    this._selectIndicator.rect,
                    false
                );

                if (!tilingPopup.show(this._windows)) {
                    tilingPopup.destroy();
                    return Modes.DEFAULT;
                }

                tilingPopup.connect('closed', (popup, canceled) => {
                    if (canceled)
                        return;

                    const { tiledWindow } = popup;
                    this._windows.unshift(tiledWindow);
                    this._selectIndicator.focus(tiledWindow.tiledRect, tiledWindow);
                });
            }
        }

        return Modes.DEFAULT;
    }

    /**
     * Automatically called on a keyEvent.
     *
     * @param {number} keyEvent
     * @returns {Modes} The mode to enter after the event was handled.
     */
    handleKeyRelease() {
        return Modes.DEFAULT;
    }

    /**
     * Move the the selection indicator towards direction of `dir`.
     *
     * @param {Direction} dir
     */
    _focusInDir(dir) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
        const tiledRects = this._windows.map(w => w.tiledRect);
        const screenRects = tiledRects.concat(workArea.minus(tiledRects));
        const nearestRect = this._selectIndicator.rect.getNeighbor(dir, screenRects);
        if (!nearestRect)
            return;

        const newWindow = this._windows.find(w => w.tiledRect.equal(nearestRect));
        this._selectIndicator.focus(newWindow?.tiledRect ?? nearestRect, newWindow);
    }

    /**
     * Create a new indicator, add it to the indicators array
     * and to the Tile Editor.
     *
     * @param {string} styleClass
     * @param {Rect} rect
     * @returns {Indicator} the newly created Indicator.
     */
    _makeIndicator(styleClass, rect) {
        const indicator = new Indicator(styleClass, rect);
        this._indicators.push(indicator);
        this._tileEditor.add_child(indicator);
        return indicator;
    }

    get _indicators() {
        return this._tileEditor.indicators;
    }

    get _windows() {
        return this._tileEditor.windows;
    }

    get _selectIndicator() {
        return this._indicators[0];
    }

    /**
     * @returns {Indicator} the first indicator after the user selection
     *      indicator. This is usually the indicator the user selected before
     *      entering a non-default mode. For example, when swapping windows.
     */
    get _anchorIndicator() {
        return this._indicators[1];
    }
};

/**
 * Move the selected window to a different position. If there is a window at
 * the new position, the 2 windows will swap their positions.
 *
 * @param {TileEditingMode} tileEditor
 */
const SwapKeyHandler = class SwapKeyHandler extends DefaultKeyHandler {

    constructor(tileEditor) {
        super(tileEditor);

        // Create an 'anchor indicator' to indicate the window that will be swapped
        const styleClass = 'tile-editing-mode-anchor-indicator';
        const indicator = this._makeIndicator(styleClass, this._selectIndicator.rect);
        indicator.focus(this._selectIndicator.rect, this._selectIndicator.window);
    }

    handleKeyPress(keyEvent) {
        const direction = Util.getDirection(keyEvent.keyval);

        // [Directions] to choose a window to swap with WASD, hjkl or arrow keys
        if (direction)
            this._focusInDir(direction);

        // [Esc]ape Tile Editing Mode
        else if (keyEvent.keyval === Clutter.KEY_Escape)
            return Modes.DEFAULT;

        return Modes.SWAP;
    }

    handleKeyRelease(keyEvent) {
        const keyVal = keyEvent.keyval;
        const ctrlKeys = [Clutter.KEY_Control_L, Clutter.KEY_Control_R];

        if (ctrlKeys.includes(keyVal)) {
            this._swap();
            return Modes.DEFAULT;
        }

        return Modes.SWAP;
    }

    _swap() {
        if (this._anchorIndicator.window)
            Util.tile(this._anchorIndicator.window, this._selectIndicator.rect, {
                openTilingPopup: false
            });

        if (this._selectIndicator.window)
            Util.tile(this._selectIndicator.window, this._anchorIndicator.rect, {
                openTilingPopup: false
            });

        this._selectIndicator.focus(this._selectIndicator.rect,
            this._anchorIndicator.window);
    }
};

const ResizeKeyHandler = class ResizeKeyHandler extends DefaultKeyHandler {

    constructor(tileEditor) {
        super(tileEditor);

        // The edge that is currently being resized.
        this._currEdge = null;
    }

    prepareLeave() {
        // Delete the resize styles.
        this._removeResizeStyle();
    }

    handleKeyPress(keyEvent) {
        // [Directions] to resize with WASD, hjkl or arrow keys
        const direction = Util.getDirection(keyEvent.keyval);
        if (direction) {
            const window = this._selectIndicator.window;
            if (!window)
                return Modes.DEFAULT;

            // First call: Go to an edge.
            if (!this._currEdge) {
                this._currEdge = direction;
                this._applyResizeStyle(direction);
                return Modes.RESIZE;

            // Change resize orientation from H to V
            } else if ([Direction.N, Direction.S].includes(this._currEdge)) {
                if ([Direction.W, Direction.E].includes(direction)) {
                    this._currEdge = direction;
                    this._applyResizeStyle(direction);
                    return Modes.RESIZE;
                }

            // Change resize orientation from V to H
            } else if ([Direction.W, Direction.E].includes(this._currEdge)) {
                if ([Direction.N, Direction.S].includes(direction)) {
                    this._currEdge = direction;
                    this._applyResizeStyle(direction);
                    return Modes.RESIZE;
                }
            }

            this._resize(window, direction);

            // Update the selection indicator.
            this._selectIndicator.focus(window.tiledRect, window);

        // [Esc]ape Tile Editing Mode
        } else if (keyEvent.keyval === Clutter.KEY_Escape) {
            return Modes.CLOSE;
        }

        return Modes.RESIZE;
    }

    handleKeyRelease(keyEvent) {
        const keyVal = keyEvent.keyval;
        const superKeys = [Clutter.KEY_Super_L, Clutter.KEY_Super_R];
        return superKeys.includes(keyVal) ? Modes.DEFAULT : Modes.RESIZE;
    }

    _resize(window, keyDir) {
        // Rect, which is being resized by the user. But it still has
        // its original / pre-resize dimensions
        const resizedRect = window.tiledRect;
        const workArea = new Rect(window.get_work_area_current_monitor());
        let resizeAmount = 50;

        // Limit resizeAmount to the workArea
        if (this._currEdge === Direction.N && keyDir === Direction.N)
            resizeAmount = Math.min(resizeAmount, resizedRect.y - workArea.y);
        else if (this._currEdge === Direction.S && keyDir === Direction.S)
            resizeAmount = Math.min(resizeAmount, workArea.y2 - resizedRect.y2);
        else if (this._currEdge === Direction.W && keyDir === Direction.W)
            resizeAmount = Math.min(resizeAmount, resizedRect.x - workArea.x);
        else if (this._currEdge === Direction.E && keyDir === Direction.E)
            resizeAmount = Math.min(resizeAmount, workArea.x2 - resizedRect.x2);

        if (resizeAmount <= 0)
            return;

        // Function to update the passed rect by the resizeAmount depending on
        // the edge that is resized. Some windows will resize on the same edge
        // as the one the user is resizing. Other windows will resize on the
        // opposite edge.
        const updateRectSize = function(rect, resizeOnEdge) {
            const growDir = keyDir === resizeOnEdge ? 1 : -1;
            switch (resizeOnEdge) {
                case Direction.N:
                    rect.y -= resizeAmount * growDir;
                    // falls through
                case Direction.S:
                    rect.height += resizeAmount * growDir;
                    break;

                case Direction.W:
                    rect.x -= resizeAmount * growDir;
                    // falls through
                case Direction.E:
                    rect.width += resizeAmount * growDir;
            }
        };

        // Actually resize the windows here.
        this._windows.forEach(w => {
            // The window, which is resized by the user, is included in this.
            if (this._isSameSide(resizedRect, w.tiledRect)) {
                const newRect = w.tiledRect.copy();
                updateRectSize(newRect, this._currEdge);
                Util.tile(w, newRect, { openTilingPopup: false });

            } else if (this._isOppositeSide(resizedRect, w.tiledRect)) {
                const newRect = w.tiledRect.copy();
                updateRectSize(newRect, Direction.opposite(this._currEdge));
                Util.tile(w, newRect, { openTilingPopup: false });
            }
        });
    }

    _isOppositeSide(rect1, rect2) {
        switch (this._currEdge) {
            case Direction.N:
                return rect1.y === rect2.y2;
            case Direction.S:
                return rect1.y2 === rect2.y;
            case Direction.W:
                return rect1.x === rect2.x2;
            case Direction.E:
                return rect1.x2 === rect2.x;
        }

        return false;
    }

    _isSameSide(rect1, rect2) {
        switch (this._currEdge) {
            case Direction.N:
                return rect1.y === rect2.y;
            case Direction.S:
                return rect1.y2 === rect2.y2;
            case Direction.W:
                return rect1.x === rect2.x;
            case Direction.E:
                return rect1.x2 === rect2.x2;
        }

        return false;
    }

    _applyResizeStyle(dir) {
        this._removeResizeStyle();

        if (dir === Direction.N)
            this._selectIndicator.add_style_class_name('tile-editing-mode-resize-top');
        if (dir === Direction.S)
            this._selectIndicator.add_style_class_name('tile-editing-mode-resize-bottom');
        if (dir === Direction.E)
            this._selectIndicator.add_style_class_name('tile-editing-mode-resize-right');
        if (dir === Direction.W)
            this._selectIndicator.add_style_class_name('tile-editing-mode-resize-left');
    }

    _removeResizeStyle() {
        this._selectIndicator.remove_style_class_name('tile-editing-mode-resize-left');
        this._selectIndicator.remove_style_class_name('tile-editing-mode-resize-right');
        this._selectIndicator.remove_style_class_name('tile-editing-mode-resize-top');
        this._selectIndicator.remove_style_class_name('tile-editing-mode-resize-bottom');
    }
};
