const Lang = imports.lang;
const {main, iconGrid} = imports.ui;
const {GObject, GLib, St, Shell, Clutter, Meta, Graphene} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

let openWindowsDash = null;
let tilePreview = null;
let tiledWindows = {}; // {window : oldFrameRect}
let windowGrabSignals = {}; // {windowID : [signalIDs]}

let settings = null;

function init() {
};

function enable() {
	settings = ExtensionUtils.getSettings("org.gnome.shell.extensions.tiling-assistant");

	// signal connections
	this.windowGrabBegin = global.display.connect('grab-op-begin', onGrabBegin.bind(this) );
	this.windowGrabEnd = global.display.connect("grab-op-end", onGrabEnd.bind(this));
	this.shortcutPressed = global.window_manager.connect( "filter-keybinding", onShortcutPressed.bind(this));
	this.maximizedStateChanged = global.window_manager.connect("size-change", onMaxStateChanged.bind(this));
	this.overviewShown = main.overview.connect("showing", () => {if (openWindowsDash.isVisible()) openWindowsDash.close();});

	openWindowsDash = new OpenWindowsDash();
	tilePreview = new MyTilePreview();

	// disable native tiling
	// taken from ShellTile@emasab.it - https://extensions.gnome.org/extension/657/shelltile/
	// dont know why gnome_shell_settings tiling is disabled...
	this.gnome_mutter_settings = ExtensionUtils.getSettings("org.gnome.mutter");
	this.gnome_mutter_settings.set_boolean("edge-tiling", false);
	this.gnome_shell_settings = ExtensionUtils.getSettings("org.gnome.shell.overrides");
	this.gnome_shell_settings.set_boolean("edge-tiling", false);

	// tiling keybindings
	this.keyBindings = ["tile-top-half", "tile-bottom-half", "tile-topleft-quarter", "tile-topright-quarter", "tile-bottomleft-quarter", "tile-bottomright-quarter"];
	this.keyBindings.forEach(key => {
		main.wm.addKeybinding(
			key,
			settings,
			Meta.KeyBindingFlags.NONE,
			Shell.ActionMode.NORMAL,
			onCustomShortcutPressed.bind(this, key)
		);
	});
};

function disable() {
	// disconnect signals
	global.display.disconnect(this.windowGrabBegin);
	global.display.disconnect(this.windowGrabEnd);
	global.window_manager.disconnect(this.shortcutPressed);
	global.window_manager.disconnect(this.maximizedStateChanged);
	main.overview.disconnect(this.overviewShown);

	tilePreview.destroy();
	openWindowsDash._destroy();

	// re-enable native tiling
	this.gnome_mutter_settings.reset("edge-tiling");
	this.gnome_shell_settings.reset("edge-tiling");

	// remove keybindings
	this.keyBindings.forEach(key => {
		main.wm.removeKeybinding(key);
	});

	settings = null;
};

function tileWindow(window, rect) {
	if (!window)
		return;

	if (window.get_maximized())
		window.unmaximize(window.get_maximized());

	if (!window.allows_resize() || !window.allows_move())
		return;

	if ( !(window in tiledWindows) )
		tiledWindows[window] = window.get_frame_rect();
	else
		tiledWindows[window] = new Meta.Rectangle({
			x: rect.x,
			y: rect.y,
			width: tiledWindows[window].width,
			height: tiledWindows[window].height,
		});

	let wActor = window.get_compositor_private();
	wActor.connect("destroy", ((w) => {
		if (tiledWindows[w])
			delete tiledWindows[w];
	}).bind(this, window));

	// make the use of GNOME's animations optional
	// there are error messages in journalctl and animation issues with other extensions who rely on the size-change signal
	// e.g. hiding the titlebar on maximization
	if (settings.get_boolean("use-anim"))
		main.wm._prepareAnimationInfo(global.window_manager, wActor, tiledWindows[window], 0);

	window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
	window.focus(global.get_current_time());

	let workArea = window.get_work_area_current_monitor();
	let sourceID = 0;
	let sID = 0;

	sID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
		openDash(window);
		GLib.source_remove(sID);
	}); // timer needed to correctly shade the bg / focusing

	if (settings.get_boolean("use-anim")) {
		sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => { // wait for GNOME's sizing anim to be done
			GLib.source_remove(sourceID);

			if (rect.height == workArea.height && rect.width == workArea.width)
				window.maximize(Meta.MaximizeFlags.BOTH);

			else if (rect.height >= workArea.height - 2)
				window.maximize(Meta.MaximizeFlags.VERTICAL);

			else if (rect.width >= workArea.width - 2)
				window.maximize(Meta.MaximizeFlags.HORIZONTAL);
		});

	} else {
		if (rect.height == workArea.height && rect.width == workArea.width)
			window.maximize(Meta.MaximizeFlags.BOTH);

		else if (rect.height >= workArea.height - 2)
			window.maximize(Meta.MaximizeFlags.VERTICAL);

		else if (rect.width >= workArea.width - 2)
			window.maximize(Meta.MaximizeFlags.HORIZONTAL);
	}
};

