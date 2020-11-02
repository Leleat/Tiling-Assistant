const Lang = imports.lang;
const {main, iconGrid, appDisplay, panel} = imports.ui;
const {GObject, GLib, St, Shell, Clutter, Meta, Graphene} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

let openWindowsDash = null;
let tilePreview = null;
let tiledWindows = {}; // {window : oldFrameRect}
let windowGrabSignals = {}; // {windowID : [signalIDs]}
let newWindowsToTile = [[], []]; // to open apps directly in tiled state -> [[apps, to, tile, ...], [side, to, tile, to, ...]]

let settings = null;

// TODO newsflash focus issue with tiling start

function init() {
};

function enable() {
	settings = ExtensionUtils.getSettings("org.gnome.shell.extensions.tiling-assistant");

	// signal connections
	this.windowGrabBegin = global.display.connect('grab-op-begin', onGrabBegin.bind(this) );
	this.windowGrabEnd = global.display.connect("grab-op-end", onGrabEnd.bind(this));
	this.maximizedStateChanged = global.window_manager.connect("size-change", onMaxStateChanged.bind(this));
	this.overviewShown = main.overview.connect("showing", () => {if (openWindowsDash.isVisible()) openWindowsDash.close();});
	this.windowCreated = global.display.connect("window-created", onWindowCreated.bind(this));

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
	this.keyBindings = ["tile-top-half", "tile-right-half", "tile-left-half", "tile-bottom-half", "tile-topleft-quarter", "tile-topright-quarter", "tile-bottomleft-quarter", "tile-bottomright-quarter"];
	this.keyBindings.forEach(key => {
		main.wm.addKeybinding(
			key,
			settings,
			Meta.KeyBindingFlags.NONE,
			Shell.ActionMode.NORMAL,
			onCustomShortcutPressed.bind(this, key)
		);
	});

	// change appDisplay.AppIcon.activate function
	this.oldAppActivateFunc = appDisplay.AppIcon.prototype.activate;
	appDisplay.AppIcon.prototype.activate = newAppActivate;
	};

function disable() {
	// disconnect signals
	global.display.disconnect(this.windowGrabBegin);
	global.display.disconnect(this.windowGrabEnd);
	global.window_manager.disconnect(this.maximizedStateChanged);
	main.overview.disconnect(this.overviewShown);
	global.display.disconnect(this.windowCreated);

	tilePreview.destroy();
	openWindowsDash._destroy();

	// re-enable native tiling
	this.gnome_mutter_settings.reset("edge-tiling");
	this.gnome_shell_settings.reset("edge-tiling");

	// remove keybindings
	this.keyBindings.forEach(key => {
		main.wm.removeKeybinding(key);
	});

	// restore old function
	appDisplay.AppIcon.prototype.activate = this.oldAppActivateFunc;

	settings = null;
};

// allow to directly open an app in a tiled state
// via holding Alt or Shift when activating the icon
function newAppActivate(button) {
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

	} else if (isShiftPressed && this.app.can_open_new_window()) {
		newWindowsToTile[0].push(this.app.get_name());
		newWindowsToTile[1].push(Meta.Side.LEFT);

		this.app.open_new_window(-1);

	} else if (isAltPressed && this.app.can_open_new_window()) {
		newWindowsToTile[0].push(this.app.get_name());
		newWindowsToTile[1].push(Meta.Side.RIGHT);

		this.app.open_new_window(-1);

	} else {
		this.app.activate();
	}

	main.overview.hide();
};

// to tile a window after it has been created via holding alt/shift on an icon
function onWindowCreated (src, w) {
	let app = Shell.WindowTracker.get_default().get_window_app(w);
	if (app) {
		let idx = newWindowsToTile[0].indexOf(app.get_name());
		if (idx != -1 && w.get_window_type() != Meta.WindowType.SPLASHSCREEN && w.allows_move() && w.allows_resize()) {
			let sourceID = GLib.timeout_add( GLib.PRIORITY_DEFAULT, 50, () => { // timer needed because window won't be sized correctly on the window-created signal yet; so tiling wont work properly yet
				GLib.source_remove(sourceID);

				let rect = getTileRectFor(newWindowsToTile[1][idx], w.get_work_area_current_monitor());
				tileWindow(w, rect);

				newWindowsToTile[0].splice(idx, 1);
				newWindowsToTile[1].splice(idx, 1);
			} );
		}
	}
};

