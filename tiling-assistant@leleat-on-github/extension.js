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
const {Gio, GLib, Meta, Shell} = imports.gi;
const ByteArray = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Util = Me.imports.tilingUtil;
const MoveHandler = Me.imports.tilingMoveHandler;
const ResizeHandler = Me.imports.tilingResizeHandler;
const KeybindingHandler = Me.imports.tilingKeybindingHandler;
const TileGroupManager = Me.imports.tilingGroupManager;

var settings = null;
var TILING = { // keybindings
	DEBUGGING: "debugging-show-tiled-rects",
	DEBUGGING_FREE_RECTS: "debugging-free-rects",
	TOGGLE_POPUP: "toggle-tiling-popup",
	AUTO: "auto-tile",
	MAXIMIZE: "tile-maximize",
	EDIT_MODE: "tile-edit-mode",
	RIGHT: "tile-right-half",
	LEFT: "tile-left-half",
	TOP: "tile-top-half",
	BOTTOM: "tile-bottom-half",
	TOP_LEFT: "tile-topleft-quarter",
	TOP_RIGHT: "tile-topright-quarter",
	BOTTOM_LEFT: "tile-bottomleft-quarter",
	BOTTOM_RIGHT: "tile-bottomright-quarter"
};

/**
 * 2 entry points:
 * 	1. keyboard shortcuts:
 * 		=> tilingKeybindingHandler.js
 * 	2. Grabbing a window:
 * 		=> tilingMoveHandler.js (when moving a window)
 * 		=> tilingResizeHandler.js (when resizing a window)
 */

function init() {
	ExtensionUtils.initTranslations(Me.metadata.uuid);
};

function enable() {
	settings = ExtensionUtils.getSettings("org.gnome.shell.extensions.tiling-assistant");
	this.settingsSignals = [];

	this.windowMoveHandler = new MoveHandler.Handler();
	this.windowResizeHandler = new ResizeHandler.Handler();
	this.keybindingHandler = new KeybindingHandler.Handler();
	this.tileGroupManager = new TileGroupManager.Manager();

	// disable native tiling
	this.gnome_mutter_settings = ExtensionUtils.getSettings("org.gnome.mutter");
	this.gnome_mutter_settings.set_boolean("edge-tiling", false);
	this.gnome_shell_settings = ExtensionUtils.getSettings("org.gnome.shell.overrides");
	this.gnome_shell_settings.set_boolean("edge-tiling", false);

	// change main.panel._getDraggableWindowForPosition to also include windows tiled with this extension
	this.oldGetDraggableWindowForPosition = main.panel._getDraggableWindowForPosition;
	main.panel._getDraggableWindowForPosition = function (stageX) {
		const workspaceManager = global.workspace_manager;
		const windows = workspaceManager.get_active_workspace().list_windows();
		const allWindowsByStacking = global.display.sort_windows_by_stacking(windows).reverse();

		return allWindowsByStacking.find(metaWindow => {
			const rect = metaWindow.get_frame_rect();
			const workArea = metaWindow.get_work_area_current_monitor();
			return metaWindow.is_on_primary_monitor()
					&& metaWindow.showing_on_its_workspace()
					&& metaWindow.get_window_type() !== Meta.WindowType.DESKTOP
					&& (metaWindow.maximized_vertically || (metaWindow.tiledRect && metaWindow.tiledRect.y === workArea.y))
					&& stageX > rect.x && stageX < rect.x + rect.width;
		});
	};

	// restore window properties after session was unlocked
	_loadAfterSessionLock();
};

function disable() {
	// save window properties, if session was locked to restore after unlock
	_saveBeforeSessionLock();

	this.windowMoveHandler.destroy();
	this.windowMoveHandler = null;
	this.windowResizeHandler.destroy();
	this.windowResizeHandler = null;
	this.keybindingHandler.destroy();
	this.keybindingHandler = null;
	this.tileGroupManager.destroy();
	this.tileGroupManager = null;

	// disconnect signals
	this.settingsSignals.forEach(id => this.settings.disconnect(id));

	// re-enable native tiling
	this.gnome_mutter_settings.reset("edge-tiling");
	this.gnome_shell_settings.reset("edge-tiling");

	// restore old functions
	main.panel._getDraggableWindowForPosition = this.oldGetDraggableWindowForPosition;

	// delete custom properties
	const openWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
	openWindows.forEach(w => {
		delete w.isTiled;
		delete w.tiledRect;
		delete w.untiledRect;
	});

	settings.run_dispose();
	settings = null;
};

function _saveBeforeSessionLock() {
	if (!main.sessionMode.isLocked)
		return;

	this.wasLocked = true;

	const metaToStringRect = metaRect => metaRect && {x: metaRect.x, y: metaRect.y, width: metaRect.width, height: metaRect.height};
	const savedWindows = [];
	const openWindows = Util.getOpenWindows(false);
	openWindows.forEach(window => {
		// can't just check for isTiled because maximized windows may
		// have an untiledRect as well in case window gaps are used
		if (!window.untiledRect)
			return;

		savedWindows.push({
			windowStableId: window.get_stable_sequence(),
			isTiled: window.isTiled,
			tiledRect: metaToStringRect(window.tiledRect),
			untiledRect: metaToStringRect(window.untiledRect),
		});
	});

	const saveObj = {
		"windows": savedWindows,
		"tileGroups": Array.from(this.tileGroupManager.getTileGroups())
	};

	const parentDir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), "/tiling-assistant"]));
	try {parentDir.make_directory_with_parents(null)} catch (e) {}
	const path = GLib.build_filenamev([GLib.get_user_config_dir(), "/tiling-assistant/tiledSessionRestore.json"]);
	const file = Gio.File.new_for_path(path);
	try {file.create(Gio.FileCreateFlags.NONE, null)} catch (e) {}
	file.replace_contents(JSON.stringify(saveObj), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
};

function _loadAfterSessionLock() {
	if (!this.wasLocked)
		return;

	this.wasLocked = false;

	const path = GLib.build_filenamev([GLib.get_user_config_dir(), "/tiling-assistant/tiledSessionRestore.json"]);
	const file = Gio.File.new_for_path(path);
	if (!file.query_exists(null))
		return;

	try {file.create(Gio.FileCreateFlags.NONE, null)} catch (e) {}
	const [success, contents] = file.load_contents(null);
	if (!success || !contents.length)
		return;

	const openWindows = Util.getOpenWindows(false);
	const saveObj = JSON.parse(ByteArray.toString(contents));

	const windowObjects = saveObj["windows"];
	windowObjects.forEach(wObj => {
		const {windowStableId, isTiled, tiledRect, untiledRect, tileGroup} = wObj;
		const windowIdx = openWindows.findIndex(w => w.get_stable_sequence() === windowStableId);
		const window = openWindows[windowIdx];
		if (!window)
			return;

		window.isTiled = isTiled;
		window.tiledRect = tiledRect && new Meta.Rectangle({
			x: tiledRect.x, y: tiledRect.y,
			width: tiledRect.width, height: tiledRect.height
		});
		window.untiledRect = untiledRect && new Meta.Rectangle({
			x: untiledRect.x, y: untiledRect.y,
			width: untiledRect.width, height: untiledRect.height
		});
	});

	const tileGroups = new Map(saveObj["tileGroups"]);
	this.tileGroupManager.setTileGroups(tileGroups);
	openWindows.forEach(w => {
		if (tileGroups.has(w.get_id())) {
			const group = this.tileGroupManager.getTileGroupFor(w);
			this.tileGroupManager.updateTileGroup(group);
		}
	});
};
