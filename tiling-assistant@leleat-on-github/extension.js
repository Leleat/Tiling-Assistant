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

/* exported init */

"use strict";

const Lang = imports.lang;
const {altTab, appDisplay, iconGrid, main, panel, switcherPopup, windowManager} = imports.ui;
const {Clutter, GLib, GObject, Graphene, Meta, Shell, St} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Funcs = Me.imports.funcs;

var appDash = null;
let tilePreview = null;
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
	this.overviewShown = main.overview.connect("showing", () => { 
		if (appDash.shown) 
			appDash.close(); 
	});
	this.shortcutPressed = global.window_manager.connect("filter-keybinding", (shellWM, keyBinding) => {
		if (appDash.shown) {
			appDash.close();
			return true;
		}
		return false;
	});

	appDash = new TilingAppDash();
	tilePreview = new TilingTilePreview();

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

			Funcs.openAppTiled(this.app, rect);

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
	main.overview.disconnect(this.overviewShown);
	global.window_manager.disconnect(this.shortcutPressed);

	tilePreview.destroy();
	tilePreview = null;
	appDash._destroy();
	appDash = null;

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
    let currTileGroup = Funcs.getTopTileGroup();
    let freeScreenRects = Funcs.getFreeScreenRects(currTileGroup);
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
			Funcs.tileToLayout(idx);
			return;

		case "tile-maximize":
			rect = workArea;
			break;
			
		case "tile-top-half":
			rect = Funcs.getTileRectForSide(Meta.Side.TOP, workArea, screenRects);
			break;

		case "tile-left-half":
			rect = Funcs.getTileRectForSide(Meta.Side.LEFT, workArea, screenRects);
			break;

		case "tile-right-half":
			rect = Funcs.getTileRectForSide(Meta.Side.RIGHT, workArea, screenRects);
			break;

		case "tile-bottom-half":
			rect = Funcs.getTileRectForSide(Meta.Side.BOTTOM, workArea, screenRects);
			break;

		case "tile-topleft-quarter":
			rect = Funcs.getTileRectForSide(Meta.Side.TOP + Meta.Side.LEFT, workArea, screenRects);
			break;

		case "tile-topright-quarter":
			rect = Funcs.getTileRectForSide(Meta.Side.TOP + Meta.Side.RIGHT, workArea, screenRects);
			break;

		case "tile-bottomleft-quarter":
			rect = Funcs.getTileRectForSide(Meta.Side.BOTTOM + Meta.Side.LEFT, workArea, screenRects);
			break;

		case "tile-bottomright-quarter":
			rect = Funcs.getTileRectForSide(Meta.Side.BOTTOM + Meta.Side.RIGHT, workArea, screenRects);
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
				if (!Funcs.equalApprox(freeArea, area, 5))
					rect = workArea;
			}
			break;
		
		case "replace-window":
			Funcs.replaceTiledWindow(window);
			return;
	}

	if ((window.isTiled && Funcs.rectsAreAboutEqual(rect, window.tiledRect)) || (shortcutName == "tile-maximize" && Funcs.rectsAreAboutEqual(workArea, window.get_frame_rect()))) {
		Funcs.restoreWindowSize(window, true);

	} else {
		if (Funcs.rectsAreAboutEqual(rect, workArea))
			Funcs.maximizeBoth(window);
		else
			Funcs.tileWindow(window, rect);
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

	let openWindows = Funcs.getOpenWindows()
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
            let currTileGroup = Funcs.getTopTileGroup();
            let freeScreenRects = Funcs.getFreeScreenRects(currTileGroup);
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
					if (Funcs.equalApprox(otherRect.y + otherRect.height, grabbedRect.y, gap) && Funcs.equalApprox(grabbedRect.x, otherRect.x, gap) && Funcs.equalApprox(grabbedRect.width, otherRect.width, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}

				} else {
					if (Funcs.equalApprox(otherRect.y, grabbedRect.y, gap)) {
						grabbedWindow.sameSideWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
	
					} else if (Funcs.equalApprox(otherRect.y + otherRect.height, grabbedRect.y, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}
				}
			}

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("size-changed", Funcs.resizeComplementingWindows.bind(this, grabbedWindow, grabOp, settings.get_int("window-gaps"))));
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
					if (Funcs.equalApprox(otherRect.y, grabbedRect.y + grabbedRect.height, gap) && Funcs.equalApprox(grabbedRect.x, otherRect.x, gap) && Funcs.equalApprox(grabbedRect.width, otherRect.width, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}

				} else {
					if (Funcs.equalApprox(otherRect.y + otherRect.height, grabbedRect.y + grabbedRect.height, gap)) {
						grabbedWindow.sameSideWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();

					} else if (Funcs.equalApprox(otherRect.y, grabbedRect.y + grabbedRect.height, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}
				}
			}

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("size-changed", Funcs.resizeComplementingWindows.bind(this, grabbedWindow, grabOp, gap)));
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
					if (Funcs.equalApprox(otherRect.x, grabbedRect.x + grabbedRect.width, gap) && Funcs.equalApprox(grabbedRect.y, otherRect.y, gap) && Funcs.equalApprox(grabbedRect.height, otherRect.height, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}

				} else {
					if (Funcs.equalApprox(otherRect.x + otherRect.width, grabbedRect.x + grabbedRect.width, gap)) {
						grabbedWindow.sameSideWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();

					} else if (Funcs.equalApprox(otherRect.x, grabbedRect.x + grabbedRect.width, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}
				}
			}

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("size-changed", Funcs.resizeComplementingWindows.bind(this, grabbedWindow, grabOp, gap)));
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
					if (Funcs.equalApprox(otherRect.x + otherRect.width, grabbedRect.x, gap) && Funcs.equalApprox(grabbedRect.y, otherRect.y, gap) && Funcs.equalApprox(grabbedRect.height, otherRect.height, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}

				} else {
					if (Funcs.equalApprox(otherRect.x, grabbedRect.x, gap)) {
						grabbedWindow.sameSideWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();

					} else if (Funcs.equalApprox(otherRect.x + otherRect.width, grabbedRect.x, gap)) {
						grabbedWindow.opposingWindows.push(oW);
						oW.preGrabRect = oW.get_frame_rect().copy();
					}
				}
			}

			grabbedWindow.grabSignalIDs.push(grabbedWindow.connect("size-changed", Funcs.resizeComplementingWindows.bind(this, grabbedWindow, grabOp, settings.get_int("window-gaps"))));
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
			if (tilePreview.showing) {
				// halving already tiled window
				if (tilePreview.tiledWindow)
					Funcs.tileWindow(tilePreview.tiledWindow, Funcs.rectDiff(tilePreview.tiledWindow.tiledRect, tilePreview.rect)[0], false);
		
				let workArea = window.get_work_area_current_monitor();
				if (workArea.equal(tilePreview.rect))
					Funcs.maximizeBoth(window);
				else
					Funcs.tileWindow(window, tilePreview.rect);
		
				tilePreview.close();
			}

		default:
			return;
	}

	if (!window.isTiled)
		return;

	// update the tiledRects.
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
	let tileGroup = Funcs.getTopTileGroup(null, false);
	tileGroup.forEach(w => Funcs.removeTileGroup(w));
	Funcs.updateTileGroup(tileGroup);
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
		
		// timer needed because for some apps the grab will overwrite/ignore the size changes of Funcs.restoreWindowSize()
		// so far I only noticed this behaviour with firefox
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
			Funcs.restoreWindowSize(window);

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
	let onBottom = workArea.height - wRect.y < 75 || mouseY > workArea.height - 25;
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

	let pos = 0; // Meta.Side.X

	// halve tiled window which is hovered while pressing ctrl
	let event = Clutter.get_current_event();
	let modifiers = event ? event.get_state() : 0;
	let isCtrlPressed = modifiers & Clutter.ModifierType.CONTROL_MASK;
	let isHoveringRect = false;
	let mousePoint = {x: mouseX, y: mouseY};

    // default sizes or halving tiled windows
	if (isCtrlPressed) {
        if (tileTopLeftQuarter) {  
            tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x,
                y: workArea.y,
                width: workArea.width / 2,
                height: workArea.height / 2,
            }), monitorNr);
    
        } else if (tileTopRightQuarter) {
            tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x + workArea.width / 2,
                y: workArea.y,
                width: workArea.width / 2,
                height: workArea.height / 2,
            }), monitorNr);
    
        } else if (tileBottomLeftQuarter) {
           tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x,
                y: workArea.y + workArea.height / 2,
                width: workArea.width / 2,
                height: workArea.height / 2,
            }), monitorNr);
    
        } else if (tileBottomRightQuarter) {
            tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x + workArea.width / 2,
                y: workArea.y + workArea.height / 2,
                width: workArea.width / 2,
                height: workArea.height / 2,
            }), monitorNr);
    
        } else if (tileRightHalf) {
            tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x + workArea.width / 2,
                y: workArea.y,
                width: workArea.width / 2,
                height: workArea.height,
            }), monitorNr);
    
        } else if (tileLeftHalf) {
            tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x,
                y: workArea.y,
                width: workArea.width / 2,
                height: workArea.height,
            }), monitorNr);
    
        } else if (tileTopHalf) {
            tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x,
                y: workArea.y,
                width: workArea.width,
                height: workArea.height / 2,
            }), monitorNr);
    
        } else if (tileBottomHalf) {
            tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x,
                y: workArea.y + workArea.height / 2,
                width: workArea.width,
                height: workArea.height / 2,
            }), monitorNr);
    
        } else if (tileMaximized) {
            tilePreview.open(window, new Meta.Rectangle({
                x: workArea.x,
                y: workArea.y,
                width: workArea.width,
                height: workArea.height,
            }), monitorNr);

        } else {
            // tile to half of a tiled window
            for (let i = 0; i < currTileGroup.length; i++) {
                let w = currTileGroup[i];
                let wRect = w.get_frame_rect();
    
                if (!Funcs.rectHasPoint(wRect, mousePoint))
                    continue;
    
                isHoveringRect = true;
    
                let top = mouseY < wRect.y + wRect.height * .2;
                let bottom = mouseY > wRect.y + wRect.height * .8;
                let vertical = top || bottom;
                let right = mouseX > wRect.x + wRect.width / 2;
    
                wRect = w.tiledRect;
                let r = new Meta.Rectangle({
                    x: wRect.x + (right && !vertical ? wRect.width / 2 : 0),
                    y: wRect.y + (bottom ? wRect.height / 2 : 0),
                    width: wRect.width / (vertical ? 1 : 2),
                    height: wRect.height / (vertical ? 2 : 1)
                });
            
                tilePreview.open(window, r, monitorNr, w);
            }
    
            if (!isHoveringRect) {
                // tile to freeScreenRect
                for (let i = 0; i < freeScreenRects.length; i++) {
                    let r = freeScreenRects[i];
                    if (!Funcs.rectHasPoint(r, mousePoint))
                        continue;
    
                    tilePreview.open(window, r, monitorNr);
                    return;
                }
                
                tilePreview.close();
            }
        }

	} else if (tileTopLeftQuarter) {
		tilePreview.open(window, Funcs.getTileRectForSide(Meta.Side.TOP + Meta.Side.LEFT, workArea, screenRects), monitorNr);

	} else if (tileTopRightQuarter) {
		tilePreview.open(window, Funcs.getTileRectForSide(Meta.Side.TOP + Meta.Side.RIGHT, workArea, screenRects), monitorNr);

	} else if (tileBottomLeftQuarter) {
		tilePreview.open(window, Funcs.getTileRectForSide(Meta.Side.BOTTOM + Meta.Side.LEFT, workArea, screenRects), monitorNr);

	} else if (tileBottomRightQuarter) {
		tilePreview.open(window, Funcs.getTileRectForSide(Meta.Side.BOTTOM + Meta.Side.RIGHT, workArea, screenRects), monitorNr);

	} else if (tileRightHalf) {
		tilePreview.open(window, Funcs.getTileRectForSide(Meta.Side.RIGHT, workArea, screenRects), monitorNr);

	} else if (tileLeftHalf) {
		tilePreview.open(window, Funcs.getTileRectForSide(Meta.Side.LEFT, workArea, screenRects), monitorNr);

	} else if (tileTopHalf) {
		tilePreview.open(window, Funcs.getTileRectForSide(Meta.Side.TOP, workArea, screenRects), monitorNr);

	} else if (tileBottomHalf) {
		tilePreview.open(window, Funcs.getTileRectForSide(Meta.Side.BOTTOM, workArea, screenRects), monitorNr);

	} else if (tileMaximized) {
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y,
			width: workArea.width,
			height: workArea.height,
		}), monitorNr);

	} else {
		tilePreview.close();
	}
};