function tileWindow(window, newRect) {
	if (!window)
		return;

	let wasMaximized = window.get_maximized();
	if (wasMaximized)
		window.unmaximize(window.get_maximized());

	if (!window.allows_resize() || !window.allows_move())
		return;

	let oldRect = window.get_frame_rect();
	let workArea = window.get_work_area_current_monitor();
	
	if (!(window in tiledWindows))
		tiledWindows[window] = window.get_frame_rect();

	let wActor = window.get_compositor_private();
	wActor.connect("destroy", () => {
		if (tiledWindows[window])
			delete tiledWindows[window];
	});

	let onlyMove = oldRect.width == newRect.width && oldRect.height == newRect.height;
	if (settings.get_boolean("use-anim")) {
		if (onlyMove || wasMaximized) // custom anim because otherwise it is pretty bad (even worse than this custom one)
			animate(window, newRect, onlyMove);
		else
			main.wm._prepareAnimationInfo(global.window_manager, wActor, window.get_frame_rect(), 0);
	}

	window.move_resize_frame(true, newRect.x, newRect.y, newRect.width, newRect.height);
	window.focus(global.get_current_time());

	let sourceID = 0;
	let sID = 0;

	sID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
		openDash(window);
		GLib.source_remove(sID);
	}); // timer needed to correctly shade the bg / focusing

	if (settings.get_boolean("use-anim")) {
		sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => { // wait for anim to be done
			GLib.source_remove(sourceID);

			if (newRect.height == workArea.height && newRect.width == workArea.width)
				window.maximize(Meta.MaximizeFlags.BOTH);

			else if (newRect.height >= workArea.height - 2)
				window.maximize(Meta.MaximizeFlags.VERTICAL);

			else if (newRect.width >= workArea.width - 2)
				window.maximize(Meta.MaximizeFlags.HORIZONTAL);
		});

	} else {
		if (newRect.height == workArea.height && newRect.width == workArea.width)
			window.maximize(Meta.MaximizeFlags.BOTH);

		else if (newRect.height >= workArea.height - 2)
			window.maximize(Meta.MaximizeFlags.VERTICAL);

		else if (newRect.width >= workArea.width - 2)
			window.maximize(Meta.MaximizeFlags.HORIZONTAL);
	}
};

// TODO could definitly use some improvements for resizing animation
function animate(window, newRect, onlyMove = true) {
	let oldRect = window.get_frame_rect();
	let wActor = window.get_compositor_private();
	let actorContent = Shell.util_get_content_for_window_actor(wActor, oldRect);
	let clone = new St.Widget({
		content: actorContent,
		x: oldRect.x,
		y: oldRect.y,
		width: oldRect.width,
		height: oldRect.height,
	});
	main.uiGroup.add_child(clone);
	wActor.hide();

	clone.ease({
		x: newRect.x,
		y: newRect.y,
		width: newRect.width,
		height: newRect.height,
		duration: 200,
		mode: Clutter.AnimationMode.EASE_OUT_QUAD,
		onComplete: () => {
			wActor.show();
			clone.destroy();

			if (!onlyMove) {
				let fadeOutClone = new St.Widget({
					content: actorContent,
					x: newRect.x,
					y: newRect.y,
					width: newRect.width,
					height: newRect.height,
				});
				main.uiGroup.add_child(fadeOutClone);
				fadeOutClone.set_pivot_point(.5, .5);
		
				fadeOutClone.ease({
					scale_x: 0.9,
					scale_y: 0.9,
					opacity: 0,
					duration: 100,
					mode: Clutter.AnimationMode.EASE_OUT_QUAD,
					onComplete: () => {
						fadeOutClone.destroy();
					}
				});
			}
		}
	});
};

