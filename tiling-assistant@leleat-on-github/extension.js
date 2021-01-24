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

const {appDisplay, main, panel} = imports.ui;
const {Clutter, GLib, Meta, Shell} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Util = Me.imports.util;
const TilingDash = Me.imports.tilingDash;
const TilingPreviewRect = Me.imports.tilingPreviewRect;
const TilingLayoutManager = Me.imports.tilingLayoutManager;

var tilingPreviewRect = null;
var tilingLayoutManager = null;
var settings = null;

// 2 entry points:
// 1. tiled with keyboard shortcut (set with this extension) => onMyTilingShortcutPressed()
// 2. tiled via DND => onGrabBegin()

function init() {
};

function enable() {
	settings = ExtensionUtils.getSettings("org.gnome.shell.extensions.tiling-assistant");

	// signal connections
	this.windowGrabBegin = global.display.connect("grab-op-begin", onGrabBegin.bind(this));
	this.windowGrabEnd = global.display.connect("grab-op-end", onGrabEnd.bind(this));

	tilingLayoutManager = new TilingLayoutManager.MyTilingLayoutManager();
	tilingPreviewRect = new TilingPreviewRect.MyTilingPreviewRect();

	// disable native tiling
	// taken from ShellTile@emasab.it - https://extensions.gnome.org/extension/657/shelltile/
	// dont know why gnome_shell_settings tiling is disabled...
	this.gnome_mutter_settings = ExtensionUtils.getSettings("org.gnome.mutter");
	this.gnome_mutter_settings.set_boolean("edge-tiling", false);
	this.gnome_shell_settings = ExtensionUtils.getSettings("org.gnome.shell.overrides");
	this.gnome_shell_settings.set_boolean("edge-tiling", false);

	// tiling keybindings
	this.keyBindings = ["toggle-dash", "replace-window", "tile-maximize", "tile-empty-space", "tile-right-half", "tile-left-half", "tile-top-half", "tile-bottom-half", "tile-bottomleft-quarter", "tile-bottomright-quarter", "tile-topright-quarter", "tile-topleft-quarter",
			"layout1", "layout2", "layout3", "layout4", "layout5", "layout6", "layout7", "layout8", "layout9", "layout10"];
	this.keyBindings.forEach(key => {
		main.wm.addKeybinding(
			key,
			settings,
			Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
			Shell.ActionMode.NORMAL,
			onMyTilingShortcutPressed.bind(this, key)
		);
	});

	// change appDisplay.AppIcon.activate function.
	// allow to directly open an app in a tiled state
	// via holding Alt or Shift when activating the icon
	this.oldAppActivateFunc = appDisplay.AppIcon.prototype.activate;
	appDisplay.AppIcon.prototype.activate = function (button) {
		let event = Clutter.get_current_event();
		let modifiers = event ? event.get_state() : 0;
		let isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
		let isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;
		let isMiddleButton = button && button == Clutter.BUTTON_MIDDLE;
		let isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) != 0;
		let openNewWindow = this.app.can_open_new_window() &&
				this.app.state == Shell.AppState.RUNNING &&
				(isCtrlPressed || isMiddleButton);

		if (this.app.state == Shell.AppState.STOPPED || openNewWindow || isShiftPressed || isAltPressed)
			this.animateLaunch();

		if (openNewWindow) {
			this.app.open_new_window(-1);

		// main new code
		} else if ((isShiftPressed || isAltPressed)) {
			let workArea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(global.display.get_current_monitor());
			let rect = new Meta.Rectangle({
				x: workArea.x + ((isShiftPressed) ? 0 : workArea.width / 2),
				y: workArea.y,
				width: workArea.width / 2,
				height: workArea.height
			});

			Util.openAppTiled(this.app, rect);

		} else {
			this.app.activate();
		}

		main.overview.hide();
	};

	// change main.panel._getDraggableWindowForPosition to also include windows tiled with this extension
	this.oldGetDraggableWindowForPosition = main.panel._getDraggableWindowForPosition;
	main.panel._getDraggableWindowForPosition = function (stageX) {
		let workspaceManager = global.workspace_manager;
		const windows = workspaceManager.get_active_workspace().list_windows();
		const allWindowsByStacking = global.display.sort_windows_by_stacking(windows).reverse();

		return allWindowsByStacking.find(metaWindow => {
			let rect = metaWindow.get_frame_rect();
			let workArea = metaWindow.get_work_area_current_monitor();

			return metaWindow.is_on_primary_monitor() &&
				metaWindow.showing_on_its_workspace() &&
				metaWindow.get_window_type() != Meta.WindowType.DESKTOP &&
				(metaWindow.maximized_vertically || (metaWindow.isTiled && metaWindow.tiledRect.y == workArea.y)) &&
				stageX > rect.x && stageX < rect.x + rect.width;
		});
	};
};

