"use strict";

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;

/**
 * This class tracks the different tileGroups for each tiled window.
 * Windows in a tileGroup will be raised together, if a tiled window is raised (and if the setting isn't disabled).
 */

var Manager = class TilingGroupManager {

	constructor() {
		this._groupRaiseIds = new Map(); // {windowId1: int, windowId2: int, ...}
		this._unmanagedIds = new Map(); // {windowId1: int, windowId2: int, ...}
		this._tileGroups = new Map(); // {windowId1: [windowIdX, windowIdY, ...], windowId2: [,,,]...}
	}

	destroy() {
		this._groupRaiseIds.clear();
		this._unmanagedIds.clear();
		this._tileGroups.clear();
	}

	// @tileGroup is an array of metaWindows.
	// save the windowIds in the tracking Maps and connect to the raise signals to raise the tileGroup together
	updateTileGroup(tileGroup) {
		tileGroup.forEach(window => {
			const windowId = window.get_id();
			this._tileGroups.set(windowId, tileGroup.map(w => w.get_id()));
			this._groupRaiseIds.has(windowId) && window.disconnect(this._groupRaiseIds.get(windowId));

			this._groupRaiseIds.set(windowId, window.connect("raised", raisedWindow => {
				const raisedWindowId = raisedWindow.get_id();
				if (MainExtension.settings.get_boolean("enable-raise-tile-group")) {
					const raisedWindowsTileGroup = this._tileGroups.get(raisedWindowId);
					raisedWindowsTileGroup.forEach(wId => {
						// disconnect the raise signal first, so we don't end up
						// in an infinite loop of windows raising each other
						const w = this._getWindow(wId);
						if (this._groupRaiseIds.has(wId)) {
							w.disconnect(this._groupRaiseIds.get(wId));
							this._groupRaiseIds.delete(wId);
						}
						w.raise();
					});

					// re-raise the just raised window so it may not be below other tiled window
					// otherwise when untiling via keyboard it may be below other tiled windows
					raisedWindow.raise();
				}

				// update the tileGroup (and reconnect the raised signals) to allow windows to be part of multiple tileGroups:
				// for ex.: tiling a window over another tiled window will replace the overlapped window in the old tileGroup
				// but the overlapped window will remember its old tile group to raise them as well, if it is raised
				const raisedTileGroup = this._tileGroups.get(raisedWindowId);
				this.updateTileGroup(Util.getOpenWindows().filter(w => raisedTileGroup.includes(w.get_id())));
			}));

			this._unmanagedIds.has(windowId) && window.disconnect(this._unmanagedIds.get(windowId));
			this._unmanagedIds.set(windowId, window.connect("unmanaged", w => this.dissolveTileGroup(windowId)));
		});
	}

	// delete the tileGroup of @window for group-raising and
	// remove the @window from the tileGroup of other tiled windows
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

		// delete @window's tileGroup
		this._tileGroups.delete(windowId);
		// delete @window from other windows' tileGroup
		this._tileGroups.forEach(tileGroup => {
			const idx = tileGroup.indexOf(windowId);
			idx !== -1 && tileGroup.splice(idx, 1);
		});
	}

	getTileGroupFor(window) {
		const tileGroup = this._tileGroups.get(window.get_id());
		return Util.getOpenWindows().filter(w => tileGroup.includes(w.get_id()));
	}

	_getWindow(windowId) {
		return Util.getOpenWindows().find(w => w.get_id() === windowId);
	}
}