function onCustomShortcutPressed(shortcutName) {
	let window = global.display.focus_window;
	if (!window)
		return;

	let rect;
	let workArea = window.get_work_area_current_monitor();
	switch (shortcutName) {
		case "tile-top-half":
			rect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width,
				height: Math.floor(workArea.height / 2)
			});

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-bottom-half":
			rect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + Math.floor(workArea.height / 2),
				width: workArea.width,
				height: Math.floor(workArea.height / 2)
			});

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-topleft-quarter":
			rect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: Math.floor(workArea.width / 2),
				height: Math.floor(workArea.height / 2)
			});

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-topright-quarter":
			rect = new Meta.Rectangle({
				x: workArea.x + Math.floor(workArea.width / 2),
				y: workArea.y,
				width: Math.floor(workArea.width / 2),
				height: Math.floor(workArea.height / 2)
			});

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-bottomleft-quarter":
			rect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + Math.floor(workArea.height / 2),
				width: Math.floor(workArea.width / 2),
				height: Math.floor(workArea.height / 2)
			});

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-bottomright-quarter":
			rect = new Meta.Rectangle({
				x: workArea.x + Math.floor(workArea.width / 2),
				y: workArea.y + Math.floor(workArea.height / 2),
				width: Math.floor(workArea.width / 2),
				height: Math.floor(workArea.height / 2)
			});

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);
	}
};

// called whenever the maximize state of a window is changed (...and maybe at other times as well; I dont know?)
function onMaxStateChanged(shellwm, actor, whichChange, oldFrameRect, _oldBufferRect) {
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
// decides wether the Dash should be opened. If yes, the dash will be opened.
function openDash(tiledWindow) {
	if (openWindowsDash.isVisible())
		return;

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
			if (!(windowRect.height == workArea.height && windowRect.width == workArea.width)) { // isnt maximized
				if (windowRect.height == workArea.height) { // is vertically maximized
					maximizedIdx = remainingPoints.indexOf(bottomLeftPoint);
					if (maximizedIdx == -1)
						return false;

					remainingPoints.splice(maximizedIdx, 1);

				} else if (windowRect.width == workArea.width) { // is horizontally maximized
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
			if (windowRect.height == workArea.height && windowRect.width != workArea.width) { // is vertically maximized
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
			if (windowRect.width == workArea.width && windowRect.height != workArea.height) { // is horizontally maximized
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
function onGrabBegin(_metaDisplay, metaDisplay, grabbedWindow, grabOp) {
	if (!grabbedWindow)
		return;

	if (!windowGrabSignals[grabbedWindow.get_id()])
		windowGrabSignals[grabbedWindow.get_id()] = [];

	// for resizing op
	let sameSideWindow = null;
	let opposingWindows = [];
	let grabbedRect = grabbedWindow.get_frame_rect();

	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();
	openWindows.splice(openWindows.indexOf(grabbedWindow), 1);

	switch (grabOp) {
		case Meta.GrabOp.MOVING:
			restoreWindowSize(grabbedWindow);
			windowGrabSignals[grabbedWindow.get_id()].push( grabbedWindow.connect("position-changed", onWindowMoving.bind(this, grabbedWindow)) );
			break;

		case Meta.GrabOp.RESIZING_N:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i] in tiledWindows))
					break;

				let otherRect = openWindows[i].get_frame_rect();
				if (otherRect.y == grabbedRect.y)
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.y + otherRect.height, grabbedRect.y, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push( grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)) );
			break;

		case Meta.GrabOp.RESIZING_S:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i] in tiledWindows))
					break;

				let otherRect = openWindows[i].get_frame_rect();
				if (otherRect.y == grabbedRect.y)
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.y, grabbedRect.y + grabbedRect.height, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push( grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)) );
			break;

		case Meta.GrabOp.RESIZING_E:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i] in tiledWindows))
					break;

				let otherRect = openWindows[i].get_frame_rect();
				if (otherRect.x == grabbedRect.x)
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.x, grabbedRect.x + grabbedRect.width, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push( grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)) );
			break;

		case Meta.GrabOp.RESIZING_W:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i] in tiledWindows))
					break;

				let otherRect = openWindows[i].get_frame_rect();
				if (otherRect.x == grabbedRect.x)
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.x + otherRect.width, grabbedRect.x, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push( grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)) );
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