// called when a window is tiled (via tileWindow()).
// decides wether the Dash should be opened. If yes, the dash will be opened.
function onWindowTiled(tiledWindow) {
	if (appDash.shown || !settings.get_boolean("enable-dash"))
		return;
		
	let openWindows = Funcs.getOpenWindows();
	let currTileGroup = Funcs.getTopTileGroup(openWindows, false);

	// remove the tiled windows from openWindows to populate the Dash
	currTileGroup.forEach(w => {
		let idx = openWindows.indexOf(w);
		if (idx != -1)
			openWindows.splice(idx, 1);
	});

	// filter for non-normal windows (like Desktop windows e.g. conky...)
	let winTracker = Shell.WindowTracker.get_default();
	openWindows = openWindows.filter((w, idx) => w.get_window_type() == Meta.WindowType.NORMAL);
	
	if (openWindows.length == 0)
		return;

	// filter the openWindows array, so that no duplicate apps are shown
	let openApps = [];
	openWindows.forEach(w => openApps.push(winTracker.get_window_app(w)));
	openWindows = openWindows.filter((w, pos) => openApps.indexOf(winTracker.get_window_app(w)) == pos);
	
	let freeScreenRects = Funcs.getFreeScreenRects(currTileGroup);
	if (!freeScreenRects.length)
		return;
	
	let freeScreenSpace = freeScreenRects[0];
	
	if (freeScreenRects.length > 1) {
		let area = freeScreenRects[0].area();
		for (let i = 1; i < freeScreenRects.length; i++) {
			area += freeScreenRects[i].area();
			freeScreenSpace = freeScreenSpace.union(freeScreenRects[i]);
		}

		// free screen space doesnt consist of "aligned" rects, e.g. only 1 quartered window or uneven windows...
		if (!Funcs.equalApprox(freeScreenSpace.area(), area, 15))
			return;		
	}

	if (freeScreenSpace.width < 200 || freeScreenSpace.height < 200)
		return;

	appDash.open(openWindows, tiledWindow, tiledWindow.get_monitor(), freeScreenSpace);
};

