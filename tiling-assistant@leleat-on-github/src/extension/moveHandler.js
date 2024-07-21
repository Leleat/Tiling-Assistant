import { Clutter, GLib, GObject, Gio, Meta, Mtk } from '../dependencies/gi.js';
import { Main, WindowManager } from '../dependencies/shell.js';
import { WINDOW_ANIMATION_TIME } from '../dependencies/unexported/windowManager.js';

import { Orientation, MoveModes, Settings } from '../common.js';
import { Rect, Util } from './utility.js';
import { TilingWindowManager as Twm } from './tilingWindowManager.js';

/**
 * This class gets to handle the move events (grab & monitor change) of windows.
 * If the moved window is tiled at the start of the grab, untile it. This is
 * done by releasing the grab via code, resizing the window, and then restarting
 * the grab via code. On Wayland this may not be reliable. As a workaround there
 * is a setting to restore a tiled window's size on the actual grab end.
 */

export default class TilingMoveHandler {
    constructor() {
        const moveOps = [Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING];

        global.display.connectObject(
            'grab-op-begin',
            (src, window, grabOp) => {
                grabOp &= ~1024; // META_GRAB_OP_WINDOW_FLAG_UNCONSTRAINED

                if (window && moveOps.includes(grabOp))
                    this._onMoveStarted(window, grabOp);
            },
            this
        );

        global.display.connectObject(
            'window-entered-monitor',
            this._onMonitorEntered.bind(this),
            this
        );

        // Save the windows, which need to make space for the
        // grabbed window (this is for the so called 'adaptive mode'):
        // { window1: newTileRect1, window2: newTileRect2, ... }
        this._splitRects = new Map();
        // The rect the grabbed window will tile to
        // (it may differ from the tilePreview's rect)
        this._tileRect = null;

        this._favoritePreviews = [];
        this._tilePreview = new TilePreview();

        // The mouse button mod to move/resize a window may be changed to Alt.
        // So switch Alt and Super in our own prefs, if the user switched from
        // Super to Alt.
        const modKeys = [
            'move-adaptive-tiling-mod',
            'move-favorite-layout-mod',
            'ignore-ta-mod'
        ];
        const handleWindowActionKeyConflict = () => {
            const currMod = this._wmPrefs.get_string('mouse-button-modifier');

            if (currMod === '<Alt>') {
                for (const key of modKeys) {
                    const mod = Settings.getInt(key);
                    if (mod === 2) // Alt
                        Settings.setInt(key, 0);
                }
            } else if (currMod === '<Super>') {
                for (const key of modKeys) {
                    const mod = Settings.getInt(key);
                    if (mod === 4) // Super
                        Settings.setInt(key, 0);
                }
            }
        };

        this._wmPrefs = new Gio.Settings({
            schema_id: 'org.gnome.desktop.wm.preferences'
        });
        this._wmPrefs.connectObject(
            'changed::mouse-button-modifier',
            () => handleWindowActionKeyConflict(),
            this
        );
        handleWindowActionKeyConflict();
    }

    destroy() {
        this._wmPrefs.disconnectObject(this);
        this._wmPrefs = null;

        global.display.disconnectObject(this);

        this._tilePreview.destroy();

        if (this._latestMonitorLockTimerId) {
            GLib.Source.remove(this._latestMonitorLockTimerId);
            this._latestMonitorLockTimerId = null;
        }

        if (this._latestPreviewTimerId) {
            GLib.Source.remove(this._latestPreviewTimerId);
            this._latestPreviewTimerId = null;
        }

        if (this._restoreSizeTimerId) {
            GLib.Source.remove(this._restoreSizeTimerId);
            this._restoreSizeTimerId = null;
        }

        if (this._movingTimerId) {
            GLib.Source.remove(this._movingTimerId);
            this._movingTimerId = null;
        }
    }

    _onMonitorEntered(src, monitorNr, window) {
        if (this._isGrabOp)
            // Reset preview mode:
            // Currently only needed to grab the favorite layout for the new monitor.
            this._preparePreviewModeChange(this._currPreviewMode, window);
    }

