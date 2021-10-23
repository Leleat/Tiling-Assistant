'use strict';

const { Clutter, GLib, Meta } = imports.gi;
const WindowManager = imports.ui.windowManager;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Orientation, RestoreOn, MoveModes, Settings, Shortcuts } = Me.imports.src.common;
const Rect = Me.imports.src.extension.geometry.Rect;
const Util = Me.imports.src.extension.utility.Util;

/**
 * This class gets to handle the move events (grab & monitor change) of windows.
 * If the moved window is tiled at the start of the grab, untile it. This is
 * done by releasing the grab via code, resizing the window, and then restarting
 * the grab via code. On Wayland this may not be reliable. As a workaround there
 * is a setting to restore a tiled window's size on the actual grab end.
 */

var Handler = class TilingMoveHandler {
    constructor() {
        const moveOps = [Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING];

        this._displaySignals = [];
        const g1Id = global.display.connect('grab-op-begin', (src, window, grabOp) => {
            if (window && moveOps.includes(grabOp))
                this._onMoveStarted(window, grabOp);
        });
        this._displaySignals.push(g1Id);

        const g2Id = global.display.connect('grab-op-end', (src, window, grabOp) => {
            if (window && moveOps.includes(grabOp))
                this._onMoveFinished(window);
        });
        this._displaySignals.push(g2Id);

        // Adapt the size of tiled windows when moving them the across monitors
        const w1Id = global.display.connect('window-left-monitor', (src, monitorNr, window) => {
            // Use this._isGrabOp because when tiling the window during
            // the grace period on a monitor change, the window will first
            // be tiled and then moved to the old monitor, which fires another
            // window-left / window-entered signal. UntiledRect -> also include
            // maximized windows with gaps
            if (this._isGrabOp || !window.untiledRect)
                return;

            const activeWs = global.workspace_manager.get_active_workspace();
            const workArea = activeWs.get_work_area_for_monitor(monitorNr);
            const windowRect = window.tiledRect || workArea;
            this._scaleFactors = {
                x: (windowRect.x - workArea.x) / workArea.width,
                y: (windowRect.y - workArea.y) / workArea.height,
                width: windowRect.width / workArea.width,
                height: windowRect.height / workArea.height
            };
        });
        this._displaySignals.push(w1Id);

        // See window-left-monitor signal connection.
        const w2Id = global.display.connect('window-entered-monitor', (src, monitorNr, window) => {
            if (this._isGrabOp || !window.untiledRect)
                return;

            this._onMonitorChanged(window, monitorNr, this._scaleFactors);
        });
        this._displaySignals.push(w2Id);

        // Save the windows, which need to make space for the
        // grabbed window (this is for the so called 'secondary mode'):
        // { window1: newTileRect1, window2: newTileRect2, ... }
        this._splitRects = new Map();
        // The rect the grabbed window will tile to
        // (it may differ from the tilePreview's rect)
        this._tileRect = null;

        this._tilePreview = new WindowManager.TilePreview();
        this._tilePreview.needsUpdate = rect =>
            !this._tilePreview._rect || !rect.equal(this._tilePreview._rect);
        // Don't bother with rounded corners since we have more than 2 previews
        this._tilePreview.style_class = 'tile-preview';
        this._tilePreview._updateStyle = () => {};
    }

    destroy() {
        this._displaySignals.forEach(sId => global.display.disconnect(sId));
        this._tilePreview.destroy();
    }

    // Adapt the size of tiled windows when moving them the across monitors.
    // Windows, which are *way too* large for the new monitor, won't be moved
    // ... bug or intentional design in mutter / gnome shell?
    _onMonitorChanged(tiledWindow, monitorNr, scaleFactors) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitorNr));
        const newRect = new Rect(
            workArea.x + (workArea.width * scaleFactors.x),
            workArea.y + (workArea.height * scaleFactors.y),
            workArea.width * scaleFactors.width,
            workArea.height * scaleFactors.height
        );

        // Try to stick the newRect to other tiled windows already on the
        // workArea and to the workArea itself to workaround rounding errors
        const topTileGroup = Util.getTopTileGroup(true, monitorNr);
        topTileGroup.forEach(w => newRect.tryAlignWith(w));
        newRect.tryAlignWith(workArea);

        // Retile to update tiledRects, tileGroups etc...
        Util.tile(tiledWindow, newRect, { openTilingPopup: false, skipAnim: true });
    }

    _onMoveStarted(window, grabOp) {
        // Also work with a window, which was maximized by GNOME natively
        // because it may have been tiled with this extension before being
        // maximized so we need to restore its size to pre-tiling.
        this._wasMaximizedOnStart = window.get_maximized();
        const [eventX, eventY] = global.get_pointer();

        // Try to restore the window size
        const restoreSetting = Settings.getString(Settings.RESTORE_SIZE_ON);
        if ((window.tiledRect || this._wasMaximizedOnStart) &&
                restoreSetting === RestoreOn.ON_GRAB_START) {
            // HACK:
            // The grab begin signal (and thus this function call) gets fired
            // at the moment of the first click. However I don't want to restore
            // the window size on just a click. Only if the user actually wanted
            // to start a grab i.e. if the click is held for a bit or if the
            // cursor moved while holding the click. I assume a cursor change
            // means the grab was released since I couldn't find a better way...
            let grabReleased = false;
            let cursorId = global.display.connect('cursor-updated', () => {
                grabReleased = true;
                cursorId && global.display.disconnect(cursorId);
                cursorId = 0;
            });
            // Clean up in case my assumption mentioned above is wrong
            // and the cursor never gets updated or something else...
            GLib.timeout_add(GLib.PRIORITY_LOW, 400, () => {
                cursorId && global.display.disconnect(cursorId);
                cursorId = 0;
                return GLib.SOURCE_REMOVE;
            });

            let counter = 0;
            GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE, 10, () => {
                if (grabReleased)
                    return GLib.SOURCE_REMOVE;

                counter += 10;
                if (counter >= 400) {
                    this._restoreSizeAndRestartGrab(window, eventX, eventY, grabOp);
                    return GLib.SOURCE_REMOVE;
                }

                const [currX, currY] = global.get_pointer();
                const currPoint = { x: currX, y: currY };
                const oldPoint = { x: eventX, y: eventY };
                const moveDist = Util.getDistance(currPoint, oldPoint);
                if (moveDist > 10) {
                    this._restoreSizeAndRestartGrab(window, eventX, eventY, grabOp);
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });

        // Tile preview
        } else {
            this._isGrabOp = true;
            this._monitorNr = global.display.get_current_monitor();
            this._lastMonitorNr = this._monitorNr;
            this._fixedLayout = Util.getFixedLayout();

            const activeWs = global.workspace_manager.get_active_workspace();
            const monitor = global.display.get_current_monitor();
            const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));

            const topTileGroup = Util.getTopTileGroup();
            const tRects = topTileGroup.map(w => w.tiledRect);
            const freeScreenRects = workArea.minus(tRects);
            this._posChangedId = window.connect('position-changed',
                this._onMoving.bind(
                    this,
                    grabOp,
                    window,
                    topTileGroup,
                    freeScreenRects
                )
            );
        }
    }

    _onMoveFinished(window) {
        if (this._posChangedId) {
            window.disconnect(this._posChangedId);
            this._posChangedId = 0;
        }

        if (!this._tilePreview._showing) {
            const restoreSetting = Settings.getString(Settings.RESTORE_SIZE_ON);
            const restoreOnEnd = restoreSetting === RestoreOn.ON_GRAB_END;
            restoreOnEnd && Util.untile(
                window, {
                    restoreFullPos: false,
                    xAnchor: this._lastPointerPos.x,
                    skipAnim: this._wasMaximizedOnStart
                }
            );

            return;
        }

        this._splitRects.forEach((rect, w) => Util.tile(w, rect, {
            openTilingPopup: false
        }));
        Util.tile(window, this._tileRect);

        this._fixedLayout = [];
        this._splitRects.clear();
        this._tilePreview.close();
        this._tileRect = null;
        this._isGrabOp = false;
    }

    _onMoving(grabOp, window, topTileGroup, freeScreenRects) {
        // Use the current event's coords instead of global.get_pointer
        // to support touch...?
        const event = Clutter.get_current_event();
        if (!event)
            return;

        const [eventX, eventY] = grabOp === Meta.GrabOp.KEYBOARD_MOVING
            ? global.get_pointer()
            : event.get_coords();
        this._lastPointerPos = { x: eventX, y: eventY };

        const ctrl = Clutter.ModifierType.CONTROL_MASK;
        const altL = Clutter.ModifierType.MOD1_MASK;
        const altGr = Clutter.ModifierType.MOD5_MASK;
        const rmb = Clutter.ModifierType.BUTTON3_MASK;
        const pressed = {
            Ctrl: Util.isModPressed(ctrl),
            Alt: Util.isModPressed(altL) || Util.isModPressed(altGr),
            RMB: Util.isModPressed(rmb)
        };

        const defaultMode = Settings.getString(Settings.DEFAULT_MOVE_MODE);
        const splitActivator = Settings.getString(Settings.SPLIT_TILE_MOD);
        const fixedActivator = Settings.getString(Settings.FIXED_LAYOUT_MOD);

        if (pressed[splitActivator]) {
            defaultMode === MoveModes.SPLIT_TILES
                ? this._edgeTilingPreview(window, grabOp)
                : this._splitTilingPreview(window, grabOp, topTileGroup, freeScreenRects);
        } else if (pressed[fixedActivator]) {
            defaultMode === MoveModes.FIXED_LAYOUT
                ? this._edgeTilingPreview(window, grabOp)
                : this._fixedLayoutTilingPreview(window);
        } else if (defaultMode === MoveModes.SPLIT_TILES) {
            this._splitTilingPreview(window, grabOp, topTileGroup, freeScreenRects);
        } else if (defaultMode === MoveModes.FIXED_LAYOUT) {
            this._fixedLayoutTilingPreview(window);
        } else {
            this._edgeTilingPreview(window, grabOp);
        }
    }

    _restoreSizeAndRestartGrab(window, eventX, eventY, grabOp) {
        global.display.end_grab_op(global.get_current_time());

        const rect = window.get_frame_rect();
        const x = eventX - rect.x;
        const relativeX = x / rect.width;
        let untiledRect = window.untiledRect;
        Util.untile(window, {
            restoreFullPos: false,
            xAnchor: eventX,
            skipAnim: this._wasMaximizedOnStart
        });
        // untiledRect is null, if the window was maximized via non-extension
        // way (dblc-ing the titlebar, maximize button...). So just get the
        // restored window's rect directly... doesn't work on Wayland because
        // get_frame_rect() doesnt return the correct size immediately after
        // calling untile()... in that case just guess a random size
        if (!untiledRect && !Meta.is_wayland_compositor())
            untiledRect = new Rect(rect);

        const untiledWidth = untiledRect?.width ?? 1000;
        const postUntileRect = window.get_frame_rect();

        global.display.begin_grab_op(
            window,
            grabOp,
            true, // Pointer already grabbed
            true, // Frame action
            -1, // Button
            global.get_pointer()[2], // modifier
            global.get_current_time(),
            postUntileRect.x + untiledWidth * relativeX,
            // So the pointer isn't above the window in some cases.
            Math.max(eventY, postUntileRect.y)
        );
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
        if (this._lastMonitorNr !== currMonitorNr) {
            this._monitorNr = this._lastMonitorNr;
            let timerId = 0;
            this._latestMonitorLockTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                // Only update the monitorNr, if the latest timer timed out.
                if (timerId === this._latestMonitorLockTimerId) {
                    this._monitorNr = global.display.get_current_monitor();
                    if (global.display.get_grab_op() === grabOp) // !
                        this._edgeTilingPreview(window, grabOp);
                }
                return GLib.SOURCE_REMOVE;
            });
            timerId = this._latestMonitorLockTimerId;
        }
        this._lastMonitorNr = currMonitorNr;

        const wRect = window.get_frame_rect();
        const workArea = new Rect(window.get_work_area_for_monitor(this._monitorNr));

        const vDetectionSize = Settings.getInt(Settings.VERTICAL_PREVIEW_AREA);
        const pointerAtTopEdge = this._lastPointerPos.y <= workArea.y + vDetectionSize;
        const pointerAtBottomEdge = this._lastPointerPos.y >= workArea.y2 - vDetectionSize;
        const hDetectionSize = Settings.getInt(Settings.HORIZONTAL_PREVIEW_AREA);
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
            this._tileRect = Util.getTileFor(Shortcuts.TOP_LEFT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileTopRightQuarter) {
            this._tileRect = Util.getTileFor(Shortcuts.TOP_RIGHT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileBottomLeftQuarter) {
            this._tileRect = Util.getTileFor(Shortcuts.BOTTOM_LEFT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileBottomRightQuarter) {
            this._tileRect = Util.getTileFor(Shortcuts.BOTTOM_RIGHT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtTopEdge) {
            // Switch between maximize & top tiling when keeping the mouse at the top edge.
            const monitorRect = global.display.get_monitor_geometry(this._monitorNr);
            const isLandscape = monitorRect.width >= monitorRect.height;
            const shouldMaximize =
                    isLandscape && !Settings.getBoolean(Settings.ENABLE_HOLD_INVERSE_LANDSCAPE) ||
                    !isLandscape && !Settings.getBoolean(Settings.ENABLE_HOLD_INVERSE_PORTRAIT);
            const tileRect = shouldMaximize
                ? workArea
                : Util.getTileFor(Shortcuts.TOP, workArea, this._monitorNr);
            const holdTileRect = shouldMaximize
                ? Util.getTileFor(Shortcuts.TOP, workArea, this._monitorNr)
                : workArea;
            // Dont open preview / start new timer if preview was already one for the top
            if (this._tilePreview._rect &&
                        (holdTileRect.equal(this._tilePreview._rect) ||
                                this._tilePreview._rect.equal(tileRect.meta)))
                return;

            this._tileRect = tileRect;
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);

            let timerId = 0;
            this._latestPreviewTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Settings.getInt(Settings.INVERSE_TOP_MAXIMIZE_TIMER), () => {
                // Only open the alternative preview, if the timeout-ed timer
                // is the same as the one which started last
                    if (timerId === this._latestPreviewTimerId &&
                        this._tilePreview._showing &&
                        this._tilePreview._rect.equal(tileRect.meta)) {
                        this._tileRect = holdTileRect;
                        this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
                    }

                    return GLib.SOURCE_REMOVE;
                });
            timerId = this._latestPreviewTimerId;
        } else if (pointerAtBottomEdge) {
            this._tileRect = Util.getTileFor(Shortcuts.BOTTOM, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtLeftEdge) {
            this._tileRect = Util.getTileFor(Shortcuts.LEFT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtRightEdge) {
            this._tileRect = Util.getTileFor(Shortcuts.RIGHT, workArea, this._monitorNr);
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
     * 'group' mode. Take a look at _splitTilingPreviewSingle() and
     * _splitTilingPreviewGroup() for details.
     *
     * @param {Meta.Window} window
     * @param {Meta.GrabOp} grabOp
     * @param {Meta.Window[]} topTileGroup
     * @param {Rect[]} freeScreenRects
     */
    _splitTilingPreview(window, grabOp, topTileGroup, freeScreenRects) {
        if (!topTileGroup.length) {
            this._edgeTilingPreview(window, grabOp);
            return;
        }

        const screenRects = topTileGroup.map(w => w.tiledRect).concat(freeScreenRects);
        const hoveredRect = screenRects.find(r => r.containsPoint(this._lastPointerPos));
        if (!hoveredRect) {
            this._tilePreview.close();
            return;
        }

        const edgeRadius = 50;
        const atTopEdge = this._lastPointerPos.y < hoveredRect.y + edgeRadius;
        const atBottomEdge = this._lastPointerPos.y > hoveredRect.y2 - edgeRadius;
        const atLeftEdge = this._lastPointerPos.x < hoveredRect.x + edgeRadius;
        const atRightEdge = this._lastPointerPos.x > hoveredRect.x2 - edgeRadius;

        atTopEdge || atBottomEdge || atLeftEdge || atRightEdge
            ? this._splitTilingPreviewGroup(window, hoveredRect, topTileGroup,
                { atTopEdge, atBottomEdge, atLeftEdge, atRightEdge })
            : this._splitTilingPreviewSingle(window, hoveredRect, topTileGroup);
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
     * @param {Meta.Window[]} topTileGroup
     */
    _splitTilingPreviewSingle(window, hoveredRect, topTileGroup) {
        const atTop = this._lastPointerPos.y < hoveredRect.y + hoveredRect.height * .25;
        const atBottom = this._lastPointerPos.y > hoveredRect.y + hoveredRect.height * .75;
        const atRight = this._lastPointerPos.x > hoveredRect.x + hoveredRect.width * .75;
        const atLeft = this._lastPointerPos.x < hoveredRect.x + hoveredRect.width * .25;
        const splitVertically = atTop || atBottom;
        const splitHorizontally = atLeft || atRight;

        if (splitHorizontally || splitVertically) {
            const idx = atTop && !atRight || atLeft ? 0 : 1;
            const size = splitHorizontally ? hoveredRect.width : hoveredRect.height;
            const orienation = splitHorizontally ? Orientation.V : Orientation.H;
            this._tileRect = hoveredRect.getUnitAt(idx, size / 2, orienation);
        } else {
            this._tileRect = hoveredRect.copy();
        }

        if (!this._tilePreview.needsUpdate(this._tileRect))
            return;

        const monitor = global.display.get_current_monitor();
        this._tilePreview.open(window, this._tileRect.meta, monitor);
        this._splitRects.clear();

        const hoveredWindow = topTileGroup.find(w => {
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
     * Similiar to _splitTilingPreviewSingle(). But it's activated by hovering
     * the very edges of a tiled window. And instead of affecting just 1 window
     * it can possibly re-tile multiple windows. A tiled window will be affected,
     * if it aligns with the edge that is being hovered. It's probably easier
     * to understand, if you see it in action first rather than reading about it.
     *
     * @param {Meta.Window} window
     * @param {Rect} hoveredRect
     * @param {Meta.Window[]} topTileGroup
     * @param {object} hovered contains booleans at which position the
     *      `hoveredRect` is hovered.
     */
    _splitTilingPreviewGroup(window, hoveredRect, topTileGroup, hovered) {
        // Find the smallest window that will be affected and use it to calcuate
        // the sizes of the preview. Determine the new tileRects for the rest
        // of the tileGroup via Rect.minus().
        const smallestWindow = topTileGroup.reduce((smallest, w) => {
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
                return topTileGroup.reduce((x1x2, w) => {
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
                return topTileGroup.reduce((y1y2, w) => {
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

        topTileGroup.forEach(w => {
            const leftOver = w.tiledRect.minus(this._tileRect);
            const splitRect = leftOver[0];
            // w isn't an affected window.
            if (splitRect?.equal(this._tileRect) ?? true)
                return;

            this._splitRects.set(w, splitRect);
        });
    }

    _fixedLayoutTilingPreview(window) {
        for (const rect of this._fixedLayout) {
            if (rect.containsPoint(this._lastPointerPos)) {
                this._tileRect = rect.copy();
                this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
                return;
            }
        }

        this._tileRect = null;
        this._tilePreview.close();
    }
};