function onCustomShortcutPressed(shortcutName) {
	let window = global.display.focus_window;
	if (!window)
		return;

	let rect;
	let workArea = window.get_work_area_current_monitor();
	switch (shortcutName) {
		case "tile-top-half":
			rect = getTileRectFor(Meta.Side.TOP, workArea)

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-left-half":
			rect = getTileRectFor(Meta.Side.LEFT, workArea)

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;
		
		case "tile-right-half":
			rect = getTileRectFor(Meta.Side.RIGHT, workArea)

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-bottom-half":
			rect = getTileRectFor(Meta.Side.BOTTOM, workArea)

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-topleft-quarter":
			rect = getTileRectFor(Meta.Side.TOP + Meta.Side.LEFT, workArea)

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-topright-quarter":
			rect = getTileRectFor(Meta.Side.TOP + Meta.Side.RIGHT, workArea)

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-bottomleft-quarter":
			rect = getTileRectFor(Meta.Side.BOTTOM + Meta.Side.LEFT, workArea)

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);

			break;

		case "tile-bottomright-quarter":
			rect = getTileRectFor(Meta.Side.BOTTOM + Meta.Side.RIGHT, workArea)

			if (rect.equal(window.get_frame_rect()))
				restoreWindowSize(window, true);
			else
				tileWindow(window, rect);
	}
};

// called whenever the maximize state of a window is changed (...and maybe at other times as well; I dont know?)
function onMaxStateChanged(shellwm, actor, whichChange, oldFrameRect, _oldBufferRect) {
	// timer to get the correct new window pos and size
	let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
		GLib.source_remove(sourceID);

		let tiledWindow = actor.get_meta_window();
		if (!tiledWindow.get_maximized() || tiledWindow.get_maximized() == Meta.MaximizeFlags.BOTH)
			return;

		openDash(tiledWindow);
	});
};

// get the top most tiled windows which are in a group (by stack order)
// and the last tiled window -> to shade the bg correctly for the dash
// optionally ignore the focused window (needed for tile preview via DND)
function getTileGroup(openWindows, lastInTileGroup = null, ignoreFocusedWindow = false) {
	// first start with an empty tile group
	// if a quad is null, that means that that space is free screen space
	let currTileGroup = {
		TOP_LEFT: null,
		TOP_RIGHT: null,
		BOTTOM_LEFT: null,
		BOTTOM_RIGHT: null
	};

	// this functions removes at least one empty quad from currTileGroup, if "window" is tiled
	// it also returns wether "window" is part of the currTileGroup
	// "window" isnt part of the currTileGroup, if a window in a higher stack order already occupied that quad,
	// if "window" isnt tiled or if "window" is maximized
	let removeFreeQuad = function(currTileGroup, window) {
		if (!(window in tiledWindows) || window.get_maximized() == Meta.MaximizeFlags.BOTH)
			return false;
		
		let wRect = window.get_frame_rect();
		let workArea = window.get_work_area_current_monitor();
	
		// maximization state is checked via their size rather than via get_maximized()
		// because tileWindow() will delay the maximize(), if animations are enabled
	
		// top left window
		if (wRect.x == workArea.x && wRect.y == workArea.y) {
			if (currTileGroup.TOP_LEFT)
				return false;
				 
			if (wRect.height == workArea.height) {
				if (currTileGroup.BOTTOM_LEFT)
					return false;
	
				currTileGroup.BOTTOM_LEFT = window;
	
			} else if (wRect.width == workArea.width) {
				if (currTileGroup.TOP_RIGHT)
					return false;
	
				currTileGroup.TOP_RIGHT = window;
			}
	
			currTileGroup.TOP_LEFT = window;
			return true;
		
		// top right window
		} else if (wRect.x != workArea.x && wRect.y == workArea.y) {
			if (currTileGroup.TOP_RIGHT)
				return false;
	
			if (wRect.height == workArea.height) {
				if (currTileGroup.BOTTOM_RIGHT)
					return false;
	
				currTileGroup.BOTTOM_RIGHT = window;
			}
	
			currTileGroup.TOP_RIGHT = window;
			return true;
	
		// bottom left window
		} else if (wRect.x == workArea.x && wRect.y != workArea.y) {
			if (currTileGroup.BOTTOM_LEFT)
				return false;
	
			if (wRect.width == workArea.width) {
				if (currTileGroup.BOTTOM_RIGHT)
					return false;
	
				currTileGroup.BOTTOM_RIGHT = window;
			}
	
			currTileGroup.BOTTOM_LEFT = window;
			return true;
	
		// bottom right window
		} else if (wRect.x != workArea.x && wRect.y != workArea.y) {
			if (currTileGroup.BOTTOM_RIGHT)
				return false;
	
			currTileGroup.BOTTOM_RIGHT = window;
			return true;
		}
	
		return false;
	};

	for (let i = ((ignoreFocusedWindow) ? 1 : 0); i < openWindows.length; i++) {
		let windowIsInTileGroup = removeFreeQuad(currTileGroup, openWindows[i]);
		if (!windowIsInTileGroup)
			break;

		lastInTileGroup = openWindows[i];
	}

	return [currTileGroup, lastInTileGroup];
};

