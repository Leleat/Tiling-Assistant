/**
 * @file This file contains a collection of classes to handle the  movement of
 * windows with a pointer grab.
 */

'use strict';

const { Clutter, GLib, GObject, Meta, St } = imports.gi;
const {
    main: Main,
    pointerWatcher: PointerWatcher,
    windowManager: GnomeShellWindowManager
} = imports.ui;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { AssistantManager } = Me.imports.src.assistantManager;
const { WindowManager } = Me.imports.src.window;
const { Point, Rect, TileMode, Timeouts } = Me.imports.src.util;

/**
 * A high level class that handles the window movement caused by a
 * pointer grab. It should only be instanced by the AssistantManager.
 */
var GrabHandler = class GrabHandler {
    /** @type {BaseMode} */
    #currMode = null;
    /** @type {GnomeShellWindowManager.TilePreview} */
    #tilePreview = null;
    /** @type {PointerWatcher.PointerWatch} */
    #pointerWatch = null;

    constructor() {
        this._grabStartSignal = global.display.connect('grab-op-begin',
            (src, metaWindow, grabOp) => this.#onGrabStarted(metaWindow, grabOp));
        this._grabEndSignal = global.display.connect('grab-op-end',
            (src, metaWindow) => this.#onGrabEnded(metaWindow));

        this.#tilePreview = new GnomeShellWindowManager.TilePreview();
    }

    destroy() {
        global.display.disconnect(this._grabStartSignal);
        global.display.disconnect(this._grabEndSignal);

        this.#tilePreview.destroy();
        this.#tilePreview = null;
    }

    /**
     * @param {Meta.Window} metaWindow
     * @param {Meta.GrabOp} grabOp
     */
    #onGrabStarted(metaWindow, grabOp) {
        if (!this.#isMoveOperation(grabOp))
            return;

        const window = WindowManager.get().getWindow(metaWindow);
        this.#watchPointerAfterItMoved(window);
    }

    /** @param {Meta.Window} metaWindow */
    #onGrabEnded(metaWindow) {
        if (!this.#isWatchingPointer())
            return;

        this.#stopWatchingPointer();

        this.#currMode.finish();
        this.#currMode.destroy();
        this.#currMode = null;

        log('\nGrab handled. Current layout:');
        const window = WindowManager.get().getWindow(metaWindow);
        window.tile?.tileGroup.tiles.forEach(tile =>
            log(tile.window?.getWmClass(), tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height));
        log('');
    }

    /**
     * Initiates the pointer watching if the pointer gets moved during the grab.
     * @param {Window} window
     */
    #watchPointerAfterItMoved(window) {
        const [initialX, initialY] = global.get_pointer();

        Timeouts.get().add({
            interval: 10,
            fn: () => {
                const isGrabbed =
                    global.display.is_grabbed?.() ?? global.display.get_grab_op();

                if (!isGrabbed)
                    return GLib.SOURCE_REMOVE;

                const [x, y] = global.get_pointer();
                const currPointerPos = new Point({ x, y });
                const movementThresholdPassed = currPointerPos.getDistance({
                    x: initialX,
                    y: initialY
                }) > 5;

                if (movementThresholdPassed) {
                    this.#startWatchingPointer(window);
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            }
        });
    }

    /**
     * Starts watching the pointer for updates.
     * @param {Window} window
     */
    #startWatchingPointer(window) {
        if (this.#isWatchingPointer())
            return;

        if (window.tile) {
            const assistantManager = AssistantManager.get();
            assistantManager.getCurrentTileGroupManager().untileWindow(window);
        }

        this.#currMode = new EdgeMode({ tilePreview: this.#tilePreview });

        const updatesPerSec = 20;
        const pointerWatcher = PointerWatcher.getPointerWatcher();
        this.#pointerWatch = pointerWatcher.addWatch(1000 / updatesPerSec,
            (x, y) => this.#onPointerUpdated(window, x, y));
    }

    /**
     * @param {Meta.GrabOp} grabOp
     * @returns {boolean}
     */
    #isMoveOperation(grabOp) {
        return [
            Meta.GrabOp.MOVING,
            Meta.GrabOp.KEYBOARD_MOVING,
            Meta.GrabOp.MOVING_UNCONSTRAINED
        ].includes(grabOp);
    }

    #isWatchingPointer() {
        return this.#pointerWatch;
    }

    #stopWatchingPointer() {
        this.#pointerWatch.remove();
        this.#pointerWatch = null;
    }

    /**
     * Is called during the pointer watching. This forwards the pointer updates
     * to the appropriate grab modes.
     * @param {Window} window
     * @param {number} x
     * @param {number} y
     */
    #onPointerUpdated(window, x, y) {
        if (this.#shouldChangeMode()) {
            this.#currMode.destroy();
            this.#currMode = this.#getNextMode();
        }

        this.#currMode.update(window, x, y);
    }

    /**
     *
     */
    #shouldChangeMode() {
        //
    }

    /**
     *
     */
    #getNextMode() {
        //
    }
};

/**
 * An interface that the different grab modes need to implement.
 * @interface BaseMode
 */