    _onMoveStarted(window, grabOp) {
        // Also work with a window, which was maximized by GNOME natively
        // because it may have been tiled with this extension before being
        // maximized so we need to restore its size to pre-tiling.
        this._wasMaximizedOnStart = window.get_maximized();
        const [x, y] = global.get_pointer();

        // Try to restore the window size
        if (window.tiledRect || this._wasMaximizedOnStart) {
            let counter = 0;
            this._restoreSizeTimerId && GLib.Source.remove(this._restoreSizeTimerId);
            this._restoreSizeTimerId = GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE, 10, () => {
                if (!global.display.is_grabbed()) {
                    this._restoreSizeTimerId = null;
                    return GLib.SOURCE_REMOVE;
                }

                counter += 10;
                if (counter >= 400) {
                    this._restoreSizeAndRestartGrab(window, x, y, grabOp);
                    this._restoreSizeTimerId = null;
                    return GLib.SOURCE_REMOVE;
                }

                const [currX, currY] = global.get_pointer();
                const currPoint = { x: currX, y: currY };
                const oldPoint = { x, y };
                const moveDist = Util.getDistance(currPoint, oldPoint);
                if (moveDist > 10) {
                    this._restoreSizeAndRestartGrab(window, x, y, grabOp);
                    this._restoreSizeTimerId = null;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });

        // Tile preview
        } else {
            this._isGrabOp = true;
            this._monitorNr = global.display.get_current_monitor();
            this._lastMonitorNr = this._monitorNr;
            this._lastPointerPos = { x, y };
            this._pointerDidntMove = false;
            this._movingTimerDuration = 20;
            this._movingTimeoutsSinceUpdate = 0;
            this._topTileGroup = Twm.getTopTileGroup({ skipTopWindow: true });

            // When low performance mode is enabled we use a timer to periodically
            // update the tile previews so that we don't update the tile preview
            // as often when compared to the position-changed signal.
            if (Settings.getBoolean('low-performance-move-mode')) {
                this._movingTimerId = GLib.timeout_add(
                    GLib.PRIORITY_IDLE,
                    this._movingTimerDuration,
                    this._onMoving.bind(
                        this,
                        grabOp,
                        window,
                        true
                    )
                );

                const id = global.display.connect('grab-op-end', () => {
                    global.display.disconnect(id);
                    // 'Quick throws' of windows won't create a tile preview since
                    // the timeout for onMoving may not have happened yet. So force
                    // 1 call of the tile preview updates for those quick actions.
                    this._onMoving(grabOp, window);
                    this._onMoveFinished(window);
                });

            // Otherwise we will update the tile preview whenever the window is
            // moved as often as necessary.
            } else {
                this._posChangedId = window.connect('position-changed',
                    this._onMoving.bind(
                        this,
                        grabOp,
                        window,
                        false
                    )
                );

                const id = global.display.connect('grab-op-end', () => {
                    global.display.disconnect(id);
                    this._onMoveFinished(window);
                });
            }
        }
    }

    _onMoveFinished(window) {
        try {
            window.assertExistence();

            if (this._tileRect) {
                // Ctrl-drag to replace some windows in a tile group / create a new tile group
                // with at least 1 window being part of multiple tile groups.
                let isCtrlReplacement = false;
                const ctrlReplacedTileGroup = [];
                const topTileGroup = Twm.getTopTileGroup({ skipTopWindow: true });
                const pointerPos = { x: global.get_pointer()[0], y: global.get_pointer()[1] };
                const twHovered = topTileGroup.some(w => w.tiledRect.containsPoint(pointerPos));
                if (this._currPreviewMode === MoveModes.ADAPTIVE_TILING && !this._splitRects.size && twHovered) {
                    isCtrlReplacement = true;
                    ctrlReplacedTileGroup.push(window);
                    topTileGroup.forEach(w => {
                        if (!this._tileRect.containsRect(w.tiledRect))
                            ctrlReplacedTileGroup.push(w);
                    });
                }

                this._splitRects.forEach((rect, w) => Twm.tile(w, rect, { openTilingPopup: false }));
                this._splitRects.clear();
                Twm.tile(window, this._tileRect, {
                    monitorNr: this._monitorNr,
                    openTilingPopup: this._currPreviewMode !== MoveModes.ADAPTIVE_TILING,
                    ignoreTA: this._ignoreTA
                });
                this._tileRect = null;

                // Create a new tile group, in which some windows are already part
                // of a different tile group, with ctrl-(super)-drag. The window may
                // be maximized by ctrl-super-drag.
                isCtrlReplacement && window.isTiled && Twm.updateTileGroup(ctrlReplacedTileGroup);
            }
        } finally {
            if (this._posChangedId) {
                window.disconnect(this._posChangedId);
                this._posChangedId = 0;
            }

            this._favoriteLayout = [];
            this._favoritePreviews?.forEach(p => p.destroy());
            this._favoritePreviews = [];
            this._freeScreenRects = [];
            this._anchorRect = null;
            this._topTileGroup = null;
            this._tilePreview.close();
            this._currPreviewMode = MoveModes.ADAPTIVE_TILING;
            this._isGrabOp = false;
        }
    }