function restoreWindowSize(window, restoreFullPos = false) {
	if (!(window in tiledWindows))
		return;

	let windowIsQuartered = !window.get_maximized();
	if (window.get_maximized())
		window.unmaximize(window.get_maximized());

	if (window.allows_resize() && window.allows_move()) {
		if (windowIsQuartered) { // custom restore anim since GNOME doesnt have one for this case
			let oldFrameRect = window.get_frame_rect();
			let actorContent = Shell.util_get_content_for_window_actor(window.get_compositor_private(), oldFrameRect);
			let actorClone = new St.Widget({
				content: actorContent,
				x: oldFrameRect.x,
				y: oldFrameRect.y,
				width: oldFrameRect.width,
				height: oldFrameRect.height,
			});
			main.uiGroup.add_child(actorClone);

			actorClone.ease({
				opacity: 0,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => actorClone.destroy()
			});
		}

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

function onWindowMoving(window) {
	let [mouseX, mouseY] = global.get_pointer();
	let workArea = window.get_work_area_current_monitor();

	let onTop = mouseY <= 25;
	let onBottom = mouseY >= workArea.y + workArea.height - 25;
	let onLeft = mouseX <= workArea.x + 25;
	let onRight = mouseX >= workArea.x + workArea.width - 25;

	let tileTopLeftQuarter = onTop && onLeft;
	let tileTopRightQuarter = onTop && onRight;
	let tileBottomLeftQuarter = onLeft && onBottom;
	let tileBottomRightQuarter = onRight && onBottom;

	// tile to top half on the most left and on the most right side of the topbar
	let tileTopHalf = onTop && ( (mouseX > 25 && mouseX < workArea.width / 4) || (mouseX < workArea.y + workArea.width - 25 && mouseX > workArea.y + workArea.width - workArea.width / 4) );
	let tileRightHalf = onRight
	let tileLeftHalf = onLeft;
	let tileMaximized = onTop;
	let tileBottomHalf = onBottom;

	// prioritize quarter over other tiling
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

// sameSideWindow is the window which is on the same side as the resizedRect based on the drag direction
// opposingWindows is the opposite
function resizeComplementingWindows(resizedWindow, sameSideWindow, opposingWindows, grabOp) {
	if (!(resizedWindow in tiledWindows))
		return;

	let resizedRect = resizedWindow.get_frame_rect();
	let workArea = resizedWindow.get_work_area_current_monitor();

	switch (grabOp) {
		case Meta.GrabOp.RESIZING_N:
			if (sameSideWindow) {
				let sameSideRect = sameSideWindow.get_frame_rect();
				sameSideWindow.move_resize_frame(true, sameSideRect.x, resizedRect.y, sameSideRect.width, resizedRect.height);
			}

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(true, wRect.x, wRect.y, wRect.width, workArea.height - resizedRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_S:
			if (sameSideWindow) {
				let sameSideRect = sameSideWindow.get_frame_rect();
				sameSideWindow.move_resize_frame(true, sameSideRect.x, sameSideRect.y, sameSideRect.width, resizedRect.height);
			}

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(true, wRect.x, resizedRect.y + resizedRect.height, wRect.width, workArea.height - resizedRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_E:
			if (sameSideWindow) {
				let sameSideRect = sameSideWindow.get_frame_rect();
				sameSideWindow.move_resize_frame(true, sameSideRect.x, sameSideRect.y, resizedRect.width, sameSideRect.height);
			}

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(true, resizedRect.x + resizedRect.width, wRect.y, workArea.width - resizedRect.width, wRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_W:
			if (sameSideWindow) {
				let sameSideRect = sameSideWindow.get_frame_rect();
				sameSideWindow.move_resize_frame(true, resizedRect.x, sameSideRect.y, resizedRect.width, sameSideRect.height);
			}

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(true, wRect.x, wRect.y, workArea.width - resizedRect.width, wRect.height);
			});
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

			this._shown = false;
			this.maxColumnCount = 0;

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
			this._shown = true;
			this.appContainer.destroy_all_children();

			let workArea = tiledWindow.get_work_area_current_monitor();
			let entireWorkArea = tiledWindow.get_work_area_all_monitors();

			// fill appContainer
			let winTracker = Shell.WindowTracker.get_default();
			this.appContainer.appCount = 0;
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

			let buttonSize = settings.get_int("icon-size") + 16 + settings.get_int("icon-margin") + ((settings.get_boolean("show-label")) ? 28 : 0); // magicNr are margins/paddings from the icon to the full-sized highlighted button
			this.maxColumnCount = Math.floor((freeScreenRect.width * 0.7) / buttonSize);

			// dont allow "too empty" rows
			if (openWindows.length % this.maxColumnCount <= this.maxColumnCount / 2)
				for (let i = this.maxColumnCount; i >= 1; i--) {
					if (openWindows.length % i + i / 2 - 1 >= i) {
						this.maxColumnCount = i;
						break;
					}
				}

			let dashHeight = Math.ceil(openWindows.length / this.maxColumnCount) * buttonSize;
			let dashWidth = Math.min(this.maxColumnCount, openWindows.length) * buttonSize;

			this.bgGrid.set_size(dashWidth, dashHeight);
			this.appContainer.set_size(dashWidth, dashHeight);

			let posX = 0;
			let posY = 0;
			openWindows.forEach(w => {
				let app = new OpenAppIcon(winTracker.get_window_app(w), w, this.appContainer.appCount++, freeScreenRect, tiledWindow.get_monitor(), {showLabel: settings.get_boolean("show-label")});
				this.appContainer.add_child(app);
				app.set_position(posX, posY);
				posX += buttonSize;

				if (posX >= dashWidth) {
					posX = 0;
					posY += buttonSize;
				}
			});

			// setup bgGrid
			this.bgGrid.show();
			this.bgGrid.set_position(freeScreenRect.x + freeScreenRect.width / 2 - this.bgGrid.width / 2
				, freeScreenRect.y + freeScreenRect.height / 2 - this.bgGrid.height / 2);

			// setup appContainer
			this.appContainer.set_position(settings.get_int("icon-margin") / 2, settings.get_int("icon-margin") / 2);
			this.appContainer.get_child_at_index(0).grab_key_focus();

			// move bgContainer FROM final posX to animate (move) to final posX
			let finalX = this.bgGrid.x;
			let finalY = this.bgGrid.y;
			this.animationDir.x = Math.sign(tiledWindow.get_frame_rect().x - freeScreenRect.x);
			this.animationDir.y = Math.sign(tiledWindow.get_frame_rect().y - freeScreenRect.y);
			this.bgGrid.set_position(finalX + 200 * this.animationDir.x, this.bgGrid.y + 200 * this.animationDir.y);
			this.bgGrid.ease({
				x: finalX,
				y: finalY,
				opacity: 255,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup shadeBG
			let windowActor = lastTiledW.get_compositor_private();
			if (windowActor)
				global.window_group.set_child_below_sibling(this.shadeBG, windowActor);

			//this.shadeBG.set_position(entireWorkArea.x, entireWorkArea.y);
			this.shadeBG.set_size(entireWorkArea.width, entireWorkArea.height + main.panel.height);
			this.shadeBG.show();
			this.shadeBG.ease({
				opacity: 180,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup mouseCatcher
			this.mouseCatcher.show();
			this.mouseCatcher.set_size(entireWorkArea.width, entireWorkArea.height + main.panel.height);
		}

		close() {
			this._shown = false;
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
			index = (index < 0 ) ? openWindowsDash.getAppCount() - 1 : index;
			index = (index >= openWindowsDash.getAppCount()) ? 0 : index;
			this.get_child_at_index(index).grab_key_focus();
		}

		isVisible() {
			return this._shown;
		}

		getAppCount() {
			return this.appContainer.appCount;
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
				let monitorRect = new Meta.Rectangle({	x: monitor.x,
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
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		}

		close() {
			if (!this._showing)
				return;

			this._showing = false;
			this.ease({
				opacity: 0,
				duration: 200,
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

			iconParams['createIcon'] = this._createIcon.bind(this, app, settings.get_int("icon-size"));
			iconParams['setSizeManually'] = true;
			this.icon = new iconGrid.BaseIcon(app.get_name(), iconParams);
			this.iconContainer.add_child(this.icon);
		}

		vfunc_key_press_event(keyEvent) {
			let index = 0;
			let getLastRowFirstItem = function() {
				let rowCountBeforeLast = Math.floor(openWindowsDash.getAppCount() / openWindowsDash.maxColumnCount);
				if (openWindowsDash.getAppCount() % openWindowsDash.maxColumnCount == 0)
					rowCountBeforeLast--;
	
				let firstItem = rowCountBeforeLast * openWindowsDash.maxColumnCount;
				return firstItem;
			};
			
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
					this.get_parent().focusItemAtIndex(this.index + 1);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					this.get_parent().focusItemAtIndex(this.index - 1);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Up:
					index = this.index - openWindowsDash.maxColumnCount;
					index = (index < 0) ? getLastRowFirstItem() + this.index : index;
					this.get_parent().focusItemAtIndex(index);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Down:
					index = this.index + openWindowsDash.maxColumnCount;
					index = (index >= openWindowsDash.getAppCount()) ? this.index - getLastRowFirstItem() : index;
					this.get_parent().focusItemAtIndex(index);
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
				let isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
				let isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;
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