function disable() {
	// disconnect signals
	global.display.disconnect(this.windowGrabBegin);
	global.display.disconnect(this.windowGrabEnd);

	tilingPreviewRect.destroy();
	tilingPreviewRect = null;
	tilingLayoutManager._destroy();
	tilingLayoutManager = null;

	// re-enable native tiling
	this.gnome_mutter_settings.reset("edge-tiling");
	this.gnome_shell_settings.reset("edge-tiling");

	// remove keybindings
	this.keyBindings.forEach(key => {
		main.wm.removeKeybinding(key);
	});

	// restore old function
	appDisplay.AppIcon.prototype.activate = this.oldAppActivateFunc;
	main.panel._getDraggableWindowForPosition = this.oldGetDraggableWindowForPosition;

	// delete custom properties
	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = activeWS.list_windows();
	openWindows.forEach(w => {
		delete w.isTiled;
		delete w.tiledRect;
		delete w.tileGroup;
		delete w.sameSideWindows;
		delete w.opposingWindows;
		delete w.preGrabRect;

		if (w.grabSignalIDs)
			w.grabSignalIDs.forEach(id => w.disconnect(id));
		delete w.grabSignalIDs;

		if (w.groupFocusSignalID)
			w.disconnect(w.groupFocusSignalID);
		delete w.groupFocusSignalID;
	});

	settings.run_dispose();
	settings = null;
};

function onMyTilingShortcutPressed(shortcutName) {
	let window = global.display.focus_window;
	if (!window)
		return;

	let rect;
	let workArea = window.get_work_area_current_monitor();
	let currTileGroup = Util.getTopTileGroup();
	let freeScreenRects = Util.getFreeScreenRects(currTileGroup);
	let screenRects = [];
	currTileGroup.forEach(w => screenRects.push(w.tiledRect.copy()));
	screenRects = freeScreenRects.concat(screenRects);

	switch (shortcutName) {
		case "toggle-dash":
			let toggleTo = !settings.get_boolean("enable-dash");
			settings.set_boolean("enable-dash", toggleTo);

			main.notify("Tiling Assistant", "Dash " + (toggleTo ? 'enabled' : 'was disabled'));
			return;

		case "layout1":
		case "layout2":
		case "layout3":
		case "layout4":
		case "layout5":
		case "layout6":
		case "layout7":
		case "layout8":
		case "layout9":
		case "layout10":
			let idx = Number.parseInt(shortcutName.substring(6)) - 1;
			tilingLayoutManager.startTilingToLayout(idx, window.get_monitor());
			return;

		case "tile-maximize":
			rect = workArea;
			break;
			
		case "tile-top-half":
			rect = Util.getTileRectForSide(Meta.Side.TOP, workArea, screenRects);
			break;

		case "tile-left-half":
			rect = Util.getTileRectForSide(Meta.Side.LEFT, workArea, screenRects);
			break;

		case "tile-right-half":
			rect = Util.getTileRectForSide(Meta.Side.RIGHT, workArea, screenRects);
			break;

		case "tile-bottom-half":
			rect = Util.getTileRectForSide(Meta.Side.BOTTOM, workArea, screenRects);
			break;

		case "tile-topleft-quarter":
			rect = Util.getTileRectForSide(Meta.Side.TOP + Meta.Side.LEFT, workArea, screenRects);
			break;

		case "tile-topright-quarter":
			rect = Util.getTileRectForSide(Meta.Side.TOP + Meta.Side.RIGHT, workArea, screenRects);
			break;

		case "tile-bottomleft-quarter":
			rect = Util.getTileRectForSide(Meta.Side.BOTTOM + Meta.Side.LEFT, workArea, screenRects);
			break;

		case "tile-bottomright-quarter":
			rect = Util.getTileRectForSide(Meta.Side.BOTTOM + Meta.Side.RIGHT, workArea, screenRects);
			break;

		case "tile-empty-space":
			if (!freeScreenRects.length) {
				rect = workArea;
				
			} else {
				rect = freeScreenRects[0];
				let area = freeScreenRects[0].area();

				for (let i = 1; i < freeScreenRects.length; i++) {
					let r = freeScreenRects[i];
					area += r.area();
					rect = rect.union(r);
				}

				let freeArea = rect.area();
				// free screen space doesnt consist of "aligned" rects, e.g. only 1 quartered window or 2 diagonally quartered windows...
				// TODO: need better alignment detection; currently it doesnt work if resized was done manually (i .e. holding ctrl) 
				if (!Util.equalApprox(freeArea, area, 5))
					rect = workArea;
			}
			break;
		
		case "replace-window":
			Util.replaceTiledWindow(window);
			return;
	}

	if ((window.isTiled && Util.rectsAreAboutEqual(rect, window.tiledRect)) || (Util.rectsAreAboutEqual(rect, workArea) && window.get_maximized())) {
		Util.restoreWindowSize(window, true);

	} else {
		if (Util.rectsAreAboutEqual(rect, workArea))
			Util.maximizeBoth(window);
		else
			Util.tileWindow(window, rect);
	}
};