// called when a window is tiled
// decides wether the Dash should be opened. If yes, the dash will be opened.
function openDash(tiledWindow) {
	if (openWindowsDash.isVisible())
		return;

	let workArea = tiledWindow.get_work_area_current_monitor();

	// window was maximized - dont check via get_maximized()
	if (tiledWindow.get_frame_rect().width == workArea.width && tiledWindow.get_frame_rect().height == workArea.height)
		return;

	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();

	let [currTileGroup, lastInTileGroup] = getTileGroup(openWindows, tiledWindow);
	
	// assume all 4 quads are free
	// remove a quad for each window in currTileGroup
	// and remove the tiled windows from openWindows for the Dash
	let freeQuadCount = 4;
	for (let pos in currTileGroup) {
		if (currTileGroup[pos] != null) {
			// focus tiled windows in a group
			let w = currTileGroup[pos];
			let wActor = w.get_compositor_private();
			w.tileGroup = currTileGroup;
			w.connect("focus", () => {
				for (let pos in w.tileGroup) {
					let window = w.tileGroup[pos];
					if (window in tiledWindows)
						window.raise();
				}

				w.raise();
			});
			wActor.connect("destroy", () => w.tileGroup[pos] = null);

			let idx = openWindows.indexOf(currTileGroup[pos]);
			if (idx != -1)
				openWindows.splice(idx, 1);

			freeQuadCount--;
		}
	}

	if (openWindows.length == 0)
		return;

	let freeScreenRect = null;
	// if a window is maximized, 2 rects can be the same rect
	// e.g. a window vertically maxmized on the left will set topLeftRect and bottomLeftRect to its rect
	let topLeftRect = (currTileGroup.TOP_LEFT) ? currTileGroup.TOP_LEFT.get_frame_rect() : null;
	let topRightRect = (currTileGroup.TOP_RIGHT) ? currTileGroup.TOP_RIGHT.get_frame_rect() : null;
	let bottomLeftRect = (currTileGroup.BOTTOM_LEFT) ? currTileGroup.BOTTOM_LEFT.get_frame_rect() : null;
	let bottomRightRect = (currTileGroup.BOTTOM_RIGHT) ? currTileGroup.BOTTOM_RIGHT.get_frame_rect() : null;

	// the dimensions of the free screen rect
	let _height = 0;
	let _width = 0;
	// "limit"-dimension are the dimensions of the opposing windows
	// e.g. if the user wants to tile a window to the right (vertically maximized), 
	// the width will be limited by the windows in the top left and bottom left quad
	let limitWidth = 0;
	let limitHeight = 0;

	// only 1 quad is free
	if (freeQuadCount == 1) {
		if (currTileGroup.TOP_LEFT == null) {
			[_width, _height] = getRectDimensions(workArea, bottomRightRect, topRightRect, bottomLeftRect);
			freeScreenRect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: _width,
				height: _height,
			});

		} else if (currTileGroup.TOP_RIGHT == null) {
			[_width, _height] = getRectDimensions(workArea, bottomLeftRect, topLeftRect, bottomRightRect);
			freeScreenRect = new Meta.Rectangle({
				x: workArea.x + workArea.width - _width,
				y: workArea.y,
				width: _width,
				height: _height,
			});

		} else if (currTileGroup.BOTTOM_LEFT == null) {
			[_width, _height] = getRectDimensions(workArea, topRightRect, bottomRightRect, topLeftRect);
			freeScreenRect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height - _height,
				width: _width,
				height: _height,
			});

		} else if (currTileGroup.BOTTOM_RIGHT == null) {
			[_width, _height] = getRectDimensions(workArea, topLeftRect, bottomLeftRect, topRightRect);
			freeScreenRect = new Meta.Rectangle({
				x: workArea.x + workArea.width - _width,
				y: workArea.y + workArea.height - _height,
				width: _width,
				height: _height,
			});
		}

		openWindowsDash.open(openWindows, tiledWindow, freeScreenRect, lastInTileGroup);

	// free screen space consists of 2 quads
	} else if (freeQuadCount == 2) {
		// dont open the dash if the free space consists of diagonal quads
		if ( (currTileGroup.TOP_LEFT == null && currTileGroup.BOTTOM_RIGHT == null)
				|| (currTileGroup.TOP_RIGHT == null && currTileGroup.BOTTOM_LEFT == null) )
			return;

		if (currTileGroup.TOP_LEFT == null && currTileGroup.TOP_RIGHT == null) {
			limitHeight = getMaxHeight(bottomLeftRect, bottomRightRect, workArea);

			freeScreenRect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width,
				height: (limitHeight) ? workArea.height - limitHeight : workArea.height / 2,
			});

		} else if (currTileGroup.TOP_RIGHT == null && currTileGroup.BOTTOM_RIGHT == null) {
			limitWidth = getMaxWidth(topLeftRect, bottomLeftRect, workArea);

			freeScreenRect = new Meta.Rectangle({
				x: workArea.x + ((limitWidth) ? limitWidth : workArea.width / 2),
				y: workArea.y,
				width: (limitWidth) ? workArea.width - limitWidth : workArea.width / 2,
				height: workArea.height
			});

		} else if (currTileGroup.BOTTOM_RIGHT == null && currTileGroup.BOTTOM_LEFT == null) {
			limitHeight = getMaxHeight(topLeftRect, topRightRect, workArea);

			freeScreenRect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + ((limitHeight) ? limitHeight : workArea.height / 2),
				width: workArea.width,
				height: (limitHeight) ? workArea.height - limitHeight : workArea.height / 2
			});

		} else if (currTileGroup.BOTTOM_LEFT == null && currTileGroup.TOP_LEFT == null) {
			limitWidth = getMaxWidth(topRightRect, bottomRightRect, workArea);

			freeScreenRect = new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: (limitWidth) ? workArea.width - limitWidth : workArea.width / 2,
				height: workArea.height
			});
		}

		openWindowsDash.open(openWindows, tiledWindow, freeScreenRect, lastInTileGroup);
	}
};