    // If lowPerfMode is enabled in the settings:
    // Called periodically (~ every 20 ms) with a timer after a window was grabbed.
    // However this function will only update the tile previews fully after about
    // 500 ms. Force an earlier update, if the pointer movement state changed
    // (e.g. pointer came to a stop after a movement). This Detection is done
    // naively by comparing the pointer position of the previous timeout with
    // the current position.
    // Without the lowPerfMode enabled this will be called whenever the window is
    // moved (by listening to the position-changed signal)
    _onMoving(grabOp, window, lowPerfMode = false) {
        const [x, y] = global.get_pointer();
        const currPointerPos = { x, y };

        if (lowPerfMode) {
            if (!this._isGrabOp) {
                this._movingTimerId = null;
                return GLib.SOURCE_REMOVE;
            }

            const movementDist = Util.getDistance(this._lastPointerPos, currPointerPos);
            const movementDetectionThreshold = 10;
            let forceMoveUpdate = false;
            this._movingTimeoutsSinceUpdate++;

            // Force an early update if the movement state changed
            // i. e. moving -> stand still or stand still -> moving
            if (this._pointerDidntMove) {
                if (movementDist > movementDetectionThreshold) {
                    this._pointerDidntMove = false;
                    forceMoveUpdate = true;
                }
            } else if (movementDist < movementDetectionThreshold) {
                this._pointerDidntMove = true;
                forceMoveUpdate = true;
            }

            // Only update the tile preview every 500 ms for better performance.
            // Force an early update, if the pointer movement state changed.
            const updateInterval = 500;
            const timeSinceLastUpdate = this._movingTimerDuration * this._movingTimeoutsSinceUpdate;
            if (timeSinceLastUpdate < updateInterval && !forceMoveUpdate)
                return GLib.SOURCE_CONTINUE;

            this._movingTimeoutsSinceUpdate = 0;
        }

        this._lastPointerPos = currPointerPos;

        const ctrl = Clutter.ModifierType.CONTROL_MASK;
        const altL = Clutter.ModifierType.MOD1_MASK;
        const altGr = Clutter.ModifierType.MOD5_MASK;
        const meta = Clutter.ModifierType.MOD4_MASK;
        const rmb = Meta.is_wayland_compositor()
            ? Clutter.ModifierType.BUTTON2_MASK
            : Clutter.ModifierType.BUTTON3_MASK;
        const pressed = [ // idxs come from settings
            false, // Dummy for disabled state so that we can use the correct idxs
            Util.isModPressed(ctrl),
            Util.isModPressed(altL) || Util.isModPressed(altGr),
            Util.isModPressed(rmb),
            Util.isModPressed(meta)
        ];

        const defaultMode = Settings.getInt('default-move-mode');
        const adaptiveMod = Settings.getInt('move-adaptive-tiling-mod');
        const favMod = Settings.getInt('move-favorite-layout-mod');
        const ignoreTAMod = Settings.getInt('ignore-ta-mod');
        const noMod = !pressed[adaptiveMod] && !pressed[ignoreTAMod] && !pressed[ignoreTAMod];

        const useAdaptiveTiling = defaultMode !== MoveModes.ADAPTIVE_TILING && pressed[adaptiveMod] ||
            noMod && defaultMode === MoveModes.ADAPTIVE_TILING;
        const usefavLayout = defaultMode !== MoveModes.FAVORITE_LAYOUT && pressed[favMod] ||
            noMod && defaultMode === MoveModes.FAVORITE_LAYOUT;
        const useIgnoreTa = defaultMode !== MoveModes.IGNORE_TA && pressed[ignoreTAMod] ||
            noMod && defaultMode === MoveModes.IGNORE_TA;

        let newMode = '';

        if (useAdaptiveTiling)
            newMode = MoveModes.ADAPTIVE_TILING;
        else if (usefavLayout)
            newMode = MoveModes.FAVORITE_LAYOUT;
        else if (useIgnoreTa)
            newMode = MoveModes.IGNORE_TA;
        else
            newMode = MoveModes.EDGE_TILING;

        if (this._currPreviewMode !== newMode)
            this._preparePreviewModeChange(newMode, window);

        switch (newMode) {
            case MoveModes.IGNORE_TA:
            case MoveModes.EDGE_TILING:
                this._edgeTilingPreview(window, grabOp);
                break;
            case MoveModes.ADAPTIVE_TILING:
                this._adaptiveTilingPreview(window, grabOp);
                break;
            case MoveModes.FAVORITE_LAYOUT:
                this._favoriteLayoutTilingPreview(window);
        }

        this._currPreviewMode = newMode;

        return GLib.SOURCE_CONTINUE;
    }