// calls either restoreWindowSize(), onWindowMoving() or resizeComplementingWindows() depending on where the drag began on the window
function onGrabBegin(_metaDisplay, metaDisplay, grabbedWindow, grabOp) {
	if (!grabbedWindow)
		return;

	// resizing non-tiled window
	if (grabOp != Meta.GrabOp.MOVING && !grabbedWindow.isTiled)
		return;

	let grabbedRect = (grabbedWindow.isTiled) ? grabbedWindow.tiledRect : grabbedWindow.get_frame_rect();
	grabbedWindow.preGrabRect = grabbedWindow.get_frame_rect().copy();

	grabbedWindow.grabSignalIDs = [];

	// for resizing op
	// sameSideWindows is the window which is on the same side relative to where the grab began
	// e.g. if resizing the top left on the E side, the bottom left window is the sameSideWindows
	// opposingWindows are the remaining windows
	grabbedWindow.sameSideWindows = [];
	grabbedWindow.opposingWindows = [];

	let openWindows = Util.getOpenWindows();
	openWindows.splice(openWindows.indexOf(grabbedWindow), 1);

	// if ctrl is pressed, tile grabbed window and its directly opposing windows (instead of whole group)
	let event = Clutter.get_current_event();
	let modifiers = event ? event.get_state() : 0;
	let isCtrlPressed = modifiers & Clutter.ModifierType.CONTROL_MASK;
	let gap = settings.get_int("window-gaps");

	switch (grabOp) {
		case Meta.GrabOp.MOVING:
			let [x, y] = global.get_pointer();
			// rectangles of tileGroup and freeScreenRects; so together they represent the entire screen
			let rects = [];
			let currTileGroup = Util.getTopTileGroup();
			let freeScreenRects = Util.getFreeScreenRects(currTileGroup);
			currTileGroup.forEach(w => rects.push(w.tiledRect.copy()));
			rects = freeScreenRects.concat(rects);

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("position-changed", onWindowMoving.bind(this, grabbedWindow, [x, y], currTileGroup, rects, freeScreenRects)));
			break;

		case Meta.GrabOp.RESIZING_N:
			for (let i = 0, len = openWindows.length; i < len; i++) {
				let oW = openWindows[i];
				if (!oW.isTiled) {
					if (grabbedRect.contains_rect(oW.get_frame_rect()))
						continue;
					break;
				}

				let otherRect = oW.tiledRect;

				if (isCtrlPressed) {
					if (Util.equalApprox(otherRect.y + otherRect.height, grabbedRect.y, gap) && Util.equalApprox(grabbedRect.x, otherRect.x, gap) && Util.equalApprox(grabbedRect.width, otherRect.width, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}

				} else {
					if (Util.equalApprox(otherRect.y, grabbedRect.y, gap)) {
						grabbedWindow.sameSideWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
	
					} else if (Util.equalApprox(otherRect.y + otherRect.height, grabbedRect.y, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}
				}
			}

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("size-changed", Util.resizeComplementingWindows.bind(this, grabbedWindow, grabOp, settings.get_int("window-gaps"))));
			break;

		case Meta.GrabOp.RESIZING_S:
			for (let i = 0, len = openWindows.length; i < len; i++) {
				let oW = openWindows[i];
				if (!oW.isTiled) {
					if (grabbedRect.contains_rect(oW.get_frame_rect()))
						continue;
					break;
				}

				let otherRect = oW.tiledRect;

				if (isCtrlPressed) {
					if (Util.equalApprox(otherRect.y, grabbedRect.y + grabbedRect.height, gap) && Util.equalApprox(grabbedRect.x, otherRect.x, gap) && Util.equalApprox(grabbedRect.width, otherRect.width, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}

				} else {
					if (Util.equalApprox(otherRect.y + otherRect.height, grabbedRect.y + grabbedRect.height, gap)) {
						grabbedWindow.sameSideWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();

					} else if (Util.equalApprox(otherRect.y, grabbedRect.y + grabbedRect.height, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}
				}
			}

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("size-changed", Util.resizeComplementingWindows.bind(this, grabbedWindow, grabOp, gap)));
			break;

		case Meta.GrabOp.RESIZING_E:
			for (let i = 0, len = openWindows.length; i < len; i++) {
				let oW = openWindows[i];
				if (!oW.isTiled) {
					if (grabbedRect.contains_rect(oW.get_frame_rect()))
						continue;
					break;
				}

				let otherRect = oW.tiledRect;

				if (isCtrlPressed) {
					if (Util.equalApprox(otherRect.x, grabbedRect.x + grabbedRect.width, gap) && Util.equalApprox(grabbedRect.y, otherRect.y, gap) && Util.equalApprox(grabbedRect.height, otherRect.height, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}

				} else {
					if (Util.equalApprox(otherRect.x + otherRect.width, grabbedRect.x + grabbedRect.width, gap)) {
						grabbedWindow.sameSideWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();

					} else if (Util.equalApprox(otherRect.x, grabbedRect.x + grabbedRect.width, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}
				}
			}

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("size-changed", Util.resizeComplementingWindows.bind(this, grabbedWindow, grabOp, gap)));
			break;

		case Meta.GrabOp.RESIZING_W:
			for (let i = 0, len = openWindows.length; i < len; i++) {
				let oW = openWindows[i];
				if (!oW.isTiled) {
					if (grabbedRect.contains_rect(oW.get_frame_rect()))
						continue;
					break;
				}

				let otherRect = oW.tiledRect;

				if (isCtrlPressed) {
					if (Util.equalApprox(otherRect.x + otherRect.width, grabbedRect.x, gap) && Util.equalApprox(grabbedRect.y, otherRect.y, gap) && Util.equalApprox(grabbedRect.height, otherRect.height, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}

				} else {
					if (Util.equalApprox(otherRect.x, grabbedRect.x, gap)) {
						grabbedWindow.sameSideWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();

					} else if (Util.equalApprox(otherRect.x + otherRect.width, grabbedRect.x, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}
				}
			}

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("size-changed", Util.resizeComplementingWindows.bind(this, grabbedWindow, grabOp, settings.get_int("window-gaps"))));
	}
};

function onGrabEnd(_metaDisplay, metaDisplay, window, grabOp) {
	if (!window)
		return;
	
	// disconnect the signals
	if (window.grabSignalIDs) {
		window.grabSignalIDs.forEach(sID => window.disconnect(sID));
		window.grabSignalIDs = [];
	}

	switch (grabOp) {
		case Meta.GrabOp.RESIZING_N:
		case Meta.GrabOp.RESIZING_S:
		case Meta.GrabOp.RESIZING_E:
		case Meta.GrabOp.RESIZING_W:
			break;
		
		case Meta.GrabOp.MOVING:
			if (tilingPreviewRect.showing) {
				// halving already tiled window, if we dont tile over it completely
				if (tilingPreviewRect.windowToSplit)
					Util.tileWindow(tilingPreviewRect.windowToSplit, Util.rectDiff(tilingPreviewRect.windowToSplit.tiledRect, tilingPreviewRect.rect)[0], false);
		
				let workArea = window.get_work_area_current_monitor();
				if (workArea.equal(tilingPreviewRect.rect))
					Util.maximizeBoth(window);
				else
					Util.tileWindow(window, tilingPreviewRect.rect);
		
				tilingPreviewRect.close();
			}

		default:
			return;
	}

	if (!window.isTiled)
		return;

	// update the window.tiledRects.
	// Careful with resizing issues for some terminals!
	let gap = settings.get_int("window-gaps");
	let newRect = window.get_frame_rect();
	let oldTiledRect = window.tiledRect.copy();

	// first calculate the new tiledRect for the grabbed window
	let diffX = window.preGrabRect.x - newRect.x;
	let diffY = window.preGrabRect.y - newRect.y;

	let _x = window.tiledRect.x - diffX;
	let _y = window.tiledRect.y - diffY;
	window.tiledRect = new Meta.Rectangle({
		x: _x,
		y: _y,
		// tiledRect's x2 sticks to where it was, if not resizing on the East
		width: (grabOp == Meta.GrabOp.RESIZING_E) ? newRect.width + 2 * gap : window.tiledRect.x + window.tiledRect.width - _x,
		// tiledRect's y2 sticks to where it was, if not resizing on the South
		height: (grabOp == Meta.GrabOp.RESIZING_S) ? newRect.height + 2 * gap : window.tiledRect.y + window.tiledRect.height - _y
	});

	// update the diff vars based on the tiledRects diff
	diffX = oldTiledRect.x - window.tiledRect.x;
	diffY = oldTiledRect.y - window.tiledRect.y;
	let diffWidth = oldTiledRect.width - window.tiledRect.width;
	let diffHeight = oldTiledRect.height - window.tiledRect.height;

	window.sameSideWindows.forEach(w => {
		w.tiledRect = new Meta.Rectangle({
			x: w.tiledRect.x - diffX,
			y: w.tiledRect.y - diffY,
			width: w.tiledRect.width - diffWidth,
			height: w.tiledRect.height - diffHeight
		});
	});
	window.sameSideWindows = [];

	window.opposingWindows.forEach(w => {
		w.tiledRect = new Meta.Rectangle({
			x: w.tiledRect.x - ((grabOp == Meta.GrabOp.RESIZING_E) ? diffWidth : 0),
			y: w.tiledRect.y - ((grabOp == Meta.GrabOp.RESIZING_S) ? diffHeight : 0),
			width: w.tiledRect.width + diffWidth,
			height: w.tiledRect.height + diffHeight
		});
	});
	window.opposingWindows = [];

	// update tileGroup.
	// only actually needed, if resizing while holding ctrl to resize single windows
	let tileGroup = Util.getTopTileGroup(null, false);
	tileGroup.forEach(w => Util.removeTileGroup(w));
	Util.updateTileGroup(tileGroup);
};

// tile previewing via DND and restore window size, if window is already tiled
function onWindowMoving(window, grabStartPos, currTileGroup, screenRects, freeScreenRects) {
	let [mouseX, mouseY] = global.get_pointer();

	// restore the window size of tiled windows after DND distance of at least 1px
	// to prevent restoring the window after just clicking on the title/top bar
	if (window.isTiled) {
		let moveVec = [grabStartPos[0] - mouseX, grabStartPos[1] - mouseY];
		let moveDist = Math.sqrt(moveVec[0] * moveVec[0] + moveVec[1] * moveVec[1]);

		if (moveDist <= 0)
			return;

		global.display.end_grab_op(global.get_current_time());
		
		// timer needed because for some apps the grab will overwrite/ignore the size changes of Util.restoreWindowSize()
		// so far I only noticed this behaviour with firefox
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
			Util.restoreWindowSize(window);

			global.display.begin_grab_op(
				window,
				Meta.GrabOp.MOVING,
				true, // pointer already grabbed
				true, // frame action
				-1, // button
				0, // modifier
				global.get_current_time(),
				mouseX, Math.max(grabStartPos[1], window.get_frame_rect().y)
			);

			return GLib.SOURCE_REMOVE;
		});

		return;
	}

	let monitorNr = global.display.get_current_monitor();
	let workArea = window.get_work_area_for_monitor(monitorNr);
	let wRect = window.get_frame_rect();

	let onTop = mouseY < main.panel.height + 25;
	let onBottom = workArea.y + workArea.height - wRect.y < 40 || mouseY > workArea.y + workArea.height - 25;
	let onLeft = mouseX <= workArea.x + 25;
	let onRight = mouseX >= workArea.x + workArea.width - 25;

	let tileTopLeftQuarter = onTop && onLeft;
	let tileTopRightQuarter = onTop && onRight;
	let tileBottomLeftQuarter = onLeft && onBottom;
	let tileBottomRightQuarter = onRight && onBottom;

	// tile to top half on the most left and on the most right side of the topbar
	let tileTopHalf = onTop && ((mouseX > 25 && mouseX < workArea.width / 4) || (mouseX < workArea.y + workArea.width - 25 && mouseX > workArea.y + workArea.width - workArea.width / 4));
	let tileRightHalf = onRight
	let tileLeftHalf = onLeft;
	let tileMaximized = onTop;
	let tileBottomHalf = onBottom;

	// halve tiled window which is hovered while pressing ctrl
	let event = Clutter.get_current_event();
	let modifiers = event ? event.get_state() : 0;
	let isCtrlPressed = modifiers & Clutter.ModifierType.CONTROL_MASK;
	let mousePoint = {x: mouseX, y: mouseY};

	// default sizes or halving tiled windows
	if (isCtrlPressed) {
		if (tileTopLeftQuarter) {  
			tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width / 2,
				height: workArea.height / 2,
			}), monitorNr);
	
		} else if (tileTopRightQuarter) {
			tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x + workArea.width / 2,
				y: workArea.y,
				width: workArea.width / 2,
				height: workArea.height / 2,
			}), monitorNr);
	
		} else if (tileBottomLeftQuarter) {
		   tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height / 2,
				width: workArea.width / 2,
				height: workArea.height / 2,
			}), monitorNr);
	
		} else if (tileBottomRightQuarter) {
			tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x + workArea.width / 2,
				y: workArea.y + workArea.height / 2,
				width: workArea.width / 2,
				height: workArea.height / 2,
			}), monitorNr);
	
		} else if (tileRightHalf) {
			tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x + workArea.width / 2,
				y: workArea.y,
				width: workArea.width / 2,
				height: workArea.height,
			}), monitorNr);
	
		} else if (tileLeftHalf) {
			tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width / 2,
				height: workArea.height,
			}), monitorNr);
	
		} else if (tileTopHalf) {
			tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width,
				height: workArea.height / 2,
			}), monitorNr);
	
		} else if (tileBottomHalf) {
			tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height / 2,
				width: workArea.width,
				height: workArea.height / 2,
			}), monitorNr);
	
		} else if (tileMaximized) {
			tilingPreviewRect.open(window, new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width,
				height: workArea.height,
			}), monitorNr);

		} else {
			for (let i = 0; i < screenRects.length; i++) {
				const rect = screenRects[i];
				if (!Util.rectHasPoint(rect, mousePoint))
					continue;

				const top = mouseY < rect.y + rect.height * .2;
				const bottom = mouseY > rect.y + rect.height * .8;
				const right = mouseX > rect.x + rect.width * .8;
				const left = mouseX < rect.x + rect.width * .2;
				const vertical = top || bottom;
				const horizontal = left || right;

				let _x = rect.x;
				let _y = rect.y;
				let _width = rect.width;
				let _height = rect.height;

				if (horizontal || vertical) {
					_x = rect.x + (right && !vertical ? rect.width / 2 : 0);
					_y = rect.y + (bottom ? rect.height / 2 : 0);
					_width = rect.width / (vertical ? 1 : 2);
					_height = rect.height / (vertical ? 2 : 1);
				}

				let r = new Meta.Rectangle({
					x: _x,
					y: _y,
					width: _width,
					height: _height
				});
			
				tilingPreviewRect.open(window, r, monitorNr, ((horizontal || vertical) && i >= freeScreenRects.length) ? currTileGroup[i - freeScreenRects.length] : null);
				return;
			}
		}

	} else if (tileTopLeftQuarter) {
		tilingPreviewRect.open(window, Util.getTileRectForSide(Meta.Side.TOP + Meta.Side.LEFT, workArea, screenRects), monitorNr);

	} else if (tileTopRightQuarter) {
		tilingPreviewRect.open(window, Util.getTileRectForSide(Meta.Side.TOP + Meta.Side.RIGHT, workArea, screenRects), monitorNr);

	} else if (tileBottomLeftQuarter) {
		tilingPreviewRect.open(window, Util.getTileRectForSide(Meta.Side.BOTTOM + Meta.Side.LEFT, workArea, screenRects), monitorNr);

	} else if (tileBottomRightQuarter) {
		tilingPreviewRect.open(window, Util.getTileRectForSide(Meta.Side.BOTTOM + Meta.Side.RIGHT, workArea, screenRects), monitorNr);

	} else if (tileRightHalf) {
		tilingPreviewRect.open(window, Util.getTileRectForSide(Meta.Side.RIGHT, workArea, screenRects), monitorNr);

	} else if (tileLeftHalf) {
		tilingPreviewRect.open(window, Util.getTileRectForSide(Meta.Side.LEFT, workArea, screenRects), monitorNr);

	} else if (tileTopHalf) {
		tilingPreviewRect.open(window, Util.getTileRectForSide(Meta.Side.TOP, workArea, screenRects), monitorNr);

	} else if (tileBottomHalf) {
		tilingPreviewRect.open(window, Util.getTileRectForSide(Meta.Side.BOTTOM, workArea, screenRects), monitorNr);

	} else if (tileMaximized) {
		tilingPreviewRect.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y,
			width: workArea.width,
			height: workArea.height,
		}), monitorNr);

	} else {
		tilingPreviewRect.close();
	}
};

