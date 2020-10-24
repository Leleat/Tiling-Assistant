const Lang = imports.lang;
const {main, iconGrid} = imports.ui;
const {GObject, GLib, St, Shell, Clutter, Meta, Graphene} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

let openWindowsDash = null;
let tilePreview = null;
let tiledWindows = {}; // {window : old frame rect}
let windowGrabSignals = {}; // {windowID : [signalIDs]}

let ICON_SIZE;
let ICON_MARGIN;
let SHOW_LABEL;

// TODO
// resizing of windows
// new tiling keyboard shortcuts

// Known issue:
// breaks GNOME's resize animations

function init() {
};

function enable() {
	ICON_SIZE = 75;
	ICON_MARGIN = 20;
	SHOW_LABEL = false;
	
	// signal connections
	this.windowGrabBegin = global.display.connect('grab-op-begin', onGrabBegin.bind(this) );
	this.windowGrabEnd = global.display.connect("grab-op-end", onGrabEnd.bind(this));
	this.shortcutPressed = global.window_manager.connect( "filter-keybinding", onShortcutPressed.bind(this));
	this.maximizedStateChanged = global.window_manager.connect("size-change", onMaxStateChanged.bind(this));

	openWindowsDash = new OpenWindowsDash();
	tilePreview = new MyTilePreview();

	// disable native tiling
	// taken from ShellTile@emasab.it - https://extensions.gnome.org/extension/657/shelltile/
	// dont know why gnome_shell_settings tiling is disabled...
	// Known Issue:
	// sometimes the window wont move to the top completely; instead there is an invisible barrier below the topbar and only on enough force will the window snaps to top
	this.gnome_mutter_settings = ExtensionUtils.getSettings("org.gnome.mutter");
	this.gnome_mutter_settings.set_boolean("edge-tiling", false);
	this.gnome_shell_settings = ExtensionUtils.getSettings("org.gnome.shell.overrides");
	this.gnome_shell_settings.set_boolean("edge-tiling", false);
};

function disable() {
	// disconnect signals
	global.display.disconnect(this.windowGrabBegin);
	global.display.disconnect(this.windowGrabEnd);
	global.window_manager.disconnect(this.shortcutPressed);
	global.window_manager.disconnect(this.maximizedStateChanged);

	tilePreview.destroy();

	openWindowsDash._destroy();
	ICON_SIZE = null;
	ICON_MARGIN = null;
	SHOW_LABEL = null;

	// re-enable native tiling
	this.gnome_mutter_settings.reset("edge-tiling");
	this.gnome_shell_settings.reset("edge-tiling");
};

function tileWindow(window, rect) {
	if (!window)
		return;
		
	if (window.get_maximized())
		window.unmaximize(window.get_maximized());

	if (!window.allows_resize() || !window.allows_move())
		return;
		
	tiledWindows[window] = window.get_frame_rect();
	let wActor = window.get_compositor_private();
	wActor.connect("destroy", ((w) => {	
		if (tiledWindows[w])
			delete tiledWindows[w];
	}).bind(this, window));

	window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
	window.focus(global.get_current_time());

	let workArea = window.get_work_area_current_monitor();
	if (rect.height == workArea.height && rect.width == workArea.width)
		window.maximize(Meta.MaximizeFlags.BOTH);

	else if (rect.height >= workArea.height - 2)
		window.maximize(Meta.MaximizeFlags.VERTICAL);
	
	else if (rect.width >= workArea.width - 2)
		window.maximize(Meta.MaximizeFlags.HORIZONTAL);

	// directly check wether to open the dash on quartered since there is no signal (like size-change)
	if (equalApprox(rect.width, workArea.width / 2, 2) && equalApprox(rect.height, workArea.height / 2, 2))
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => openDash(window)); // timer needed to correctly shade the bg (on multiple tiling)
};

// called whenever the maximize state of a window is changed (...and maybe at other times as well; I dont know?)
function onMaxStateChanged(shellwm, actor, whichChange, oldFrameRect, _oldBufferRect) {
	if (openWindowsDash.isVisible())
		return;
		
	let tiledWindow = actor.get_meta_window();
	if (!tiledWindow.get_maximized() || tiledWindow.get_maximized() == Meta.MaximizeFlags.BOTH)
		return;

	// timer to get the correct new window pos and size
	let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
		GLib.source_remove(sourceID);
		openDash(tiledWindow);
	});
};

