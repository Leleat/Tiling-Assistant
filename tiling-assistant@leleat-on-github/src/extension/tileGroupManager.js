'use strict';

const Meta = imports.gi.Meta;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Settings = Me.imports.src.common.Settings;

/**
 * Helper class for Util:
 * This class tracks the different tileGroups for each tiled window.
 * Windows in a tileGroup will be raised together, if a tiled window
 * is raised (and if the setting isn't disabled).
 */

var Manager = class TileGroupManager { // eslint-disable-line no-unused-vars

    constructor() {
        // { windowId1: int, windowId2: int, ... }
        this._groupRaiseIds = new Map();
        // { windowId1: int, windowId2: int, ... }
        this._unmanagedIds = new Map();
        // { windowId1: [windowIdX, windowIdY, ...], windowId2: [,,,]... }
        this._tileGroups = new Map();
    }

    destroy() {
        this._groupRaiseIds.forEach((signalId, windowId) => {
            this._getWindow(windowId).disconnect(signalId);
        });
        this._groupRaiseIds.clear();

        this._unmanagedIds.forEach((signalId, windowId) => {
            this._getWindow(windowId).disconnect(signalId);
        });
        this._unmanagedIds.clear();

        this._tileGroups.clear();
    }

    /**
     * Creates a tile group of windows to raise them together, if one of them
     * is raised.
     *
     * @param {Meta.Windows[]} tileGroup an array of Meta.Windows to group
     *      together.
     */
    updateTileGroup(tileGroup) {
        tileGroup.forEach(window => {
            const windowId = window.get_id();
            this._tileGroups.set(windowId, tileGroup.map(w => w.get_id()));

            if (this._groupRaiseIds.has(windowId))
                window.disconnect(this._groupRaiseIds.get(windowId));

            this._groupRaiseIds.set(windowId, window.connect('raised', raisedWindow => {
                const raisedWindowId = raisedWindow.get_id();
                if (Settings.getBoolean(Settings.RAISE_TILE_GROUPS)) {
                    const raisedWindowsTileGroup = this._tileGroups.get(raisedWindowId);
                    raisedWindowsTileGroup.forEach(wId => {
                        const w = this._getWindow(wId);
                        // May be undefined, if w was just closed. This would
                        // automatically call dissolveTileGroup() with the signal
                        // but in case I missed / don't know about other cases where
                        // w may be nullish, dissolve the tileGroups anyway.
                        if (!w) {
                            this.dissolveTileGroup(wId);
                            return;
                        }

                        // Disconnect the raise signal, so we don't end up
                        // in an infinite loop of windows raising each other.
                        if (this._groupRaiseIds.has(wId)) {
                            w.disconnect(this._groupRaiseIds.get(wId));
                            this._groupRaiseIds.delete(wId);
                        }

                        w.raise();
                    });

                    // Re-raise the just raised window so it may not be below
                    // other tiled window otherwise when untiling via keyboard
                    // it may be below other tiled windows.
                    raisedWindow.raise();
                }

                // Re-establish the tileGroups after having disconnected
                // the raise signals before.
                const raisedTileGroup = this._tileGroups.get(raisedWindowId);
                this.updateTileGroup(this._getAllWindows()
                    .filter(w => raisedTileGroup.includes(w.get_id())));
            }));

            if (this._unmanagedIds.has(windowId))
                window.disconnect(this._unmanagedIds.get(windowId));

            this._unmanagedIds.set(windowId, window.connect('unmanaged', () =>
                this.dissolveTileGroup(windowId)));
        });
    }

    /**
     * Delete the tile group of a window and remove that window from other
     * tiled windows' tile groups.
     *
     * @param {number} windowId the id of a Meta.Window.
     */
    dissolveTileGroup(windowId) {
        const window = this._getWindow(windowId);
        if (this._groupRaiseIds.has(windowId)) {
            window && window.disconnect(this._groupRaiseIds.get(windowId));
            this._groupRaiseIds.delete(windowId);
        }

        if (this._unmanagedIds.has(windowId)) {
            window && window.disconnect(this._unmanagedIds.get(windowId));
            this._unmanagedIds.delete(windowId);
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
     * @returns {Map<number,number>}
     *      For ex: { windowId1: [windowIdX, windowIdY, ...], windowId2: ... }
     */
    getTileGroups() {
        return this._tileGroups;
    }

    /**
     * @param {Map<number, number>} tileGroups
     *      For ex: { windowId1: [windowIdX, windowIdY, ...], windowId2: ... }
     */
    setTileGroups(tileGroups) {
        this._tileGroups = tileGroups;
    }

    /**
     * @param {Meta.Window} window a Meta.Window.
     * @returns {Array} an array of Meta.Windows, which are in `window`'s
     *      tile group (including the `window` itself).
     */
    getTileGroupFor(window) {
        const tileGroup = this._tileGroups.get(window.get_id());
        return this._getAllWindows().filter(w => tileGroup.includes(w.get_id()));
    }

    _getAllWindows() {
        return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
    }

    _getWindow(windowId) {
        return this._getAllWindows().find(w => w.get_id() === windowId);
    }
};