// called when a window is tiled (via tileWindow()).
// decides wether the Dash should be opened. If yes, the dash will be opened.
function onWindowTiled(tiledWindow) {
	if (!settings.get_boolean("enable-dash"))
		return;
	
	let openWindows = Util.getOpenWindows();
	let currTileGroup = Util.getTopTileGroup(openWindows, false);

	// remove the tiled windows from openWindows to populate the Dash
	currTileGroup.forEach(w => openWindows.splice(openWindows.indexOf(w), 1));
	if (openWindows.length == 0)
		return;

	let freeScreenRects = Util.getFreeScreenRects(currTileGroup);
	if (!freeScreenRects.length)
		return;
	
	let freeScreenSpace = freeScreenRects[0];
	if (freeScreenRects.length > 1) {
		let area = freeScreenRects[0].area();
		for (let i = 1; i < freeScreenRects.length; i++) {
			area += freeScreenRects[i].area();
			freeScreenSpace = freeScreenSpace.union(freeScreenRects[i]);
		}

		// free screen space doesnt consist of "aligned" rects, e.g. only 1 quartered window or uneven windows, etc...
		if (!Util.equalApprox(freeScreenSpace.area(), area, 50))
			return;		
	}

	// some (random) hardcoded min space requirements
	if (freeScreenSpace.width < 350 || freeScreenSpace.height < 350)
		return;

	TilingDash.openDash(openWindows, tiledWindow, tiledWindow.get_monitor(), freeScreenSpace);
};