// called when a window is tiled
// either through the size-change signal when maximizing or directly when this extensions quarters a window.
// decides wether the Dash should be opened. If yes, the dash will be opened.
function openDash(tiledWindow) {
	let workArea = tiledWindow.get_work_area_current_monitor();

	// first we assume the entire screen is free space.
	// the screen will be split into 4 quads and be represented by the origin points of the quads in an array.
	let topLeftPoint = {
		x: workArea.x,
		y: workArea.y,
	};
	let topRightPoint = {
		x: workArea.x + Math.floor(workArea.width / 2),
		y: workArea.y,
	};
	let bottomLeftPoint = {
		x: workArea.x,
		y: workArea.y + Math.floor(workArea.height / 2),
	};
	let bottomRightPoint = {
		x: workArea.x + Math.floor(workArea.width / 2),
		y: workArea.y + Math.floor(workArea.height / 2),
	};
	let freeQuadOrigins = [topLeftPoint, topRightPoint, bottomLeftPoint, bottomRightPoint];

	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();
	let groupedWindows = getComplementingWindows(freeQuadOrigins, openWindows);

	if (freeQuadOrigins.length == 1) {
		openWindows = openWindows.filter((w) => {
			return !groupedWindows.includes(w);
		});

		if (openWindows.length)
			openWindowsDash.open(openWindows, tiledWindow, freeQuadOrigins, groupedWindows[groupedWindows.length - 1]);
		
	} else if (freeQuadOrigins.length == 2) {
		// dont open dash if the free space consists of diagonal quads
		if ( (freeQuadOrigins.includes(topLeftPoint) && freeQuadOrigins.includes(bottomRightPoint))
				|| (freeQuadOrigins.includes(topRightPoint) && freeQuadOrigins.includes(bottomLeftPoint)) )
			return;

		openWindows = openWindows.filter((w) => {
			return !groupedWindows.includes(w);
		});

		if (openWindows.length)
			openWindowsDash.open(openWindows, tiledWindow, freeQuadOrigins, groupedWindows[groupedWindows.length - 1]);
	}
};