// calls either restoreWindowSize(), onWindowMoving() or resizeComplementingWindows() depending on where the drag began on the window
function onGrabBegin(_metaDisplay, metaDisplay, grabbedWindow, grabOp) {
	if (!grabbedWindow)
		return;

	if (!windowGrabSignals[grabbedWindow.get_id()])
		windowGrabSignals[grabbedWindow.get_id()] = [];

	// for resizing op
	// sameSideWindow is the window which is on the same side relative to where the grab began
	// e.g. if resizing the top left on the E side, the bottom left window is the sameSideWindow
	// opposingWindows are the remaining windows
	let sameSideWindow = null;
	let opposingWindows = [];
	let grabbedRect = grabbedWindow.get_frame_rect();

	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();
	openWindows.splice(openWindows.indexOf(grabbedWindow), 1);

	switch (grabOp) {
		case Meta.GrabOp.MOVING:
			// to properly restore the position with move_resize_frame() I need to end the grab
			// and restart it after the restoration is done
			if (grabbedWindow in tiledWindows) {
				global.display.end_grab_op(global.get_current_time())
				
				restoreWindowSize(grabbedWindow);
				
				let [x, y] = global.get_pointer();
				global.display.begin_grab_op(
					grabbedWindow, 
					Meta.GrabOp.MOVING, 
					false, // pointer already grabbed
					true, // frame action
					-1, // button
					0, // modifier
					global.get_current_time(), 
					x, y
				);

				return;
			}
			windowGrabSignals[grabbedWindow.get_id()].push( grabbedWindow.connect("position-changed", onWindowMoving.bind(this, grabbedWindow)) );
			break;

		case Meta.GrabOp.RESIZING_N:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i] in tiledWindows))
					break;

				let otherRect = openWindows[i].get_frame_rect();
				if (equalApprox(otherRect.y, grabbedRect.y, 2) && equalApprox(otherRect.height, grabbedRect.height, 2))
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
				if (equalApprox(otherRect.y, grabbedRect.y, 2) && equalApprox(otherRect.height, grabbedRect.height, 2))
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
				if (equalApprox(otherRect.x, grabbedRect.x, 2) && equalApprox(otherRect.width, grabbedRect.width, 2))
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
				if (equalApprox(otherRect.x, grabbedRect.x, 2) && equalApprox(otherRect.width, grabbedRect.width, 2))
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.x + otherRect.width, grabbedRect.x, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push( grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)) );
	}
};