////////////////////////////////////////////////////////////////////
////////////////////////      Classes      /////////////////////////
////////////////////////////////////////////////////////////////////

// the Dash which contains the TilingAppIcons to auto-fill the empty screen space
var TilingAppDash = GObject.registerClass(
	class TilingAppDash extends St.Widget {
		_init() {
			super._init();

			this.shown = false;

			// for animation move direction of the Dash.
			// Dash will move from the tiled window dir to the center of the free screen space
			this.animationDir = { x: 0, y: 0 };

			// shade BG when the Dash is open for easier visibility
			this.shadeBG = new St.Widget({
				style: ("background-color : black"),
				x: 0, y: 0,
				opacity: 0
			});
			global.window_group.add_child(this.shadeBG);
			this.shadeBG.hide();

			// clones to show above the shadeBG (which is just below the tiledWindow)
			this.windowClones = [];

			// hide Dash on mouse clicks
			this.mouseCatcher = new St.Widget({
				reactive: true,
				x: 0, y: 0,
			});
			main.layoutManager.addChrome(this.mouseCatcher);
			this.mouseCatcher.hide();
			this.mouseCatcher.connect("button-press-event", () => {
				if (this.shown)
					this.close();
			});

			// visual BG for the windows if an app has multiple open windows
			this.windowDash = new St.Widget({
				style_class: "my-open-windows-dash",
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
			});
			main.layoutManager.addChrome(this.windowDash);
			this.windowDash.focusItemAtIndex = this.focusItemAtIndex;
			this.windowDash.set_opacity(0);
			this.windowDash.hide();

			// visual BG for the Dash of open appIcons
			this.dashBG = new St.Widget({
				style_class: "my-open-windows-dash",
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 })
			});
			main.layoutManager.addChrome(this.dashBG);
			this.dashBG.hide();

			// container for appIcons, centered in dashBG
			this.appContainer = new St.Widget({
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 })
			});
			this.appContainer.focusItemAtIndex = this.focusItemAtIndex;
			this.dashBG.add_child(this.appContainer);
		}

		_destroy() {
			this.shadeBG.destroy();
			this.mouseCatcher.destroy();
			this.dashBG.destroy();
			this.windowDash.destroy();
			this.destroy();
		}

		// open when a window is tiled and when there is screen space available
		open(openWindows, tiledWindow, monitorNr, freeScreenRect, layout = null) {
			this.shown = true;
            this.appContainer.destroy_all_children();
            
			this.freeScreenRect = freeScreenRect;
			this.tilingLayout = layout;
			this.openWindows = openWindows;
			this.monitor = monitorNr;
			let monitorScale = global.display.get_monitor_scale(monitorNr);
			let buttonSize = monitorScale * (settings.get_int("icon-size") + 16 + settings.get_int("icon-margin") + ((settings.get_boolean("show-label")) ? 28 : 0));

			this._setupAppContainer(buttonSize, monitorScale);
			this._setupDashBg(buttonSize, tiledWindow);
			this._shadeBackground(tiledWindow);
			this._setupMouseCatcher();

			if (Array.isArray(layout)) {
				this.layoutPreview = new St.Widget({
					style_class: "tile-preview",
					x: freeScreenRect.x + freeScreenRect.width / 2,
					y: freeScreenRect.y + freeScreenRect.height / 2,
				});
				global.window_group.add_child(this.layoutPreview);

				this.layoutPreview.ease({
					x: freeScreenRect.x,
					y: freeScreenRect.y,
					width: freeScreenRect.width,
					height: freeScreenRect.height,
					duration: windowManager.MINIMIZE_WINDOW_ANIMATION_TIME,
					mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				});
			}
		}

		close(clearTilingLayout = false) {
			this.shown = false;
			this.mouseCatcher.hide();
			this.shadeBG.hide();

			if (clearTilingLayout) {
				this.tilingLayout = [];
				this.openWindows = [];
			}
			if (this.layoutPreview) {
				this.layoutPreview.destroy();
				this.layoutPreview = null;
			}

			this.windowClones.forEach(clone => {
				clone.source.show();
				clone.destroy();
			});

			let finalX = this.dashBG.x + 200 * this.animationDir.x;
			let finalY = this.dashBG.y + 200 * this.animationDir.y;
			this.dashBG.ease({
				x: finalX,
				y: finalY,
				opacity: 0,
				duration: windowManager.MINIMIZE_WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => {
					this.dashBG.hide();
				}
			});

			let finalX2 = this.windowDash.x + 200 * this.animationDir.x;
			let finalY2 = this.windowDash.y + 200 * this.animationDir.y;
			this.windowDash.ease({
				x: finalX2,
				y: finalY2,
				opacity: 0,
				duration: windowManager.MINIMIZE_WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.windowDash.hide()
			});
		}

		_setupAppContainer(buttonSize, monitorScale) {
			let windowCount = this.openWindows.length;
			this.appContainer.set_size(windowCount * buttonSize, buttonSize);
			this.appContainer.set_position(settings.get_int("icon-margin") / 2 * monitorScale, settings.get_int("icon-margin") / 2 * monitorScale);

			for (let idx = 0, posX = 0; idx < windowCount; idx++, posX += buttonSize) {
				let appIcon = new TilingAppIcon(this.openWindows[idx], idx, { showLabel: settings.get_boolean("show-label") });
				this.appContainer.add_child(appIcon);
				appIcon.set_position(posX, 0);
			}
		}

		_setupDashBg(buttonSize, tiledWindow) {
			this.dashBG.set_size(this.openWindows.length * buttonSize, buttonSize);
			this.dashBG.set_scale(1, 1);

			// scale Dash to fit the freeScreenRect
			if (this.dashBG.width > this.freeScreenRect.width * .95) {
				let scale = this.freeScreenRect.width * .95 / this.dashBG.width;
				this.dashBG.set_scale(scale, scale);
			}

			this.dashBG.show();
			this.dashBG.set_position(this.freeScreenRect.x + this.freeScreenRect.width / 2 - this.dashBG.width / 2
					, this.freeScreenRect.y + this.freeScreenRect.height / 2 - this.dashBG.height / 2);

			// move bgContainer FROM final pos to animate TO final pos
			let finalX = this.dashBG.x;
			let finalY = this.dashBG.y;
			this.animationDir.x = Math.sign(((tiledWindow) ? tiledWindow.tiledRect.x : 0) - this.freeScreenRect.x); // tiledWindow = null on first tiling of layout
			this.animationDir.y = Math.sign(((tiledWindow) ? tiledWindow.tiledRect.y : 0) - this.freeScreenRect.y);
			this.dashBG.set_position(finalX + 400 * this.animationDir.x, this.dashBG.y + 400 * this.animationDir.y);
			this.dashBG.ease({
				x: finalX,
				y: finalY,
				opacity: 255,
				duration: windowManager.WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});
		}

		_shadeBackground(tiledWindow) {
			this.windowClones = [];

			if (tiledWindow) {
				// create clones to show above the shade
				tiledWindow.tileGroup.forEach(w => {
					if (w && w != tiledWindow) {
						let wA = w.get_compositor_private();
						let clone = new Clutter.Clone({
							source: wA,
							x: wA.x,
							y: wA.y
						});
						wA.hide();
						global.window_group.add_child(clone);
						this.windowClones.push(clone);
					}
				});
	
				// shadeBG wont be set properly on consecutive tiling (i. e. holding shift/alt when tiling).
				// signal used as a workaround; not sure if this is the right/best signal to use
				let tiledWindowActor = tiledWindow.get_compositor_private();
				let sID = tiledWindowActor.connect("queue-redraw", () => {
					global.window_group.set_child_below_sibling(this.shadeBG, tiledWindowActor);
					this.windowClones.forEach(clone => global.window_group.set_child_below_sibling(clone, tiledWindowActor));
	
					// first icon grabs key focus
					// here to prevent focus issues on consecutive tiling
					this.appContainer.get_child_at_index(0).grab_key_focus();
	
					tiledWindowActor.disconnect(sID);
				});

			// no tiledWindow on first rect when using layouts
			} else {
				global.window_group.remove_child(this.shadeBG);
				global.window_group.add_child(this.shadeBG);
				this.appContainer.get_child_at_index(0).grab_key_focus();
			}

			let entireWorkArea = global.workspace_manager.get_active_workspace().get_work_area_all_monitors();
			this.shadeBG.set_size(entireWorkArea.width, entireWorkArea.height + main.panel.height);
			this.shadeBG.set_position(entireWorkArea.x, entireWorkArea.y);
			this.shadeBG.show();
			this.shadeBG.ease({
				opacity: 180,
				duration: windowManager.WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});
		}

		_setupMouseCatcher() {
			this.mouseCatcher.show();
			let monitorRect = global.display.get_monitor_geometry(this.monitor);
			this.mouseCatcher.set_size(monitorRect.width, monitorRect.height);
			this.mouseCatcher.set_position(0, 0);
		}

		// called with this.appContainer or this.windowDash as this
		focusItemAtIndex(index, maxCount) {
			index = (index < 0) ? maxCount - 1 : index;
			index = (index >= maxCount) ? 0 : index;
			this.get_child_at_index(index).grab_key_focus();
		}

		getAppCount() {
			return this.appContainer.get_n_children();
		}

		openWindowPreview(appIcon) {
			if (!appIcon.hasMultipleWindows())
				return;

			this.windowDash.destroy_all_children();
			this.windowDash.focusedWindow = null;
			this.windowDash.show();
			this.windowDash.set_scale(1, 1);
			this.windowDash.previewedAppIcon = appIcon;

			let windows = appIcon.windows;
			let windowCount = windows.length;

			let monitorRect = global.display.get_monitor_geometry(windows[0].get_monitor());
			let size = Math.round(200 * monitorRect.height / 1000); // might need a more consistent way to get a good button size

			// create window previews
			for (let idx = 0, posX = 0; idx < windowCount; idx++) {
				let preview = new TilingWindowPreview(appIcon, windows[idx], idx, size);
				this.windowDash.add_child(preview);
				preview.set_position(posX, 0);
				posX += preview.width;
			}

			// 30 = margin from stylesheet
			this.windowDash.set_size(windowCount * (size + 30), size + 30);

			// animate opening
			let finalWidth = this.windowDash.width;
			let finalHeight = this.windowDash.height;
			let finalScale = (finalWidth > monitorRect.width * .95) ? monitorRect.width * .95 / finalWidth : 1; // scale to fit screen if its too big
			let finalX = appIcon.get_transformed_position()[0] + appIcon.width / 2 - this.windowDash.width / 2;
			let finalY = this.dashBG.y + ((appIcon.arrowIsAbove) ? - 20 - finalHeight : this.dashBG.height + 20);

			if (finalX + finalWidth > monitorRect.width)
				finalX = monitorRect.width - 20 - finalWidth;
			else if (finalX < monitorRect.x)
				finalX = monitorRect.x + 20;

			this.windowDash.set_position(appIcon.get_transformed_position()[0] - this.windowDash.width / 2 + appIcon.width / 2, appIcon.get_transformed_position()[1] - this.windowDash.height / 2 + appIcon.height / 2);
			this.windowDash.set_scale(0, 0);
			this.windowDash.ease({
				x: (finalScale != 1) ? monitorRect.x + monitorRect.width / 2 - finalWidth / 2 : finalX, // center to screen if scale < 1 else center around appIcon
				y: finalY + ((appIcon.arrowIsAbove) ? 1 : -1) * (finalHeight - finalHeight * finalScale) / 2, // position 20 px above or below Dash respecting the finalScale
				scale_x: finalScale,
				scale_y: finalScale,
				width: finalWidth,
				height: finalHeight,
				opacity: 255,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			this.windowDash.get_child_at_index(0).grab_key_focus();
		}

		closeWindowPreview() {
			let currAppIcon = this.windowDash.previewedAppIcon;
			currAppIcon.grab_key_focus();
			this.windowDash.previewedAppIcon = null;

			// scale in to the appIcon
			let finalX = currAppIcon.get_transformed_position()[0] - this.windowDash.width / 2 + currAppIcon.width / 2;
			let finalY = currAppIcon.get_transformed_position()[1] - this.windowDash.height / 2 + currAppIcon.height / 2
			this.windowDash.ease({
				x: finalX,
				y: finalY,
				scale_x: 0,
				scale_y: 0,
				opacity: 0,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => {
					this.windowDash.hide();
					this.windowDash.destroy_all_children();
				}
			});
		}
	}
);

