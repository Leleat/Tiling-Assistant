import { Clutter, GObject, Meta, St } from '../dependencies/gi.js';
import { _, Main } from '../dependencies/shell.js';

import { Direction, Orientation, Settings } from '../common.js';
import { Rect, Util } from './utility.js';
import { TilingWindowManager as Twm } from './tilingWindowManager.js';

const SCALE_SIZE = 100;
const Modes = {
    DEFAULT: 1,
    SWAP: 2,
    RESIZE: 4,
    MOVE: 8,
    CLOSE: 16
};

/**
 * Classes for the 'Tile Editing Mode'. A mode to manage your tiled windows
 * with your keyboard (and only the keyboard). The Tile Editor gets instanced
 * as soon as the keyboard shortcut is activated. The Handler classes are
 * basically modes / states for the Tile Editor each with a 'on key press' and
 * 'on key released' function.
 */

export const TileEditor = GObject.registerClass(
class TileEditingMode extends St.Widget {
    _init() {
        super._init({ reactive: true });

        this._haveModal = false;
        // The windows managed by the Tile Editor, that means the tiled windows
        // that aren't overlapped by other windows; in other words: the top tile Group
        this._windows = [];
        // Indicate the active selection by the user. Added to `this`.
        this._selectIndicator = null;
        this._mode = Modes.DEFAULT;
        // Handler of keyboard events depending on the mode.
        this._keyHandler = null;

        Main.uiGroup.add_child(this);

        this.connect('key-press-event', (__, event) =>
            this._onKeyPressEvent(event));
    }

    open() {
        this._windows = Twm.getTopTileGroup();

        const grab = Main.pushModal(this);
        // We expect at least a keyboard grab here
        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            return false;
        }

        this._grab = grab;
        this._haveModal = true;

        const openWindows = Twm.getWindows();
        if (!openWindows.length || !this._windows.length) {
            // Translators: This is a notification that pops up if the user tries to enter the Tile Editing Mode via a keyboard shortcut.
            const msg = _("Can't enter 'Tile Editing Mode', if no tiled window is visible.");
            Main.notify('Tiling Assistant', msg);
            this.close();
            return;
        }

        this.monitor = this._windows[0].get_monitor();
        const display = global.display.get_monitor_geometry(this.monitor);
        this.set_position(display.x, display.y);
        this.set_size(display.width, display.height);

        // Enter initial state.
        this._mode = Modes.DEFAULT;
        this._keyHandler = new DefaultKeyHandler(this);

        // The windows may not be at the foreground. They just weren't
        // overlapping other windows. So raise the entire tile group.
        this._windows.forEach(w => {
            if (w.raise_and_make_recent_on_workspace)
                w.raise_and_make_recent_on_workspace(global.workspace_manager.get_active_workspace());
            else
                w.raise_and_make_recent();
        });

        // Create the active selection indicator.
        const window = this._windows[0];
        const params = { style_class: 'tile-preview' };
        this._selectIndicator = new Indicator(window.tiledRect, this.monitor, params);
        this._selectIndicator.focus(window.tiledRect, window);
        this.add_child(this._selectIndicator);
    }

    close() {
        if (this._haveModal) {
            Main.popModal(this._grab);
            this._haveModal = false;
        }

        this._windows = [];
        this._keyHandler = null;

        // this._selectIndicator may be undefined, if Tile Editing Mode is
        // left as soon as it's entered (e. g. when there's no tile group).
        this._selectIndicator?.window?.activate(global.get_current_time());
        this._selectIndicator?.ease({
            x: this._selectIndicator.x + SCALE_SIZE / 2,
            y: this._selectIndicator.y + SCALE_SIZE / 2,
            width: this._selectIndicator.width - SCALE_SIZE,
            height: this._selectIndicator.height - SCALE_SIZE,
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.destroy()
        }) ?? this.destroy();
    }

    vfunc_button_press_event() {
        this._keyHandler.prepareLeave();
        this.close();
    }

    async _onKeyPressEvent(keyEvent) {
        const mods = keyEvent.get_state();
        let newMode;

        // Swap windows
        if (mods & Clutter.ModifierType.CONTROL_MASK)
            newMode = Modes.SWAP;
        // Move group to different workspace / monitor
        else if (mods & Clutter.ModifierType.SHIFT_MASK)
            newMode = Modes.MOVE;
        // Resize windows
        else if (mods & Clutter.ModifierType.MOD4_MASK)
            newMode = Modes.RESIZE;
        // Default keys
        else
            newMode = Modes.DEFAULT;

        // First switch mode, if a new mod is pressed.
        if (newMode !== this._mode)
            this._switchMode(newMode);

        // Handle the key press and get mode depending on that.
        newMode = await this._keyHandler.handleKeyPress(keyEvent);

        if (newMode && newMode !== this._mode)
            this._switchMode(newMode);
    }

    vfunc_key_release_event(keyEvent) {
        const newMode = this._keyHandler.handleKeyRelease(keyEvent);
        if (newMode && newMode !== this._mode)
            this._switchMode(newMode);
    }

    _switchMode(newMode) {
        if (!newMode)
            return;

        this._mode = newMode;
        this._keyHandler.prepareLeave();

        switch (newMode) {
            case Modes.DEFAULT:
                this._keyHandler = new DefaultKeyHandler(this);
                break;
            case Modes.SWAP:
                this._keyHandler = new SwapKeyHandler(this);
                break;
            case Modes.MOVE:
                this._keyHandler = new MoveKeyHandler(this);
                break;
            case Modes.RESIZE:
                this._keyHandler = new ResizeKeyHandler(this);
                break;
            case Modes.CLOSE:
                this.close();
        }
    }
});