function onGrabEnd(_metaDisplay, metaDisplay, window, grabOp) {
	// disconnect the signals
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
			window.move_resize_frame(true, oldRect.x, oldRect.y, oldRect.width, oldRect.height)
			
		else // scale while keeping the top at the same y pos -> for example when DND
			window.move_resize_frame(true, newPosX, currWindowFrame.y, oldRect.width, oldRect.height);

		window.tileGroup = null;
		delete tiledWindows[window];
	}
};

// used for DND and custom keyboard shortcut
function getTileRectFor(side, workArea) {
	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();

	let [currTileGroup] = getTileGroup(openWindows, null, true);
	// if a window is maximized, 2 rects can be the same rect
	// e.g. a window vertically maxmized on the left will set topLeftRect and bottomLeftRect to its rect
	let topLeftRect = (currTileGroup.TOP_LEFT) ? currTileGroup.TOP_LEFT.get_frame_rect() : null;
	let topRightRect = (currTileGroup.TOP_RIGHT) ? currTileGroup.TOP_RIGHT.get_frame_rect() : null;
	let bottomLeftRect = (currTileGroup.BOTTOM_LEFT) ? currTileGroup.BOTTOM_LEFT.get_frame_rect() : null;
	let bottomRightRect = (currTileGroup.BOTTOM_RIGHT) ? currTileGroup.BOTTOM_RIGHT.get_frame_rect() : null;

	let width = 0;
	let height = 0;
	// "limit"-dimension are the dimensions of the opposing windows
	// e.g. if the user wants to tile a window to the right (vertically maximized), 
	// the width will be limited by the windows in the top left and bottom left quad
	let limitWidth = 0;
	let limitHeight = 0;
	
	switch (side) {
		case Meta.Side.LEFT:
			limitWidth = getMaxWidth(topRightRect, bottomRightRect, workArea);

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: (limitWidth) ? workArea.width - limitWidth : workArea.width / 2,
				height: workArea.height,
			});

		case Meta.Side.RIGHT:
			limitWidth = getMaxWidth(topLeftRect, bottomLeftRect, workArea);
			
			return new Meta.Rectangle({
				x: workArea.x + ((limitWidth) ? limitWidth : workArea.width / 2),
				y: workArea.y,
				width: (limitWidth) ? workArea.width - limitWidth : workArea.width / 2,
				height: workArea.height,
			});

		case Meta.Side.TOP:
			limitHeight = getMaxHeight(bottomLeftRect, bottomRightRect, workArea);
			
			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width,
				height: (limitHeight) ? workArea.height - limitHeight : workArea.height / 2,
			});

		case Meta.Side.BOTTOM:
			limitHeight = getMaxHeight(topLeftRect, topRightRect, workArea);
			
			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + ((limitHeight) ? limitHeight : workArea.height / 2),
				width: workArea.width,
				height: (limitHeight) ? workArea.height - limitHeight : workArea.height / 2,
			});
	
		case Meta.Side.TOP + Meta.Side.LEFT:
			[width, height] = getRectDimensions(workArea, bottomRightRect, topRightRect, bottomLeftRect);

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: (width) ? width : workArea.width / 2,
				height: (height) ? height : workArea.height / 2,
			});

		case Meta.Side.TOP + Meta.Side.RIGHT:
			[width, height] = getRectDimensions(workArea, bottomLeftRect, topLeftRect, bottomRightRect);

			return new Meta.Rectangle({
				x: workArea.x + ((width) ? workArea.width - width : workArea.width / 2),
				y: workArea.y,
				width: (width) ? width : workArea.width / 2,
				height: (height) ? height : workArea.height / 2,
			});

		case Meta.Side.BOTTOM + Meta.Side.LEFT:
			[width, height] = getRectDimensions(workArea, topRightRect, bottomRightRect, topLeftRect);

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + ((height) ? workArea.height - height : workArea.height / 2),
				width: (width) ? width : workArea.width / 2,
				height: (height) ? height : workArea.height / 2,
			});

		case Meta.Side.BOTTOM + Meta.Side.RIGHT:
			[width, height] = getRectDimensions(workArea, topLeftRect, bottomLeftRect, topRightRect);

			return new Meta.Rectangle({
				x: workArea.x + ((width) ? workArea.width - width : workArea.width / 2),
				y: workArea.y + ((height) ? workArea.height - height : workArea.height / 2),
				width: (width) ? width : workArea.width / 2,
				height: (height) ? height : workArea.height / 2,
			});
	}
}