// mostly from windowManager.js
// this is the preview which is shown when DNDing to a screen edge/corner
var TilingTilePreview = GObject.registerClass(
	class TilingTilePreview extends St.Widget {
		_init() {
			super._init();
			main.uiGroup.add_child(this);

			this.reset();
			this.showing = false;
		}

		open(window, tileRect, monitorIndex, tiledWindow = null) {
			let windowActor = window.get_compositor_private();
			if (!windowActor)
				return;

			if (this.rect && this.rect.equal(tileRect))
				return;

			let changeMonitor = this.monitorIndex == -1 ||
				this.monitorIndex != monitorIndex;

			this.monitorIndex = monitorIndex;
			this.rect = tileRect;
			this.tiledWindow = tiledWindow; // preview over tiled window when holding ctrl

			let monitor = main.layoutManager.monitors[monitorIndex];

			// update style class
			let styles = ["tile-preview"];
			if (this.monitorIndex == main.layoutManager.primaryIndex)
				styles.push("on-primary");
			if (this.rect.x == monitor.x)
				styles.push("tile-preview-left");
			if (this.rect.x + this.rect.width == monitor.x + monitor.width)
				styles.push("tile-preview-right");
			this.style_class = styles.join(" ");

			if (!this.showing || changeMonitor) {
				let monitorRect = new Meta.Rectangle({
					x: monitor.x,
					y: monitor.y,
					width: monitor.width,
					height: monitor.height
				});
				let [, rect] = window.get_frame_rect().intersect(monitorRect);
				this.set_size(rect.width, rect.height);
				this.set_position(rect.x, rect.y);
				this.opacity = 0;
			}

			this.showing = true;
			this.show();
			this.ease({
				x: tileRect.x,
				y: tileRect.y,
				width: tileRect.width,
				height: tileRect.height,
				opacity: 255,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		}

		close() {
			if (!this.showing)
				return;

			this.showing = false;
			this.tiledWindow = null;
			this.ease({
				opacity: 0,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => this.reset(),
			});
		}

		reset() {
			this.hide();
			this.rect = null;
			this.monitorIndex = -1;
		}
	}
);

// some stuff from appDisplay.js
// app icons which populate TilingAppDash
var TilingAppIcon = GObject.registerClass(
	class TilingAppIcon extends St.Button {
		_init(window, idx, iconParams = {}) {
			super._init({
				style_class: "app-well-app",
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
				reactive: true,
				button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
				can_focus: true,
			});

			this.index = idx;
			this.window = window;

			this.iconContainer = new St.Widget({
				layout_manager: new Clutter.BinLayout(),
				x_expand: true,
				y_expand: true
			});
			this.set_child(this.iconContainer);

			let winTracker = Shell.WindowTracker.get_default();
			this.app = winTracker.get_window_app(window);

			iconParams["createIcon"] = () => this.app.create_icon_texture(settings.get_int("icon-size"));
			iconParams["setSizeManually"] = true;
			this.icon = new iconGrid.BaseIcon(this.app.get_name(), iconParams);
			this.iconContainer.add_child(this.icon);

			let tmpWindows = this.app.get_windows();
			let windowCount = tmpWindows.length
			if (windowCount <= 1)
				return;

			// show arrow indicator if app has multiple windows; ignore the focused window (i. e. the just-tiled window) if its the same app
			let activeWS = global.workspace_manager.get_active_workspace();
			let tiledWindow = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse()[0];
			this.windows = [];

			for (let i = 0; i < windowCount; i++) {
				if (!tmpWindows[i].located_on_workspace(activeWS))
					break;

				// dont add the windows to the preview, if they are part of the current tileGroup
				if (tiledWindow.tileGroup) {
					let _continue = false;
					for (let pos in tiledWindow.tileGroup)
						if (tiledWindow.tileGroup[pos] == tmpWindows[i]) {
							_continue = true;
							break;
						}

					if (_continue)
						continue;
				}

				this.windows.push(tmpWindows[i]);
			}

			if (this.windows.length > 1) {
				let workArea = window.get_work_area_current_monitor();
				this.arrowIsAbove = appDash.freeScreenRect.y != workArea.y; // arrow above == true, if free quad is either the bottom left or bottom right quad
				this.arrowContainer = new St.BoxLayout({
					x_expand: true,
					y_expand: true,
					x_align: Clutter.ActorAlign.CENTER,
					y_align: (this.arrowIsAbove) ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
				});
				this.iconContainer.add_child(this.arrowContainer);

				let arrow = new St.DrawingArea({
					width: 8,
					height: 4,
					style: (this.arrowIsAbove) ? "margin-top: 2px; color: white" : "margin-bottom: 2px; color: white"
				});
				arrow.connect("repaint", () => switcherPopup.drawArrow(arrow, (this.arrowIsAbove) ? St.Side.TOP : St.Side.BOTTOM));
				this.arrowContainer.add_child(arrow);
			}

			this.connect("enter-event", () => {
				this.isHovered = true;

				if (appDash.windowDash.visible && appDash.windowDash.previewedAppIcon != this)
					appDash.closeWindowPreview()

				GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
					if (this.isHovered && appDash.shown && appDash.windowDash.previewedAppIcon != this)
						appDash.openWindowPreview(this);
					
					return GLib.SOURCE_REMOVE;
				});
			});

			this.connect("leave-event", () => {
				this.isHovered = false;
			});
		}

		hasMultipleWindows() {
			return (this.arrowContainer) ? true : false;
		}

		vfunc_key_press_event(keyEvent) {
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
					appDash.appContainer.focusItemAtIndex(this.index + 1, appDash.getAppCount());
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					appDash.appContainer.focusItemAtIndex(this.index - 1, appDash.getAppCount());
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Up:
				case Clutter.KEY_Down:
					appDash.openWindowPreview(this);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					this.activate(this.window);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case 65513: // LAlt
				case 65027: // RAlt
					return Clutter.EVENT_STOP;
			}

			// close the Dash on all other key inputs
			if (appDash.shown)
				appDash.close(true);

			return Clutter.EVENT_PROPAGATE;
		}

		vfunc_clicked(button) {
			this.activate(this.window);
		}

		activate(window) {
			if (appDash.shown) {
				appDash.close();

				this.icon.animateZoomOut();

				window.move_to_monitor(appDash.monitor);
				window.activate(global.get_current_time());

				let event = Clutter.get_current_event();
				let modifiers = event ? event.get_state() : 0;
				let isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
				let isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;

				let tileInLayout = appDash.tilingLayout && appDash.tilingLayout.length > 0;

				if (!tileInLayout) {
					if (isAltPressed) {
						if (appDash.freeScreenRect.width >= appDash.freeScreenRect.height * 1.25) { // prefer vertical tiling more (because of horizontal screen orientation)
							appDash.freeScreenRect.x = appDash.freeScreenRect.x + appDash.freeScreenRect.width / 2;
							appDash.freeScreenRect.width = appDash.freeScreenRect.width / 2;
	
						} else {
							appDash.freeScreenRect.y = appDash.freeScreenRect.y + appDash.freeScreenRect.height / 2;
							appDash.freeScreenRect.height = appDash.freeScreenRect.height / 2;
						}
	
					} else if (isShiftPressed) {
						if (appDash.freeScreenRect.width >= appDash.freeScreenRect.height * 1.25) // prefer vertical tiling more (because of horizontal screen orientation)
							appDash.freeScreenRect.width = appDash.freeScreenRect.width / 2;
	
						else
							appDash.freeScreenRect.height = appDash.freeScreenRect.height / 2;
					}
				}

				Funcs.tileWindow(window, appDash.freeScreenRect, !tileInLayout);

				if (tileInLayout) {
					// save the windows which were tiled as part of a layout to remove them from the openWindows.
					// cant use tileGroup here
					if (!appDash.tiledViaLayout)
						appDash.tiledViaLayout = [];
					
					appDash.tiledViaLayout.push(window);

					// remove windows from openWindows, if they were tiled with the current layout
					let allWindowsTiledInLayout = true;
					let idx = appDash.openWindows.indexOf(window);
					let appWindows = this.app.get_windows().filter(w => w.located_on_workspace(global.workspace_manager.get_active_workspace()));
					for (let i = 0; i < appWindows.length; i++) {
						let w = appWindows[i];
						if (appDash.tiledViaLayout.includes(w))
							continue;

						allWindowsTiledInLayout = false;
						appDash.openWindows[idx] = w;
						break;
					}

					if (allWindowsTiledInLayout)
						appDash.openWindows.splice(idx, 1);

					if (!appDash.openWindows.length) {
						appDash.tiledViaLayout = [];
						return;
					}

					let freeScreenRect = appDash.tilingLayout.shift();
					if (!appDash.tilingLayout.length)
						appDash.tiledViaLayout = [];

					appDash.open(appDash.openWindows, window, window.get_monitor(), freeScreenRect, appDash.tilingLayout)
				}
			}
		}
	}
);

