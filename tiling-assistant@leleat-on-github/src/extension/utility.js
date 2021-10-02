'use strict';

const { Clutter, GLib, Meta, Shell, St } = imports.gi;
const { altTab: AltTab, main: Main } = imports.ui;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Direction, Orientation, Settings, Shortcuts } = Me.imports.src.common;
const { Axis, Rect } = Me.imports.src.extension.geometry;
const TileGroupManager = Me.imports.src.extension.tileGroupManager.Manager;

const GNOME_VERSION = parseFloat(imports.misc.config.PACKAGE_VERSION);

/**
 * Library of commonly used functions for the extension.js' files
 * (and *not* the prefs files)
 */

var Util = class Utility { // eslint-disable-line no-unused-vars

    static initialize() {
        this._tileGroupManager = new TileGroupManager();
    }

    static destroy() {
        this._tileGroupManager.destroy();
        this._tileGroupManager = null;
    }

    /**
     * Performs an approximate equality check. There will be times when
     * there will be inaccuracies. For example, the user may enable window
     * gaps and resize 2 tiled windows and try to line them up manually.
     * But since the gaps are implemented with this extension, there will
     * be no window snapping. So the windows won't be aligned pixel
     * perfectly... in that case we first check approximately and correct
     * the inaccuracies afterwards.
     *
     * @param {number} value
     * @param {number} value2
     * @param {number} [margin=4]
     * @returns {boolean} wether the values are approximately equal.
     */
    static equal(value, value2, margin = 4) {
        return Math.abs(value - value2) <= margin;
    }

    /**
     * @param {{x, y}} pointA
     * @param {{x, y}} pointB
     * @returns {number} the distance between `pointA` and `pointB`,
     */
    static getDistance(pointA, pointB) {
        const diffX = pointA.x - pointB.x;
        const diffY = pointA.y - pointB.y;
        return Math.sqrt(diffX * diffX + diffY * diffY);
    }

    /**
     * @param {number} keyVal
     * @param {Direction} direction
     * @returns {boolean} wether the `keyVal` is considered to be in the
     *      direction of `direction`.
     */
    static isDirection(keyVal, direction) {
        switch (direction) {
        case Direction.N:
            return keyVal === Clutter.KEY_Up
                        || keyVal === Clutter.KEY_w || keyVal === Clutter.KEY_W
                        || keyVal === Clutter.KEY_k || keyVal === Clutter.KEY_K;

        case Direction.S:
            return keyVal === Clutter.KEY_Down
                        || keyVal === Clutter.KEY_s || keyVal === Clutter.KEY_S
                        || keyVal === Clutter.KEY_j || keyVal === Clutter.KEY_J;

        case Direction.W:
            return keyVal === Clutter.KEY_Left
                        || keyVal === Clutter.KEY_a || keyVal === Clutter.KEY_A
                        || keyVal === Clutter.KEY_h || keyVal === Clutter.KEY_H;

        case Direction.E:
            return keyVal === Clutter.KEY_Right
                        || keyVal === Clutter.KEY_d || keyVal === Clutter.KEY_D
                        || keyVal === Clutter.KEY_l || keyVal === Clutter.KEY_L;
        }

        return false;
    }

    /**
     * @param {number} modMask a Clutter.ModifierType.
     * @returns wether the current event the modifier at `modMask`.
     */
    static isModPressed(modMask) {
        const event = Clutter.get_current_event();
        const modifiers = event?.get_state() ?? 0;
        return modifiers & modMask;
    }

    /**
     * @param {Meta.Window} window a Meta.Window.
     * @returns wether the window is maximized. Be it using GNOME's native
     *      maximization or the maximization by this extension when using gaps.
     */
    static isMaximized(window) {
        const workArea = window.get_work_area_current_monitor();
        return window.get_maximized() === Meta.MaximizeFlags.BOTH
                || (window.tiledRect?.equal(workArea));
    }

    /**
     * @param {boolean} [currentWorkspace=true] determines wether we only want
     *      the windows from the current workspace.
     * @returns {Meta.Windows[]} an array of of the open Meta.Windows in
     *      stacking order.
     */
    static getWindows(currentWorkspace = true) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const openWindows = AltTab.getWindows(currentWorkspace ? activeWs : null);
        const orderedOpenWindows = global.display.sort_windows_by_stacking(openWindows);
        return orderedOpenWindows.reverse().filter(w => {
            return w.allows_move() && w.allows_resize() || this.isMaximized(w);
        });
    }

    /**
     * Gets the top most tiled window group; that means they complement each
     * other and don't intersect. This may differ from the TileGroupManager's
     * *tracked* tile groups since floating windows may overlap some tiled
     * windows *at the moment* when this function is called.
     *
     * @param {boolean} [ignoreTopWindow=true] wether we ignore the top window
     *      for the consideration of overlaps.
     * @param {number} [monitor=null] get the group for the monitor number.
     * @returns {Meta.Windows[]} an array of tiled Meta.Windows.
     */
    static getTopTileGroup(ignoreTopWindow = true, monitor = null) {
        const openWindows = this.getWindows();
        const groupedWindows = [];
        const notGroupedWindows = [];
        // Optionally, set a custom monitorNr. This is used for the 'grace period'.
        // When trying to tile window by quickly dragging (and releasing) a window
        // over a screen edge. Even if there is a different monitor there, we want
        // to stick to the old monitor for a short period of time.
        monitor = monitor ?? openWindows[0]?.get_monitor();

        for (let i = ignoreTopWindow ? 1 : 0; i < openWindows.length; i++) {
            const window = openWindows[i];
            if (window.get_monitor() !== monitor)
                continue;

            if (window.isTiled) {
                const wRect = window.tiledRect;

                // If a non-grouped window in a higher stack order overlaps the
                // currently tested tiled window, the currently tested tiled
                // window isn't part of the top tile group.
                const overlapsNonGroupedWindows = notGroupedWindows.some(w => {
                    const rect = w.tiledRect ?? new Rect(w.get_frame_rect());
                    return rect.overlap(wRect);
                });
                // Same applies for already grouped windows; but only check if,
                // it doesn't already overlap non-grouped windows.
                const overlapsGroupedWindows = !overlapsNonGroupedWindows
                        && groupedWindows.some(w => w.tiledRect.overlap(wRect));

                if (overlapsNonGroupedWindows || overlapsGroupedWindows)
                    notGroupedWindows.push(window);
                else
                    groupedWindows.push(window);

            } else {
                // The window is maximized, so all windows below it can't belong
                // to this group anymore.
                if (this.isMaximized(window))
                    break;

                // Ignore non-tiled windows, which are always-on-top, for the
                // calculation since they are probably some utility apps etc.
                if (!window.is_above())
                    notGroupedWindows.push(window);
            }
        }

        return groupedWindows;
    }

    /**
     * Gets the free screen space (1 big Rect). If the free screen space
     * is ambigious that means it consists of multiple (unaligned) rectangles
     * (for ex.: 2 diagonally opposing quarters). In that case we return null.
     *
     * @param {Rect[]} rectList an array of Rects, which occupy the screen.
     * @returns {Rect|null} a Rect, which represent the free screen space.
     */
    static getFreeScreen(rectList) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
        const freeScreenRects = workArea.minus(rectList);
        if (!freeScreenRects.length)
            return null;

        // Create the union of all freeScreenRects and calculate the sum
        // of their areas. If the area of the union-rect equals the area
        // of the individual rects, the individual rects align properly.
        const startRect = new Rect(freeScreenRects[0].x, freeScreenRects[0].y, 0, 0);
        const { checkSum, combinedRect } = freeScreenRects.reduce((result, rect) => {
            result.checkSum += rect.area;
            result.combinedRect = result.combinedRect.union(rect);
            return result;
        }, { checkSum: 0, combinedRect: startRect });

        if (combinedRect.area !== checkSum)
            return null;

        // Random min. size requirement
        if (combinedRect.width < 250 || combinedRect.height < 250)
            return null;

        return combinedRect;
    }

    /**
     * Gets the best available free screen rect. If a `currRect` is passed,
     * instead this will return an expanded copy of that rect filling all
     * the available space around it.
     *
     * @param {Rect[]} rectList an array of Rects, which occupy the screen.
     *      Like usual, they shouldn't overlap each other.
     * @param {Rect} [currRect=null] a Rect, which may be expanded.
     * @param {Orientation} [orientation=null] The direction we want to expand
     *      `currRect` into. If `null`, expand in all directions.
     * @returns {Rect} a new Rect.
     */
    static getBestFreeRect(rectList, currRect = null, orientation = null) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
        const freeRects = workArea.minus(rectList);
        if (!freeRects.length) {
            const activeWs = global.workspace_manager.get_active_workspace();
            const monitor = global.display.get_current_monitor();
            const workArea = activeWs.get_work_area_for_monitor(monitor);
            return currRect ?? new Rect(workArea);
        }

        // Try to expand the currRect to fill the rest of the space
        // that is available around it.
        if (currRect) {
            const isVert = (orientation ?? Orientation.V) === Orientation.V;
            const [xpndPos1, xpndPos2] = isVert ? ['y', 'y2'] : ['x', 'x2'];
            const [unxpndPos1, unxpndPos2] = isVert ? ['x', 'x2'] : ['y', 'y2'];

            // Filter the rects to only keep the ones directly bordering the
            // currRect and sort the array so that the free rects are ordered
            // from the left to the right or from the top to the bottom. See
            // below for the reasoning.
            const borderingRects = freeRects.filter(r => {
                const axis1 = currRect[xpndPos1] === r[xpndPos2] || currRect[xpndPos2] === r[xpndPos1];
                const axis2 = isVert ? currRect.horizOverlap(r) : currRect.vertOverlap(r);
                return axis1 && axis2;
            }).sort((a, b) => a[unxpndPos1] - b[unxpndPos1]);

            // Separate the rects into the ones that come before (left / top)
            // or after (right / bottom) the current rect.
            const { before, after } = borderingRects.reduce((result, r) => {
                if (currRect[xpndPos1] === r[xpndPos2])
                    result.before.push(r);
                else if (currRect[xpndPos2] === r[xpndPos1])
                    result.after.push(r);

                return result;
            }, { before: [], after: [] });

            // An Axis oject is just an axis-aligned (finite) line. If we want
            // to check wether the current rect can expand on a certain axis
            // (let's say we expand the height), we need to check the *other*
            // (unexpanded) axis. So wether the current rect is bordering free
            // screen rects along its entire *width*. We do this by 'linking'
            // the free screen rects along the relevant axis (width). link()
            // simply combines 2 axes / lines, if they overlap. For this reason
            // we needed to sort the free rects in ascending order before to
            // make sure they overlap. After the linking, we just check, if the
            // combinded link fully contains the current rects unexpanded axis.
            const currAxis = new Axis(currRect[unxpndPos1], currRect[unxpndPos2]);
            const freeRectsEncompassCurrRectAxis = function(freeRects) {
                const linkedAxes = freeRects.reduce((linked, r) => {
                    return linked.link(new Axis(r[unxpndPos1], r[unxpndPos2]));
                }, new Axis(freeRects[0][unxpndPos1], freeRects[0][unxpndPos2]));

                return linkedAxes.contains(currAxis);
            };

            const newRect = currRect.copy();

            // Expand to the left / top.
            if (before.length) {
                if (freeRectsEncompassCurrRectAxis(before)) {
                    const expandStartTo = before.reduce((currSize, rect) => {
                        return Math.max(currSize, rect[xpndPos1]);
                    }, before[0][xpndPos1]);

                    newRect[xpndPos2] += newRect[xpndPos1] - expandStartTo;
                    newRect[xpndPos1] = expandStartTo;
                }
            }

            // Expand to the right / bottom.
            if (after.length) {
                if (freeRectsEncompassCurrRectAxis(after)) {
                    const expandEndTo = after.reduce((currSize, rect) => {
                        return Math.min(currSize, rect[xpndPos2]);
                    }, after[0][xpndPos2]);

                    newRect[xpndPos2] = expandEndTo;
                }
            }

            if (!orientation) {
                // if orientation is null, we expanded vertically. Now we want
                // to expand horizontally as well.
                rectList = [...rectList];
                const currRectIdx = rectList.findIndex(r => r.equal(currRect));
                rectList.splice(currRectIdx, 1);
                rectList.push(newRect);
                return newRect.union(
                    this.getBestFreeRect(rectList, newRect, Orientation.H));

            } else {
                return newRect;
            }

        // No currRect was passed, so we just choose the single biggest free rect
        // and expand it using this function. This is a naive approach and doesn't
        // guarantee that we get the best combination of free screen rects... but
        // it should be good enough.
        } else {
            const biggestSingle = freeRects.reduce((currBiggest, rect) => {
                return currBiggest.area >= rect.area ? currBiggest: rect;
            });
            rectList.push(biggestSingle);

            return this.getBestFreeRect(rectList, biggestSingle);
        }
    }

    /**
     * Gets the nearest Meta.Window in the direction of `dir`.
     *
     * @param {Meta.Windows} currWindow the Meta.Window that the search starts
     *      from.
     * @param {Meta.Windows[]} windows an array of the available Meta.Windows.
     *      It may contain the current window itself. The windows shouldn't
     *      overlap each other.
     * @param {Direction} dir the direction that is look into.
     * @param {boolean} [wrap=true] wether we wrap around,
     *      if there is no Meta.Window in the direction of `dir`.
     * @returns {Meta.Window|null} the nearest Meta.Window.
     */
    static getNearestWindow(currWindow, windows, dir, wrap = true) {
        const getRect = w => w.tiledRect ?? new Rect(w.get_frame_rect());
        const rects = windows.map(w => getRect(w));
        const nearestRect = getRect(currWindow).getNeighbor(dir, rects, wrap);
        if (!nearestRect)
            return null;

        return windows.find(w => getRect(w).equal(nearestRect));
    }

    /**
     * Gets the rectangle for special positions (the screen halves and
     * quarters) adapted to the surrounding rectangles. The position is
     * determined by `shortcut` but this function isn't limited to just
     * keyboard shortcuts. This is also used when dnd-ing a window.
     *
     * Examples: Shortcuts.LEFT gets the left-most rectangle with the height
     * of the workArea. Shortcuts.BOTTOM_LEFT gets the rectangle touching the
     * bottom left screen corner etc... If there is no other rect to adapt to
     * we default to half the workArea.
     *
     * @param {Shortcut} shortcut the side / quarter to get the tile rect for.
     * @param {Rect} workArea the workArea.
     * @param {number} [monitor=null] the monitor number we want to get the
     *      rect for. This may not always be the current monitor. It is only
     *      used to implement the 'grace period' to enable quickly tiling a
     *      window using the screen edges even if there is another monitor
     *      at that edge.
     * @returns a Rect.
     */
    static getTileFor(shortcut, workArea, monitor = null) {
        const topTileGroup = this.getTopTileGroup(true, monitor);
        const tRects = topTileGroup.map(w => w.tiledRect);
        const screenRects = tRects.concat(workArea.minus(tRects));

        switch (shortcut) {
        case Shortcuts.MAXIMIZE: {
            return workArea.copy();

        } case Shortcuts.LEFT: {
            const left = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
            const { width } = left ?? workArea.getUnitAt(0, workArea.width / 2, Orientation.V);
            return new Rect(
                workArea.x,
                workArea.y,
                width,
                workArea.height
            );

        } case Shortcuts.RIGHT: {
            const right = screenRects.find(r => r.x2 === workArea.x2 && r.width !== workArea.width);
            const { width } = right ?? workArea.getUnitAt(1, workArea.width / 2, Orientation.V);
            return new Rect(
                workArea.x2 - width,
                workArea.y,
                width,
                workArea.height
            );

        } case Shortcuts.TOP: {
            const top = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
            const { height } = top ?? workArea.getUnitAt(0, workArea.height / 2, Orientation.H);
            return new Rect(
                workArea.x,
                workArea.y,
                workArea.width,
                height
            );

        } case Shortcuts.BOTTOM: {
            const bottom = screenRects.find(r => r.y2 === workArea.y2 && r.height !== workArea.height);
            const { height } = bottom ?? workArea.getUnitAt(1, workArea.height / 2, Orientation.H);
            return new Rect(
                workArea.x,
                workArea.y2 - height,
                workArea.width,
                height
            );

        } case Shortcuts.TOP_LEFT: {
            const left = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
            const { width } = left ?? workArea.getUnitAt(0, workArea.width / 2, Orientation.V);
            const top = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
            const { height } = top ?? workArea.getUnitAt(0, workArea.height / 2, Orientation.H);
            return new Rect(
                workArea.x,
                workArea.y,
                width,
                height
            );

        } case Shortcuts.TOP_RIGHT: {
            const right = screenRects.find(r => r.x2 === workArea.x2 && r.width !== workArea.width);
            const { width } = right ?? workArea.getUnitAt(1, workArea.width / 2, Orientation.V);
            const top = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
            const { height } = top ?? workArea.getUnitAt(0, workArea.height / 2, Orientation.H);
            return new Rect(
                workArea.x2 - width,
                workArea.y,
                width,
                height
            );

        } case Shortcuts.BOTTOM_LEFT: {
            const left = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
            const { width } = left ?? workArea.getUnitAt(0, workArea.width / 2, Orientation.V);
            const bottom = screenRects.find(r => r.y2 === workArea.y2 && r.height !== workArea.height);
            const { height } = bottom ?? workArea.getUnitAt(1, workArea.height / 2, Orientation.H);
            return new Rect(
                workArea.x,
                workArea.y2 - height,
                width,
                height
            );

        } case Shortcuts.BOTTOM_RIGHT: {
            const right = screenRects.find(r => r.x2 === workArea.x2 && r.width !== workArea.width);
            const { width } = right ?? workArea.getUnitAt(1, workArea.width / 2, Orientation.V);
            const bottom = screenRects.find(r => r.y2 === workArea.y2 && r.height !== workArea.height);
            const { height } = bottom ?? workArea.getUnitAt(1, workArea.height / 2, Orientation.H);
            return new Rect(
                workArea.x2 - width,
                workArea.y2 - height,
                width,
                height
            );
        }}
    }

    /**
     * Tiles or untiles a window based on its current tiling state.
     *
     * @param {Meta.Window} window a Meta.Window.
     * @param {Rect} rect the Rect the `window` tiles to or untiles from.
     */
    static toggleTiling(window, rect) {
        const workArea = window.get_work_area_current_monitor();
        const equalsWA = rect.equal(workArea);
        const equalsTile = window.tiledRect && rect.equal(window.tiledRect);
        if (window.isTiled && equalsTile || this.isMaximized(window) && equalsWA)
            this.untile(window);
        else
            this.tile(window, rect);
    }

    /**
     * Tiles a window to a specific spot and setup all tiling properties.
     *
     * @param {Meta.Window} window a Meta.Window to tile.
     * @param {Rect} newRect the Rect the `window` will be tiled to.
     * @param {boolean} [openTilingPopup=true] decides, if we open a Tiling
     *      Popup after the window is tiled and there is unambiguous free
     *      screen space.
     * @param {boolean} [skipAnim=false] decides, if we skip the tile animation.
     */
    static tile(window, newRect, { openTilingPopup = true, skipAnim = false } = {}) {
        if (!window || window.is_skip_taskbar())
            return;

        const wasMaximized = window.get_maximized();
        if (wasMaximized)
            window.unmaximize(wasMaximized);

        if (!window.allows_resize() || !window.allows_move())
            return;

        window.unminimize();
        // Raise window since tiling with the popup means that
        // the window can be below others.
        window.raise();

        // Remove window from the other windows' tileGroups so it
        // doesn't falsely get raised with them.
        this.dissolveTileGroup(window.get_id());

        const oldRect = new Rect(window.get_frame_rect());
        const gap = Settings.getInt(Settings.WINDOW_GAP);
        const monitor = window.get_monitor();
        const workArea = new Rect(window.get_work_area_for_monitor(monitor));
        const maximize = newRect.equal(workArea);

        window.isTiled = !maximize;
        if (!window.untiledRect)
            window.untiledRect = oldRect;

        const maxUsesGap = gap && Settings.getBoolean(Settings.MAXIMIZE_WITH_GAPS);
        if (maximize && !maxUsesGap) {
            window.tiledRect = null;
            window.maximize(Meta.MaximizeFlags.BOTH);
            return;
        }

        // Save the intended tiledRect for accurate operations later.
        // Workaround for windows which can't be resized freely...
        // For ex. which only resize in full rows/columns like gnome-terminal
        window.tiledRect = newRect.copy();

        const x = newRect.x + (gap - (workArea.x === newRect.x ? 0 : gap / 2));
        const y = newRect.y + (gap - (workArea.y === newRect.y ? 0 : gap / 2));
        // Lessen gap by half when the window isn't on the
        // left or the right edge of the screen
        const width = newRect.width
                - (2 * gap - (workArea.x === newRect.x ? 0 : gap / 2)
                - (workArea.x2 === newRect.x2 ? 0 : gap / 2));
        const height = newRect.height
                - (2 * gap - (workArea.y === newRect.y ? 0 : gap / 2)
                - (workArea.y2 === newRect.y2 ? 0 : gap / 2));

        // Animations
        const wActor = window.get_compositor_private();
        if (Settings.getBoolean(Settings.ENABLE_TILE_ANIMATIONS) && !skipAnim && wActor) {
            const onlyMove = oldRect.width === width && oldRect.height === height;
            if (onlyMove) { // Custom anims because they don't exist
                const clone = new St.Widget({
                    content: GNOME_VERSION < 41
                        ? Shell.util_get_content_for_window_actor(wActor, oldRect.meta)
                        : wActor.paint_to_content(oldRect.meta),
                    x: oldRect.x,
                    y: oldRect.y,
                    width: oldRect.width,
                    height: oldRect.height
                });
                Main.uiGroup.add_child(clone);
                wActor.hide();

                clone.ease({
                    x, y, width, height,
                    duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        wActor.show();
                        clone.destroy();
                    }
                });

            } else if (wasMaximized) {
                //
            } else {
                // HACK => journalctl: 'error in size change accounting'...
                Main.wm._prepareAnimationInfo(
                    global.window_manager,
                    wActor,
                    oldRect.meta,
                    Meta.SizeChange.MAXIMIZE
                );
            }
        }

        // Wayland workaround because some apps dont work properly
        // e. g. tiling Nautilus and then choosing firefox from the popup
        Meta.is_wayland_compositor() && window.move_frame(false, x, y);
        // user_op as false needed for some apps
        window.move_resize_frame(false, x, y, width, height);

        if (maximize)
            return;

        // Setup the (new) tileGroup to raise tiled windows as a group
        // but only allow a window to be part of 1 tileGroup at a time
        const topTileGroup = this.getTopTileGroup(false);
        topTileGroup.forEach(w => this.dissolveTileGroup(w.get_id()));
        this.updateTileGroup(topTileGroup);

        openTilingPopup && this.tryOpeningTilingPopup();
    }

    /**
     * Untiles a tiled window and delete all tiling properties.
     *
     * @param {Meta.Window} window a Meta.Window to untile.
     * @param {boolean} [restoreFullPos=true] decides, if we restore the
     *      pre-tile position or wether the size while keeping the titlebar
     *      at the relative same position.
     * @param {number} [xAnchor=undefined] used when wanting to restore the
     *      size while keeping titlebar at the relative x position. By default,
     *      we use the pointer position.
     * @param {boolean} [skipAnim=false] decides, if we skip the until animation.
     */
    static untile(window, { restoreFullPos = true, xAnchor = undefined, skipAnim = false } = {}) {
        const wasMaximized = window.get_maximized();
        if (wasMaximized)
            window.unmaximize(wasMaximized);

        if (!window.untiledRect || !window.allows_resize() || !window.allows_move())
            return;

        // If you tiled a window and then used the popup to tile more
        // windows, the consecutive windows will be raised above the first
        // one. So untiling the initial window after tiling more windows with
        // the popup (without re-focusing the initial window), means the
        // untiled window will be below the others.
        window.raise();

        const untileAnim = Settings.getBoolean(Settings.ENABLE_UNTILE_ANIMATIONS);
        if (!wasMaximized && !skipAnim && untileAnim)
            Main.wm._prepareAnimationInfo(
                global.window_manager,
                window.get_compositor_private(),
                window.get_frame_rect(),
                Meta.SizeChange.UNMAXIMIZE
            );

        const oldRect = window.untiledRect;
        if (restoreFullPos) {
            window.move_resize_frame(false, oldRect.x, oldRect.y, oldRect.width, oldRect.height);

        } else {
            // Resize the window while keeping the relative x pos (of the pointer)
            const currWindowFrame = new Rect(window.get_frame_rect());
            xAnchor = xAnchor ?? global.get_pointer()[0];
            const relativeMouseX = (xAnchor - currWindowFrame.x) / currWindowFrame.width;
            const newPosX = xAnchor - oldRect.width * relativeMouseX;

            // Wayland workaround for DND / restore position
            Meta.is_wayland_compositor() && window.move_frame(true, newPosX, currWindowFrame.y);
            window.move_resize_frame(true, newPosX, currWindowFrame.y, oldRect.width, oldRect.height);
        }

        this.dissolveTileGroup(window.get_id());
        window.isTiled = false;
        window.tiledRect = null;
        window.untiledRect = null;
    }

    /**
     * Opens the Tiling Popup, if there is unambiguous free screen space,
     * and offer to tile an open window to that spot.
     */
    static tryOpeningTilingPopup() {
        if (!Settings.getBoolean(Settings.ENABLE_TILING_POPUP))
            return;

        const currWorkspace = Settings.getBoolean(Settings.CURR_WORKSPACE_ONLY);
        const openWindows = this.getWindows(currWorkspace);
        const topTileGroup = this.getTopTileGroup(false);
        topTileGroup.forEach(w => openWindows.splice(openWindows.indexOf(w), 1));
        if (!openWindows.length)
            return;

        const tRects = topTileGroup.map(w => w.tiledRect);
        const freeSpace = this.getFreeScreen(tRects);
        if (!freeSpace)
            return;

        const TilingPopup = Me.imports.src.extension.tilingPopup;
        const popup = new TilingPopup.TilingSwitcherPopup(openWindows, freeSpace);
        if (!popup.show(topTileGroup))
            popup.destroy();
    }

    /**
     * Tries to open an app on a tiling state (in a very dumb way...).
     *
     * @param {Shell.App} app the Shell.App to open and tile.
     * @param {Rect} rect the Rect to tile to.
     * @param {boolean} [openTilingPopup=false] allow the Tiling Popup to
     *      appear, if there is free screen space after the `app` was tiled.
     */
    static openAppTiled(app, rect, openTilingPopup = false) {
        if (!app.can_open_new_window())
            return;

        let sId = global.display.connect('window-created', (d, window) => {
            const disconnectWindowCreateSignal = () => {
                global.display.disconnect(sId);
                sId = 0;
            };

            const firstFrameId = window.get_compositor_private()
                .connect('first-frame', () => {

                    window.get_compositor_private().disconnect(firstFrameId);
                    const winTracker = Shell.WindowTracker.get_default();
                    const openedWindowApp = winTracker.get_window_app(window);
                    // Check, if the created window is from the app and if it allows
                    // to be moved and resized because, for example, Steam uses a
                    // WindowType.Normal window for their loading screen, which we
                    // don't want to trigger the tiling for.
                    if (sId && openedWindowApp && openedWindowApp === app
                        && (window.allows_resize() && window.allows_move()
                                || window.get_maximized())) {

                        disconnectWindowCreateSignal();
                        this.tile(window, rect, { openTilingPopup, skipAnim: true });
                    }
                });

            // Don't immediately disconnect the signal in case the launched
            // window doesn't match the original app since it may be a loading
            // screen or the user started an app inbetween etc... but in case the
            // check above fails disconnect signal after 1 min at the latest
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
                sId && disconnectWindowCreateSignal();
                return GLib.SOURCE_REMOVE;
            });
        });

        app.open_new_window(-1);
    }

    /**
     * Delegates to the TileGroupmanager. See tileGroupManager.js' function.
     *
     * @param {*} tileGroup
     */
    static updateTileGroup(tileGroup) {
        this._tileGroupManager.updateTileGroup(tileGroup);
    }

    /**
     * Delegates to the TileGroupmanager. See tileGroupManager.js' function.
     *
     * @param {*} windowId
     */
    static dissolveTileGroup(windowId) {
        this._tileGroupManager.dissolveTileGroup(windowId);
    }

    /**
     * Delegates to the TileGroupmanager. See tileGroupManager.js' function.
     */
    static getTileGroups() {
        return this._tileGroupManager.getTileGroups();
    }

    /**
     * Delegates to the TileGroupmanager. See tileGroupManager.js' function.
     *
     * @param {*} tileGroups
     */
    static setTileGroups(tileGroups) {
        this._tileGroupManager.setTileGroups(tileGroups);
    }

    /**
     * Delegates to the TileGroupmanager. See tileGroupManager.js' function.
     *
     * @param {*} tileGroups
     */
    static getTileGroupFor(window) {
        return this._tileGroupManager.getTileGroupFor(window);
    }

    /**
     * Shows the tiled rects of the top tile group.
     *
     * @returns {St.Widget[]} an array of St.Widgets to indicate the tiled rects.
     */
    static ___debugShowTiledRects() {
        const topTileGroup = this.getTopTileGroup(false);
        if (!topTileGroup.length) {
            Main.notify('Tiling Assistant', 'No tiled windows / tiled rects.');
            return null;
        }

        const indicators = [];
        topTileGroup.forEach(w => {
            const indicator = new St.Widget({
                style_class: 'tile-preview',
                opacity: 160,
                x: w.tiledRect.x,
                y: w.tiledRect.y,
                width: w.tiledRect.width,
                height: w.tiledRect.height
            });
            Main.uiGroup.add_child(indicator);
            indicators.push(indicator);
        });

        return indicators;
    }

    /**
     * Shows the free screen rects based on the top tile group.
     *
     * @returns {St.Widget[]} an array of St.Widgets to indicate the free
     *      screen rects.
     */
    static ___debugShowFreeScreenRects() {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
        const topTileGroup = this.getTopTileGroup(false);
        const tRects = topTileGroup.map(w => w.tiledRect);
        const freeScreenSpace = this.getFreeScreen(tRects);
        const rects = freeScreenSpace ? [freeScreenSpace] : workArea.minus(tRects);
        if (!rects.length) {
            Main.notify('Tiling Assistant', 'No free screen rects to show.');
            return null;
        }

        const indicators = [];
        rects.forEach(rect => {
            const indicator = new St.Widget({
                style_class: 'tile-preview',
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            });
            Main.uiGroup.add_child(indicator);
            indicators.push(indicator);
        });

        return indicators.length ? indicators : null;
    }

    /**
     * Print the tile groups to the logs.
     */
    static __debugPrintTileGroups() {
        log('--- Tiling Assistant: Start ---');
        const openWindows = this.getWindows();
        openWindows.forEach(w => {
            if (!w.isTiled)
                return;

            log('Tile group for: ' + w.get_wm_class());
            const tileGroup = this.getTileGroupFor(w);
            tileGroup.forEach(tw => log(tw.get_wm_class()));
            log('---');
        });
        log('--- Tiling Assistant: End ---');
    }
};