// tile previewing via DND
function onWindowMoving(window) {
	let [mouseX, mouseY] = global.get_pointer(); // mouseY alone is unreliable, so windowRect's y will also be used
	let workArea = window.get_work_area_current_monitor();
	let wRect = window.get_frame_rect();

	let onTop = wRect.y < main.panel.height + 15;
	let onBottom = workArea.height - wRect.y < 75 || mouseY > workArea.height - 25; // mitigation for wrong grabPos when grabbing from topbar, see github issue #2; seems app dependant as well (especially GNOME apps cause problems)
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
	if (tileTopLeftQuarter) {
		tilePreview.open(window, getTileRectFor(Meta.Side.TOP + Meta.Side.LEFT, workArea), window.get_monitor());

	} else if (tileTopRightQuarter) {
		tilePreview.open(window, getTileRectFor(Meta.Side.TOP + Meta.Side.RIGHT, workArea), window.get_monitor());

	} else if (tileBottomLeftQuarter) {
		tilePreview.open(window, getTileRectFor(Meta.Side.BOTTOM + Meta.Side.LEFT, workArea), window.get_monitor());

	} else if (tileBottomRightQuarter) {
		tilePreview.open(window, getTileRectFor(Meta.Side.BOTTOM + Meta.Side.RIGHT, workArea), window.get_monitor());

	} else if (tileRightHalf) {
		tilePreview.open(window, getTileRectFor(Meta.Side.RIGHT, workArea), window.get_monitor());

	} else if (tileLeftHalf) {
		tilePreview.open(window, getTileRectFor(Meta.Side.LEFT, workArea), window.get_monitor());

	} else if (tileTopHalf) {
		tilePreview.open(window, getTileRectFor(Meta.Side.TOP, workArea), window.get_monitor());

	} else if (tileBottomHalf) {
		tilePreview.open(window, getTileRectFor(Meta.Side.BOTTOM, workArea), window.get_monitor());

	} else if (tileMaximized) {
		tilePreview.open(window, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y,
			width: workArea.width,
			height: workArea.height,
		}), window.get_monitor());

	} else {
		tilePreview.close();
	}
};

// sameSideWindow is the window which is on the same side as the resizedRect based on the drag direction
// e.g. if resizing the top left on the E side, the bottom left window is the sameSideWindow
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

function getMaxWidth(rect1, rect2, workArea) {
	// ignore maximized windows
	if (rect1 && rect1.width == workArea.width)
		rect1 = null;
	if (rect2 && rect2.width == workArea.width)
		rect2 = null;

	if (rect1 && rect2)
		return Math.max(rect1.width, rect2.width);
	else if (rect1)
		return rect1.width;
	else if (rect2)
		return rect2.width;
	else
		return 0;
};

function getMaxHeight(rect1, rect2, workArea) {
	// ignore maximized windows
	if (rect1 && rect1.height == workArea.height)
		rect1 = null;
	if (rect2 && rect2.height == workArea.height)
		rect2 = null;

	if (rect1 && rect2)
		return Math.max(rect1.height, rect2.height);
	else if (rect1)
		return rect1.height;
	else if (rect2)
		return rect2.height;
	else
		return 0;
};