// some stuff from altTab.WindowIcon
// the window preview, if a TilingAppIcon has multiple windows open on the current workspace
var TilingWindowPreview = GObject.registerClass(
	class TilingWindowPreview extends St.Button {
		_init(appIcon, window, index, fullSize) {
			super._init({
				style_class: "tiling-window-unfocused",
				reactive: true,
				button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
				can_focus: true,
			});

			this.appIcon = appIcon;
			this.window = window;
			this.index = index;

			this.iconContainer = new St.Widget({
				layout_manager: new Clutter.BinLayout(),
				x_expand: true,
				y_expand: true,
				width: fullSize,
				height: fullSize,
			});
			this.set_child(this.iconContainer);

			this.icon = altTab._createWindowClone(window.get_compositor_private(), fullSize - 20); // 20 = small gap from preview size to actual window preview
			this.iconContainer.add_child(this.icon);

			this.connect("enter-event", () => {
				if (this.get_style_class_name() != "tiling-window-focused")
					this.set_style_class_name("tiling-window-hovered");
			});

			this.connect("leave-event", () => {
				if (this.get_style_class_name() != "tiling-window-focused")
					this.set_style_class_name("tiling-window-unfocused");
			});
		}

		vfunc_clicked(button) {
			this.appIcon.activate(this.window);
		}

		vfunc_key_focus_in() {
			if (appDash.windowDash.focusedWindow)
				appDash.windowDash.focusedWindow.set_style_class_name("tiling-window-unfocused");
			appDash.windowDash.focusedWindow = this;
			this.set_style_class_name("tiling-window-focused");
		}

		vfunc_key_press_event(keyEvent) {
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
					appDash.windowDash.focusItemAtIndex(this.index + 1, appDash.windowDash.previewedAppIcon.windows.length);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					appDash.windowDash.focusItemAtIndex(this.index - 1, appDash.windowDash.previewedAppIcon.windows.length);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Up:
				case Clutter.KEY_Down:
					appDash.closeWindowPreview();
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					this.appIcon.activate(this.window);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case 65513: // LAlt
				case 65027: // RAlt
					return Clutter.EVENT_STOP;
			}

			// close the Dash on all other key inputs
			if (appDash.shown)
				appDash.close();

			return Clutter.EVENT_PROPAGATE;
		}
	}
);