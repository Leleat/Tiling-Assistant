/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

"use strict";

const {main} = imports.ui;
const {Gio, GLib, Meta} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const {Settings} = Me.imports.src.common;
const {Util} = Me.imports.src.utility;

/**
 * 2 entry points:
 * 	1. keyboard shortcuts:
 * 		=> keybindingHandler.js
 * 	2. Grabbing a window:
 * 		=> moveHandler.js (when moving a window)
 * 		=> resizeHandler.js (when resizing a window)
 */

function init() {
};

function enable() {
	Settings.initialize();
	Util.initialize();

	const MoveHandler = Me.imports.src.moveHandler;
	this._moveHandler = new MoveHandler.Handler();
	const ResizeHandler = Me.imports.src.resizeHandler;
	this._resizeHandler = new ResizeHandler.Handler();
	const KeybindingHandler = Me.imports.src.keybindingHandler;
	this._keybindingHandler = new KeybindingHandler.Handler();

	// disable native tiling
	this._gnomeMutterSettings = ExtensionUtils.getSettings("org.gnome.mutter");
	this._gnomeMutterSettings.set_boolean("edge-tiling", false);
	this._gnomeShellSettings = ExtensionUtils.getSettings("org.gnome.shell.overrides");
	this._gnomeShellSettings.set_boolean("edge-tiling", false);

	// also include tiled windows when dragging from the top panel
	this._getDraggableWindowForPosition = main.panel._getDraggableWindowForPosition;
	main.panel._getDraggableWindowForPosition = function (stageX) {
		const workspaceManager = global.workspace_manager;
		const windows = workspaceManager.get_active_workspace().list_windows();
		const allWindowsByStacking = global.display.sort_windows_by_stacking(windows).reverse();

		return allWindowsByStacking.find(w => {
			const rect = w.get_frame_rect();
			const workArea = w.get_work_area_current_monitor();
			return w.is_on_primary_monitor()
					&& w.showing_on_its_workspace()
					&& w.get_window_type() !== Meta.WindowType.DESKTOP
					&& (w.maximized_vertically || (w.tiledRect && w.tiledRect.y === workArea.y))
					&& stageX > rect.x && stageX < rect.x + rect.width;
		});
	};

	// restore window properties after session was unlocked
	_loadAfterSessionLock();
};

function disable() {
	// save window properties, if session was locked to restore after unlock
	_saveBeforeSessionLock();

	this._moveHandler.destroy();
	this._resizeHandler.destroy();
	this._keybindingHandler.destroy();

	Util.destroy();
	Settings.destroy();

	// re-enable native tiling
	this._gnomeMutterSettings.reset("edge-tiling");
	this._gnomeShellSettings.reset("edge-tiling");

	// restore old functions
	main.panel._getDraggableWindowForPosition = this._getDraggableWindowForPosition;

	// delete custom properties
	const openWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
	openWindows.forEach(w => {
		delete w.isTiled;
		delete w.tiledRect;
		delete w.untiledRect;
	});
};

function _saveBeforeSessionLock() {
	if (!main.sessionMode.isLocked)
		return;

	this._wasLocked = true;

	const metaToStringRect = metaRect => metaRect && {
		x: metaRect.x,
		y: metaRect.y,
		width: metaRect.width,
		height: metaRect.height
	};

	// can't just check for isTiled because maximized windows may
	// have an untiledRect as well in case window gaps are used
	const openWindows = Util.getOpenWindows(false);
	const savedWindows = openWindows.filter(w => w.untiledRect).map(w => {
		return {
			windowStableId: w.get_stable_sequence(),
			isTiled: w.isTiled,
			tiledRect: metaToStringRect(w.tiledRect),
			untiledRect: metaToStringRect(w.untiledRect)
		}
	});

	const saveObj = {
		"windows": savedWindows,
		"tileGroups": Array.from(Util.getTileGroups())
	};

	const userPath = GLib.get_user_config_dir();
	const parentPath = GLib.build_filenamev([userPath, "/tiling-assistant"]);
	const parent = Gio.File.new_for_path(parentPath);
	try {parent.make_directory_with_parents(null)} catch (e) {}
	const path = GLib.build_filenamev([parentPath, "/tiledSessionRestore.json"]);
	const file = Gio.File.new_for_path(path);
	try {file.create(Gio.FileCreateFlags.NONE, null)} catch (e) {}
	file.replace_contents(JSON.stringify(saveObj), null, false
			, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
};

function _loadAfterSessionLock() {
	if (!this._wasLocked)
		return;

	this._wasLocked = false;

	const userPath = GLib.get_user_config_dir();
	const path = GLib.build_filenamev([userPath, "/tiling-assistant/tiledSessionRestore.json"]);
	const file = Gio.File.new_for_path(path);
	if (!file.query_exists(null))
		return;

	try {file.create(Gio.FileCreateFlags.NONE, null)} catch (e) {}
	const [success, contents] = file.load_contents(null);
	if (!success || !contents.length)
		return;

	const openWindows = Util.getOpenWindows(false);
	const saveObj = JSON.parse(new TextDecoder().decode(contents));

	const windowObjects = saveObj["windows"];
	windowObjects.forEach(wObj => {
		const {windowStableId, isTiled, tiledRect, untiledRect} = wObj;
		const windowIdx = openWindows.findIndex(w => w.get_stable_sequence() === windowStableId);
		const window = openWindows[windowIdx];
		if (!window)
			return;

		window.isTiled = isTiled;
		window.tiledRect = tiledRect && new Meta.Rectangle({
			x: tiledRect.x,
			y: tiledRect.y,
			width: tiledRect.width,
			height: tiledRect.height
		});
		window.untiledRect = untiledRect && new Meta.Rectangle({
			x: untiledRect.x,
			y: untiledRect.y,
			width: untiledRect.width,
			height: untiledRect.height
		});
	});

	const tileGroups = new Map(saveObj["tileGroups"]);
	Util.setupTileGroups(tileGroups);
	openWindows.forEach(w => {
		if (tileGroups.has(w.get_id())) {
			const group = Util.getTileGroupFor(w);
			Util.updateTileGroup(group);
		}
	});
};