// diagonalRect is the rect which is in the diagonal quad to the space we try to get the rect for
// for example: if we try to get the free space for the top left quad, the diagonal rect is at the bottom right
// if a window is maximized, 2 rects can be equal
// vertToDiaRect/horiToDiaRect are the quads in relation to the diagonal quad
// ONLY used to get the dimensions for 1 quad and not more (i. e. not maximized windows)
function getRectDimensions(workArea, diagonalRect, vertToDiaRect, horiToDiaRect) {
	// 0 other rect
	if (!diagonalRect && !vertToDiaRect && !horiToDiaRect) {
		return [workArea.width / 2, workArea.height / 2];

	// 1 rect isnt null
	} else if (diagonalRect && !vertToDiaRect && !horiToDiaRect) {
		return [workArea.width - diagonalRect.width, workArea.height - diagonalRect.height];

	} else if (!diagonalRect && vertToDiaRect && !horiToDiaRect) {
		return [workArea.width - vertToDiaRect.width, vertToDiaRect.height];

	} else if (!diagonalRect && !vertToDiaRect && horiToDiaRect) {
		return [horiToDiaRect.width, workArea.height - horiToDiaRect.height];

	// 2 rects arent null
	} else if (diagonalRect && vertToDiaRect && !horiToDiaRect) {
		return [workArea.width - vertToDiaRect.width, (diagonalRect.equal(vertToDiaRect)) ? workArea.height / 2 : vertToDiaRect.height];

	} else if (diagonalRect && !vertToDiaRect && horiToDiaRect) {
		return [(diagonalRect.equal(horiToDiaRect)) ? workArea.width / 2 : horiToDiaRect.width, workArea.height - horiToDiaRect.height];

	} else if (!diagonalRect && vertToDiaRect && horiToDiaRect) {
		return [horiToDiaRect.width, vertToDiaRect.height];

	// 3 rects arent null
	} else {
		// if there are 3 differently sized windows, there are (at least?) 2 possible rects
		// one, where the height is limited by the union between the diagonalRect and the horiToDiaRect and the width is limited by vertToDiaRect
		// and the other one, where the height is limited by the horiToDiaRect and the width is limited by the union between the diagonalRect and the vertToDiaRect
		let vertUnion = (!diagonalRect.equal(horiToDiaRect)) ? diagonalRect.union(vertToDiaRect) : vertToDiaRect;
		let horiUnion = (!diagonalRect.equal(vertToDiaRect)) ? diagonalRect.union(horiToDiaRect) : horiToDiaRect;

		let r1 = [workArea.width - vertUnion.width, workArea.height - horiToDiaRect.height];
		let r1area = r1[0] * r1[1];

		let r2 = [workArea.width - vertToDiaRect.width, workArea.height - horiUnion.height];
		let r2area = r2[0] * r2[1];
		
		return (r1area > r2area) ? r1 : r2;
	}
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

			// container for appIcons, centered in bgGrid
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

		open(openWindows, tiledWindow, freeScreenRect, lastInTileGroupW) {
			this._shown = true;
			this.appContainer.destroy_all_children();

			let entireWorkArea = tiledWindow.get_work_area_all_monitors();
			let monitorScale = global.display.get_monitor_scale(tiledWindow.get_monitor());

			// fill appContainer
			let winTracker = Shell.WindowTracker.get_default();
			this.appContainer.appCount = 0;

			let buttonSize = monitorScale * (settings.get_int("icon-size") + 16 + settings.get_int("icon-margin") + ((settings.get_boolean("show-label")) ? 28 : 0)); // magicNr are margins/paddings from the icon to the full-sized highlighted button
			this.maxColumnCount = Math.floor((freeScreenRect.width * 0.7) / buttonSize);

			// dont allow "too empty" rows
			if (openWindows.length % this.maxColumnCount <= this.maxColumnCount / 2)
				for (let i = this.maxColumnCount; i >= 1; i--) {
					if (openWindows.length % i >= Math.ceil(i / 2)) {
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
			this.appContainer.set_position(settings.get_int("icon-margin") / 2 * monitorScale, settings.get_int("icon-margin") / 2 * monitorScale);
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
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup shadeBG
			let windowActor = lastInTileGroupW.get_compositor_private();
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