    _preparePreviewModeChange(newMode, window) {
        this._tileRect = null;
        this._ignoreTA = false;
        this._topTileGroup = Twm.getTopTileGroup({ skipTopWindow: true });

        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
        const tRects = this._topTileGroup.map(w => w.tiledRect);
        this._freeScreenRects = workArea.minus(tRects);

        switch (this._currPreviewMode) {
            case MoveModes.ADAPTIVE_TILING:
                this._monitorNr = global.display.get_current_monitor();
                this._splitRects.clear();
                this._anchorRect = null;
                break;
            case MoveModes.FAVORITE_LAYOUT:
                this._monitorNr = global.display.get_current_monitor();
                this._favoritePreviews.forEach(p => {
                    p.ease({
                        opacity: 0,
                        duration: 100,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => p.destroy()
                    });
                });
                this._favoritePreviews = [];
                this._anchorRect = null;
        }

        switch (newMode) {
            case MoveModes.IGNORE_TA:
                this._ignoreTA = true;
                break;
            case MoveModes.FAVORITE_LAYOUT:
                this._favoriteLayout = Util.getFavoriteLayout();
                this._favoriteLayout.forEach(rect => {
                    const tilePreview = new TilePreview();
                    tilePreview.open(window, rect, this._monitorNr, {
                        opacity: 255,
                        duration: 150
                    });
                    this._favoritePreviews.push(tilePreview);
                });
        }
    }

    _restoreSizeAndRestartGrab(window, px, py, grabOp) {
        Twm.untile(window, {
            restoreFullPos: false,
            xAnchor: px,
            skipAnim: this._wasMaximizedOnStart
        });

        this._onMoveStarted(window, grabOp);
    }