// we loop through the windows based on their stack order (top to bottom)
// and remove the origin points from the free quad array. If the window is maximized, we will remove multiple points.
// if the point(s) we want to remove arent in the array, that means that the window isnt part of the tile group 
// because a window in a higher order already occupies that space
// in that case we will break from the loop.
// only works for windows which are at originial quarter position.
function getComplementingWindows(remainingQuadOrigins, openWindows) {
	// returns wether the window is tiled and fully visible considering the available space (which is represented by remainingPoints)
	let removeQuads = function(remainingPoints, window) {
		let workArea = window.get_work_area_current_monitor();
	
		// origin points of the 4 quadrants
		let topLeftPoint = null;
		let topRightPoint = null;
		let bottomLeftPoint = null;
		let bottomRightPoint = null;

		// setup the quadrant's origin point
		remainingPoints.forEach(point => {
			// top left point
			if (point.x == workArea.x && point.y == workArea.y)
				topLeftPoint = point;
			
			// top right point
			if (point.x == workArea.x + Math.floor(workArea.width / 2) && point.y == workArea.y)
				topRightPoint = point;
			
			// bottom left point
			if (point.x == workArea.x && point.y == workArea.y + Math.floor(workArea.height / 2))
				bottomLeftPoint = point;

			// bottom right point
			if (point.x == workArea.x + Math.floor(workArea.width / 2) && point.y == workArea.y + Math.floor(workArea.height / 2))
				bottomRightPoint = point;
		});

		let idx = -1;
		let maximizedIdx = -1;
		let windowRect = window.get_frame_rect();
		let windowIsQuartered = (windowRect.width == Math.floor(workArea.width / 2)) && (windowRect.height == Math.floor(workArea.height / 2));

		// top left still in remainingPoints
		if (topLeftPoint && windowRect.x == topLeftPoint.x && windowRect.y == topLeftPoint.y) {
			if (window.get_maximized() != Meta.MaximizeFlags.BOTH) {
				if (window.get_maximized() == Meta.MaximizeFlags.VERTICAL) {
					maximizedIdx = remainingPoints.indexOf(bottomLeftPoint);
					if (maximizedIdx == -1)
						return false;

					remainingPoints.splice(maximizedIdx, 1);
					
				} else if (window.get_maximized() == Meta.MaximizeFlags.HORIZONTAL) {
					maximizedIdx = remainingPoints.indexOf(topRightPoint);
					if (maximizedIdx == -1)
						return false;

					remainingPoints.splice(maximizedIdx, 1);

				} else if (!windowIsQuartered) {
					return false;
				}

				idx = remainingPoints.indexOf(topLeftPoint);
				remainingPoints.splice(idx, 1);
				return true;
			}

		// top right still in remainingPoints
		} else if (topRightPoint && windowRect.x == topRightPoint.x && windowRect.y == topRightPoint.y) {
			if (window.get_maximized() == Meta.MaximizeFlags.VERTICAL) {
				maximizedIdx = remainingPoints.indexOf(bottomRightPoint);
				if (maximizedIdx == -1)
					return false;

				remainingPoints.splice(maximizedIdx, 1);

			} else if (!windowIsQuartered) {
				return false;
			}

			idx = remainingPoints.indexOf(topRightPoint);
			remainingPoints.splice(idx, 1);
			return true;

		// bottom left still in remainingPoints
		} else if (bottomLeftPoint && windowRect.x == bottomLeftPoint.x && windowRect.y == bottomLeftPoint.y) {
			if (window.get_maximized() == Meta.MaximizeFlags.HORIZONTAL) {
				maximizedIdx = remainingPoints.indexOf(bottomRightPoint);
				if (maximizedIdx == -1)
					return false;

				remainingPoints.splice(maximizedIdx, 1);
			
			} else if (!windowIsQuartered) {
				return false;
			}

			idx = remainingPoints.indexOf(bottomLeftPoint);
			remainingPoints.splice(idx, 1);
			return true;

		// bottom right still in remainingPoints
		} else if (bottomRightPoint && windowRect.x == bottomRightPoint.x && windowRect.y == bottomRightPoint.y) {
			if (!windowIsQuartered)
				return false;

			idx = remainingPoints.indexOf(bottomRightPoint);
			remainingPoints.splice(idx, 1);
			return true;
		}

		return false;
	};

	let complementingWindows = [];		
	for (let i = 0; i < openWindows.length; i++) {
		let windowIsTiledNVisible = removeQuads(remainingQuadOrigins, openWindows[i]);
		if (!windowIsTiledNVisible)
			break;

		complementingWindows.push(openWindows[i]);
	}

	return complementingWindows;
};

// restore windows which were tiled with this extension and tiling keyboard shortcut pressed
function onShortcutPressed(shellWM, keyBinding) {
	if (openWindowsDash.isVisible()) {
		openWindowsDash.close();
		return;
	}
	
	let window = global.display.focus_window;
	if (!window)
		return;

	let workArea = window.get_work_area_current_monitor();
	let sourceID = 0;

	switch(keyBinding.get_name()) {
		case "toggle-tiled-left":
			log(window.get_maximized() == Meta.MaximizeFlags.VERTICAL)
			if ( (window.get_frame_rect().x - workArea.x < 5) ) // window is on the left on the current monitor (with a margin)
				if (window in tiledWindows && window.get_maximized() == Meta.MaximizeFlags.VERTICAL)
					sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { // timer needed because first the split view will be entered
						restoreWindowSize(window, true);
						GLib.source_remove(sourceID);
					});
			break;

		case "toggle-tiled-right":
			if ( (window.get_frame_rect().x - workArea.x > 5) ) // window is on the right on the current monitor (with a margin)
				if (window in tiledWindows && window.get_maximized() == Meta.MaximizeFlags.VERTICAL)
					sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { // timer needed because first the split view will be entered
						restoreWindowSize(window, true);
						GLib.source_remove(sourceID);
					});
			break;
	}
};

// calls either restoreWindowSize(), onWindowMoving() or resizeComplementingWindows() depending on where the drag began on the window
function onGrabBegin(_metaDisplay, metaDisplay, window, grabOp) {
	if (!window)
		return;
	
	if (!windowGrabSignals[window.get_id()])
		windowGrabSignals[window.get_id()] = [];

	switch (grabOp) {
		case Meta.GrabOp.MOVING:
			restoreWindowSize(window);
			windowGrabSignals[window.get_id()].push( window.connect("position-changed", onWindowMoving.bind(this, window)) );	
			break;
		
		case Meta.GrabOp.RESIZING_N:
		case Meta.GrabOp.RESIZING_S:
		case Meta.GrabOp.RESIZING_E:
		case Meta.GrabOp.RESIZING_W:
			windowGrabSignals[window.get_id()].push( window.connect("size-changed", resizeComplementingWindows.bind(this, window, grabOp)) );
	}
};

