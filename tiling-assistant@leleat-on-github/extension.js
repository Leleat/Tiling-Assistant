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

const {main, panel, windowManager, windowMenu} = imports.ui;
const {Clutter, Meta, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Util = Me.imports.tilingUtil;
const WindowGrabHandler = Me.imports.tilingGrabHandler;
const TilingLayoutManager = Me.imports.tilingLayoutManager;
const PieMenu = Me.imports.tilingPieMenu;
const TileEditing = Me.imports.tilingEditingMode;
const TiledWindowOpener = Me.imports.tilingWindowOpener;

var TILING = { // keybindings
	DEBUGGING: "debugging-show-tiled-rects",
	DEBUGGING_FREE_RECTS: "debugging-free-rects",
	TOGGLE_POPUP: "toggle-tiling-popup",
	AUTO: "auto-tile",
	MAXIMIZE: "tile-maximize",
	EDIT_MODE: "tile-edit-mode",
	LAYOUTS_OVERVIEW: "layouts-overview",
	RIGHT: "tile-right-half",
	LEFT: "tile-left-half",
	TOP: "tile-top-half",
	BOTTOM: "tile-bottom-half",
	TOP_LEFT: "tile-topleft-quarter",
	TOP_RIGHT: "tile-topright-quarter",
	BOTTOM_LEFT: "tile-bottomleft-quarter",
	BOTTOM_RIGHT: "tile-bottomright-quarter",
	TOGGLE_APP_SPLIT: "toggle-open-app-vertically"
};

var settings = null;

// 2 entry points:
// 1. tiled with keyboard shortcut => onCustomKeybindingPressed()
// 2. tiled via Grab => onGrabStarted()

function init() {
};

function enable() {
	settings = ExtensionUtils.getSettings("org.gnome.shell.extensions.tiling-assistant");
	this.tilePreview = new windowManager.TilePreview();
	this.windowGrabHandler = new WindowGrabHandler.WindowGrabHandler();
	this.tilingLayoutManager = new TilingLayoutManager.LayoutManager();

	// signal connections
	this.windowGrabBegin = global.display.connect("grab-op-begin", onGrabStarted.bind(this));
	this.windowGrabEnd = global.display.connect("grab-op-end", onGrabFinished.bind(this));

	// disable native tiling
	this.gnome_mutter_settings = ExtensionUtils.getSettings("org.gnome.mutter");
	this.gnome_mutter_settings.set_boolean("edge-tiling", false);
	this.gnome_shell_settings = ExtensionUtils.getSettings("org.gnome.shell.overrides");
	this.gnome_shell_settings.set_boolean("edge-tiling", false);

	// keybindings
	this.keyBindings = Object.values(TILING);
	[...Array(30)].forEach((undef, idx) => this.keyBindings.push(`activate-layout${idx}`));
	const bindingInOverview = [TILING.TOGGLE_POPUP, TILING.TOGGLE_APP_SPLIT];
	this.keyBindings.forEach(key => {
		main.wm.addKeybinding(key, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL
				| (bindingInOverview.includes(key) ? Shell.ActionMode.OVERVIEW : 0), onCustomKeybindingPressed.bind(this, key));
	});

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

	// pie menu when super + rmb'ing a window
	this.oldShowWindowMenu = main.wm._windowMenuManager.showWindowMenuForWindow;
	const that = this;
	main.wm._windowMenuManager.showWindowMenuForWindow = function(...params) {
		Util.isModPressed(Clutter.ModifierType.MOD4_MASK) && that.settings.get_boolean("enable-pie-menu")
				? new PieMenu.PieMenu() : windowMenu.WindowMenuManager.prototype.showWindowMenuForWindow.apply(this, params);
	};

	// open apps tiled by holding Shift/Alt
	this.tilingWindowOpener = new TiledWindowOpener.Handler();
};

function disable() {
	this.tilePreview.destroy();
	this.tilePreview = null;
	this.windowGrabHandler.destroy();
	this.windowGrabHandler = null;
	this.tilingLayoutManager.destroy();
	this.tilingLayoutManager = null;
	this.debuggingIndicators && this.debuggingIndicators.forEach(i => i.destroy());
	this.debuggingIndicators = null;
	this.tilingWindowOpener.destroy();
	this.tilingWindowOpener = null;

	// disconnect signals
	global.display.disconnect(this.windowGrabBegin);
	global.display.disconnect(this.windowGrabEnd);

	// re-enable native tiling
	this.gnome_mutter_settings.reset("edge-tiling");
	this.gnome_shell_settings.reset("edge-tiling");

	// remove keybindings
	this.keyBindings.forEach(key => main.wm.removeKeybinding(key));

	// restore old functions
	main.panel._getDraggableWindowForPosition = this.oldGetDraggableWindowForPosition;
	main.wm._windowMenuManager.showWindowMenuForWindow = this.oldShowWindowMenu;

	// delete custom properties
	const openWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
	openWindows.forEach(w => {
		delete w.isTiled;
		delete w.tiledRect;
		delete w.untiledRect;
		delete w.tileGroup;
		delete w.preGrabRect;
		delete w.resizeSameSideV;
		delete w.resizeSameSideH;
		w.grabSignalID && w.disconnect(w.grabSignalID);
		delete w.grabSignalID;
		w.groupRaiseId && w.disconnect(w.groupRaiseId);
		delete w.groupRaiseId;
		w.unmanagingDissolvedId && w.disconnect(w.unmanagingDissolvedId);
		delete w.unmanagingDissolvedId;
	});

	settings.run_dispose();
	settings = null;
};

function onCustomKeybindingPressed(shortcutName) {
	// debugging
	if (shortcutName === TILING.DEBUGGING || shortcutName === TILING.DEBUGGING_FREE_RECTS) {
		if (this.debuggingIndicators) {
			this.debuggingIndicators.forEach(i => i.destroy());
			this.debuggingIndicators = null;
		} else {
			const func = shortcutName === TILING.DEBUGGING ? Util.___debugShowTiledRects : Util.___debugShowFreeScreenRects;
			this.debuggingIndicators = func.call(this);
		}
		return;

	// toggle the popup, which appears when a window is tiled and there's free screen space
	} else if (shortcutName === TILING.TOGGLE_POPUP) {
		const toggleTo = !settings.get_boolean("enable-tiling-popup");
		settings.set_boolean("enable-tiling-popup", toggleTo);
		main.notify("Tiling Assistant", "Tiling-assistant's popup " + (toggleTo ? "enabled" : "was disabled"));
		return;

	// layout overview
	} else if (shortcutName === TILING.LAYOUTS_OVERVIEW) {
		this.tilingLayoutManager.openLayoutSelector();
		return;

	// open the appDash consecutively to tile to a layout
	} else if (shortcutName.startsWith("activate-layout")) {
		this.tilingLayoutManager.startTilingToLayout(Number.parseInt(shortcutName.substring(15)));
		return;

	// toggle app split
	} else if (shortcutName === TILING.TOGGLE_APP_SPLIT) {
		this.tilingWindowOpener.toggleSplitMode();
		return;
	}

	const window = global.display.focus_window;
	if (!window)
		return;

	// auto tile: tile to empty space. If there's no empty space: untile, if it's already tiled else maximize
	if (shortcutName === TILING.AUTO) {
		const tileRect = Util.getBestFitTiledRect(window);
		Util.toggleTileState(window, tileRect);

	// tile editing mode
	} else if (shortcutName === TILING.EDIT_MODE) {
		if (!Util.getTopTileGroup(!window.isTiled).length) {
			main.notify("Tiling Assistant", "Can't enter 'Tile Editing Mode', if the focused window isn't tiled.");
			return;
		}

		!window.isTiled && window.lower();
		const openWindows = Util.getOpenWindows();

		const tileEditor = new TileEditing.TileEditor();
		tileEditor.open(openWindows[0]);

	// tile window
	} else {
		settings.get_boolean("enable-dynamic-tiling") ? _dynamicTiling(window, shortcutName)
				: Util.toggleTileState(window, Util.getTileRectFor(shortcutName, window.get_work_area_current_monitor()));
	}
};

function _dynamicTiling(window, shortcutName) {
	const topTileGroup = Util.getTopTileGroup(false);
	// switch focus between topTileGroup
	if (window.isTiled && topTileGroup.length > 1) {
		const closestTiledRect = Util.getClosestRect(window.tiledRect, topTileGroup.map(w => w.tiledRect), shortcutName);
		if (!closestTiledRect) {
			Util.toggleTileState(window, Util.getTileRectFor(shortcutName, window.get_work_area_current_monitor()));
			return;
		}

		const closestTiledWindow = topTileGroup.find(w => w.tiledRect.equal(closestTiledRect));
		closestTiledWindow.activate(global.get_current_time());

		// animate for visibilty
		const fromRect = window.get_frame_rect();
		const focusIndicator = new St.Widget({
			style_class: "tile-preview",
			opacity: 0,
			x: fromRect.x, y: fromRect.y,
			width: fromRect.width, height: fromRect.height
		});
		main.uiGroup.add_child(focusIndicator);
		const toRect = closestTiledWindow.get_frame_rect();
		focusIndicator.ease({
			opacity: 255,
			x: toRect.x, y: toRect.y,
			width: toRect.width, height: toRect.height,
			duration: 200,
			mode: Clutter.AnimationMode.EASE_OUT_QUART,
			onComplete: () => focusIndicator.ease({
				opacity: 0,
				delay: 100, duration: 200,
				mode: Clutter.AnimationMode.EASE_IN_OUT_CIRC,
				onComplete: () => focusIndicator.destroy()
			})
		});

	// toggle tile state window, if it isn't tiled or the only one which is
	} else {
		Util.toggleTileState(window, Util.getTileRectFor(shortcutName, window.get_work_area_current_monitor()));
	}
};

function onGrabStarted(...params) {
	// pre GNOME 40 the signal emitter was added as the first and second param, fixed with !1734 in mutter
	const [grabbedWindow, grabOp] = [params[params.length - 2], params[params.length - 1]];
	if (!grabbedWindow)
		return;

	if (_grabIsMoving(grabOp))
		this.windowGrabHandler.onMoveStarted(grabbedWindow, grabOp);
	else if (_grabIsResizing(grabOp))
		this.windowGrabHandler.onResizeStarted(grabbedWindow, grabOp);
};

function onGrabFinished(...params) {
	// pre-GNOME 40 the signal emitter was added as the first and second param; fixed with !1734 in mutter
	const [grabbedWindow, grabOp] = [params[params.length - 2], params[params.length - 1]];
	if (!grabbedWindow)
		return;

	if (grabbedWindow.grabSignalID) {
		grabbedWindow.disconnect(grabbedWindow.grabSignalID);
		grabbedWindow.grabSignalID = 0;
	}

	if (_grabIsMoving(grabOp))
		this.windowGrabHandler.onMoveFinished(grabbedWindow);
	else if (_grabIsResizing(grabOp))
		this.windowGrabHandler.onResizeFinished(grabbedWindow, grabOp);
};

function _grabIsMoving(grabOp) {
	switch (grabOp) {
		case Meta.GrabOp.MOVING:
		case Meta.GrabOp.KEYBOARD_MOVING:
			return true;

		default:
			return false;
	}
};

function _grabIsResizing(grabOp) {
	switch (grabOp) {
		case Meta.GrabOp.RESIZING_N:
		case Meta.GrabOp.RESIZING_NW:
		case Meta.GrabOp.RESIZING_NE:
		case Meta.GrabOp.RESIZING_S:
		case Meta.GrabOp.RESIZING_SW:
		case Meta.GrabOp.RESIZING_SE:
		case Meta.GrabOp.RESIZING_E:
		case Meta.GrabOp.RESIZING_W:
			return true;

		default:
			return false;
	}
};
