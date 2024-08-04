import { Clutter, GLib, GObject, Meta, Mtk, Shell } from '../dependencies/gi.js';
import { Main } from '../dependencies/shell.js';
import { getWindows } from '../dependencies/unexported/altTab.js';

import { Orientation, Settings } from '../common.js';
import { Rect, Util } from './utility.js';

/**
 * Singleton responsible for tiling. Implement the signals in a separate Clutter
 * class so this doesn't need to be instanced.
 */
export class TilingWindowManager {
    static initialize() {
        this._signals = new TilingSignals();

        // { windowId1: [windowIdX, windowIdY, ...], windowId2: [...], ... }
        this._tileGroups = new Map();

        /**
         * {windowId: {isTiled: boolean, tiledRect: {}, untiledRect: {}}}
         */
        this._tileStates = new Map();

        const assertExistenceFor = window => {
            window.assertExistence = () => {};

            window.connectObject(
                'unmanaging',
                () => {
                    window.assertExistence = () => {
                        throw new Error(
                            'Trying to operate on an unmanaging window!'
                        );
                    };
                },
                this
            );
        };

        global.display.list_all_windows().forEach(w => assertExistenceFor(w));
        global.display.connectObject(
            'window-created',
            (_, window) => assertExistenceFor(window),
            this
        );

        global.workspace_manager.connectObject(
            'workspace-added',
            this._onWorkspaceAdded.bind(this),
            this
        );
        global.workspace_manager.connectObject(
            'workspace-removed',
            this._onWorkspaceRemoved.bind(this),
            this
        );
    }

    static destroy() {
        this._signals.destroy();
        this._signals = null;

        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);

        global.display.list_all_windows().forEach(w => {
            w.disconnectObject(this);

            delete w.assertExistence;
        });

        this._tileGroups.clear();
        this._tileStates.clear();

        if (this._openAppTiledTimerId) {
            GLib.Source.remove(this._openAppTiledTimerId);
            this._openAppTiledTimerId = null;
        }

        if (this._wsAddedTimer) {
            GLib.Source.remove(this._wsAddedTimer);
            this._wsAddedTimer = null;
        }