class BaseMode {
    destroy() {}
    /** Is called when the pointer position updates. */
    update() {}
    /** Is called when the grab ended. */
    finish() {}
}

/**
 * A class to handle the movement of windows to the screen edges and corners.
 * This is the default mode unless the user changed it in the preferences.
 * @implements {BaseMode}
 */
class EdgeMode extends BaseMode {
    /** @type {EdgeTilingPreviewState} */
    #currState = null;
    /** @type {GnomeShellWindowManager.TilePreview} */
    #tilePreview = null;

    /** @param {{GnomeShellWindowManager.TilePreview}} tilePreview */
    constructor({ tilePreview }) {
        super();

        this.#currState = new EdgeTilingPreviewState();
        this.#tilePreview = tilePreview;
    }

    destroy() {
        this.#currState.destroy();
        this.#currState = null;

        this.#tilePreview.close();
        this.#tilePreview = null;
    }

    /**
     * @param {Window} window
     * @param {number} pointerX
     * @param {number} pointerY
     */
    update(window, pointerX, pointerY) {
        const monitor = global.display.get_current_monitor();
        const workArea = WindowManager.get().getWorkArea(monitor);
        const triggerArea = 15;

        const pointerAtTop = pointerY <= workArea.y + triggerArea;
        const pointerAtBottom = pointerY >= workArea.y2 - triggerArea;
        const pointerAtLeft = pointerX <= workArea.x + triggerArea;
        const pointerAtRight = pointerX >= workArea.x2 - triggerArea;

        const pointerAtTopLeft = pointerAtTop && pointerAtLeft;
        const pointerAtTopRight = pointerAtTop && pointerAtRight;
        const pointerAtBottomLeft = pointerAtBottom && pointerAtLeft;
        const pointerAtBottomRight = pointerAtBottom && pointerAtRight;

        if (pointerAtTopLeft) {
            this.#updateTilePreview(TileMode.TOP | TileMode.LEFT, window);
        } else if (pointerAtTopRight) {
            this.#updateTilePreview(TileMode.TOP | TileMode.RIGHT, window);
        } else if (pointerAtBottomLeft) {
            this.#updateTilePreview(TileMode.BOTTOM | TileMode.LEFT, window);
        } else if (pointerAtBottomRight) {
            this.#updateTilePreview(TileMode.BOTTOM | TileMode.RIGHT, window);
        } else if (pointerAtTop) {
            if ([TileMode.MAXIMIZE, TileMode.TOP].includes(this.#currState.tileMode))
                return;

            this.#updateTilePreview(TileMode.MAXIMIZE, window);

            const timer = Timeouts.get().add({
                interval: 600,
                fn: () => {
                    const lastStartedTimerTimedOut =
                        timer === this._lastStartedTopEdgeTimer;

                    if (lastStartedTimerTimedOut &&
                        this.#currState?.tileMode === TileMode.MAXIMIZE
                    )
                        this.#updateTilePreview(TileMode.TOP, window);

                    return GLib.SOURCE_REMOVE;
                }
            });

            this._lastStartedTopEdgeTimer = timer;
        } else if (pointerAtBottom) {
            this.#updateTilePreview(TileMode.BOTTOM, window);
        } else if (pointerAtLeft) {
            this.#updateTilePreview(TileMode.LEFT, window);
        } else if (pointerAtRight) {
            this.#updateTilePreview(TileMode.RIGHT, window);
        } else {
            this.#updateTilePreview();
        }
    }

    finish() {
        this.#currState.tiledWindowGenerator?.next();
    }

    /**
     * @param {TileMode} tileMode
     * @param {Window} window
     */
    #updateTilePreview(tileMode, window) {
        if (this.#currState.tileMode === tileMode)
            return;

        this.#currState.destroy();

        if (tileMode) {
            const monitor = global.display.get_current_monitor();
            this.#currState = new EdgeTilingPreviewState(tileMode, window);
            this.#tilePreview.open(window, this.#currState.tile.rect, monitor);
        } else {
            this.#currState = new EdgeTilingPreviewState();
            this.#tilePreview.close();
        }
    }
}

/** A class containing data for the tile preview and the tiling operation. */
class EdgeTilingPreviewState {
    /** @type {TileMode|null} */
    tileMode = null;
    /** @type {Generator|null} */
    tiledWindowGenerator = null;
    /** @type {Tile|null} */
    tile = null;

    /**
     * @param {TileMode} tileMode
     * @param {Windwow} window
     */
    constructor(tileMode = null, window = null) {
        if (tileMode) {
            const tileGroupManager = AssistantManager.get().getCurrentTileGroupManager();
            const generator = tileGroupManager.generateTiledWindow(window, tileMode);

            this.tileMode = tileMode;
            this.tiledWindowGenerator = generator;
            this.tile = generator?.next().value;
        }
    }

    destroy() {
        this.tileMode = null;
        this.tile = null;

        try {
            this.tiledWindowGenerator?.throw('Clean up tiled window generator...');
            this.tiledWindowGenerator = null;
        } catch (error) {}
    }
}