    /**
     * Previews the rect the `window` will tile to when moving along the
     * screen edges.
     *
     * @param {Meta.Window} window the grabbed Meta.Window.
     * @param {Meta.GrabOp} grabOp the current Meta.GrabOp.
     */
    _edgeTilingPreview(window, grabOp) {
        // When switching monitors, provide a short grace period
        // in which the tile preview will stick to the old monitor so that
        // the user doesn't have to slowly inch the mouse to the monitor edge
        // just because there is another monitor at that edge.
        const currMonitorNr = global.display.get_current_monitor();
        const useGracePeriod = Settings.getBoolean('monitor-switch-grace-period');
        if (useGracePeriod) {
            if (this._lastMonitorNr !== currMonitorNr) {
                this._monitorNr = this._lastMonitorNr;
                let timerId = 0;
                this._latestMonitorLockTimerId && GLib.Source.remove(this._latestMonitorLockTimerId);
                this._latestMonitorLockTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    // Only update the monitorNr, if the latest timer timed out.
                    if (timerId === this._latestMonitorLockTimerId) {
                        this._monitorNr = global.display.get_current_monitor();
                        if (global.display.is_grabbed())
                            this._edgeTilingPreview(window, grabOp);
                    }

                    this._latestMonitorLockTimerId = null;
                    return GLib.SOURCE_REMOVE;
                });
                timerId = this._latestMonitorLockTimerId;
            }
        } else {
            this._monitorNr = global.display.get_current_monitor();
        }

        this._lastMonitorNr = currMonitorNr;

        const wRect = window.get_frame_rect();
        const workArea = new Rect(window.get_work_area_for_monitor(this._monitorNr));

        const vDetectionSize = Settings.getInt('vertical-preview-area');
        const pointerAtTopEdge = this._lastPointerPos.y <= workArea.y + vDetectionSize;
        const pointerAtBottomEdge = this._lastPointerPos.y >= workArea.y2 - vDetectionSize;
        const hDetectionSize = Settings.getInt('horizontal-preview-area');
        const pointerAtLeftEdge = this._lastPointerPos.x <= workArea.x + hDetectionSize;
        const pointerAtRightEdge = this._lastPointerPos.x >= workArea.x2 - hDetectionSize;
        // Also use window's pos for top and bottom area detection for quarters
        // because global.get_pointer's y isn't accurate (no idea why...) when
        // grabbing the titlebar & slowly going from the left/right sides to
        // the top/bottom corners.
        const titleBarGrabbed = this._lastPointerPos.y - wRect.y < 50;
        const windowAtTopEdge = titleBarGrabbed && wRect.y === workArea.y;
        const windowAtBottomEdge = wRect.y >= workArea.y2 - 75;
        const tileTopLeftQuarter = pointerAtLeftEdge && (pointerAtTopEdge || windowAtTopEdge);
        const tileTopRightQuarter = pointerAtRightEdge && (pointerAtTopEdge || windowAtTopEdge);
        const tileBottomLeftQuarter = pointerAtLeftEdge && (pointerAtBottomEdge || windowAtBottomEdge);
        const tileBottomRightQuarter = pointerAtRightEdge && (pointerAtBottomEdge || windowAtBottomEdge);

        if (tileTopLeftQuarter) {
            this._tileRect = Twm.getTileFor('tile-topleft-quarter', workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileTopRightQuarter) {
            this._tileRect = Twm.getTileFor('tile-topright-quarter', workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileBottomLeftQuarter) {
            this._tileRect = Twm.getTileFor('tile-bottomleft-quarter', workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileBottomRightQuarter) {
            this._tileRect = Twm.getTileFor('tile-bottomright-quarter', workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtTopEdge) {
            // Switch between maximize & top tiling when keeping the mouse at the top edge.
            const monitorRect = global.display.get_monitor_geometry(this._monitorNr);
            const isLandscape = monitorRect.width >= monitorRect.height;
            const shouldMaximize =
                    isLandscape && !Settings.getBoolean('enable-hold-maximize-inverse-landscape') ||
                    !isLandscape && !Settings.getBoolean('enable-hold-maximize-inverse-portrait');
            const tileRect = shouldMaximize
                ? workArea
                : Twm.getTileFor('tile-top-half', workArea, this._monitorNr);
            const holdTileRect = shouldMaximize
                ? Twm.getTileFor('tile-top-half', workArea, this._monitorNr)
                : workArea;
            // Dont open preview / start new timer if preview was already one for the top
            if (this._tilePreview._rect &&
                        (holdTileRect.equal(this._tilePreview._rect) ||
                                this._tilePreview._rect.equal(tileRect.meta)))
                return;

            this._tileRect = tileRect;
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);

            let timerId = 0;
            this._latestPreviewTimerId && GLib.Source.remove(this._latestPreviewTimerId);
            this._latestPreviewTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Settings.getInt('toggle-maximize-tophalf-timer'), () => {
                // Only open the alternative preview, if the timeout-ed timer
                // is the same as the one which started last
                    if (timerId === this._latestPreviewTimerId &&
                        this._tilePreview._showing &&
                        this._tilePreview._rect.equal(tileRect.meta)) {
                        this._tileRect = holdTileRect;
                        this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
                    }

                    this._latestPreviewTimerId = null;
                    return GLib.SOURCE_REMOVE;
                });
            timerId = this._latestPreviewTimerId;
        } else if (pointerAtBottomEdge) {
            this._tileRect = Twm.getTileFor('tile-bottom-half', workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtLeftEdge) {
            this._tileRect = Twm.getTileFor('tile-left-half', workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtRightEdge) {
            this._tileRect = Twm.getTileFor('tile-right-half', workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else {
            this._tileRect = null;
            this._tilePreview.close();
        }
    }

    /**
     * Activates the secondary preview mode. By default, it's activated with
     * `Ctrl`. When tiling using this mode, it will not only affect the grabbed
     * window but possibly others as well. It's split into a 'single' and a
     * 'group' mode. Take a look at _adaptiveTilingPreviewSingle() and
     * _adaptiveTilingPreviewGroup() for details.
     *
     * @param {Meta.Window} window
     * @param {Meta.GrabOp} grabOp
     */
    _adaptiveTilingPreview(window, grabOp) {
        if (!this._topTileGroup.length) {
            this._edgeTilingPreview(window, grabOp);
            return;
        }

        const screenRects = this._topTileGroup
            .map(w => w.tiledRect)
            .concat(this._freeScreenRects);
        const hoveredRect = screenRects.find(r => r.containsPoint(this._lastPointerPos));
        if (!hoveredRect) {
            this._tilePreview.close();
            this._tileRect = null;
            return;
        }

        const isSuperPressed = Util.isModPressed(Clutter.ModifierType.MOD4_MASK);
        if (isSuperPressed) {
            this._anchorRect = this._anchorRect ?? hoveredRect;
            this._tileRect = hoveredRect.union(this._anchorRect);
            this._splitRects.clear();

            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr, {
                x: this._tileRect.x,
                y: this._tileRect.y,
                width: this._tileRect.width,
                height: this._tileRect.height,
                opacity: 200
            });
        } else {
            this._anchorRect = null;
            const edgeRadius = 50;
            const atTopEdge = this._lastPointerPos.y < hoveredRect.y + edgeRadius;
            const atBottomEdge = this._lastPointerPos.y > hoveredRect.y2 - edgeRadius;
            const atLeftEdge = this._lastPointerPos.x < hoveredRect.x + edgeRadius;
            const atRightEdge = this._lastPointerPos.x > hoveredRect.x2 - edgeRadius;

            atTopEdge || atBottomEdge || atLeftEdge || atRightEdge
                ? this._adaptiveTilingPreviewGroup(window, hoveredRect,
                    { atTopEdge, atBottomEdge, atLeftEdge, atRightEdge })
                : this._adaptiveTilingPreviewSingle(window, hoveredRect);
        }
    }

    /**
     * In this mode, when moving a window over a tiled window, the tilePreview
     * will appear and (partly) cover the tiled window. If your pointer is at
     * the center, the grabbed window will just tile over the hovered tiled
     * window. If your pointer is hovering over the sides (but not the very
     * edges) of the tiled window, the tilePreview will only cover half of the
     * tiled window. Once the grabbed window is tiled, the previously hovered
     * tiled window, will make space for the grabbed window by halving its size.
     *
     * @param {Meta.Window} window
     * @param {Rect} hoveredRect
     */
    _adaptiveTilingPreviewSingle(window, hoveredRect) {
        const atTop = this._lastPointerPos.y < hoveredRect.y + hoveredRect.height * .25;
        const atBottom = this._lastPointerPos.y > hoveredRect.y + hoveredRect.height * .75;
        const atRight = this._lastPointerPos.x > hoveredRect.x + hoveredRect.width * .75;
        const atLeft = this._lastPointerPos.x < hoveredRect.x + hoveredRect.width * .25;
        const splitVertically = atTop || atBottom;
        const splitHorizontally = atLeft || atRight;

        if (splitHorizontally || splitVertically) {
            const idx = atTop && !atRight || atLeft ? 0 : 1;
            const size = splitHorizontally ? hoveredRect.width : hoveredRect.height;
            const orientation = splitHorizontally ? Orientation.V : Orientation.H;
            this._tileRect = hoveredRect.getUnitAt(idx, size / 2, orientation);
        } else {
            this._tileRect = hoveredRect.copy();
        }

        if (!this._tilePreview.needsUpdate(this._tileRect))
            return;

        const monitor = global.display.get_current_monitor();
        this._tilePreview.open(window, this._tileRect.meta, monitor);
        this._splitRects.clear();

        const hoveredWindow = this._topTileGroup.find(w => {
            return w.tiledRect.containsPoint(this._lastPointerPos);
        });

        if (!hoveredWindow)
            return;

        // Don't halve the window, if we compelety cover it i. e.
        // the user is hovering the tiled window at the center.
        if (hoveredWindow.tiledRect.equal(this._tileRect))
            return;

        const splitRect = hoveredWindow.tiledRect.minus(this._tileRect)[0];
        this._splitRects.set(hoveredWindow, splitRect);
    }

    /**
     * Similar to _adaptiveTilingPreviewSingle(). But it's activated by hovering
     * the very edges of a tiled window. And instead of affecting just 1 window
     * it can possibly re-tile multiple windows. A tiled window will be affected,
     * if it aligns with the edge that is being hovered. It's probably easier
     * to understand, if you see it in action first rather than reading about it.
     *
     * @param {Meta.Window} window
     * @param {Rect} hoveredRect
     * @param {object} hovered contains booleans at which position the
     *      `hoveredRect` is hovered.
     */
    _adaptiveTilingPreviewGroup(window, hoveredRect, hovered) {
        // Find the smallest window that will be affected and use it to calculate
        // the sizes of the preview. Determine the new tileRects for the rest
        // of the tileGroup via Rect.minus().
        const smallestWindow = this._topTileGroup.reduce((smallest, w) => {
            if (hovered.atTopEdge) {
                if (w.tiledRect.y === hoveredRect.y || w.tiledRect.y2 === hoveredRect.y)
                    return w.tiledRect.height < smallest.tiledRect.height ? w : smallest;
            } else if (hovered.atBottomEdge) {
                if (w.tiledRect.y === hoveredRect.y2 || w.tiledRect.y2 === hoveredRect.y2)
                    return w.tiledRect.height < smallest.tiledRect.height ? w : smallest;
            } else if (hovered.atLeftEdge) {
                if (w.tiledRect.x === hoveredRect.x || w.tiledRect.x2 === hoveredRect.x)
                    return w.tiledRect.width < smallest.tiledRect.width ? w : smallest;
            } else if (hovered.atRightEdge) {
                if (w.tiledRect.x === hoveredRect.x2 || w.tiledRect.x2 === hoveredRect.x2)
                    return w.tiledRect.width < smallest.tiledRect.width ? w : smallest;
            }

            return smallest;
        });

        const monitor = global.display.get_current_monitor();
        const workArea = new Rect(window.get_work_area_for_monitor(monitor));
        // This factor is used in combination with the smallestWindow to
        // determine the final size of the grabbed window. Use half of the size
        // factor, if we are at the screen edges. The cases for the bottom and
        // right screen edges are covered further down.
        const factor = hovered.atLeftEdge && hoveredRect.x === workArea.x ||
                hovered.atTopEdge && hoveredRect.y === workArea.y
            ? 1 / 3
            : 2 / 3;

        // The grabbed window will be horizontal. The horizontal size (x1 - x2)
        // is determined by the furthest left- and right-reaching windows that
        // align with the hovered rect. The vertical size (height) is a fraction
        // of the smallestWindow.
        if (hovered.atTopEdge || hovered.atBottomEdge) {
            const getX1X2 = alignsAt => {
                return this._topTileGroup.reduce((x1x2, w) => {
                    const currX = x1x2[0];
                    const currX2 = x1x2[1];
                    return alignsAt(w)
                        ? [Math.min(w.tiledRect.x, currX), Math.max(w.tiledRect.x2, currX2)]
                        : x1x2;
                }, [hoveredRect.x, hoveredRect.x2]);
            };
            const alignTopEdge = w => {
                return hoveredRect.y === w.tiledRect.y ||
                        hoveredRect.y === w.tiledRect.y2;
            };
            const alignBottomEdge = w => {
                return hoveredRect.y2 === w.tiledRect.y2 ||
                        hoveredRect.y2 === w.tiledRect.y;
            };

            const [x1, x2] = getX1X2(hovered.atTopEdge ? alignTopEdge : alignBottomEdge);
            const size = Math.ceil(smallestWindow.tiledRect.height * factor);
            // Keep within workArea bounds.
            const y = Math.max(workArea.y, Math.floor(hovered.atTopEdge
                ? hoveredRect.y - size / 2
                : hoveredRect.y2 - size / 2
            ));
            const height = Math.min(size, workArea.y2 - y);

            this._tileRect = new Rect(x1, y, x2 - x1, height);

        // The grabbed window will be vertical. The vertical size (y1 - y2) is
        // determined by the furthest top- and bottom-reaching windows that align
        // with the hovered rect. The horizontal size (width) is a fraction of
        // the smallestWindow.
        } else {
            const getY1Y2 = alignsAt => {
                return this._topTileGroup.reduce((y1y2, w) => {
                    const currY = y1y2[0];
                    const currY2 = y1y2[1];
                    return alignsAt(w)
                        ? [Math.min(w.tiledRect.y, currY), Math.max(w.tiledRect.y2, currY2)]
                        : y1y2;
                }, [hoveredRect.y, hoveredRect.y2]);
            };
            const alignLeftEdge = w => {
                return hoveredRect.x === w.tiledRect.x ||
                        hoveredRect.x === w.tiledRect.x2;
            };
            const alignRightEdge = w => {
                return hoveredRect.x2 === w.tiledRect.x2 ||
                        hoveredRect.x2 === w.tiledRect.x;
            };

            const [y1, y2] = getY1Y2(hovered.atLeftEdge ? alignLeftEdge : alignRightEdge);
            const size = Math.ceil(smallestWindow.tiledRect.width * factor);
            // Keep within workArea bounds.
            const x = Math.max(workArea.x, Math.floor(hovered.atLeftEdge
                ? hoveredRect.x - size / 2
                : hoveredRect.x2 - size / 2
            ));
            const width = Math.min(size, workArea.x2 - x);

            this._tileRect = new Rect(x, y1, width, y2 - y1);
        }

        this._tileRect.tryAlignWith(workArea);

        if (!this._tilePreview.needsUpdate(this._tileRect))
            return;

        this._tilePreview.open(window, this._tileRect.meta, monitor);
        this._splitRects.clear();

        this._topTileGroup.forEach(w => {
            const leftOver = w.tiledRect.minus(this._tileRect);
            const splitRect = leftOver[0];
            // w isn't an affected window.
            if (splitRect?.equal(this._tileRect) ?? true)
                return;

            this._splitRects.set(w, splitRect);
        });
    }

    _favoriteLayoutTilingPreview(window) {
        // Holding Super will make the window span multiple rects of the favorite
        // layout starting from the rect, which the user starting holding Super in.
        const isSuperPressed = Util.isModPressed(Clutter.ModifierType.MOD4_MASK);
        for (const rect of this._favoriteLayout) {
            if (rect.containsPoint(this._lastPointerPos)) {
                if (isSuperPressed) {
                    this._anchorRect = this._anchorRect ?? rect;
                    this._tileRect = rect.union(this._anchorRect);
                } else {
                    this._tileRect = rect.copy();
                    this._anchorRect = null;
                }

                this._tilePreview.open(window, this._tileRect.meta, this._monitorNr, {
                    x: this._tileRect.x,
                    y: this._tileRect.y,
                    width: this._tileRect.width,
                    height: this._tileRect.height,
                    opacity: 200
                });
                return;
            }
        }

        this._tileRect = null;
        this._tilePreview.close();
    }
}

const TilePreview = GObject.registerClass(
class TilePreview extends WindowManager.TilePreview {
    _init() {
        super._init();
        this.set_style_class_name('tile-preview');
    }

    needsUpdate(rect) {
        return !this._rect || !rect.equal(this._rect);
    }

    // Added param for animation and removed style for rounded corners
    open(window, tileRect, monitorIndex, animateTo = undefined) {
        const windowActor = window.get_compositor_private();
        if (!windowActor)
            return;

        global.window_group.set_child_below_sibling(this, windowActor);

        if (this._rect && this._rect.equal(tileRect))
            return;

        const changeMonitor = this._monitorIndex === -1 ||
            this._monitorIndex !== monitorIndex;

        this._monitorIndex = monitorIndex;
        this._rect = tileRect;

        const monitor = Main.layoutManager.monitors[monitorIndex];

        if (!this._showing || changeMonitor) {
            const monitorRect = new Mtk.Rectangle({
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height
            });
            const [, rect] = window.get_frame_rect().intersect(monitorRect);
            this.set_size(rect.width, rect.height);
            this.set_position(rect.x, rect.y);
            this.opacity = 0;
        }

        this._showing = true;
        this.show();

        if (!animateTo) {
            animateTo = {
                x: tileRect.x,
                y: tileRect.y,
                width: tileRect.width,
                height: tileRect.height,
                opacity: 255,
                duration: WINDOW_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            };
        } else {
            animateTo.x === undefined && this.set_x(tileRect.x);
            animateTo.y === undefined && this.set_y(tileRect.y);
            animateTo.width === undefined && this.set_width(tileRect.width);
            animateTo.height === undefined && this.set_height(tileRect.height);
            animateTo.opacity === undefined && this.set_opacity(255);
            animateTo.duration = animateTo.duration ?? WINDOW_ANIMATION_TIME;
            animateTo.mode = animateTo.mode ?? Clutter.AnimationMode.EASE_OUT_QUAD;
        }

        this.ease(animateTo);
    }
});