function onGrabEnd(_metaDisplay, metaDisplay, window, grabOp) {
	// disconnect the signals first
	if ( window && windowGrabSignals[window.get_id()] )
		for (let i = windowGrabSignals[window.get_id()].length - 1; i >= 0; i--) {
			window.disconnect( windowGrabSignals[window.get_id()][i] );
			windowGrabSignals[window.get_id()].splice(i, 1);
		}
	
	if (tilePreview._showing) {
		tileWindow(window, tilePreview._rect);
		tilePreview.close();
	}
};

// TODO 
// calculation for newPosX seems correct. But it only works when starting the drag in the Topbar AND not moving. 
// After that the window will teleport to a different pos.
function restoreWindowSize(window, restoreFullPos = false) {
	if (window && !(window in tiledWindows) )
		return;

	if (window.get_maximized())
		window.unmaximize(window.get_maximized());

	if (window.allows_resize() && window.allows_move()) {
		let oldRect = tiledWindows[window];
		let currWindowFrame = window.get_frame_rect();
		let [mouseX] = global.get_pointer();
		let relativeMouseX = (mouseX - currWindowFrame.x) / currWindowFrame.width; // percentage (in decimal) where the mouse.x is in the current window size
		let newPosX = mouseX - oldRect.width * relativeMouseX; // position the window after scaling, so that the mouse is at the same relative position.x e.g. mouse was at 50% of the old window and will be at 50% of the new one

		if (restoreFullPos)
			window.move_resize_frame(true, oldRect.x, oldRect.y, oldRect.width, oldRect.height);

		else // scale while keeping the top at the same y pos
			window.move_resize_frame(true, newPosX, currWindowFrame.y, oldRect.width, oldRect.height);

		delete tiledWindows[window];
	}
};

// TODO corner detection is kinda iffy
function onWindowMoving(window) {
	let [mouseX, mouseY] = global.get_pointer();
	let workArea = window.get_work_area_current_monitor();

	let tileMaximized = mouseY <= 20;
	// on the left and the right side of the panel
	let tileTopHalf = mouseY <= 20 && ( (mouseX > 20 && mouseX < workArea.width / 4) || (mouseX < workArea.y + workArea.width - 20 && mouseX > workArea.y + workArea.width - workArea.width / 4) );
	let tileTopLeftQuarter = mouseX <= workArea.x + 20 && mouseY <= workArea.y + 20;
	let tileTopRightQuarter = mouseX >= workArea.x + workArea.width - 20 && mouseY <= workArea.y + 20;
	let tileBottomLeftQuarter = mouseX <= workArea.x + 20 && mouseY >= workArea.y + workArea.height - 20;
	let tileBottomRightQuarter = mouseX >= workArea.x + workArea.width - 20 && mouseY >= workArea.y + workArea.height - 20;
	let tileRightHalf = mouseX >= workArea.x + workArea.width - 20 && (mouseY >= workArea.y + 20 || mouseY <= workArea.y + workArea.height - 20);
	let tileLeftHalf = mouseX <= workArea.x + 20 && (mouseY >= workArea.y + 20 || mouseY <= workArea.y + workArea.height - 20);
	let tileBottomHalf = mouseY >= workArea.y + workArea.height - 20;

	if (tileTopLeftQuarter)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y,
			width: workArea.width / 2,
			height: workArea.height / 2,
		}), window.get_monitor());

	else if (tileTopRightQuarter)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x + workArea.width / 2,
			y: workArea.y,
			width: workArea.width / 2,
			height: workArea.height / 2,
		}), window.get_monitor());

	else if (tileBottomLeftQuarter)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y + workArea.height / 2,
			width: workArea.width / 2,
			height: workArea.height / 2,
		}), window.get_monitor());

	else if (tileBottomRightQuarter)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x + workArea.width / 2,
			y: workArea.y + workArea.height / 2,
			width: workArea.width / 2,
			height: workArea.height / 2,
		}), window.get_monitor());

	else if (tileRightHalf)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x + workArea.width / 2,
			y: workArea.y,
			width: workArea.width / 2,
			height: workArea.height,
		}), window.get_monitor());

	else if (tileLeftHalf)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y,
			width: workArea.width / 2,
			height: workArea.height,
		}), window.get_monitor());

	else if (tileTopHalf)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y,
			width: workArea.width,
			height: workArea.height / 2,
		}), window.get_monitor());

	else if (tileBottomHalf)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y + workArea.height / 2,
			width: workArea.width,
			height: workArea.height / 2,
		}), window.get_monitor());

	else if (tileMaximized)
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y,
			width: workArea.width,
			height: workArea.height,
		}), window.get_monitor());
	
	else
		tilePreview.close();
};