/**
 * Indicate the user selection or other stuff.
 */
const Indicator = GObject.registerClass(class TileEditingModeIndicator extends St.Widget {
    /**
     * @param {string} widgetParams
     * @param {Rect} rect the final rect / pos of the indicator
     * @param {number} monitor
     */
    _init(rect, monitor, widgetParams = {}) {
        // Start from a scaled down position.
        super._init({
            ...widgetParams,
            x: rect.x + SCALE_SIZE / 2,
            y: rect.y + SCALE_SIZE / 2,
            width: rect.width - SCALE_SIZE,
            height: rect.height - SCALE_SIZE,
            opacity: 0
        });

        this.rect = null;
        this.window = null;
        this._monitor = monitor;
    }

    /**
     * Animate the indicator to a specific position.
     *
     * @param {Rect} rect the position the indicator will animate to.
     * @param {Meta.Window|null} window the window at `rect`'s position.
     */
    focus(rect, window = null) {
        const display = global.display.get_monitor_geometry(this._monitor);
        const activeWs = global.workspace_manager.get_active_workspace();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(this._monitor));

        // Adjusted for window / screen gaps
        const { x, y, width, height } = rect.addGaps(workArea);

        this.ease({
            x: x - display.x,
            y: y - display.y,
            width,
            height,
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
    async handleKeyPress(keyEvent) {
        const keyVal = keyEvent.get_key_symbol();

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
            const tileRect = Twm.getBestFreeRect(tiledRect, { currRect: window.tiledRect });
            if (window.tiledRect.equal(tileRect))
                return Modes.DEFAULT;

            const workArea = window.get_work_area_current_monitor();
            const maximize = tileRect.equal(workArea);
            if (maximize && this._windows.length > 1)
                return Modes.DEFAULT;

            Twm.tile(window, tileRect, { openTilingPopup: false });

            if (maximize)
                return Modes.CLOSE;

            this._selectIndicator.focus(window.tiledRect, window);

        // [C]ycle through halves of the available space around the window
        } else if (keyVal === Clutter.KEY_c || keyVal === Clutter.KEY_C) {
            const window = this._selectIndicator.window;
            if (!window)
                return Modes.DEFAULT;

            const tiledRects = this._windows.map(w => w.tiledRect);
            const fullRect = Twm.getBestFreeRect(tiledRects, { currRect: window.tiledRect });
            const topHalf = fullRect.getUnitAt(0, fullRect.height / 2, Orientation.H);
            const rightHalf = fullRect.getUnitAt(1, fullRect.width / 2, Orientation.V);
            const bottomHalf = fullRect.getUnitAt(1, fullRect.height / 2, Orientation.H);
            const leftHalf = fullRect.getUnitAt(0, fullRect.width / 2, Orientation.V);
            const rects = [topHalf, rightHalf, bottomHalf, leftHalf];
            const currIdx = rects.findIndex(r => r.equal(window.tiledRect));
            const newIndex = (currIdx + 1) % 4;

            Twm.tile(window, rects[newIndex], { openTilingPopup: false });
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
            Twm.untile(window);
            if (!this._windows.length)
                return Modes.CLOSE;

            // Re-raise tile group, so it isn't below the just-untiled window
            if (this._windows[0].raise_and_make_recent_on_workspace)
                this._windows[0].raise_and_make_recent_on_workspace(global.workspace_manager.get_active_workspace());
            else
                this._windows[0].raise_and_make_recent();
            this._selectIndicator.focus(selectedRect, null);

        // [Enter] / [Esc]ape Tile Editing Mode
        } else if (keyVal === Clutter.KEY_Escape || keyVal === Clutter.KEY_Return) {
            return Modes.CLOSE;

        // [Space] to activate the Tiling Popup
        } else if (keyVal === Clutter.KEY_space) {
            const allWs = Settings.getBoolean('tiling-popup-all-workspace');
            const openWindows = Twm.getWindows(allWs).filter(w => !this._windows.includes(w));
            const TilingPopup = await import('./tilingPopup.js');
            const tilingPopup = new TilingPopup.TilingSwitcherPopup(
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
                const replaced = this._windows.findIndex(w => w.tiledRect.equal(tiledWindow.tiledRect));
                replaced !== -1 && this._windows.splice(replaced, 1);

                // Create the new tile group to allow 1 window to be part of multiple tile groups
                Twm.updateTileGroup([tiledWindow, ...this._windows]);

                this._windows.unshift(tiledWindow);
                this._selectIndicator.focus(tiledWindow.tiledRect, tiledWindow);
            });
        }

        return Modes.DEFAULT;
    }

    /**
     * Automatically called on a keyEvent.
     *
     * @param {number} keyEvent
     * @returns {Modes|undefined} The mode to enter after the event was handled.
     */
    handleKeyRelease() {
        return undefined;
    }

    /**
     * Move the the selection indicator towards direction of `dir`.
     *
     * @param {Direction} dir
     */
    _focusInDir(dir) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(this._tileEditor.monitor));
        const tiledRects = this._windows.map(w => w.tiledRect);
        const screenRects = tiledRects.concat(workArea.minus(tiledRects));
        const nearestRect = this._selectIndicator.rect.getNeighbor(dir, screenRects);
        if (!nearestRect)
            return;

        const newWindow = this._windows.find(w => w.tiledRect.equal(nearestRect));
        this._selectIndicator.focus(newWindow?.tiledRect ?? nearestRect, newWindow);
    }

    get _windows() {
        return this._tileEditor._windows;
    }

    get _selectIndicator() {
        return this._tileEditor._selectIndicator;
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
        const color = this._selectIndicator.get_theme_node().get_background_color();
        const { red, green, blue, alpha } = color;
        this._anchorIndicator = new Indicator(this._selectIndicator.rect, tileEditor.monitor, {
            style: `background-color: rgba(${red}, ${green}, ${blue}, ${alpha / 255})`
        });
        this._anchorIndicator.focus(this._selectIndicator.rect, this._selectIndicator.window);
        this._tileEditor.add_child(this._anchorIndicator);
    }

    prepareLeave() {
        this._anchorIndicator.destroy();
    }

    handleKeyPress(keyEvent) {
        const direction = Util.getDirection(keyEvent.get_key_symbol());

        // [Directions] to choose a window to swap with WASD, hjkl or arrow keys
        if (direction)
            this._focusInDir(direction);

        // [Esc]ape Tile Editing Mode
        else if (keyEvent.get_key_symbol() === Clutter.KEY_Escape)
            return Modes.DEFAULT;

        return Modes.SWAP;
    }

    handleKeyRelease(keyEvent) {
        const keyVal = keyEvent.get_key_symbol();
        const ctrlKeys = [Clutter.KEY_Control_L, Clutter.KEY_Control_R];

        if (ctrlKeys.includes(keyVal)) {
            this._swap();
            return Modes.DEFAULT;
        }

        return Modes.SWAP;
    }

    _swap() {
        if (this._anchorIndicator.window)
        { Twm.tile(this._anchorIndicator.window, this._selectIndicator.rect, {
            openTilingPopup: false
        }); }

        if (this._selectIndicator.window)
        { Twm.tile(this._selectIndicator.window, this._anchorIndicator.rect, {
            openTilingPopup: false
        }); }

        this._selectIndicator.focus(this._selectIndicator.rect,
            this._anchorIndicator.window);
    }
};