        if (this._wsRemovedTimer) {
            GLib.Source.remove(this._wsRemovedTimer);
            this._wsRemovedTimer = null;
        }
    }

    static connect(signal, func) {
        return this._signals.connect(signal, func);
    }

    static disconnect(id) {
        this._signals.disconnect(id);
    }

    static emit(...params) {
        this._signals.emit(...params);
    }

    /**
     * Gets windows, which can be tiled
     *
     * @param {boolean} [allWorkspaces=false] determines whether we only want
     *      the windows from the current workspace.
     * @returns {Meta.Windows[]} an array of of the open Meta.Windows in
     *      stacking order.
     */
    static getWindows(allWorkspaces = false) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const openWindows = getWindows(allWorkspaces ? null : activeWs);
        // The open windows are not sorted properly when tiling with the Tiling
        // Popup because altTab sorts by focus.
        const sorted = global.display.sort_windows_by_stacking(openWindows);
        return sorted.reverse().filter(w => {
            // I don't think this should normally happen but if it does, this
            // extension can crash GNOME Shell.. so guard against it. A way to
            // have a window's monitor be -1, for example, is explained here:
            // https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4713
            if (w.get_monitor() === -1)
                return false;

            // Assumption: a maximized window can also resize (once unmaximized)
            const canResize = w.allows_move() && w.allows_resize() || this.isMaximized(w);
            return canResize;
        });
    }

    /**
     * @param {Meta.Window} window a Meta.Window.
     * @param {Meta.WorkArea|Rect|null} workArea useful for the grace period
     * @returns whether the window is maximized. Be it using GNOME's native
     *      maximization or the maximization by this extension when using gaps.
     */
    static isMaximized(window, workArea = null) {
        const area = workArea ?? window.get_work_area_current_monitor();
        return window.get_maximized() === Meta.MaximizeFlags.BOTH ||
                window.tiledRect?.equal(area);
    }

    /**
     * Tiles a window to a specific spot and setup all tiling properties.
     *
     * @param {Meta.Window} window a Meta.Window to tile.
     * @param {Rect} newRect the Rect the `window` will be tiled to.
     * @param {boolean} [openTilingPopup=true] decides, if we open a Tiling
     *      Popup after the window is tiled and there is unambiguous free
     *      screen space.
     * @param {number} [number=null] is used to get the workArea in which the
     *      window tiles on. It's used for gap calculation. We can't always rely on
     *      window.get_monitor with its monitor or global.display.get_current_monitor
     *      (the pointer monitor) because of the 'grace period' during a quick dnd
     *      towards a screen border since the pointer and the window will be on the
     *      'wrong' monitor.
     * @param {boolean} [skipAnim=false] decides, if we skip the tile animation.
     * @param {boolean} [tileGroup=null] forces the creation of this tile group.
     * @param {boolean} [fakeTile=false] don't create a new tile group, don't
     *      emit 'tiled' signal or open the Tiling Popup
     */
    static async tile(window, newRect, {
        openTilingPopup = true,
        ignoreTA = false,
        monitorNr = null,
        skipAnim = false,
        fakeTile = false
    } = {}) {
        if (!window || window.is_skip_taskbar())
            return;

        const wasMaximized = window.get_maximized();
        if (wasMaximized)
            window.unmaximize(wasMaximized);

        window.unmake_fullscreen();

        if (!window.allows_resize() || !window.allows_move())
            return;

        // Remove window from the other windows' tileGroups so it
        // doesn't falsely get raised with them.
        this.clearTilingProps(window.get_id());

        window.unmake_above();
        window.unminimize();
        // Raise window since tiling with the popup means that
        // the window can be below others.
        if (window.raise_and_make_recent_on_workspace)
            window.raise_and_make_recent_on_workspace(global.workspace_manager.get_active_workspace());
        else
            window.raise_and_make_recent();

        const oldRect = new Rect(window.get_frame_rect());
        const monitor = monitorNr ?? window.get_monitor();
        const workArea = new Rect(window.get_work_area_for_monitor(monitor));
        const maximize = newRect.equal(workArea);

        window.isTiled = !maximize;
        if (!window.untiledRect)
            window.untiledRect = oldRect;

        if (maximize && !Settings.getBoolean('maximize-with-gap')) {
            window.tiledRect = null;
            // It's possible for a window to maximize() to the wrong monitor.
            // This is very easy to reproduce when dragging a window on the
            // lower half with Super + LMB.
            window.move_to_monitor(monitor);
            window.maximize(Meta.MaximizeFlags.BOTH);
            return;
        }

        // Save the intended tiledRect for accurate operations later.
        // Workaround for windows which can't be resized freely...
        // For ex. which only resize in full rows/columns like gnome-terminal
        window.tiledRect = newRect.copy();

        const { x, y, width, height } = newRect.addGaps(workArea, monitor);

        // Animations
        const wActor = window.get_compositor_private();
        if (Settings.getBoolean('enable-tile-animations') && wActor && !skipAnim) {
            wActor.remove_all_transitions();
            // HACK => journalctl: 'error in size change accounting'...?
            // TODO: no animation if going from maximized -> tiled and back to back multiple times?
            Main.wm._prepareAnimationInfo(
                global.window_manager,
                wActor,
                oldRect.meta,
                Meta.SizeChange.MAXIMIZE
            );
        }

        // See issue #137.
        // Under some circumstances it's possible that windows will tile to the wrong
        // monitor. I can't reproduce it but I suspect that it's because of passing
        // false as the user_op to move_resize_frame. user_op is meant to determine if
        // the window should be clamped to the monitor. A user operation (user_op = true)
        // won't be clamped. So I think there is something unexpected happening.
        // Someone in the issue mentioned that passing true as the user_op fixes the
        // multi-monitor bug.
        //
        // The reason why I set user_op as false originally is that GNOME Terminal (and
        // some other Terminals) will only resize but not move with user_op as true. Try
        // to workaround that by first only moving the window and then resizing it. That
        // workaround was already necessary under Wayland because of some apps. E. g.
        // first tiling Nautilus and then Firefox using the Tiling Popup.
        window.move_to_monitor(monitor);
        window.move_frame(true, x, y);
        window.move_resize_frame(true, x, y, width, height);

        // Maximized with gaps
        if (maximize) {
            this._updateGappedMaxWindowSignals(window);
            this.saveTileState(window);

        // Tiled window
        } else if (!fakeTile) {
            // Make the tile group only consist of the window itself to stop
            // resizing or raising together. Also don't call the Tiling Popup.
            if (Settings.getBoolean('disable-tile-groups') || ignoreTA) {
                this.updateTileGroup([window]);
                this.saveTileState(window);
                return;
            }

            // Setup the (new) tileGroup to raise tiled windows as a group
            const topTileGroup = this._getWindowsForBuildingTileGroup(monitor);
            this.updateTileGroup(topTileGroup);
            this.saveTileState(window);

            this.emit('window-tiled', window);

            if (openTilingPopup)
                await this.tryOpeningTilingPopup();
        }
    }

    /**
     * Untiles a tiled window and delete all tiling properties.
     *
     * @param {Meta.Window} window a Meta.Window to untile.
     * @param {boolean} [restoreFullPos=true] decides, if we restore the
     *      pre-tile position or whether the size while keeping the titlebar
     *      at the relative same position.
     * @param {number} [xAnchor=undefined] used when wanting to restore the
     *      size while keeping titlebar at the relative x position. By default,
     *      we use the pointer position.
     * @param {boolean} [skipAnim=false] decides, if we skip the until animation.
     */
    static untile(window, { restoreFullPos = true, xAnchor = undefined, skipAnim = false, clampToWorkspace = false } = {}) {
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
        if (window.raise_and_make_recent_on_workspace)
            window.raise_and_make_recent_on_workspace(global.workspace_manager.get_active_workspace());
        else
            window.raise_and_make_recent();

        // Animation
        const untileAnim = Settings.getBoolean('enable-untile-animations');
        const wActor = window.get_compositor_private();
        if (untileAnim && !wasMaximized && wActor && !skipAnim) {
            wActor.remove_all_transitions();
            Main.wm._prepareAnimationInfo(
                global.window_manager,
                wActor,
                window.get_frame_rect(),
                Meta.SizeChange.UNMAXIMIZE
            );
        }

        // userOp means that the window won't clamp to the workspace. For DND
        // we don't want to clamp to the workspace, so it's false by default.
        const userOp = !clampToWorkspace;
        const oldRect = window.untiledRect;
        if (restoreFullPos) {
            window.move_resize_frame(userOp, oldRect.x, oldRect.y, oldRect.width, oldRect.height);
        } else {
            // Resize the window while keeping the relative x pos (of the pointer)
            const currWindowFrame = new Rect(window.get_frame_rect());
            xAnchor = xAnchor ?? global.get_pointer()[0];
            const relativeMouseX = (xAnchor - currWindowFrame.x) / currWindowFrame.width;
            const newPosX = xAnchor - oldRect.width * relativeMouseX;

            // Wayland workaround for DND / restore position
            Meta.is_wayland_compositor() && window.move_frame(true, newPosX, currWindowFrame.y);

            window.move_resize_frame(userOp, newPosX, currWindowFrame.y, oldRect.width, oldRect.height);
        }

        this.clearTilingProps(window.get_id());
        window.isTiled = false;
        window.tiledRect = null;
        window.untiledRect = null;

        this.deleteTilingState(window);

        this.emit('window-untiled', window);
    }

    /**
     * Moves the tile group to a different workspace
     *
     * @param {Meta.Window[]} tileGroup
     * @param {Meta.Workspace} workspace
     */
    static moveGroupToWorkspace(tileGroup, workspace) {
        tileGroup.forEach(w => {
            this._blockTilingSignalsFor(w);
            w.change_workspace(workspace);
            this._unblockTilingSignalsFor(w);
        });
    }

    /**
     * Moves the tile group to a different monitor
     *
     * @param {Meta.Window[]} tileGroup
     * @param {number} oldMon
     * @param {number} newMon
     */
    static moveGroupToMonitor(tileGroup, oldMon, newMon) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const oldWorkArea = new Rect(activeWs.get_work_area_for_monitor(oldMon));
        const newWorkArea = new Rect(activeWs.get_work_area_for_monitor(newMon));

        const hScale = oldWorkArea.width / newWorkArea.width;
        const vScale = oldWorkArea.height / newWorkArea.height;

        tileGroup.forEach((w, idx) => {
            const newTile = w.tiledRect.copy();
            newTile.x = newWorkArea.x + Math.floor(newWorkArea.width * ((w.tiledRect.x - oldWorkArea.x) / oldWorkArea.width));
            newTile.y = newWorkArea.y + Math.floor(newWorkArea.height * ((w.tiledRect.y - oldWorkArea.y) / oldWorkArea.height));
            newTile.width = Math.floor(w.tiledRect.width * (1 / hScale));
            newTile.height = Math.floor(w.tiledRect.height * (1 / vScale));

            // Try to align with all previously scaled tiles and the workspace to prevent gaps
            for (let i = 0; i < idx; i++)
                newTile.tryAlignWith(tileGroup[i].tiledRect);

            newTile.tryAlignWith(newWorkArea, 10);

            this.tile(w, newTile, {
                skipAnim: true,
                fakeTile: true
            });
        });

        // The tiling signals got disconnected during the tile() call but not
        // (re-)connected with it since it may have been possible that wrong tile
        // groups would have been created when moving one window after the other
        // to the new monitor. So update the tileGroup now with the full/old group.
        this.updateTileGroup(tileGroup);
    }

    static getTileStates() {
        return this._tileStates;
    }

    /**
     * @param {Map<number, object>} states -
     */
    static setTileStates(states) {
        this._tileStates = states;
    }

    /**
     * @returns {Map<number,number>}
     *      For ex: { windowId1: [windowIdX, windowIdY, ...], windowId2: ... }
     */
    static getTileGroups() {
        return this._tileGroups;
    }

    /**
     * @param {Map<number, number>} tileGroups
     *      For ex: { windowId1: [windowIdX, windowIdY, ...], windowId2: ... }
     */
    static setTileGroups(tileGroups) {
        this._tileGroups = tileGroups;
    }

    /**
     * Creates a tile group of windows to raise them together, if one of them
     * is raised by (re)connecting signals. Usually, this is done automatically
     * by calling tile() and thus shouldn't be done manually. tile() only allows
     * unique/non-overlapping tile groups, so 1 window can't be part of multiple
     * tile groups. But we specifically allow the user to do that sometimes
     * (i. e. ctrl-drag or tile editing mode+space). So manually create the
     * tile group in those cases.
     *
     * @param {Meta.Windows[]} tileGroup an array of Meta.Windows to group
     *      together.
     */
    static updateTileGroup(tileGroup) {
        tileGroup.forEach(window => {
            const windowId = window.get_id();
            const signals = this._signals.getSignalsFor(windowId);

            this._tileGroups.set(windowId, tileGroup.map(w => w.get_id()));

            /**
             * clearTilingProps may have been called before this function,
             * so we need to reconnect all the signals on the tileGroup.
             * Just in case, also try to disconnect old signals...
             */

            // Reconnect unmanaging signal
            const unmanagingSignal = signals.get(TilingSignals.UNMANAGING);
            unmanagingSignal && window.disconnect(unmanagingSignal);

            const umId = window.connect('unmanaging', () => {
                this.clearTilingProps(windowId);
            });
            signals.set(TilingSignals.UNMANAGING, umId);

            // Reconnect ws-changed signal
            const wsChangeSignal = signals.get(TilingSignals.WS_CHANGED);
            wsChangeSignal && window.disconnect(wsChangeSignal);

            const wsId = window.connect('workspace-changed', () => this._onWindowWorkspaceChanged(window));
            signals.set(TilingSignals.WS_CHANGED, wsId);

            // Reconnect raise signal
            const raiseSignal = signals.get(TilingSignals.RAISE);
            raiseSignal && window.disconnect(raiseSignal);

            const raiseId = window.connect('raised', raisedWindow => {
                const raisedWindowId = raisedWindow.get_id();
                if (Settings.getBoolean('enable-raise-tile-group')) {
                    const raisedWindowsTileGroup = this._tileGroups.get(raisedWindowId);
                    raisedWindowsTileGroup.forEach(wId => {
                        const w = this._getWindow(wId);
                        const otherRaiseId = this._signals.getSignalsFor(wId).get(TilingSignals.RAISE);
                        // May be undefined, if w was just closed. This would
                        // automatically call clearTilingProps() with the signal
                        // but in case I missed / don't know about other cases where
                        // w may be nullish, dissolve the tileGroups anyway.
                        if (!w || !otherRaiseId) {
                            this.clearTilingProps(wId);
                            return;
                        }

                        // Prevent an infinite loop of windows raising each other
                        w.block_signal_handler(otherRaiseId);
                        if (w.raise_and_make_recent_on_workspace)
                            w.raise_and_make_recent_on_workspace(global.workspace_manager.get_active_workspace());
                        else
                            w.raise_and_make_recent();
                        w.unblock_signal_handler(otherRaiseId);
                    });

                    // Re-raise the just raised window so it may not be below
                    // other tiled windows otherwise when untiling via keyboard
                    // it may be below other tiled windows.
                    const signalId = this._signals.getSignalsFor(raisedWindowId).get(TilingSignals.RAISE);
                    raisedWindow.block_signal_handler(signalId);
                    if (raisedWindow.raise_and_make_recent_on_workspace)
                        raisedWindow.raise_and_make_recent_on_workspace(global.workspace_manager.get_active_workspace());
                    else
                        raisedWindow.raise_and_make_recent();
                    raisedWindow.unblock_signal_handler(signalId);
                }

                // Update the tileGroup (and reconnect the raised signals) to allow windows
                // to be part of multiple tileGroups: for ex.: tiling a window over another
                // tiled window with ctrl-drag will replace the overlapped window in the old
                // tileGroup but the overlapped window will remember its old tile group to
                // raise them as well, if it is raised.
                const raisedTileGroup = this.getTileGroupFor(raisedWindow);
                this.updateTileGroup(raisedTileGroup);
            });
            signals.set(TilingSignals.RAISE, raiseId);
        });
    }

    /**
     * Deletes the tile group of a window and remove that window from other
     * tiled windows' tile groups. Also disconnects the signals for windows
     * which are maximized-with-gaps.
     *
     * @param {number} windowId the id of a Meta.Window.
     */
    static clearTilingProps(windowId) {
        const window = this._getWindow(windowId);
        const signals = this._signals.getSignalsFor(windowId);

        if (signals.get(TilingSignals.RAISE)) {
            window && window.disconnect(signals.get(TilingSignals.RAISE));
            signals.set(TilingSignals.RAISE, 0);
        }

        if (signals.get(TilingSignals.WS_CHANGED)) {
            window && window.disconnect(signals.get(TilingSignals.WS_CHANGED));
            signals.set(TilingSignals.WS_CHANGED, 0);
        }

        if (signals.get(TilingSignals.UNMANAGING)) {
            window && window.disconnect(signals.get(TilingSignals.UNMANAGING));
            signals.set(TilingSignals.UNMANAGING, 0);
        }

        if (!this._tileGroups.has(windowId))
            return;

        // Delete window's tileGroup
        this._tileGroups.delete(windowId);
        // Delete window from other windows' tileGroup
        this._tileGroups.forEach(tileGroup => {
            const idx = tileGroup.indexOf(windowId);
            idx !== -1 && tileGroup.splice(idx, 1);
        });
    }

    /**
     * @param {Meta.Window} window a Meta.Window.
     * @returns {Meta.Window[]} an array of Meta.Windows, which are in `window`'s
     *      tile group (including the `window` itself).
     */
    static getTileGroupFor(window) {
        const tileGroup = this._tileGroups.get(window.get_id());
        if (!tileGroup)
            return [];

        return this._getAllWindows().filter(w => tileGroup.includes(w.get_id()));
    }

    /**
     * Gets the top most tiled window group; that means they complement each
     * other and don't intersect. This may differ from the TileGroupManager's
     * *tracked* tile groups since floating windows may overlap some tiled
     * windows *at the moment* when this function is called.
     *
     * @param {boolean} [skipTopWindow=true] whether we ignore the focused window
     *      in the active search for the top tile group. The focused window may
     *      still be part of the returned array if it is part of another high-
     *      stacked window's tile group. This is mainly only useful, if the
     *      focused window isn't tiled (for example when dnd-ing a window).
     * @param {number} [monitor=null] get the group for the monitor number.
     * @returns {Meta.Windows[]} an array of tiled Meta.Windows.
     */
    static getTopTileGroup({ skipTopWindow = false, monitor = null } = {}) {
        // 'Raise Tile Group' setting is enabled so we just return the tracked
        // tile group. Same thing for the setting 'Disable Tile Groups' because
        // it's implemented by just making the tile groups consist of single
        // windows (the tiled window itself).
        if (Settings.getBoolean('enable-raise-tile-group') ||
            Settings.getBoolean('disable-tile-groups')
        ) {
            const openWindows = this.getWindows();
            if (!openWindows.length)
                return [];

            if (skipTopWindow) {
                // the focused window isn't necessarily the top window due to always
                // on top windows.
                const idx = openWindows.indexOf(global.display.focus_window);
                idx !== -1 && openWindows.splice(idx, 1);
            }

            const ignoredWindows = [];
            const mon = monitor ??
                global.display.focus_window?.get_monitor() ??
                openWindows[0].get_monitor();

            for (const window of openWindows) {
                if (window.get_monitor() !== mon)
                    continue;

                // Ignore non-tiled windows, which are always-on-top, for the
                // calculation since they are probably some utility apps etc.
                if (window.is_above() && !window.isTiled)
                    continue;

                // Find the first not overlapped tile group, if it exists
                if (window.isTiled) {
                    const overlapsIgnoredWindow = ignoredWindows.some(w => {
                        const rect = w.tiledRect ?? new Rect(w.get_frame_rect());
                        return rect.overlap(window.tiledRect);
                    });

                    if (overlapsIgnoredWindow)
                        ignoredWindows.push(window);
                    else
                        return this.getTileGroupFor(window);
                } else {
                    ignoredWindows.push(window);
                }
            }

            return [];

        // 'Raise Tile Group' setting is disabled so we get thetop most
        // non-overlapped/ing tiled windows ignoring the tile groups.
        } else {
            return this._getTopTiledWindows({ skipTopWindow, monitor });
        }
    }

    /**
     * Gets the free screen space (1 big Rect). If the free screen space
     * is ambiguous that means it consists of multiple (unaligned) rectangles
     * (for ex.: 2 diagonally opposing quarters). In that case we return null.
     *
     * @param {Rect[]} rectList an array of Rects, which occupy the screen.
     * @param {number|null} [monitorNr] useful for the grace period during dnd.
     *      Defaults to pointer monitor.
     * @returns {Rect|null} a Rect, which represent the free screen space.
     */
    static getFreeScreen(rectList, monitorNr = null) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = monitorNr ?? global.display.get_current_monitor();
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
     * @param {Orientation} [orientation=null] The orientation we want to expand
     *      `currRect` into. If `null`, expand in both orientations.
     * @param {Rect} [monitor=null] defaults to pointer monitor.
     * @returns {Rect} a new Rect.
     */
    static getBestFreeRect(rectList, { currRect = null, orientation = null, monitorNr = null } = {}) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = monitorNr ?? global.display.get_current_monitor();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
        const freeRects = workArea.minus(rectList);
        if (!freeRects.length)
            return currRect ?? new Rect(workArea);

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

            // If we want to check whether the current rect can expand on a certain
            // side (let's say we expand the height), we need to check the *other*
            // (unexpanded) side. So whether the current rect is bordering the free
            // screen rects along its *entire width*. We do this by 'union-ing' the
            // free screen rects along the relevant side (our ex.: width). For this
            // reason we needed to sort the free rects in ascending order before
            // to make sure they overlap before trying to 'union' them. After the
            // union-ing, we just check, if the union-ed rect contains the current
            // rects unexpanded side.

            // Orientation doesn't matter here since we are always comparing sides
            // of the same orientation. So just make the side always horizontal.
            const makeSide = (startPoint, endPoint) => new Mtk.Rectangle({
                x: startPoint,
                width: endPoint - startPoint,
                height: 1
            });
            const freeRectsContainCurrRectSide = rects => {
                const currRectSide = makeSide(currRect[unxpndPos1], currRect[unxpndPos2]);
                const linkedSides = rects.reduce((linked, r) => {
                    const side = makeSide(r[unxpndPos1], r[unxpndPos2]);
                    return linked.overlap(side) ? linked.union(side) : linked;
                }, makeSide(rects[0][unxpndPos1], rects[0][unxpndPos2]));

                return linkedSides.contains_rect(currRectSide);
            };

            const newRect = currRect.copy();

            // Expand to the left / top.
            if (before.length) {
                if (freeRectsContainCurrRectSide(before)) {
                    const expandStartTo = before.reduce((currSize, rect) => {
                        return Math.max(currSize, rect[xpndPos1]);
                    }, before[0][xpndPos1]);

                    newRect[xpndPos2] += newRect[xpndPos1] - expandStartTo;
                    newRect[xpndPos1] = expandStartTo;
                }
            }

            // Expand to the right / bottom.
            if (after.length) {
                if (freeRectsContainCurrRectSide(after)) {
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
                    this.getBestFreeRect(rectList, {
                        currRect: newRect,
                        orientation: Orientation.H,
                        monitorNr: monitor
                    }));
            } else {
                return newRect;
            }

        // No currRect was passed, so we just choose the single biggest free rect
        // and expand it using this function. This is a naive approach and doesn't
        // guarantee that we get the best combination of free screen rects... but
        // it should be good enough.
        } else {
            const biggestSingle = freeRects.reduce((currBiggest, rect) => {
                return currBiggest.area >= rect.area ? currBiggest : rect;
            });
            rectList.push(biggestSingle);

            return this.getBestFreeRect(rectList, { currRect: biggestSingle });
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
     * @param {boolean} [wrap=true] whether we wrap around,
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
     * Gets the rectangle for special positions adapted to the surrounding
     * rectangles. The position is determined by `shortcut` but this function
     * isn't limited to just keyboard shortcuts. This is also used when
     * dnd-ing a window.
     *
     * Examples: 'tile-left-half' gets the left-most rectangle with the height
     * of the workArea. 'tile-bottomleft-quarter' gets the rectangle touching the
     * bottom left screen corner etc... If there is no other rect to adapt to
     * we default to half the workArea.
     *
     * @param {string} shortcut the side / quarter to get the tile rect for.
     * @param {Rect} workArea the workArea.
     * @param {number} [monitor=null] the monitor number we want to get the
     *      rect for. This may not always be the current monitor. It is only
     *      used to implement the 'grace period' to enable quickly tiling a
     *      window using the screen edges even if there is another monitor
     *      at that edge.
     * @returns a Rect.
     */
    static getTileFor(shortcut, workArea, monitor = null) {
        // Don't try to adapt a tile rect
        if (Settings.getBoolean('disable-tile-groups'))
            return this.getDefaultTileFor(shortcut, workArea);

        const topTileGroup = this.getTopTileGroup({ skipTopWindow: true, monitor });
        // getTileFor is used to get the adaptive tiles for dnd & tiling keyboard
        // shortcuts. That's why the top most window needs to be ignored when
        // calculating the new tile rect. The top most window is already ignored
        // for dnd in the getTopTileGroup() call. While the top most window will
        // be ignored for the active search in getTopTileGroup, it may still be
        // part of the returned array if it's part of another high-stackeing
        // window's tile group.
        const idx = topTileGroup.indexOf(global.display.focus_window);
        idx !== -1 && topTileGroup.splice(idx, 1);
        const favLayout = Util.getFavoriteLayout(monitor);
        const useFavLayout = favLayout.length && Settings.getBoolean('adapt-edge-tiling-to-favorite-layout');
        const twRects = useFavLayout && favLayout || topTileGroup.map(w => w.tiledRect);

        if (!twRects.length)
            return this.getDefaultTileFor(shortcut, workArea);

        // Return the adapted rect only if it doesn't overlap an existing tile.
        // Ignore an overlap, if a fav layout is used since we always prefer the
        // user set layout in that case.
        const getTile = rect => {
            if (useFavLayout)
                return rect;

            const overlapsTiles = twRects.some(r => r.overlap(rect));
            return overlapsTiles ? this.getDefaultTileFor(shortcut, workArea) : rect;
        };

        const screenRects = twRects.concat(workArea.minus(twRects));
        switch (shortcut) {
            case 'tile-maximize': {
                return workArea.copy();
            } case 'tile-left-half': {
                const left = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
                const { width } = left ?? workArea.getUnitAt(0, workArea.width / 2, Orientation.V);
                const result = new Rect(workArea.x, workArea.y, width, workArea.height);
                return getTile(result);
            } case 'tile-right-half': {
                const right = screenRects.find(r => r.x2 === workArea.x2 && r.width !== workArea.width);
                const { width } = right ?? workArea.getUnitAt(1, workArea.width / 2, Orientation.V);
                const result = new Rect(workArea.x2 - width, workArea.y, width, workArea.height);
                return getTile(result);
            } case 'tile-top-half': {
                const top = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
                const { height } = top ?? workArea.getUnitAt(0, workArea.height / 2, Orientation.H);
                const result = new Rect(workArea.x, workArea.y, workArea.width, height);
                return getTile(result);
            } case 'tile-bottom-half': {
                const bottom = screenRects.find(r => r.y2 === workArea.y2 && r.height !== workArea.height);
                const { height } = bottom ?? workArea.getUnitAt(1, workArea.height / 2, Orientation.H);
                const result = new Rect(workArea.x, workArea.y2 - height, workArea.width, height);
                return getTile(result);
            } case 'tile-topleft-quarter': {
                const left = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
                const { width } = left ?? workArea.getUnitAt(0, workArea.width / 2, Orientation.V);
                const top = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
                const { height } = top ?? workArea.getUnitAt(0, workArea.height / 2, Orientation.H);
                const result = new Rect(workArea.x, workArea.y, width, height);
                return getTile(result);
            } case 'tile-topright-quarter': {
                const right = screenRects.find(r => r.x2 === workArea.x2 && r.width !== workArea.width);
                const { width } = right ?? workArea.getUnitAt(1, workArea.width / 2, Orientation.V);
                const top = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
                const { height } = top ?? workArea.getUnitAt(0, workArea.height / 2, Orientation.H);
                const result = new Rect(workArea.x2 - width, workArea.y, width, height);
                return getTile(result);
            } case 'tile-bottomleft-quarter': {
                const left = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
                const { width } = left ?? workArea.getUnitAt(0, workArea.width / 2, Orientation.V);
                const bottom = screenRects.find(r => r.y2 === workArea.y2 && r.height !== workArea.height);
                const { height } = bottom ?? workArea.getUnitAt(1, workArea.height / 2, Orientation.H);
                const result = new Rect(workArea.x, workArea.y2 - height, width, height);
                return getTile(result);
            } case 'tile-bottomright-quarter': {
                const right = screenRects.find(r => r.x2 === workArea.x2 && r.width !== workArea.width);
                const { width } = right ?? workArea.getUnitAt(1, workArea.width / 2, Orientation.V);
                const bottom = screenRects.find(r => r.y2 === workArea.y2 && r.height !== workArea.height);
                const { height } = bottom ?? workArea.getUnitAt(1, workArea.height / 2, Orientation.H);
                const result = new Rect(workArea.x2 - width, workArea.y2 - height, width, height);
                return getTile(result);
            }
        }
    }

    /**
     * @param {string} shortcut determines, which half/quarter to get the tile for
     * @param {Rect} workArea
     * @returns
     */
    static getDefaultTileFor(shortcut, workArea) {
        switch (shortcut) {
            case 'tile-maximize':
                return workArea.copy();
            case 'tile-left-half':
            case 'tile-left-half-ignore-ta':
                return workArea.getUnitAt(0, workArea.width / 2, Orientation.V);
            case 'tile-right-half':
            case 'tile-right-half-ignore-ta':
                return workArea.getUnitAt(1, workArea.width / 2, Orientation.V);
            case 'tile-top-half':
            case 'tile-top-half-ignore-ta':
                return workArea.getUnitAt(0, workArea.height / 2, Orientation.H);
            case 'tile-bottom-half':
            case 'tile-bottom-half-ignore-ta':
                return workArea.getUnitAt(1, workArea.height / 2, Orientation.H);
            case 'tile-topleft-quarter':
            case 'tile-topleft-quarter-ignore-ta':
                return workArea.getUnitAt(0, workArea.width / 2, Orientation.V).getUnitAt(0, workArea.height / 2, Orientation.H);
            case 'tile-topright-quarter':
            case 'tile-topright-quarter-ignore-ta':
                return workArea.getUnitAt(1, workArea.width / 2, Orientation.V).getUnitAt(0, workArea.height / 2, Orientation.H);
            case 'tile-bottomleft-quarter':
            case 'tile-bottomleft-quarter-ignore-ta':
                return workArea.getUnitAt(0, workArea.width / 2, Orientation.V).getUnitAt(1, workArea.height / 2, Orientation.H);
            case 'tile-bottomright-quarter':
            case 'tile-bottomright-quarter-ignore-ta':
                return workArea.getUnitAt(1, workArea.width / 2, Orientation.V).getUnitAt(1, workArea.height / 2, Orientation.H);
        }
    }

    /**
     * Opens the Tiling Popup, if there is unambiguous free screen space,
     * and offer to tile an open window to that spot.
     */
    static async tryOpeningTilingPopup() {
        if (!Settings.getBoolean('enable-tiling-popup'))
            return;

        const allWs = Settings.getBoolean('tiling-popup-all-workspace');
        const openWindows = this.getWindows(allWs);
        const topTileGroup = this.getTopTileGroup();
        topTileGroup.forEach(w => openWindows.splice(openWindows.indexOf(w), 1));
        if (!openWindows.length)
            return;

        const tRects = topTileGroup.map(w => w.tiledRect);
        const monitor = topTileGroup[0]?.get_monitor(); // for the grace period
        const freeSpace = this.getFreeScreen(tRects, monitor);
        if (!freeSpace)
            return;

        const TilingPopup = await import('./tilingPopup.js');
        const popup = new TilingPopup.TilingSwitcherPopup(openWindows, freeSpace);
        if (!popup.show(topTileGroup))
            popup.destroy();
    }

    /**
     * Tiles or untiles a window based on its current tiling state.
     *
     * @param {Meta.Window} window a Meta.Window.
     * @param {Rect} rect the Rect the `window` tiles to or untiles from.
     */
    static toggleTiling(window, rect, params = {}) {
        const workArea = window.get_work_area_current_monitor();
        const equalsWA = rect.equal(workArea);
        const equalsTile = window.tiledRect && rect.equal(window.tiledRect);
        if (window.isTiled && equalsTile || this.isMaximized(window) && equalsWA)
            this.untile(window, params);
        else
            this.tile(window, rect, params);
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
        if (!app?.can_open_new_window())
            return;

        let createId = global.display.connect('window-created', (src, window) => {
            const wActor = window.get_compositor_private();
            let firstFrameId = wActor?.connect('first-frame', () => {
                wActor.disconnect(firstFrameId);
                firstFrameId = 0;

                const winTracker = Shell.WindowTracker.get_default();
                const openedWindowApp = winTracker.get_window_app(window);
                // Check, if the created window is from the app and if it allows
                // to be moved and resized because, for example, Steam uses a
                // WindowType.Normal window for their loading screen, which we
                // don't want to trigger the tiling for.
                if (createId && openedWindowApp && openedWindowApp === app &&
                        (window.allows_resize() && window.allows_move() || window.get_maximized())
                ) {
                    global.display.disconnect(createId);
                    createId = 0;
                    this.tile(window, rect, { openTilingPopup, skipAnim: true });
                }
            });

            // Don't immediately disconnect the signal in case the launched
            // window doesn't match the original app. It may be a loading screen
            // or the user started an app in between etc... but in case the checks/
            // signals above fail disconnect the signals after 1 min at the latest
            this._openAppTiledTimerId && GLib.Source.remove(this._openAppTiledTimerId);
            this._openAppTiledTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
                createId && global.display.disconnect(createId);
                createId = 0;
                firstFrameId && wActor.disconnect(firstFrameId);
                firstFrameId = 0;
                this._openAppTiledTimerId = null;
                return GLib.SOURCE_REMOVE;
            });
        });

        app.open_new_window(-1);
    }

    static saveTileState(window) {
        const windowState = this._tileStates.get(window.get_id());
        const rectToJsObject = rect => {
            return rect
                ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                : undefined;
        };

        if (windowState) {
            windowState.isTiled = window.isTiled;
            windowState.tiledRect = rectToJsObject(window.tiledRect);
            windowState.untiledRect = rectToJsObject(window.untiledRect);
        } else {
            this._tileStates.set(
                window.get_id(),
                {
                    isTiled: window.isTiled,
                    tiledRect: rectToJsObject(window.tiledRect),
                    untiledRect: rectToJsObject(window.untiledRect)
                }
            );
        }
    }

    static deleteTilingState(window) {
        this._tileStates.delete(window.get_id());
    }

    /**
     * Gets the top windows, which are supposed to be in a tile group. That
     * means windows, which are tiled, and don't overlap each other.
     */
    static _getWindowsForBuildingTileGroup(monitor = null) {
        const openWindows = this.getWindows();
        if (!openWindows.length)
            return [];

        const ignoredWindows = [];
        const result = [];
        const mon = monitor ??
            global.display.focus_window?.get_monitor() ??
            openWindows[0].get_monitor();

        for (const window of openWindows) {
            if (window.get_monitor() !== mon)
                continue;

            if (window.is_above() && !window.isTiled)
                continue;

            if (window.isTiled) {
                // Window was already checked as part of another's tileGroup.
                if (ignoredWindows.includes(window) || result.includes(window))
                    continue;

                // Check for the other windows in the tile group as well regardless
                // of the 'raise tile group' setting so that once the setting is
                // enabled the tile groups are already set properly.

                const tileGroup = this.getTileGroupFor(window);

                // This means `window` is the window that was just tiled and
                // thus has no tileGroup set at this point yet.
                if (!tileGroup.length) {
                    result.push(window);
                    continue;
                }

                const tileGroupOverlaps = tileGroup.some(w =>
                    result.some(r => r.tiledRect.overlap(w.tiledRect)) ||
                    ignoredWindows.some(r => (r.tiledRect ?? new Rect(r.get_frame_rect())).overlap(w.tiledRect)));

                tileGroupOverlaps
                    ? tileGroup.forEach(w => ignoredWindows.push(w))
                    : tileGroup.forEach(w => result.push(w));
            } else {
                // The window is maximized, so all windows below it can't belong
                // to this group anymore.
                if (this.isMaximized(window))
                    break;

                ignoredWindows.push(window);
            }
        }

        return result;
    }

    /**
     * Gets the top most non-overlapped/ing tiled windows ignoring
     * the stacking order and tile groups.
     *
     * @param {{boolean, number}} param1
     */
    static _getTopTiledWindows({ skipTopWindow = false, monitor = null } = {}) {
        const openWindows = this.getWindows();
        if (!openWindows.length)
            return [];

        if (skipTopWindow) {
            // the focused window isn't necessarily the top window due to always
            // on top windows.
            const idx = openWindows.indexOf(global.display.focus_window);
            idx !== -1 && openWindows.splice(idx, 1);
        }

        const topTiledWindows = [];
        const ignoredWindows = [];
        const mon = monitor ??
            global.display.focus_window?.get_monitor() ??
            openWindows[0].get_monitor();

        for (const window of openWindows) {
            if (window.get_monitor() !== mon)
                continue;

            if (window.is_above() && !window.isTiled)
                continue;

            if (window.isTiled) {
                const wRect = window.tiledRect;

                // If a ignored window in a higher stack order overlaps the
                // currently tested tiled window, the currently tested tiled
                // window isn't part of the top tile group.
                const overlapsIgnoredWindow = ignoredWindows.some(w => {
                    const rect = w.tiledRect ?? new Rect(w.get_frame_rect());
                    return rect.overlap(wRect);
                });
                // Same applies for already grouped windows
                const overlapsTopTiledWindows = topTiledWindows.some(w => w.tiledRect.overlap(wRect));

                overlapsIgnoredWindow || overlapsTopTiledWindows
                    ? ignoredWindows.push(window)
                    : topTiledWindows.push(window);
            } else {
                // The window is maximized, so all windows below it can't belong
                // to this group anymore.
                if (this.isMaximized(window))
                    break;

                ignoredWindows.push(window);
            }
        }

        return topTiledWindows;
    }

    /**
     * Blocks all tiling signals for a window.
     *
     * @param {Meta.Window} window
     */
    static _blockTilingSignalsFor(window) {
        const signals = this._signals.getSignalsFor(window.get_id());
        const blockedSignals = [TilingSignals.RAISE, TilingSignals.WS_CHANGED, TilingSignals.UNMANAGING];
        blockedSignals.forEach(s => {
            const id = signals.get(s);
            id && window.block_signal_handler(id);
        });
    }

    /**
     * Unblocks all tiling signals for a window.
     * Should only be called after _blockTilingSignalsFor().
     *
     * @param {Meta.Window} window
     */
    static _unblockTilingSignalsFor(window) {
        const signals = this._signals.getSignalsFor(window.get_id());
        const blockedSignals = [TilingSignals.RAISE, TilingSignals.WS_CHANGED, TilingSignals.UNMANAGING];
        blockedSignals.forEach(s => {
            const id = signals.get(s);
            id && window.unblock_signal_handler(id);
        });
    }

    /**
     * Updates the signals after maximizing a window with gaps.
     *
     * @param {Meta.Window} window
     */
    static _updateGappedMaxWindowSignals(window) {
        const wId = window.get_id();
        const signals = this._signals.getSignalsFor(wId);

        // Refresh 'unmanaging' signal
        const unmanagingSignal = signals.get(TilingSignals.UNMANAGING);
        unmanagingSignal && window.disconnect(unmanagingSignal);

        const umId = window.connect('unmanaging', () => {
            this.clearTilingProps(window.get_id());
        });
        signals.set(TilingSignals.UNMANAGING, umId);

        // Refresh 'workspace-changed' signal
        const wsId = window.connect('workspace-changed', () => this._onWindowWorkspaceChanged(window));
        this._signals.getSignalsFor(wId).set(TilingSignals.WS_CHANGED, wsId);
    }

    /**
     * @returns {Meta.Window[]} an array of *all* windows
     * (and not just the ones relevant to altTab)
     */
    static _getAllWindows() {
        return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
    }

    /**
     * Gets the window matching a window id
     *
     * @param {number} id
     * @returns {Meta.Window}
     */
    static _getWindow(id) {
        return this._getAllWindows().find(w => w.get_id() === id);
    }

    /**
     * A window's workspace-changed signal is used to untile it when the user
     * changes its workspace. However, dynamic workspaces *may* also trigger a
     * ws-changed signal. So listen to the workspace-added/removed signals and
     * 'ignore' the next ws-changed signal. A ws addition/removal doesn't guarantuee
     * a ws-changed signal (e. g. the workspace is at the end), so reset after
     * a short timer.
     */
    static _onWorkspaceAdded() {
        this._ignoreWsChange = true;
        this._wsAddedTimer && GLib.Source.remove(this._wsAddedTimer);
        this._wsAddedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._ignoreWsChange = false;
            this._wsAddedTimer = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * A window's workspace-changed signal is used to untile it when the user
     * changes its workspace. However, dynamic workspaces *may* also trigger a
     * ws-changed signal. So listen to the workspace-added/removed signals and
     * 'ignore' the next ws-changed signal. A ws addition/removal doesn't guarantuee
     * a ws-changed signal (e. g. the workspace is at the end), so reset after
     * a short timer.
     */
    static _onWorkspaceRemoved() {
        this._ignoreWsChange = true;
        this._wsRemovedTimer && GLib.Source.remove(this._wsRemovedTimer);
        this._wsRemovedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._ignoreWsChange = false;
            this._wsRemovedTimer = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * This is only called for tiled and maximized (with gaps) windows.
     * Untile tiled windows. Re-tile maximized windows to fit the whole workArea
     * since a monitor change will also trigger a workspace-change signal.
     * Previously, we tried to adapt the tiled window's size to the new monitor
     * but that is probably too unpredictable. First, it may introduce rounding
     * errors when moving multiple windows of the same tileGroup and second (and
     * more importantly) the behavior with regards to tileGroups isn't clear...
     * Should the entire tileGroup move, if 1 tiled window is moved? If not,
     * there should probably be a way to just detach 1 window from a group. What
     * happens on the new monitor, if 1 window is moved? Should it create a new
     * tileGroup? Should it try to integrate into existing tileGroups on that
     * monitor etc... there are too many open questions. Instead just untile
     * and leave it up to the user to re-tile a window.
     *
     * @param {Meta.Window} window
     */
    static _onWindowWorkspaceChanged(window) {
        // Closing a window triggers a ws-changed signal, which may lead to a
        // crash, if we try to operate on it any further.
        try {
            window.assertExistence();
        } catch {
            return;
        }

        if (this._ignoreWsChange)
            return;

        if (this.isMaximized(window)) {
            const wA = window.get_work_area_for_monitor(window.get_monitor());
            const workArea = new Rect(wA);
            if (workArea.equal(window.tiledRect))
                return;

            this.tile(window, workArea, { openTilingPopup: false, skipAnim: true });
        } else if (window.isTiled) {
            this.untile(window, { restoreFullPos: false, clampToWorkspace: true, skipAnim: Main.overview.visible });
        }
    }
}

/**
 * This is instanced by the 'TilingWindowManager'. It implements the tiling
 * signals and tracks the signal( id)s, which are relevant for tiling:
 * Raise: for group raising.
 * Ws-changed: for untiling a tiled window after its ws changed.
 * Unmanaging: to remove unmanaging tiled windows from the other tileGroups.
 */
const TilingSignals = GObject.registerClass({
    Signals: {
        'window-tiled': { param_types: [Meta.Window.$gtype] },
        'window-untiled': { param_types: [Meta.Window.$gtype] }
    }
}, class TilingSignals extends Clutter.Actor {
    // Relevant 'signal types' (sorta used as an enum / key for the signal map).
    // Tiled windows use all 3 signals; maximized-with-gaps windows only use the
    // workspace-changed and unmanaging signal.
    static RAISE = 'RAISE';
    static WS_CHANGED = 'WS_CHANGED';
    static UNMANAGING = 'UNMANAGING';

    _init() {
        super._init();

        // { windowId1: { RAISE: signalId1, WS_CHANGED: signalId2, UNMANAGING: signalId3 }, ... }
        this._ids = new Map();
    }

    destroy() {
        // Disconnect remaining signals
        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
        this._ids.forEach((signals, windowId) => {
            const window = allWindows.find(w => w.get_id() === windowId);
            window && signals.forEach(s => s && window.disconnect(s));
        });

        super.destroy();
    }

    /**
     * Gets the signal ids for the raise, ws-changed and unmanaging signals
     * for a specific window
     *
     * @param {number} windowId Meta.Window's id
     * @returns {Map<string, number>} the tiling signal ids for the window (id)
     *      with a 'signal type' as the keys
     */
    getSignalsFor(windowId) {
        let ret = this._ids.get(windowId);
        if (!ret) {
            ret = new Map();
            this._ids.set(windowId, ret);
        }

        return ret;
    }
});