function resizeComplementingWindows(resizedWindow, grabOp) {
	let workArea = resizedWindow.get_work_area_current_monitor(); 
	let resizedFrame = resizedWindow.get_frame_rect();	

	switch (grabOp) {
		case Meta.GrabOp.RESIZING_N:
			
			break;

		case Meta.GrabOp.RESIZING_S:

			break;

		case Meta.GrabOp.RESIZING_E:

			break;

		case Meta.GrabOp.RESIZING_W:

	}
};

function equalApprox(value, value2, margin) {
	if (value >= value2 - margin && value <= value2 + margin)
		return true;
return false;
};

var OpenWindowsDash = GObject.registerClass(
	class OpenWindowsDash extends St.Widget {
		_init() {
			super._init();

			// for animation move direction of the Dash (the Dash will move from the tiled window pos to the center of the remaining free space)
			this.animationDir = {x: 0, y: 0};

			// shade BG when the Dash is open for easier visibility
			this.shadeBG = new St.Widget({
				style: ("background-color : black"),
				x: 0,
				y: 0,
				opacity: 0
			});
			global.window_group.add_child(this.shadeBG);
			this.shadeBG.hide();

			// hide Dash on mouse clicks
			this.mouseCatcher = new St.Widget({
				reactive: true,
				x: 0,
				y: 0,
			});
			main.layoutManager.addChrome(this.mouseCatcher);
			this.mouseCatcher.hide();
			this.onMouseCaught = this.mouseCatcher.connect("button-press-event", () => {
				if (this.isVisible()) 
					this.close();
			});

			// visual BG for the Dash
			this.bgGrid = new St.Widget({
				height: ICON_SIZE + 16 + ICON_MARGIN + ((SHOW_LABEL) ? 28 : 0), // magicNr are margins/paddings from the icon to the full-sized highlighted button
				style_class: "my-open-windows-dash",
			});
			main.layoutManager.addChrome(this.bgGrid);
			this.bgGrid.hide();

			// container for appIcons, same pos as bgGrid
			this.appContainer = new St.Widget();
			this.appContainer.focusItemAtIndex = this.focusItemAtIndex;
			this.bgGrid.add_child(this.appContainer);
		}

		_destroy() {
			this.shadeBG.destroy();
			this.mouseCatcher.disconnect(this.onMouseCaught);
			this.mouseCatcher.destroy();
			this.bgGrid.destroy();
			this.destroy();
		}

		open(openWindows, tiledWindow, freeSpaceOriginPoints, lastTiledW) {
			this.appContainer.destroy_all_children();
			let workArea = tiledWindow.get_work_area_current_monitor();
			let entireWorkArea = tiledWindow.get_work_area_all_monitors();

			// fill appContainer
			let winTracker = Shell.WindowTracker.get_default();
			this.appContainer.appCount = 0;
			let pos = 0;
			let freeScreenRect = new Meta.Rectangle({
				x: freeSpaceOriginPoints[0].x,
				y: freeSpaceOriginPoints[0].y,
				width: Math.floor(workArea.width / 2),
				height: Math.floor(workArea.height / 2)
			});
			if (freeSpaceOriginPoints.length > 1) {
				let r = new Meta.Rectangle({
					x: freeSpaceOriginPoints[1].x,
					y: freeSpaceOriginPoints[1].y,
					width: Math.floor(workArea.width / 2),
					height: Math.floor(workArea.height / 2)
				});
				freeScreenRect = freeScreenRect.union(r);
			}

			openWindows.forEach(w => {
				let app = new OpenAppIcon(winTracker.get_window_app(w), w, this.appContainer.appCount++, freeScreenRect, tiledWindow.get_monitor(), {showLabel: SHOW_LABEL});
				this.appContainer.add_child(app);
				app.set_position(pos, 0);
				pos += ICON_SIZE + 16 + ICON_MARGIN + ((SHOW_LABEL) ? 28 : 0); // magicNr are margins/paddings from the icon to the full-sized highlighted button
			});

			// timer needed to correctly calculate the center position because the app.height isnt correct without a timer
			let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
				this.appContainer.get_children().forEach(app => {
					app.set_position(app.get_position()[0], this.bgGrid.height / 2 - app.height / 2);
				});

				GLib.source_remove(sourceID);
			});

			// setup bgGrid
			this.bgGrid.show();
			this.bgGrid.set_width(pos);
			this.bgGrid.set_position(freeScreenRect.x + freeScreenRect.width / 2 - this.bgGrid.width / 2
				, freeScreenRect.y + freeScreenRect.height / 2 - this.bgGrid.height / 2);
			
			// setup appContainer
			this.appContainer.set_position(this.bgGrid.width / 2 - this.appContainer.width / 2, this.appContainer.y);
			this.appContainer.get_child_at_index(0).grab_key_focus();

			// move bgContainer FROM final pos to animate (move) to final pos
			let finalX = this.bgGrid.x;
			let finalY = this.bgGrid.y;
			this.animationDir.x = Math.sign(tiledWindow.get_frame_rect().x - freeScreenRect.x);
			this.animationDir.y = Math.sign(tiledWindow.get_frame_rect().y - freeScreenRect.y);
			this.bgGrid.set_position(finalX + 200 * this.animationDir.x, this.bgGrid.y + 200 * this.animationDir.y);
			this.bgGrid.ease({
				x: finalX,
				y: finalY,
				opacity: 255,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup shadeBG
			let windowActor = lastTiledW.get_compositor_private();
			if (windowActor)
				global.window_group.set_child_below_sibling(this.shadeBG, windowActor);

			this.shadeBG.set_size(entireWorkArea.width, entireWorkArea.height);
			this.shadeBG.show();
			this.shadeBG.ease({
				opacity: 180,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup mouseCatcher
			this.mouseCatcher.show();
			this.mouseCatcher.set_size(entireWorkArea.width, entireWorkArea.height);
		}

		close() {
			this.mouseCatcher.hide();

			let finalX = this.bgGrid.x + 200 * this.animationDir.x;
			let finalY = this.bgGrid.y + 200 * this.animationDir.y;
			this.bgGrid.ease({
				x: finalX,
				y: finalY,
				opacity: 0,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.bgGrid.hide()
			});

			this.shadeBG.ease({
				opacity: 0,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.shadeBG.hide()
			});
		}

		// called with this.appContainer as this
		focusItemAtIndex(index) {
			// wrap around
			index = (index < 0) ? this.appCount - 1 : index;
			index = (index >= this.appCount) ? 0 : index;

			this.get_child_at_index(index).grab_key_focus();
		}
		
		isVisible() {
			return this.bgGrid.visible;
		}
	}
);

// pretty much copied from windowManager.js
// only moved the position in the window group above the dragged window because otherwise quarter-sized previews arent visible
var MyTilePreview = GObject.registerClass(
	class MyTilePreview extends St.Widget {
		_init() {
			super._init();
			global.window_group.add_actor(this);
	
			this._reset();
			this._showing = false;
		}
	
		open(window, tileRect, monitorIndex) {
			let windowActor = window.get_compositor_private();
			if (!windowActor)
				return;
	
			global.window_group.set_child_above_sibling(this, windowActor);
	
			if (this._rect && this._rect.equal(tileRect))
				return;
	
			let changeMonitor = this._monitorIndex == -1 ||
								 this._monitorIndex != monitorIndex;
	
			this._monitorIndex = monitorIndex;
			this._rect = tileRect;
	
			let monitor = main.layoutManager.monitors[monitorIndex];
	
			this._updateStyle(monitor);
	
			if (!this._showing || changeMonitor) {
				let monitorRect = new Meta.Rectangle({ x: monitor.x,
													   y: monitor.y,
													   width: monitor.width,
													   height: monitor.height });
				let [, rect] = window.get_frame_rect().intersect(monitorRect);
				this.set_size(rect.width, rect.height);
				this.set_position(rect.x, rect.y);
				this.opacity = 0;
			}
	
			this._showing = true;
			this.show();
			this.ease({
				x: tileRect.x,
				y: tileRect.y,
				width: tileRect.width,
				height: tileRect.height,
				opacity: 255,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		}
	
		close() {
			if (!this._showing)
				return;
	
			this._showing = false;
			this.ease({
				opacity: 0,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => this._reset(),
			});
		}
	
		_reset() {
			this.hide();
			this._rect = null;
			this._monitorIndex = -1;
		}
	
		_updateStyle(monitor) {
			let styles = ['tile-preview'];
			if (this._monitorIndex == main.layoutManager.primaryIndex)
				styles.push('on-primary');
			if (this._rect.x == monitor.x)
				styles.push('tile-preview-left');
			if (this._rect.x + this._rect.width == monitor.x + monitor.width)
				styles.push('tile-preview-right');
	
			this.style_class = styles.join(' ');
		}
	});

// mostly copied but trimmed from appDisplay.js
var OpenAppIcon = GObject.registerClass( 
	class OpenAppIcon extends St.Button {
		_init(app, win, idx, freeScreenRect, moveToMonitorNr, iconParams = {}) {
			super._init({
				style_class: 'app-well-app',
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
				reactive: true,
				button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
				can_focus: true,
			});

			this.index = idx;
			this.window = win;
			this.freeScreenRect = freeScreenRect;
			this.moveToMonitorNr = moveToMonitorNr;
	
			this.iconContainer = new St.Widget({ layout_manager: new Clutter.BinLayout(),
												  x_expand: true, y_expand: true });
	
			this.set_child(this.iconContainer);
	
			iconParams['createIcon'] = this._createIcon.bind(this, app, ICON_SIZE);
			iconParams['setSizeManually'] = true;
			this.icon = new iconGrid.BaseIcon(app.get_name(), iconParams);
			this.iconContainer.add_child(this.icon);
		}

		vfunc_key_press_event(keyEvent) {
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
					this.get_parent().focusItemAtIndex(this.index + 1);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					this.get_parent().focusItemAtIndex(this.index - 1);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					this.activate();
					return Clutter.EVENT_STOP;
				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case 65513: // LAlt
				case 65027: // RAlt
					return Clutter.EVENT_STOP;
			}
			
			// close the Dash on all other key inputs
			if (openWindowsDash.isVisible())
				openWindowsDash.close();

			return Clutter.EVENT_PROPAGATE;
		}

		_createIcon(app, iconSize) {
			return app.create_icon_texture(iconSize);
		}

		vfunc_clicked(button) {
			this.activate(button);
		}

		activate(button) {
			if (openWindowsDash.isVisible()) {
				openWindowsDash.close();
				
				this.icon.animateZoomOut();

				this.window.move_to_monitor(this.moveToMonitorNr);
				this.window.activate(global.get_current_time());

				let event = Clutter.get_current_event();
				let modifiers = event ? event.get_state() : 0;
				let isAltPressed = (modifiers & Clutter.ModifierType.MOD1_MASK) != 0;
				let isShiftPressed = (modifiers & Clutter.ModifierType.SHIFT_MASK) != 0;
				let workArea = this.window.get_work_area_current_monitor();

				if (isAltPressed) {
					// tile to right if free screen = 2 horizontal quadrants
					if (equalApprox(this.freeScreenRect.width, workArea.width, 2)) {
						this.freeScreenRect.width = workArea.width / 2;
						this.freeScreenRect.x = workArea.x + workArea.width / 2;
					// tile to bottom if free screen = 2 vertical quadrants
					} else if (equalApprox(this.freeScreenRect.height, workArea.height, 2)) {
						this.freeScreenRect.height = workArea.height / 2;
						this.freeScreenRect.y = workArea.y + workArea.height / 2;
					}

				} else if (isShiftPressed) {
					// tile to left if free screen = 2 horizontal quadrants
					if (equalApprox(this.freeScreenRect.width, workArea.width, 2)) {
						this.freeScreenRect.width = workArea.width / 2;
						this.freeScreenRect.x = workArea.x;
					// tile to top if free screen = 2 vertical quadrants
					} else if (equalApprox(this.freeScreenRect.height, workArea.height, 2)) {
						this.freeScreenRect.height = workArea.height / 2;
						this.freeScreenRect.y = workArea.y;
					}
				}

				tileWindow(this.window, this.freeScreenRect);
			}
		}
	}
);