/**
 * Move the tile group to a different workspace / monitor.
 *
 * @param {TileEditingMode} tileEditor
 */
const MoveKeyHandler = class MoveKeyHandler extends DefaultKeyHandler {
    handleKeyPress(keyEvent) {
        const direction = Util.getDirection(keyEvent.get_key_symbol());
        const moveWorkspace = keyEvent.get_state() & Clutter.ModifierType.MOD1_MASK;

        // [Directions] to move the tile group
        if (direction) {
            // To new workspace
            if (moveWorkspace) {
                let metaDir = Meta.MotionDirection.UP;
                if (direction === Direction.N)
                    metaDir = Meta.MotionDirection.UP;
                else if (direction === Direction.S)
                    metaDir = Meta.MotionDirection.DOWN;
                else if (direction === Direction.W)
                    metaDir = Meta.MotionDirection.LEFT;
                else if (direction === Direction.E)
                    metaDir = Meta.MotionDirection.RIGHT;

                const activeWs = global.workspace_manager.get_active_workspace();
                const newWs = activeWs.get_neighbor(metaDir);
                if (activeWs === newWs)
                    return Modes.MOVE;

                Twm.moveGroupToWorkspace(this._tileEditor._windows, newWs);

            // To new monitor
            } else {
                let metaDir = Meta.DisplayDirection.UP;
                if (direction === Direction.N)
                    metaDir = Meta.DisplayDirection.UP;
                else if (direction === Direction.S)
                    metaDir = Meta.DisplayDirection.DOWN;
                else if (direction === Direction.W)
                    metaDir = Meta.DisplayDirection.LEFT;
                else if (direction === Direction.E)
                    metaDir = Meta.DisplayDirection.RIGHT;

                // get_current_monitor isn't accurate for our case
                const currMonitor = this._tileEditor.monitor;
                const newMonitor = global.display.get_monitor_neighbor_index(currMonitor, metaDir);
                if (newMonitor === -1)
                    return Modes.MOVE;

                Twm.moveGroupToMonitor(this._tileEditor._windows, currMonitor, newMonitor);
            }

            return Modes.CLOSE;

        // [Esc] to return to default mode
        } else if (keyEvent.get_key_symbol() === Clutter.KEY_Escape) {
            return Modes.DEFAULT;
        }

        return Modes.MOVE;
    }
};

/**
 * Handler to resize the highlighted window.
 *
 * @param {TileEditor} tileEditor
 */
const ResizeKeyHandler = class ResizeKeyHandler extends DefaultKeyHandler {
    constructor(tileEditor) {
        super(tileEditor);

        // The edge that is currently being resized.
        this._currEdge = null;
        this._resizeSideIndicator = null;
    }

    prepareLeave() {
        this._resizeSideIndicator?.destroy();
    }

    handleKeyPress(keyEvent) {
        // [Directions] to resize with WASD, hjkl or arrow keys
        const direction = Util.getDirection(keyEvent.get_key_symbol());
        if (direction) {
            const window = this._selectIndicator.window;
            if (!window)
                return Modes.DEFAULT;

            // First call: Go to an edge.
            if (!this._currEdge) {
                this._currEdge = direction;
                this._createResizeIndicator();
                return Modes.RESIZE;

            // Change resize orientation from H to V
            } else if ([Direction.N, Direction.S].includes(this._currEdge)) {
                if ([Direction.W, Direction.E].includes(direction)) {
                    this._currEdge = direction;
                    this._createResizeIndicator();
                    return Modes.RESIZE;
                }

            // Change resize orientation from V to H
            } else if ([Direction.W, Direction.E].includes(this._currEdge)) {
                if ([Direction.N, Direction.S].includes(direction)) {
                    this._currEdge = direction;
                    this._createResizeIndicator();
                    return Modes.RESIZE;
                }
            }

            this._resize(window, direction);

            // Update the selection indicator.
            this._selectIndicator.focus(window.tiledRect, window);

            // Update resize side indicator
            this._resizeSideIndicator.updatePos(window.tiledRect);

        // [Esc]ape Tile Editing Mode
        } else if (keyEvent.get_key_symbol() === Clutter.KEY_Escape) {
            return Modes.CLOSE;
        }

        return Modes.RESIZE;
    }

    handleKeyRelease(keyEvent) {
        const keyVal = keyEvent.get_key_symbol();
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
        const updateRectSize = (rect, resizeOnEdge) => {
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
                Twm.tile(w, newRect, { openTilingPopup: false });
            } else if (this._isOppositeSide(resizedRect, w.tiledRect)) {
                const newRect = w.tiledRect.copy();
                updateRectSize(newRect, Direction.opposite(this._currEdge));
                Twm.tile(w, newRect, { openTilingPopup: false });
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

    _createResizeIndicator() {
        this._resizeSideIndicator?.destroy();
        this._resizeSideIndicator = new ResizeSideIndicator(
            this._currEdge, this._selectIndicator.rect);
        Main.uiGroup.add_child(this._resizeSideIndicator);
    }
};

const ResizeSideIndicator = GObject.registerClass(
class ResizeSideIndicator extends St.Widget {
    _init(edge, activeRect) {
        const [width, height] = [Direction.N, Direction.S].includes(edge)
            ? [200, 20]
            : [20, 200];

        super._init({
            width,
            height,
            opacity: 0,
            style: 'background-color: black;\
                    border-radius: 999px;'
        });

        this._edge = edge;
        this._moveDist = 100;

        this.updatePos(activeRect);

        // Inner pill
        const innerWidth = this.width < this.height ? 4 : 75;
        const innerHeight = this.width < this.height ? 75 : 4;
        this.add_child(new St.Widget({
            x: this.width / 2 - innerWidth / 2,
            y: this.height / 2 - innerHeight / 2,
            width: innerWidth,
            height: innerHeight,
            style: 'background-color: #ebebeb;\
                    border-radius: 999px;'
        }));
    }

    destroy() {
        this.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => super.destroy()
        });
    }

    updatePos(rect) {
        let x, y;
        switch (this._edge) {
            case Direction.N:
                x = rect.center.x - this.width / 2;
                y = rect.y - this.height / 2;
                break;
            case Direction.S:
                x = rect.center.x - this.width / 2;
                y = rect.y2 - this.height / 2;
                break;
            case Direction.W:
                x = rect.x - this.width / 2;
                y = rect.center.y - this.height / 2;
                break;
            case Direction.E:
                x = rect.x2 - this.width / 2;
                y = rect.center.y - this.height / 2;
        }

        this.ease({
            x,
            y,
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
    }
});
